import { computeReplacementLevels, valueOverReplacement } from './valuation';
import { SLOT_ELIGIBILITY, type League, type PlayerCard, type Position } from '@/lib/types';

// ============================================================================
// Where your league disagrees with the market.
//
// This is the edge. ADP is priced for the league everybody else is in:
// four-point passing touchdowns, a required tight end, a yard every 25. Bay
// Islands is not that league. It pays six for a passing touchdown, a yard
// every twenty, a bonus for a hundred rushing yards, and it starts ZERO tight
// ends.
//
// Every one of those differences moves a player's real worth without moving
// his ADP by a single pick, because ADP is set by twelve people looking at a
// generic ranking. A player whose value in YOUR rules is thirty picks better
// than where he goes is not a hunch — it is arithmetic, and it is the whole
// reason to do any of this.
//
// HONESTY CONSTRAINT
// ------------------
// This analysis is only run on players with a REAL projection. When a player
// has no projection, the board estimates his points from his ADP — and a value
// derived from ADP compared against ADP would produce a perfect zero edge by
// construction, or worse, noise dressed up as insight. Those players are
// excluded and counted, never quietly folded in.
// ============================================================================

export interface MarketEdge {
  player: PlayerCard;
  /** Rank by value in this league's rules; 1 is the most valuable player. */
  valueRank: number;
  /** Rank by ADP; 1 is drafted first. */
  adpRank: number;
  /**
   * adpRank − valueRank. Positive means the market drafts him later than he is
   * worth to you: that is a target. Negative means you would be paying above
   * what he is worth in your rules.
   */
  edge: number;
  /** The same gap expressed in rounds, which is how a draft actually feels. */
  roundsOfEdge: number;
  /** Value over replacement, in this league's points. */
  vor: number;
  /** Plain statement of what the gap is. */
  note: string;
}

export interface PositionalVerdict {
  position: Position;
  /** Median rounds of edge across this position's ranked players. */
  medianRoundsOfEdge: number;
  sampleSize: number;
  /** What to do about it, in words. */
  verdict: string;
}

export interface MarketAnalysis {
  /** Worth more to you than the market charges. Best first. */
  targets: MarketEdge[];
  /** Priced above what they are worth in your rules. Worst first. */
  fades: MarketEdge[];
  /** Systematic, position-wide mispricing — the strategic version of the edge. */
  byPosition: PositionalVerdict[];
  /** How many players the analysis could actually run on. */
  analyzed: number;
  /** Excluded for want of a real projection or an ADP. */
  excluded: number;
  /** Statements about the analysis' own limits, for display. */
  notes: string[];
}

/**
 * Below this share of leagues, a player's ADP is a placeholder, not a price.
 *
 * ESPN reports an average draft position for every player, including ones
 * almost nobody drafts — and it lands them all just shy of the last pick. On a
 * real board that produced 220 of 358 players stacked in the ADP 160–180
 * buckets against 8–14 per bucket everywhere else, with ownership between 0%
 * and 12%. Ranking those against each other is ranking noise, and it dragged
 * the quarterback verdict from +1.0 rounds to −3.7 on nothing but artifacts.
 *
 * A quarter of leagues is well below "every league takes him" and well above
 * the saturation floor. On real data it leaves 142 players shaped exactly like
 * a twelve-team board: 19 QB, 46 RB, 59 WR, 18 TE.
 */
export const MIN_OWNERSHIP_FOR_REAL_ADP = 25;

/**
 * Is this player's ADP a real market price?
 *
 * When ownership is unreported — a hand-rolled CSV, say — the ADP is taken at
 * face value, because the person who exported it chose what to include.
 */
function hasRealAdp(player: PlayerCard): boolean {
  if (player.percentOwned === undefined) return true;
  return player.percentOwned >= MIN_OWNERSHIP_FOR_REAL_ADP;
}

/**
 * Rank players by value in this league, compare against where they are drafted,
 * and report the gaps.
 */
