import type {
  DraftRecommendation,
  DraftState,
  League,
  PlayerCard,
  PlayerRef,
  Position,
  RecommendationFlavor,
} from '@/lib/types';
import { SLOT_ELIGIBILITY } from '@/lib/types';
import { round2 } from './scoring';
import {
  computeReplacementLevels,
  computeScarcity,
  valueOverReplacement,
  type PositionScarcity,
  type ReplacementLevels,
} from './valuation';
import {
  analyzeRoster,
  marginalLineupValue,
  rosterFitMultiplier,
  type RosterAnalysis,
} from './roster';
import {
  currentOverallPick,
  detectRuns,
  draftedPlayerIds,
  observedPickRates,
  picksForSlot,
  picksUntilNextTurn,
  roundForOverallPick,
  userNextPick,
  userRoster,
  type PositionalRun,
} from './draft-state';
import { analyzeWait, availabilityAtPick } from './availability';

// ============================================================================
// Draft recommendation engine (§10, §14).
//
// This is the module that answers "who's my pick?". It is deliberately, fully
// deterministic: the same inputs always produce the same pick, the score is
// decomposable into named components, and the LLM never touches it. The LLM
// only rewords what this file already decided.
// ============================================================================

export const RECOMMEND_ENGINE_VERSION = '1.1.0';

/**
 * Weights for the composite draft score. Every one is exposed as config (§7,
 * §10: "the exact formula should be configurable") so the model can be tuned
 * without editing code.
 */
export interface DraftScoreWeights {
  vor: number;
  marginalLineup: number;
  adpValue: number;
  scarcity: number;
  roleCertainty: number;
  injuryRisk: number;
  upside: number;
  trend: number;
  schedule: number;
  /** Cost of spending a pick on a position that can wait until the end. */
  positionTiming: number;
  /** Endgame pressure to fill required starting slots before picks run out. */
  mandatoryFill: number;
}

export const DEFAULT_WEIGHTS: DraftScoreWeights = {
  vor: 1.0,            // the backbone: points above a replacement starter
  marginalLineup: 0.55, // what he actually adds to THIS lineup
  adpValue: 0.35,      // falling to you below ADP is real, bounded value
  scarcity: 0.40,      // tier cliffs and how fast the position is drying up
  roleCertainty: 0.25,
  injuryRisk: 0.30,
  upside: 0.25,
  trend: 0.15,
  schedule: 0.10,
  positionTiming: 1.0,
  mandatoryFill: 1.0,
};

/**
 * Value forfeited by using a pick on a kicker or defense before the last two
 * rounds, expressed in fantasy points.
 *
 * This is not a fudge factor — it is the option value of the bench spot. An
 * equivalent kicker is available in the final round, so drafting one early buys
 * essentially nothing while spending a slot that could hold an injury handcuff
 * or a breakout candidate. Roughly one bench player's worth of upside.
 */
export const EARLY_KDST_COST = 30;

export interface RecommendationInput {
  state: DraftState;
  league: League;
  /** The full player pool, including already-drafted players. */
  players: PlayerCard[];
  weights?: Partial<DraftScoreWeights>;
  /** 0 = maximize floor, 1 = maximize ceiling. */
  riskTolerance?: number;
  /** Player ids the user never wants recommended. */
  avoidList?: string[];
  /** Player ids the user is targeting; a small nudge, not an override. */
  targetList?: string[];
  /** Freshness of the underlying data, for honest staleness reporting. */
  dataFetchedAt?: string;
  now?: Date;
}

