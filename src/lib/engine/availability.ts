import type { PlayerCard } from '@/lib/types';

// ============================================================================
// Availability simulation (§17).
//
// Answers "can I wait on him?" with a probability instead of a vibe.
//
// Model: a player's actual draft slot is treated as normally distributed around
// his ADP with standard deviation `adpStdev`. The probability he survives to
// pick N is P(draft position > N). Assumptions are explicit and returned with
// the answer, because a confident-sounding number from a bad model is worse
// than no number.
// ============================================================================

export const AVAILABILITY_ENGINE_VERSION = '1.0.0';

/**
 * Default ADP standard deviation when a source doesn't supply one.
 *
 * Uncertainty grows with ADP — the consensus is tight on the first pick and
 * very loose on the 120th — so this scales rather than being a constant.
 * Calibrated to roughly match observed spread in public ADP data: ~±3 picks
 * early, ~±15 by the double-digit rounds.
 */
export function defaultAdpStdev(adp: number): number {
  return Math.max(2.5, 2.0 + 0.11 * adp);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf approximation). */
export function normalCdf(x: number, mean = 0, stdev = 1): number {
  if (stdev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stdev * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface AvailabilityEstimate {
  playerId: string;
  playerName: string;
  /** 0..1 probability the player is still on the board at `atPick`. */
  probability: number;
  atPick: number;
  adp: number;
  adpStdev: number;
  /** Stated plainly so the user can discount it appropriately. */
  assumptions: string[];
}

/**
 * Probability a player is still available at a future overall pick.
 *
 * `picksAlreadyMade` matters: if a player's ADP is 40 but pick 45 has passed
 * and he's still there, the raw ADP model is already wrong about him, so the
 * estimate is conditioned on his having survived this long.
 */
export function availabilityAtPick(
  player: PlayerCard,
  atPick: number,
  currentPick: number,
): AvailabilityEstimate {
  const adp = player.adp ?? atPick;
  const stdev = player.adpStdev ?? defaultAdpStdev(adp);

  const assumptions = [
    `Draft position modeled as normal around ADP ${adp.toFixed(1)} (σ ${stdev.toFixed(1)}).`,
  ];
  if (player.adp === undefined) {
    assumptions.push('No ADP available for this player — estimate is unreliable.');
  }
  if (player.adpStdev === undefined) {
    assumptions.push('ADP spread not supplied by source; using a scaled default.');
  }

  // P(drafted after `atPick`) = 1 - CDF(atPick)
  let probability = 1 - normalCdf(atPick, adp, stdev);

  // Condition on already having survived to the current pick. Without this the
  // model keeps insisting a faller is "70% gone" while he sits on the board.
  if (currentPick > 1) {
    const survivedSoFar = 1 - normalCdf(currentPick - 1, adp, stdev);
    if (survivedSoFar > 0.01) {
      probability = Math.min(1, probability / survivedSoFar);
      assumptions.push(
        `Conditioned on still being available at pick ${currentPick}.`,
      );
    } else {
      // He is far past his ADP; the prior is uninformative. Say so rather than
      // dividing by a near-zero number and reporting spurious certainty.
      probability = 0.5;
      assumptions.push(
        'Player is well past his ADP; the ADP model no longer discriminates — treat this as a coin flip.',
      );
    }
  }

  return {
    playerId: player.id,
    playerName: player.name,
    probability: Math.round(Math.max(0, Math.min(1, probability)) * 1000) / 1000,
    atPick,
    adp,
    adpStdev: Math.round(stdev * 10) / 10,
    assumptions,
  };
}

export interface WaitAnalysis {
  /** Best guess: can the user pass on this player and still get him? */
  canWait: boolean;
  probability: number;
  nextPick: number | null;
  /** Expected points lost by waiting (probability-weighted). */
  expectedCost: number;
  /** The fallback if the player is gone. */
  fallback: PlayerCard | null;
  reasoning: string;
}

/**
 * Should the user take this player now, or can he be had next turn?
 *
 * Expected cost of waiting = P(gone) x (his value - the best replacement's
 * value at the same position). Waiting is only "safe" when that cost is small
 * in absolute points, not merely when the probability looks comfortable — a
 * 30% chance of losing 40 points is worse than a 60% chance of losing 3.
 */
export function analyzeWait(
  player: PlayerCard,
  samePositionAlternatives: PlayerCard[],
  nextPick: number | null,
  currentPick: number,
  opts: { safeThresholdPoints?: number } = {},
): WaitAnalysis {
  const safeThreshold = opts.safeThresholdPoints ?? 8;

  if (nextPick === null) {
    return {
      canWait: false,
      probability: 0,
      nextPick: null,
      expectedCost: 0,
      fallback: null,
      reasoning: 'This is your last pick — there is no next turn to wait for.',
    };
  }

  const estimate = availabilityAtPick(player, nextPick, currentPick);
  const fallback =
    samePositionAlternatives
      .filter((p) => p.id !== player.id)
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))[0] ?? null;

  const gap =
    (player.projectedPoints ?? 0) - (fallback?.projectedPoints ?? 0);
  const expectedCost = Math.round((1 - estimate.probability) * Math.max(0, gap) * 10) / 10;

  const canWait = expectedCost <= safeThreshold && estimate.probability >= 0.5;

  const pct = Math.round(estimate.probability * 100);
  const reasoning = canWait
    ? `${pct}% chance he's still there at pick ${nextPick}; if he isn't, ${
        fallback ? fallback.name : 'the next option'
      } costs you about ${expectedCost.toFixed(1)} points. Safe to wait.`
    : `Only ${pct}% chance he lasts to pick ${nextPick}, and losing him costs about ${expectedCost.toFixed(
        1,
      )} points against ${fallback ? fallback.name : 'the next option'}. Take him now.`;

  return {
    canWait,
    probability: estimate.probability,
    nextPick,
    expectedCost,
    fallback,
    reasoning,
  };
}

/**
 * Which players are likely to still be there at the user's next pick.
 * Powers "plan my next three picks".
 */
export function likelyAvailableAt(
  available: PlayerCard[],
  atPick: number,
  currentPick: number,
  opts: { minProbability?: number; limit?: number } = {},
): AvailabilityEstimate[] {
  const minProbability = opts.minProbability ?? 0.5;
  const limit = opts.limit ?? 20;

  return available
    .map((p) => availabilityAtPick(p, atPick, currentPick))
    .filter((e) => e.probability >= minProbability)
    .sort((a, b) => {
      const pa = available.find((p) => p.id === a.playerId)?.projectedPoints ?? 0;
      const pb = available.find((p) => p.id === b.playerId)?.projectedPoints ?? 0;
      return pb - pa;
    })
    .slice(0, limit);
}