export function analyzeMarket(
  players: PlayerCard[],
  league: League,
  opts: { limit?: number } = {},
): MarketAnalysis {
  const limit = opts.limit ?? 12;

  // Only players who bring their own projection AND a real market price can
  // say anything about the difference between the two.
  const usable = players.filter(
    (p) =>
      p.adp !== undefined &&
      p.projectedPoints !== undefined &&
      p.projectionSource === 'projection' &&
      hasRealAdp(p),
  );
  const excluded = players.length - usable.length;

  if (usable.length < 20) {
    return {
      targets: [],
      fades: [],
      byPosition: [],
      analyzed: usable.length,
      excluded,
      notes: [
        `Only ${usable.length} players have both a real projection and an ADP — ` +
          'too few to say anything about market mispricing. Nothing is claimed.',
      ],
    };
  }

  // Replacement level must be computed over the players who will actually be
  // drafted, not the analysable subset, or every position's baseline shifts.
  const replacement = computeReplacementLevels(players, league);

  const scored = usable
    .map((player) => ({ player, vor: valueOverReplacement(player, replacement) }))
    .sort((a, b) => b.vor - a.vor);

  const adpOrder = [...usable].sort((a, b) => a.adp! - b.adp!);
  const adpRankById = new Map(adpOrder.map((p, i) => [p.id, i + 1]));

  const teams = league.teamCount;
  const edges: MarketEdge[] = scored.map(({ player, vor }, i) => {
    const valueRank = i + 1;
    const adpRank = adpRankById.get(player.id)!;
    const edge = adpRank - valueRank;
    const roundsOfEdge = Math.round((edge / teams) * 10) / 10;
    return {
      player,
      valueRank,
      adpRank,
      edge,
      roundsOfEdge,
      vor,
      note: describeEdge(player, edge, roundsOfEdge, teams),
    };
  });

  // A "target" has to be worth drafting in the first place. Without this, the
  // list fills with replacement-level players who are cheap because they are
  // bad — a 200-pick edge on someone you would never start is not an edge.
  const startable = edges.filter((e) => e.vor > 0);

  const targets = startable
    .filter((e) => e.edge >= Math.max(6, teams / 2))
    .sort((a, b) => b.edge - a.edge)
    .slice(0, limit);

  // Fades are drawn from players going early enough to matter. Nobody needs
  // warning off a player being taken in the last round.
  const fades = edges
    .filter((e) => e.edge <= -Math.max(6, teams / 2) && e.adpRank <= teams * 10)
    .sort((a, b) => a.edge - b.edge)
    .slice(0, limit);

  const notes = [
    `Ranked ${usable.length} players by value under your rules and compared each ` +
      'against where ESPN drafters actually take him.',
  ];
  if (excluded > 0) {
    notes.push(
      `${excluded} players were left out: without a real projection their points ` +
        'are estimated from ADP, so comparing them against ADP would just be ' +
        'measuring the estimate.',
    );
  }
  notes.push(
    'Value is an inference from ESPN projections re-scored in your rules, not a ' +
      'forecast. It is only as good as those projections.',
  );

  return {
    targets,
    fades,
    // Deliberately every analysed player, not just the startable ones. The
    // single most valuable verdict this produces is "your league starts no
    // tight end, so tight ends are wildly overpriced" — and that is a
    // statement about players whose value is at or below replacement, which
    // is exactly who the startable filter removes.
    byPosition: positionalVerdicts(edges, league),
    analyzed: usable.length,
    excluded,
    notes,
  };
}

function describeEdge(
  player: PlayerCard,
  edge: number,
  rounds: number,
  teams: number,
): string {
  const where = `goes around pick ${Math.round(player.adp ?? 0)}`;
  if (edge >= teams) {
    return `${where}, worth a pick ${Math.abs(rounds).toFixed(1)} rounds earlier in your scoring.`;
  }
  if (edge <= -teams) {
    return `${where}, but in your scoring he is only worth a pick ${Math.abs(rounds).toFixed(1)} rounds later.`;
  }
  return `${where}; your scoring and the market roughly agree.`;
}

