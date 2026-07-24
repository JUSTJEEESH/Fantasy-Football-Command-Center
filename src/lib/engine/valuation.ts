import type { League, PlayerCard, Position } from '@/lib/types';
import { POSITIONS } from '@/lib/types';
import { positionalDemandPerTeam, round2 } from './scoring';

// ============================================================================
// Valuation: replacement level, value over replacement, tiers, scarcity.
//
// This is the module that knows "best player available" and "best pick for my
// roster right now" are different questions (§10). Everything here is a pure
// function of the player pool — no I/O, no clock, no randomness.
// ============================================================================

export const VALUATION_ENGINE_VERSION = '1.0.0';

export interface ReplacementLevels {
  /** Projected points of the replacement-level player at each position. */
  points: Record<Position, number>;
  /** Index into the position pool used as the baseline. */
  index: Record<Position, number>;
}

/**
 * Replacement level = the projected points of the last starter-quality player
 * at a position, given league size and lineup requirements.
 *
 * In a 12-team league starting 2 RB + 1 FLEX, roughly 12 * 2.45 ≈ 29 RBs are
 * startable, so RB30 is the baseline: drafting RB5 is worth what he scores
 * *above RB30*, not what he scores outright. This is what stops the engine
 * from over-drafting quarterbacks, who have a very high absolute floor and a
 * very high replacement level.
 *
 * `startersOnly=false` extends the baseline past pure starters to account for
 * the bench depth teams actually carry at a position.
 */
export function computeReplacementLevels(
  players: PlayerCard[],
  league: League,
  opts: { benchWeight?: number } = {},
): ReplacementLevels {
  const benchWeight = opts.benchWeight ?? 0.5;
  const points = {} as Record<Position, number>;
  const index = {} as Record<Position, number>;

  for (const position of POSITIONS) {
    const pool = players
      .filter((p) => p.position === position)
      .map((p) => p.projectedPoints ?? 0)
      .sort((a, b) => b - a);

    const demand = positionalDemandPerTeam(league.rosterSlots, position);

    // Teams also stash backups at positions they start several of; that extra
    // demand pushes the baseline deeper. K/DST get no bench allowance because
    // nobody carries a backup kicker.
    const benchAllowance =
      position === 'K' || position === 'DST'
        ? 0
        : benchWeight * Math.min(demand, league.benchSize / 4);

    const baselineIndex = Math.max(
      0,
      Math.round(league.teamCount * (demand + benchAllowance)) - 1,
    );

    index[position] = baselineIndex;
    points[position] =
      pool.length === 0
        ? 0
        : (pool[Math.min(baselineIndex, pool.length - 1)] ?? 0);
  }

  return { points, index };
}

/** Value over replacement, in projected fantasy points. */
export function valueOverReplacement(
  player: PlayerCard,
  replacement: ReplacementLevels,
): number {
  const proj = player.projectedPoints ?? 0;
  return round2(proj - (replacement.points[player.position] ?? 0));
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * Group a position's players into tiers by finding natural gaps in projected
 * points.
 *
 * Tiers matter more than ranks during a draft: the difference between RB4 and
 * RB5 is usually noise, but the difference between the last player in a tier
 * and the first player in the next one is the entire reason to take somebody
 * now instead of waiting a round.
 *
 * A gap starts a new tier when it is unusually large *for that part of the
 * curve*. Comparing against the position-wide mean does not work: projections
 * fall steeply at the top and flatten out in the tail, so a global threshold
 * declares every elite player his own tier while lumping the entire tail
 * together. The baseline is therefore a local median of neighbouring gaps.
 */
export function assignTiers(
  players: PlayerCard[],
  opts: {
    gapMultiplier?: number;
    minGapPoints?: number;
    maxPerTier?: number;
    windowSize?: number;
  } = {},
): Map<string, number> {
  const gapMultiplier = opts.gapMultiplier ?? 2.0;
  const minGapPoints = opts.minGapPoints ?? 3;
  const maxPerTier = opts.maxPerTier ?? 8;
  const windowSize = opts.windowSize ?? 8;
  const result = new Map<string, number>();

  for (const position of POSITIONS) {
    const pool = players
      .filter((p) => p.position === position && p.projectedPoints !== undefined)
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0));

    if (pool.length === 0) continue;
    if (pool.length === 1) {
      result.set(pool[0]!.id, 1);
      continue;
    }

    const gaps: number[] = [];
    for (let i = 1; i < pool.length; i++) {
      gaps.push((pool[i - 1]!.projectedPoints ?? 0) - (pool[i]!.projectedPoints ?? 0));
    }

    let tier = 1;
    let sizeInTier = 1;
    result.set(pool[0]!.id, tier);

    for (let i = 1; i < pool.length; i++) {
      const gap = gaps[i - 1] ?? 0;
      const local = median(
        gaps.slice(
          Math.max(0, i - 1 - windowSize),
          Math.min(gaps.length, i - 1 + windowSize + 1),
        ),
      );
      const threshold = Math.max(local * gapMultiplier, minGapPoints);

      if (gap >= threshold || sizeInTier >= maxPerTier) {
        tier++;
        sizeInTier = 0;
      }
      result.set(pool[i]!.id, tier);
      sizeInTier++;
    }
  }

  return result;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

