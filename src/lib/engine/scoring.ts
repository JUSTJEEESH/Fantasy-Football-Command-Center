import type {
  LineupSlot,
  Position,
  ScoringSettings,
  StatLine,
} from '@/lib/types';

// ============================================================================
// Scoring engine.
//
// Converts a projected stat line into fantasy points under a specific league's
// rules. Entirely data-driven — a league with a bespoke rule ("+1 per catch
// over 5", "-2 per pick six") is expressed in config, never in code here.
// ============================================================================

export const SCORING_ENGINE_VERSION = '1.0.0';

/** Standard (non-PPR) baseline. Every preset below extends this. */
const BASE: Record<string, number> = {
  pass_yds: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_2pt: 2,
  rush_yds: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec_yds: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  receptions: 0,
  fumbles_lost: -2,
  fg_0_39: 3,
  fg_40_49: 4,
  fg_50_plus: 5,
  fg_miss: -1,
  xp_made: 1,
  xp_miss: -1,
  dst_sack: 1,
  dst_int: 2,
  dst_fum_rec: 2,
  dst_td: 6,
  dst_safety: 2,
  dst_block: 2,
};

/**
 * The final bracket uses a large finite number rather than `Infinity` on
 * purpose: scoring settings are serialized to JSON (into the database and into
 * the offline draft pack), and `JSON.stringify(Infinity)` produces `null`,
 * which then fails validation on reload. A silently-discarded draft pack on
 * draft day is not a failure mode worth risking for a nicer-looking constant.
 */
const DST_PA_TIERS = [
  { maxPointsAllowed: 0, points: 10 },
  { maxPointsAllowed: 6, points: 7 },
  { maxPointsAllowed: 13, points: 4 },
  { maxPointsAllowed: 20, points: 1 },
  { maxPointsAllowed: 27, points: 0 },
  { maxPointsAllowed: 34, points: -1 },
  { maxPointsAllowed: 9999, points: -4 },
];

export const SCORING_PRESETS = {
  standard: (): ScoringSettings => ({
    perStat: { ...BASE },
    dstPointsAllowedTiers: DST_PA_TIERS,
  }),
  half_ppr: (): ScoringSettings => ({
    perStat: { ...BASE, receptions: 0.5 },
    dstPointsAllowedTiers: DST_PA_TIERS,
  }),
  ppr: (): ScoringSettings => ({
    perStat: { ...BASE, receptions: 1 },
    dstPointsAllowedTiers: DST_PA_TIERS,
  }),
  /** PPR with a half-point bump for tight ends. */
  te_premium: (): ScoringSettings => ({
    perStat: { ...BASE, receptions: 1 },
    receptionBonusByPosition: { TE: 0.5 },
    dstPointsAllowedTiers: DST_PA_TIERS,
  }),
} as const;

export type ScoringPreset = keyof typeof SCORING_PRESETS;

/**
 * Score a stat line under a league's rules.
 *
 * Unknown stat keys in `perStat` are simply unused; unknown keys in the stat
 * line score zero. Both directions are intentional — a new source can add a
 * stat we don't score yet without breaking, and a league can score a stat no
 * source provides yet without breaking.
 */
export function scoreStatLine(
  stats: StatLine,
  scoring: ScoringSettings,
  position?: Position,
): number {
  let points = 0;

  for (const [key, value] of Object.entries(stats)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (key === 'dst_pts_allowed' || key === 'dst_yds_allowed') continue;
    const rate = scoring.perStat[key];
    if (typeof rate === 'number') points += value * rate;
  }

  // Position-specific reception premium (TE premium, etc.)
  const bonus = position
    ? scoring.receptionBonusByPosition?.[position]
    : undefined;
  if (typeof bonus === 'number' && typeof stats.receptions === 'number') {
    points += stats.receptions * bonus;
  }

  // DST points-allowed brackets: find the tightest bracket that contains the
  // value. Tiers may be given in any order.
  if (typeof stats.dst_pts_allowed === 'number') {
    const tiers = scoring.dstPointsAllowedTiers ?? DST_PA_TIERS;
    const match = [...tiers]
      .sort((a, b) => a.maxPointsAllowed - b.maxPointsAllowed)
      .find((t) => stats.dst_pts_allowed! <= t.maxPointsAllowed);
    if (match) points += match.points;
  }

  return round2(points);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Roster shape helpers
// ---------------------------------------------------------------------------

/** Total starting spots (excludes bench). */
export function startingSlotCount(
  rosterSlots: Partial<Record<LineupSlot, number>>,
): number {
  return Object.entries(rosterSlots)
    .filter(([slot]) => slot !== 'BENCH')
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
}

/**
 * How many players at `position` the league starts on average per team,
 * counting flex slots fractionally across their eligible positions.
 *
 * This is the number that drives replacement level: in a 12-team league with
 * 2 RB + 1 FLEX, RB demand is not 2 — it's 2 plus a share of the flex, and
 * that share is what makes RB scarcer than the raw slot count suggests.
 *
 * Flex share is weighted by how often each eligible position actually fills
 * flex spots in practice rather than split evenly, because an even split
 * badly understates RB/WR demand relative to TE.
 */
const FLEX_FILL_WEIGHTS: Record<Position, number> = {
  RB: 0.45,
  WR: 0.45,
  TE: 0.10,
  QB: 0,
  K: 0,
  DST: 0,
};

const SUPERFLEX_FILL_WEIGHTS: Record<Position, number> = {
  QB: 0.85,   // superflex is nearly always a QB — that is the whole point
  RB: 0.06,
  WR: 0.07,
  TE: 0.02,
  K: 0,
  DST: 0,
};

export function positionalDemandPerTeam(
  rosterSlots: Partial<Record<LineupSlot, number>>,
  position: Position,
): number {
  let demand = rosterSlots[position as LineupSlot] ?? 0;

  const flexLike: Array<[LineupSlot, Record<Position, number>]> = [
    ['FLEX', FLEX_FILL_WEIGHTS],
    ['SUPERFLEX', SUPERFLEX_FILL_WEIGHTS],
    ['WRRB_FLEX', { RB: 0.5, WR: 0.5, TE: 0, QB: 0, K: 0, DST: 0 }],
    ['REC_FLEX', { WR: 0.75, TE: 0.25, RB: 0, QB: 0, K: 0, DST: 0 }],
  ];

  for (const [slot, weights] of flexLike) {
    const count = rosterSlots[slot] ?? 0;
    if (count > 0) demand += count * (weights[position] ?? 0);
  }

  return demand;
}
