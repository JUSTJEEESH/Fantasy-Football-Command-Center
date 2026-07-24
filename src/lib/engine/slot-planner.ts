import type { League, PlayerCard, Position } from '@/lib/types';
import { createDraftState, draftReducer, picksForSlot } from './draft-state';
import { recommend } from './recommend';
import { computeReplacementLevels, valueOverReplacement } from './valuation';
import { analyzeRoster, fillLineup } from './roster';
import { availabilityAtPick } from './availability';
import { round2 } from './scoring';

// ============================================================================
// Draft slot planner.
//
// When a league sets its order manually and announces it late, you cannot
// prepare "the plan" — you have to prepare twelve of them. This simulates a
// full draft from every slot so that the moment the order is drawn, the plan
// for that slot already exists.
//
// Opponents here pick by ADP with light noise. That is deliberately a simpler
// model than the mock-draft test's: this is about the *shape* a slot produces
// (who is realistically there at each turn), not about beating a field.
// ============================================================================

export const SLOT_PLANNER_VERSION = '1.0.0';

export interface SlotPlan {
  slot: number;
  /** The overall pick numbers this slot owns. */
  picks: number[];
  /** Longest gap between consecutive picks — the "wheel pain" number. */
  longestGap: number;
  /** Who the engine would take at each of the first few turns. */
  earlyPicks: Array<{
    overallPick: number;
    round: number;
    playerName: string;
    position: Position;
    confidence: number;
    reason: string;
  }>;
  /** Players with a realistic chance of being there at pick 1 for this slot. */
  realisticTargets: Array<{ name: string; position: Position; probability: number }>;
  /** Projected starting points of the full roster this slot produced. */
  projectedStartingPoints: number;
  /** Positional shape of the resulting roster. */
  rosterShape: Partial<Record<Position, number>>;
  /** One-line characterization of what drafting here feels like. */
  summary: string;
}

export interface SlotPlannerResult {
  plans: SlotPlan[];
  /** Slots ranked by projected starting points, best first. */
  ranking: Array<{ slot: number; points: number }>;
  /** Caveats that apply to the whole analysis. */
  assumptions: string[];
}

/**
 * Simulate the draft from every slot.
 *
 * `rounds` should be the league's actual roster size. Opponent picks are drawn
 * from the top `noiseWindow` players by ADP so the simulation is not perfectly
 * chalk, but is reproducible for a given seed.
 */
export function planAllSlots(
  players: PlayerCard[],
  league: League,
  opts: { rounds: number; seed?: number; noiseWindow?: number } = { rounds: 15 },
): SlotPlannerResult {
  const plans: SlotPlan[] = [];

  for (let slot = 1; slot <= league.teamCount; slot++) {
    plans.push(planSlot(players, league, slot, opts));
  }

  const ranking = plans
    .map((p) => ({ slot: p.slot, points: p.projectedStartingPoints }))
    .sort((a, b) => b.points - a.points);

  return {
    plans,
    ranking,
    assumptions: [
      'Opponents are modeled as drafting near ADP with small random variation.',
      'Real drafts contain reaches and runs this simulation does not reproduce, so treat the ordering of slots as indicative, not precise.',
      'Player values come from your current data. Re-run this after any significant news or an ADP refresh.',
      players.some((p) => p.adp === undefined)
        ? 'Some players have no ADP, which weakens availability estimates.'
        : 'All players have ADP data.',
    ].filter(Boolean),
  };
}

export function planSlot(
  players: PlayerCard[],
  league: League,
  slot: number,
  opts: { rounds: number; seed?: number; noiseWindow?: number } = { rounds: 15 },
): SlotPlan {
  const rounds = opts.rounds;
  const noiseWindow = opts.noiseWindow ?? 3;
  const rand = mulberry32((opts.seed ?? 20260830) + slot * 7919);

  const byId = new Map(players.map((p) => [p.id, p]));
  const slotPicks = picksForSlot(slot, league.teamCount, rounds, 'snake');

  let state = createDraftState({
    leagueId: league.id,
    teamCount: league.teamCount,
    rounds,
    userSlot: slot,
    draftType: 'snake',
  });

  const earlyPicks: SlotPlan['earlyPicks'] = [];
  const userSet = new Set(slotPicks);

  for (let pick = 1; pick <= league.teamCount * rounds; pick++) {
    const drafted = new Set(state.picks.map((p) => p.playerId));
    const available = players.filter((p) => !drafted.has(p.id));
    if (available.length === 0) break;

    let chosenId: string;

    if (userSet.has(pick)) {
      const rec = recommend({
        state,
        league: { ...league, draftSlot: slot },
        players,
      });
      if (!rec.take) break;
      chosenId = rec.take.id;

      if (earlyPicks.length < 5) {
        earlyPicks.push({
          overallPick: pick,
          round: Math.floor((pick - 1) / league.teamCount) + 1,
          playerName: rec.take.name,
          position: rec.take.position,
          confidence: rec.confidence,
          reason: rec.reasons[0] ?? '',
        });
      }
    } else {
      const byAdp = [...available]
        .filter((p) => p.adp !== undefined)
        .sort((a, b) => a.adp! - b.adp!);
      const pool = byAdp.length > 0 ? byAdp : available;
      chosenId = pool[Math.min(Math.floor(rand() * noiseWindow), pool.length - 1)]!.id;
    }

    state = draftReducer(state, {
      type: 'RECORD_PICK',
      playerId: chosenId,
      entryMethod: 'simulated',
    });
  }

  const roster = state.picks
    .filter((p) => p.draftSlot === slot)
    .map((p) => byId.get(p.playerId))
    .filter((p): p is PlayerCard => Boolean(p));

  const { points } = fillLineup(roster, league.rosterSlots);

  const rosterShape: Partial<Record<Position, number>> = {};
  for (const player of roster) {
    rosterShape[player.position] = (rosterShape[player.position] ?? 0) + 1;
  }

  const gaps = slotPicks
    .slice(1)
    .map((pick, i) => pick - slotPicks[i]! - 1);
  const longestGap = gaps.length > 0 ? Math.max(...gaps) : 0;

  // Who could realistically be there at this slot's first pick?
  const firstPick = slotPicks[0]!;
  const realisticTargets = players
    .filter((p) => p.adp !== undefined)
    .map((p) => ({
      name: p.name,
      position: p.position,
      probability: availabilityAtPick(p, firstPick, 1).probability,
    }))
    .filter((t) => t.probability >= 0.25 && t.probability <= 0.995)
    .slice(0, 6);

  return {
    slot,
    picks: slotPicks,
    longestGap,
    earlyPicks,
    realisticTargets,
    projectedStartingPoints: round2(points),
    rosterShape,
    summary: describeSlot(slot, league.teamCount, longestGap, earlyPicks),
  };
}