/**
 * Position-wide mispricing.
 *
 * This is the more valuable half. Knowing one player is a bargain wins you one
 * pick; knowing an entire position is systematically mispriced in your league
 * shapes every pick you make. A league that starts no tight end should show
 * tight ends priced far above their worth, and it should show up here as a
 * number rather than as a hunch.
 */
function positionalVerdicts(edges: MarketEdge[], league: League): PositionalVerdict[] {
  // Only players the draft actually reaches.
  //
  // Both obvious filters are wrong. Restricting to above-replacement players
  // drops tight ends entirely — and "your league starts no tight end" is the
  // most valuable thing this function can say. Including everyone lets the
  // sixty-odd quarterbacks nobody drafts decide the verdict for quarterbacks,
  // which flipped QB from +1.0 to −3.7 rounds on real data. A player who goes
  // undrafted is not mispriced; he is simply not in the draft.
  const lastPick = league.teamCount * totalRosterSize(league);

  const byPosition = new Map<Position, number[]>();
  for (const edge of edges) {
    if ((edge.player.adp ?? Infinity) > lastPick) continue;
    const list = byPosition.get(edge.player.position) ?? [];
    list.push(edge.roundsOfEdge);
    byPosition.set(edge.player.position, list);
  }

  const out: PositionalVerdict[] = [];
  for (const [position, rounds] of byPosition) {
    // Median, not mean: one extreme outlier should not define a position.
    if (rounds.length < 5) continue;
    const sorted = [...rounds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    out.push({
      position,
      medianRoundsOfEdge: median,
      sampleSize: rounds.length,
      verdict: positionVerdictText(position, median, slotDemand(position, league)),
    });
  }

  return out.sort((a, b) => b.medianRoundsOfEdge - a.medianRoundsOfEdge);
}

/** Starters plus bench — how many rounds the draft actually runs. */
function totalRosterSize(league: League): number {
  const starters = Object.values(league.rosterSlots).reduce<number>(
    (sum, n) => sum + (n ?? 0),
    0,
  );
  return starters + league.benchSize;
}

type SlotDemand = 'required' | 'flex-only' | 'none';

/**
 * How the starting lineup creates demand for a position.
 *
 * The distinction matters and is easy to get wrong. Bay Islands lists no tight
 * end slot, but it does have a FLEX, and a tight end is flex-eligible — so
 * "this league starts zero tight ends" would be false. What is true, and what
 * actually drives the strategy, is that no tight end is *required*: one can
 * only reach the lineup by beating a running back or receiver for the flex,
 * which in this scoring he rarely does.
 */
function slotDemand(position: Position, league: League): SlotDemand {
  if ((league.rosterSlots[position] ?? 0) > 0) return 'required';

  const flexes = ['FLEX', 'SUPERFLEX', 'WRRB_FLEX', 'REC_FLEX'] as const;
  const flexEligible = flexes.some(
    (slot) =>
      (league.rosterSlots[slot] ?? 0) > 0 && SLOT_ELIGIBILITY[slot].includes(position),
  );
  return flexEligible ? 'flex-only' : 'none';
}

function positionVerdictText(
  position: Position,
  median: number,
  demand: SlotDemand,
): string {
  if (demand === 'none') {
    return `Your lineup cannot start a ${position} at all, yet the board prices them for leagues that must — ${Math.abs(median).toFixed(1)} rounds of pure overpay. Never spend a pick here.`;
  }
  if (demand === 'flex-only') {
    return `You are not required to start a ${position}. One only reaches your lineup by beating an RB or WR for the FLEX, but the board prices them for the eleven other leagues that mandate one — hence ${Math.abs(median).toFixed(1)} rounds of overpay. Let someone else take them.`;
  }
  if (median >= 1) {
    return `${position}s are worth about ${median.toFixed(1)} rounds more in your league than the market charges — you can wait on everything else and still get them, or take them early knowing they are underpriced.`;
  }
  if (median <= -1) {
    return `${position}s cost about ${Math.abs(median).toFixed(1)} rounds more than they are worth in your scoring. Let someone else pay.`;
  }
  return `${position}s are priced about right for your league.`;
}