// ---------------------------------------------------------------------------
// Scarcity
// ---------------------------------------------------------------------------

export interface PositionScarcity {
  position: Position;
  /** Available players remaining at this position. */
  remaining: number;
  /** Available players remaining in the best still-available tier. */
  remainingInTopTier: number;
  /** The best tier still on the board (lower = better). */
  topTier: number | null;
  /**
   * Points lost by waiting: best available minus the best available after the
   * current tier is exhausted. This is the cost of the cliff.
   */
  tierDropoff: number;
  /**
   * 0..1 urgency. High when few players remain in the top tier relative to how
   * many picks happen before the user's next turn.
   */
  urgency: number;
  /** Best available projected points at this position. */
  bestAvailablePoints: number;
  /** Value over replacement of the best available. */
  bestAvailableVOR: number;
}

export function computeScarcity(
  available: PlayerCard[],
  replacement: ReplacementLevels,
  picksUntilNextTurn: number | null,
  positionalDemandRate: Partial<Record<Position, number>> = {},
): Record<Position, PositionScarcity> {
  const out = {} as Record<Position, PositionScarcity>;

  for (const position of POSITIONS) {
    const pool = available
      .filter((p) => p.position === position)
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0));

    const topTier = pool.length > 0 ? (pool[0]!.tier ?? null) : null;
    const inTopTier =
      topTier === null ? 0 : pool.filter((p) => (p.tier ?? null) === topTier).length;

    const bestPoints = pool[0]?.projectedPoints ?? 0;
    const nextTierBest =
      topTier === null
        ? 0
        : (pool.find((p) => (p.tier ?? Infinity) > topTier)?.projectedPoints ?? 0);
    const tierDropoff = round2(Math.max(0, bestPoints - nextTierBest));

    // Probability the whole top tier is gone before the user's next turn.
    //
    // Modeled as P(Binomial(picksUntilNextTurn, rate) >= remainingInTopTier):
    // each intervening pick independently takes a player at this position with
    // probability `rate`. This stays sensitive all the way down — the
    // difference between "4 left in the tier" and "1 left in the tier" is the
    // difference between comfort and panic, and a saturating ratio would
    // report both as maximum urgency.
    const rate = positionalDemandRate[position] ?? DEFAULT_PICK_SHARE[position];
    const exhaustionRisk =
      inTopTier === 0
        ? 0
        : binomialTailProbability(picksUntilNextTurn ?? 0, rate, inTopTier);

    // Urgency is the product of "will it be gone?" and "would that cost me
    // anything?". Both must be true. A tier that empties out but is followed
    // by an equally good player is not urgent at any probability, so there is
    // deliberately no floor here.
    const cliffWeight = tierDropoff <= 0 ? 0 : Math.min(1, tierDropoff / 20);
    const urgency = round2(Math.min(1, exhaustionRisk * cliffWeight));

    out[position] = {
      position,
      remaining: pool.length,
      remainingInTopTier: inTopTier,
      topTier,
      tierDropoff,
      urgency,
      bestAvailablePoints: round2(bestPoints),
      bestAvailableVOR: pool[0]
        ? valueOverReplacement(pool[0], replacement)
        : 0,
    };
  }

  return out;
}

/**
 * P(X >= k) where X ~ Binomial(n, p). Computed by summing the lower tail, which
 * is numerically stable for the small n (< 60 picks) this engine ever sees.
 */
export function binomialTailProbability(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (n <= 0 || p <= 0) return 0;
  if (k > n) return 0;
  if (p >= 1) return 1;

  let term = Math.pow(1 - p, n);   // P(X = 0)
  let cumulative = term;
  for (let i = 1; i < k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    cumulative += term;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
}

/**
 * Fallback share of picks that go to each position across a typical redraft.
 * Used only when no live draft history is available yet (i.e. the first few
 * picks); replaced by observed rates as soon as there is data.
 */
export const DEFAULT_PICK_SHARE: Record<Position, number> = {
  RB: 0.34,
  WR: 0.36,
  TE: 0.11,
  QB: 0.13,
  K: 0.03,
  DST: 0.03,
};