function describeSlot(
  slot: number,
  teamCount: number,
  longestGap: number,
  earlyPicks: SlotPlan['earlyPicks'],
): string {
  const opening = earlyPicks[0];
  const shape = earlyPicks
    .slice(0, 3)
    .map((p) => p.position)
    .join('-');

  if (slot <= 2) {
    return `Elite first pick${opening ? ` (${opening.playerName})` : ''}, then a ${longestGap}-pick wait at every turn. Opens ${shape}.`;
  }
  if (slot >= teamCount - 1) {
    return `No premium first-rounder, but back-to-back picks at every turn — you take two of whatever falls. Opens ${shape}.`;
  }
  return `Middle slot: even ${longestGap}-pick gaps and no extreme swings either way. Opens ${shape}.`;
}

// ---------------------------------------------------------------------------
// Slot-agnostic preparation
// ---------------------------------------------------------------------------

export interface PositionalEdge {
  position: Position;
  /** Value over replacement of the best available player at this position. */
  topVor: number;
  /** How many players clear the replacement bar at all. */
  startableCount: number;
  /** Where the meaningful drop-off sits, as an overall ADP. */
  cliffAtAdp: number | null;
  note: string;
}

/**
 * Analysis that holds regardless of draft slot — the part of the preparation
 * that can be done before the order is drawn.
 *
 * The point is that positional scarcity is a property of the league's rules and
 * the player pool, not of where you happen to pick. Knowing that tight ends are
 * nearly worthless in a league with no required TE is useful on Aug 8 whether
 * you end up picking 1st or 12th.
 */
export function analyzePositionalLandscape(
  players: PlayerCard[],
  league: League,
): PositionalEdge[] {
  const replacement = computeReplacementLevels(players, league);
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

  return positions.map((position) => {
    const pool = players
      .filter((p) => p.position === position)
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0));

    const withVor = pool.map((p) => ({
      player: p,
      vor: valueOverReplacement(p, replacement),
    }));
    const startable = withVor.filter((x) => x.vor > 0);

    // The cliff: the largest points gap inside the startable range.
    let cliffAtAdp: number | null = null;
    let largestGap = 0;
    for (let i = 1; i < Math.min(startable.length, 40); i++) {
      const gap =
        (startable[i - 1]!.player.projectedPoints ?? 0) -
        (startable[i]!.player.projectedPoints ?? 0);
      if (gap > largestGap) {
        largestGap = gap;
        cliffAtAdp = startable[i]!.player.adp ?? null;
      }
    }

    const required = league.rosterSlots[position as never] ?? 0;

    return {
      position,
      topVor: withVor[0]?.vor ?? 0,
      startableCount: startable.length,
      cliffAtAdp,
      note: positionNote(position, required, startable.length, league),
    };
  });
}

function positionNote(
  position: Position,
  requiredStarters: number,
  startableCount: number,
  league: League,
): string {
  if (position === 'TE' && requiredStarters === 0) {
    return (
      'This league starts ZERO tight ends — a TE only plays via FLEX, against ' +
      'your RBs and WRs. Only take one if he genuinely beats your flex ' +
      'alternative; otherwise the roster spot is better spent elsewhere.'
    );
  }
  if (position === 'K' || position === 'DST') {
    return 'Replaceable all season. Last two rounds only.';
  }
  if (position === 'QB' && requiredStarters === 1) {
    return `Only ${startableCount} clear the replacement bar, but ${league.teamCount} teams start one. Waiting is usually fine; the drop-off is shallow.`;
  }
  return `${startableCount} players clear replacement level.`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