export interface ScoredPlayer {
  player: PlayerCard;
  score: number;
  vor: number;
  marginalValue: number;
  adpDelta: number;
  fitMultiplier: number;
  components: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Scoring one player
// ---------------------------------------------------------------------------

export function scorePlayer(
  player: PlayerCard,
  ctx: {
    league: League;
    replacement: ReplacementLevels;
    scarcity: Record<Position, PositionScarcity>;
    rosterAnalysis: RosterAnalysis;
    roster: PlayerCard[];
    currentPick: number;
    round: number;
    totalRounds: number;
    weights: DraftScoreWeights;
    riskTolerance: number;
    /** User picks remaining, including the one on the clock. */
    picksRemaining: number;
  },
): ScoredPlayer {
  const w = ctx.weights;
  const vor = valueOverReplacement(player, ctx.replacement);
  const marginal = marginalLineupValue(
    ctx.roster,
    player,
    ctx.league,
    ctx.replacement.points,
  );

  // Below replacement level, "how far below" stops being meaningful. RB60 and
  // RB75 are equally unusable as starters; what they're actually worth is bench
  // value — injury insurance and upside — which does not fall off a cliff.
  // Taking raw negative VOR literally made deep bench players score around -100
  // and let a kicker's small positive VOR look like the best pick on the board.
  const effectiveVor = vor >= 0 ? vor : -2 * Math.sqrt(-vor);

  // ADP value: picking a player later than his ADP is a discount. Capped
  // because a 60-pick faller is usually falling for a reason the market knows
  // and we don't — treating that as pure profit is how you draft injured players.
  const adpDelta = player.adp !== undefined ? ctx.currentPick - player.adp : 0;
  const adpValue = clamp(adpDelta, -25, 25);

  const posScarcity = ctx.scarcity[player.position];
  // Scarcity only counts for the player at the front of the queue at his
  // position — the cliff is only yours to lose if you're the one at the edge.
  const isTopAtPosition =
    posScarcity.bestAvailablePoints > 0 &&
    (player.projectedPoints ?? 0) >= posScarcity.bestAvailablePoints - 0.01;
  const scarcityBonus = isTopAtPosition
    ? posScarcity.urgency * posScarcity.tierDropoff
    : 0;

  const roleCertainty = player.roleCertainty ?? 0.6;
  const injuryRisk = player.injuryRisk ?? 0.2;

  const ceiling = player.ceilingPoints ?? (player.projectedPoints ?? 0) * 1.25;
  const floor = player.floorPoints ?? (player.projectedPoints ?? 0) * 0.7;
  const spread = ceiling - floor;
  // Risk tolerance rotates the objective between floor and ceiling.
  const riskAdjustment = (ctx.riskTolerance - 0.5) * 2 * spread * 0.15;

  // Cost of taking a K/DST too early, ramped down toward the end of the draft
  // so that by the last few rounds it is simply time to fill those slots.
  const isKicker = player.position === 'K' || player.position === 'DST';
  const roundsLeft = ctx.totalRounds - ctx.round;
  const timingCost = isKicker
    ? -EARLY_KDST_COST * clamp((roundsLeft - 1) / 3, 0, 1)
    : 0;

  // Endgame constraint: you must not run out of picks with a required starting
  // slot still empty. Going into week 1 without a quarterback costs far more
  // than any marginal value difference, so as slack disappears, filling a hole
  // dominates everything else.
  const unfilled = ctx.rosterAnalysis.unfilledSlots;
  const slack = ctx.picksRemaining - unfilled.length;
  const fillsAHole = unfilled.some((slot) =>
    SLOT_ELIGIBILITY[slot].includes(player.position),
  );
  // Ramps in as spare picks run out, rather than switching on at the last
  // moment — by the time slack is zero the choice is already made for you.
  //
  // Kickers and defenses get a much tighter threshold: they are the most
  // replaceable slots on the roster, so they should always be the last holes
  // filled. Treating them with the same urgency as an empty QB slot pulls them
  // several rounds earlier than they are worth.
  const holeThreshold = isKicker ? 1 : 4;
  const pressure =
    slack > holeThreshold ? 0 : (holeThreshold + 1 - Math.max(0, slack)) * 20;
  let mandatoryFill = pressure * (fillsAHole ? 1 : -1);

  // A second kicker or defense is dead weight in every format. Never let
  // endgame pressure or ADP value talk the engine into one.
  if (isKicker) {
    const required = ctx.league.rosterSlots[player.position] ?? 0;
    if ((ctx.rosterAnalysis.counts[player.position] ?? 0) >= required) {
      mandatoryFill = -100;
    }
  }

  const components = {
    vor: w.vor * effectiveVor,
    marginalLineup: w.marginalLineup * marginal,
    adpValue: w.adpValue * adpValue,
    scarcity: w.scarcity * scarcityBonus,
    roleCertainty: w.roleCertainty * (roleCertainty - 0.6) * 20,
    injuryRisk: -w.injuryRisk * injuryRisk * 25,
    upside: w.upside * riskAdjustment,
    trend: w.trend * (player.trendScore ?? 0),
    schedule: w.schedule * (((player.scheduleEase ?? 0.5) - 0.5) * 20),
    positionTiming: w.positionTiming * timingCost,
    mandatoryFill: w.mandatoryFill * mandatoryFill,
  };

  const raw = Object.values(components).reduce((a, b) => a + b, 0);
  const fitMultiplier = rosterFitMultiplier(ctx.rosterAnalysis, player, ctx.league, {
    round: ctx.round,
    totalRounds: ctx.totalRounds,
  });

  return {
    player,
    // Fit multiplies rather than adds so it scales with how much value is at
    // stake — a need-based tilt should matter more between two studs than
    // between two waiver-wire fliers.
    score: round2(applyMultiplier(raw, fitMultiplier)),
    vor,
    marginalValue: marginal,
    adpDelta: round2(adpDelta),
    fitMultiplier,
    components: Object.fromEntries(
      Object.entries(components).map(([k, v]) => [k, round2(v)]),
    ),
  };
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

export function recommend(input: RecommendationInput): DraftRecommendation {
  const now = input.now ?? new Date();
  const { state, league } = input;
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const riskTolerance = input.riskTolerance ?? 0.5;
  const avoidSet = new Set(input.avoidList ?? []);
  const targetSet = new Set(input.targetList ?? []);

  const byId = new Map(input.players.map((p) => [p.id, p]));
  const drafted = draftedPlayerIds(state);
  const available = input.players.filter((p) => !drafted.has(p.id));
  const roster = userRoster(state)
    .map((id) => byId.get(id))
    .filter((p): p is PlayerCard => Boolean(p));

  const currentPick = currentOverallPick(state);
  const round = roundForOverallPick(currentPick, state.teamCount);
  const untilNext = picksUntilNextTurn(state);
  const nextPick = (() => {
    const upcoming = userNextPick(state);
    if (upcoming === null) return null;
    return upcoming === currentPick
      ? untilNext === null
        ? null
        : currentPick + untilNext + 1
      : upcoming;
  })();

  const replacement = computeReplacementLevels(input.players, league);
  const positionOf = (id: string) => byId.get(id)?.position;
  const pickRates = observedPickRates(state, positionOf);
  const scarcity = computeScarcity(available, replacement, untilNext, pickRates);
  const rosterAnalysis = analyzeRoster(roster, league);
  const runs = detectRuns(state, positionOf, { baselineRates: pickRates });

  // Positions already at their league maximum are removed from consideration
  // outright. A capped position is not a low-value pick, it is an illegal one,
  // and ranking it low would still let it surface once the board thins.
  const cappedPositions = new Set<Position>();
  for (const [position, limit] of Object.entries(league.positionLimits ?? {}) as Array<
    [Position, number]
  >) {
    if ((rosterAnalysis.counts[position] ?? 0) >= limit) cappedPositions.add(position);
  }

  const eligible = available.filter(
    (p) => !avoidSet.has(p.id) && !cappedPositions.has(p.position),
  );

  if (eligible.length === 0) {
    return emptyRecommendation(currentPick, round, untilNext, now);
  }

  const ctx = {
    league,
    replacement,
    scarcity,
    rosterAnalysis,
    roster,
    currentPick,
    round,
    totalRounds: state.rounds,
    weights,
    riskTolerance,
    picksRemaining: picksForSlot(
      state.userSlot,
      state.teamCount,
      state.rounds,
      state.draftType,
    ).filter((p) => p >= currentPick).length,
  };

  const scored = eligible
    .map((p) => {
      const s = scorePlayer(p, ctx);
      // A watchlist target gets a nudge, never a veto over a clear talent gap.
      return targetSet.has(p.id) ? { ...s, score: round2(s.score * 1.05) } : s;
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const flavors = buildFlavors(scored, ctx);
  const alternatives = scored
    .slice(1, 3)
    .map((s) => toRef(s.player));

  const waitAnalysis = analyzeWait(
    top.player,
    eligible.filter((p) => p.position === top.player.position),
    nextPick,
    currentPick,
  );

  const verdict = decideVerdict(top, scored, waitAnalysis.canWait, currentPick);
  const reasons = buildReasons(top, ctx, scarcity, runs, waitAnalysis, nextPick);
  const confidence = computeConfidence(scored, top, rosterAnalysis, input.dataFetchedAt, now);
  const avoid = buildAvoidList(scored, ctx, round);
  const riskFactors = buildRiskFactors(top, rosterAnalysis, input.dataFetchedAt, now);

  return {
    overallPick: currentPick,
    round,
    take: toRef(top.player),
    confidence,
    reasons,
    alternatives,
    avoid,
    verdict,
    flavors,
    picksUntilNextTurn: untilNext,
    riskFactors,
    engineVersion: RECOMMEND_ENGINE_VERSION,
    computedAt: now.toISOString(),
    staleness: describeStaleness(input.dataFetchedAt, now),
  };
}

// ---------------------------------------------------------------------------
// Flavors (§14: six distinct answers to "who should I take?")
// ---------------------------------------------------------------------------

function buildFlavors(
  scored: ScoredPlayer[],
  ctx: Parameters<typeof scorePlayer>[1],
): RecommendationFlavor[] {
  const pool = scored.slice(0, 40);
  const mk = (
    key: RecommendationFlavor['key'],
    label: string,
    pick: ScoredPlayer | undefined,
    rationale: string,
  ): RecommendationFlavor => ({
    key,
    label,
    playerId: pick?.player.id ?? null,
    playerName: pick?.player.name ?? null,
    score: pick?.score ?? 0,
    rationale,
  });

  const bestOverall = pool[0];

  const bestFit = [...pool].sort(
    (a, b) => b.marginalValue - a.marginalValue || b.score - a.score,
  )[0];

  const bestValue = [...pool].sort((a, b) => b.adpDelta - a.adpDelta || b.score - a.score)[0];

  // Safest: high floor, high role certainty, low injury risk — among players
  // who are still genuinely in contention, not the safest scrub on the board.
  const contenders = pool.slice(0, 15);
  const safest = [...contenders].sort((a, b) => safetyScore(b) - safetyScore(a))[0];

  const highestUpside = [...contenders].sort(
    (a, b) => upsideScore(b) - upsideScore(a),
  )[0];

  // Contrarian: meaningfully better by our model than by the market. Requires
  // a real ADP gap so it doesn't just surface noise.
  const contrarian = [...pool]
    .filter((s) => s.adpDelta > 8 && s.score > (bestOverall?.score ?? 0) * 0.72)
    .sort((a, b) => b.adpDelta - a.adpDelta)[0];

  return [
    mk('best_overall', 'Best overall', bestOverall, 'Highest composite draft score.'),
    mk('best_fit', 'Best roster fit', bestFit, 'Adds the most to your starting lineup as constructed.'),
    mk('best_value', 'Best value', bestValue, bestValue ? `Available ${Math.round(bestValue.adpDelta)} picks past his ADP.` : 'No clear ADP discount on the board.'),
    mk('safest', 'Safest pick', safest, 'Highest floor and role certainty among live options.'),
    mk('highest_upside', 'Highest upside', highestUpside, 'Widest gap between ceiling and current cost.'),
    mk('contrarian', 'Contrarian', contrarian, contrarian ? 'Our model rates him well above the market.' : 'Nothing on the board diverges enough from consensus to call contrarian.'),
  ];
}

function safetyScore(s: ScoredPlayer): number {
  const floor = s.player.floorPoints ?? (s.player.projectedPoints ?? 0) * 0.7;
  return (
    floor +
    (s.player.roleCertainty ?? 0.6) * 30 -
    (s.player.injuryRisk ?? 0.2) * 40
  );
}

function upsideScore(s: ScoredPlayer): number {
  const ceiling = s.player.ceilingPoints ?? (s.player.projectedPoints ?? 0) * 1.25;
  const proj = s.player.projectedPoints ?? 0;
  return (ceiling - proj) + (s.player.breakoutProbability ?? 0) * 40;
}

// ---------------------------------------------------------------------------
// Verdict, reasons, confidence
// ---------------------------------------------------------------------------

function decideVerdict(
  top: ScoredPlayer,
  scored: ScoredPlayer[],
  canWait: boolean,
  currentPick: number,
): DraftRecommendation['verdict'] {
  const second = scored[1];
  const gap = second ? top.score - second.score : Infinity;

  // Reaching well ahead of ADP with no separation from the next name is the
  // classic draft mistake; call it what it is.
  if (top.adpDelta < -12 && gap < 6) return 'REACH';
  if (canWait) return 'CAN_WAIT';
  return 'TAKE_NOW';
}

function buildReasons(
  top: ScoredPlayer,
  ctx: Parameters<typeof scorePlayer>[1],
  scarcity: Record<Position, PositionScarcity>,
  runs: PositionalRun[],
  wait: ReturnType<typeof analyzeWait>,
  nextPick: number | null,
): string[] {
  const reasons: string[] = [];
  const p = top.player;
  const s = scarcity[p.position];

  // 1. Value relative to the field.
  if (top.vor > 0) {
    reasons.push(
      `${p.name} is worth ${top.vor.toFixed(0)} points more than a replacement-level ${p.position} in your scoring.`,
    );
  }

  // 2. Why now: the tier cliff.
  if (s.remainingInTopTier <= 2 && s.tierDropoff >= 6) {
    reasons.push(
      s.remainingInTopTier === 1
        ? `He is the last ${p.position} in tier ${s.topTier ?? '?'} — the next one down costs you about ${s.tierDropoff.toFixed(0)} points.`
        : `Only ${s.remainingInTopTier} ${p.position}s left in this tier, and the drop to the next tier is about ${s.tierDropoff.toFixed(0)} points.`,
    );
  }

  // 3. Market value.
  if (top.adpDelta >= 6) {
    reasons.push(
      `He's lasted ${Math.round(top.adpDelta)} picks past his ADP of ${p.adp?.toFixed(0)} — that's a real discount.`,
    );
  }

  // 4. Roster fit.
  if (top.marginalValue > 0 && top.fitMultiplier > 1.02) {
    reasons.push(
      `He slots straight into your lineup, adding about ${top.marginalValue.toFixed(0)} points to your starters.`,
    );
  }

  // 5. Run pressure.
  const run = runs.find((r) => r.isRun && r.position === p.position);
  if (run) {
    reasons.push(
      `${run.countInWindow} ${run.position}s have gone in the last ${run.windowSize} picks — the run is on.`,
    );
  }

  // 6. Wait analysis — always worth saying out loud.
  if (nextPick !== null) reasons.push(wait.reasoning);

  if (reasons.length === 0) {
    reasons.push(
      `${p.name} is the highest-scoring player left on the board for your roster and scoring settings.`,
    );
  }

  return reasons.slice(0, 3);
}

/**
 * Confidence blends: separation from the next option, data completeness, and
 * data freshness. It is deliberately never 1.0 — the model is a model.
 */
function computeConfidence(
  scored: ScoredPlayer[],
  top: ScoredPlayer,
  rosterAnalysis: RosterAnalysis,
  dataFetchedAt: string | undefined,
  now: Date,
): number {
  const second = scored[1];
  const gap = second ? top.score - second.score : 30;
  const scale = Math.max(10, Math.abs(top.score));
  const separation = clamp(gap / scale, 0, 1);

  const p = top.player;
  const completeness =
    (p.projectedPoints !== undefined ? 0.4 : 0) +
    (p.adp !== undefined ? 0.3 : 0) +
    (p.tier !== undefined ? 0.15 : 0) +
    (p.roleCertainty !== undefined ? 0.15 : 0);

  let freshness = 1;
  if (dataFetchedAt) {
    const ageHours = (now.getTime() - new Date(dataFetchedAt).getTime()) / 3_600_000;
    freshness = ageHours <= 12 ? 1 : ageHours <= 48 ? 0.9 : ageHours <= 168 ? 0.78 : 0.6;
  } else {
    freshness = 0.85; // unknown freshness is itself a small penalty
  }

  const raw = (0.35 + 0.4 * separation) * (0.55 + 0.45 * completeness) * freshness;
  return Math.round(clamp(raw, 0.2, 0.95) * 100) / 100;
}

function buildAvoidList(
  scored: ScoredPlayer[],
  ctx: Parameters<typeof scorePlayer>[1],
  round: number,
): DraftRecommendation['avoid'] {
  const out: DraftRecommendation['avoid'] = [];

  // Players the market likes far more than we do, among names plausibly about
  // to be taken — that is what "avoid" means at this pick.
  const nearby = scored.filter(
    (s) => s.player.adp !== undefined && s.player.adp <= ctx.currentPick + 12,
  );

  for (const s of nearby) {
    if (out.length >= 2) break;
    const p = s.player;

    if ((p.injuryRisk ?? 0) >= 0.5) {
      out.push({
        player: toRef(p),
        reason: `Injury risk is high${p.injuryStatus ? ` (${p.injuryStatus})` : ''} for where he's being drafted.`,
      });
      continue;
    }
    if ((p.roleCertainty ?? 1) <= 0.4) {
      out.push({
        player: toRef(p),
        reason: 'His role is unsettled — the workload that justifies this cost may not exist.',
      });
      continue;
    }
    if (s.adpDelta < -10 && s.score < (scored[0]?.score ?? 0) * 0.6) {
      out.push({
        player: toRef(p),
        reason: `Going roughly ${Math.abs(Math.round(s.adpDelta))} picks ahead of where his production supports.`,
      });
    }
  }

  // Early K/DST is always the wrong pick and worth saying.
  if (round < ctx.totalRounds - 1) {
    const earlyKD = scored.find(
      (s) =>
        (s.player.position === 'K' || s.player.position === 'DST') &&
        s.player.adp !== undefined &&
        s.player.adp <= ctx.currentPick + 10,
    );
    if (earlyKD && out.length < 3) {
      out.push({
        player: toRef(earlyKD.player),
        reason: `It's round ${round} — ${earlyKD.player.position}s are replaceable off waivers all season.`,
      });
    }
  }

  return out;
}

function buildRiskFactors(
  top: ScoredPlayer,
  rosterAnalysis: RosterAnalysis,
  dataFetchedAt: string | undefined,
  now: Date,
): string[] {
  const risks: string[] = [];
  const p = top.player;

  if ((p.injuryRisk ?? 0) >= 0.35) {
    risks.push(`Elevated injury risk${p.injuryStatus ? ` — currently ${p.injuryStatus}` : ''}.`);
  }
  if ((p.roleCertainty ?? 1) <= 0.55) {
    risks.push('Role is not fully locked in; monitor camp and depth chart reports.');
  }
  if (p.adp === undefined) {
    risks.push('No ADP data for this player — value and availability estimates are weaker.');
  }
  if (p.projectedPoints === undefined) {
    risks.push('No projection available; this ranking leans on ADP alone.');
  }
  const conflict = rosterAnalysis.byeConflicts.find((c) => c.week === p.byeWeek);
  if (conflict) {
    risks.push(`Week ${p.byeWeek} bye stacks with ${conflict.playerIds.length} current starters.`);
  }
  const stale = describeStaleness(dataFetchedAt, now);
  if (stale) risks.push(stale);

  return risks;
}

function describeStaleness(dataFetchedAt: string | undefined, now: Date): string | undefined {
  if (!dataFetchedAt) return 'Data freshness unknown — this may not reflect the last few hours.';
  const ageHours = (now.getTime() - new Date(dataFetchedAt).getTime()) / 3_600_000;
  if (ageHours < 12) return undefined;
  if (ageHours < 48) return `Data last refreshed ${Math.round(ageHours)} hours ago.`;
  return `STALE: data last refreshed ${Math.round(ageHours / 24)} days ago — re-sync before trusting this.`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toRef(p: PlayerCard): PlayerRef {
  return { id: p.id, name: p.name, position: p.position, team: p.team };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Apply a penalty/bonus multiplier in a sign-correct way.
 *
 * Naive multiplication inverts for negative scores: a 0.2x penalty turns -100
 * into -20, which *promotes* the penalized player. That is not academic — in
 * the late rounds every remaining player has negative value over replacement,
 * and the naive form floated penalized kickers to the top of the board.
 *
 * Reflecting the multiplier around 1 for negative scores keeps the direction
 * of the adjustment intact on both sides of zero: a penalty always makes a
 * player less attractive, a bonus always makes them more attractive.
 */
export function applyMultiplier(score: number, multiplier: number): number {
  return score >= 0 ? score * multiplier : score * (2 - multiplier);
}

function emptyRecommendation(
  currentPick: number,
  round: number,
  untilNext: number | null,
  now: Date,
): DraftRecommendation {
  return {
    overallPick: currentPick,
    round,
    take: null,
    confidence: 0,
    reasons: ['No players are available to recommend.'],
    alternatives: [],
    avoid: [],
    verdict: 'NO_PICK_AVAILABLE',
    flavors: [],
    picksUntilNextTurn: untilNext,
    riskFactors: [],
    engineVersion: RECOMMEND_ENGINE_VERSION,
    computedAt: now.toISOString(),
  };
}
