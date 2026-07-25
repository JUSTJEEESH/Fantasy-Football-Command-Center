import type { League, PlayerCard, Position } from '@/lib/types';

// ============================================================================
// Deadlines.
//
// On draft night the question is almost never "who is the best player left".
// It is "if I don't take a running back now, what will be left when I pick
// again?" That is a question about deadlines, and the board already contains
// the answer: a tier is a group of players who are roughly interchangeable, so
// the moment that matters is when the LAST of them comes off the board.
//
// Before that pick you have options and can take value elsewhere. After it,
// you are choosing from a visibly worse group. Everything here exists to put a
// pick number on that moment so a glance answers it.
//
// The estimate is ADP, which is an average, not a schedule. A tier can empty
// two rounds early because one manager started a run. So every number below is
// stated as the pick by which a tier is *typically* gone, and the spread is
// carried alongside it rather than hidden.
// ============================================================================

export interface TierRunway {
  position: Position;
  /** 1-indexed planning group; 1 is the elite group at that position. */
  tier: number;
  /** How many players remain in this tier. */
  count: number;
  /** ADP of the first player in the tier — when the tier starts going. */
  firstAdp: number;
  /**
   * ADP of the last player in the tier: the deadline. Past this pick the tier
   * is typically empty.
   */
  lastAdp: number;
  /** The round that deadline falls in. */
  deadlineRound: number;
  /** Best player in the tier, for recognition. */
  headliner: string;
  /** Everyone in the tier, best first — this is the actual shopping list. */
  players: Array<{ name: string; team: string | null; adp: number }>;
}

export interface RunwayReport {
  /** Tier deadlines, soonest first. */
  tiers: TierRunway[];
  /** Caveats that apply to every number here. */
  notes: string[];
}

/**
 * How many planning groups to cut each position into, and how deep to look.
 *
 * These are NOT the engine's tiers. `assignTiers` detects local gaps for the
 * recommendation engine, which is the right tool for "is there a cliff at this
 * exact pick" — on a real board it produced 32 running-back tiers averaging two
 * players each. That is useless as a deadline: a group of two is not something
 * you plan around, it is two players.
 *
 * A cheat sheet needs groups big enough to be a decision. Five per position,
 * cut at the largest gaps in projected points, gives "the elite ones", "the
 * next ones", and so on — which is how drafters already think.
 */
const PLAN_DEPTH: Partial<Record<Position, { pool: number; groups: number }>> = {
  QB: { pool: 24, groups: 4 },
  RB: { pool: 48, groups: 5 },
  WR: { pool: 60, groups: 5 },
  TE: { pool: 24, groups: 4 },
};

/**
 * Cut a position's board into planning groups at its largest point gaps.
 *
 * Returns one array per group, best first. A gap-based cut beats fixed-size
 * buckets because it puts the boundary where the drop actually is, which is
 * the whole reason the boundary matters.
 */
function planningGroups(pool: PlayerCard[], groups: number): PlayerCard[][] {
  const sorted = [...pool].sort(
    (a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0),
  );
  if (sorted.length <= groups) return sorted.map((p) => [p]);

  // Candidate cut points, ranked by how big a drop they represent. Cuts near
  // the very top are excluded: splitting after one player recreates the
  // tier-of-one problem this exists to avoid.
  const gaps: Array<{ index: number; drop: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const drop = (sorted[i - 1]!.projectedPoints ?? 0) - (sorted[i]!.projectedPoints ?? 0);
    gaps.push({ index: i, drop });
  }

  const cuts = gaps
    .filter((g) => g.index >= 2 && g.index <= sorted.length - 2)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, groups - 1)
    .map((g) => g.index)
    .sort((a, b) => a - b);

  const out: PlayerCard[][] = [];
  let start = 0;
  for (const cut of [...cuts, sorted.length]) {
    out.push(sorted.slice(start, cut));
    start = cut;
  }
  return out.filter((g) => g.length > 0);
}

export function buildRunway(
  players: PlayerCard[],
  league: League,
): RunwayReport {
  const teams = league.teamCount;

  // Only players the draft actually reaches. A group that empties at pick 400
  // is not a deadline; it is a rounding error.
  const lastPick = teams * rosterSize(league);
  const draftable = players.filter((p) => p.adp !== undefined && p.adp <= lastPick);

  const tiers: TierRunway[] = [];

  for (const [position, depth] of Object.entries(PLAN_DEPTH) as Array<
    [Position, { pool: number; groups: number }]
  >) {
    const pool = draftable
      .filter((p) => p.position === position)
      .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))
      .slice(0, depth.pool);

    if (pool.length < depth.groups) continue;

    const groups = planningGroups(pool, depth.groups);

    // Drop the residual. Everything below the last cut is not a group with a
    // deadline, it is "the rest" — on a real board that was 52 receivers whose
    // supposed deadline was the final pick of the draft, which tells you
    // nothing and crowds out the deadlines that matter.
    const meaningful = groups.slice(0, -1).filter((g) => g.length >= 2);

    // Renumbered after filtering, so the labels read RB1, RB2, RB3 rather than
    // RB1, RB3, RB5 with silent holes where a one-player group was dropped.
    meaningful.forEach((group, index) => {
      const byAdp = [...group].sort((a, b) => a.adp! - b.adp!);
      const lastAdp = byAdp[byAdp.length - 1]!.adp!;

      tiers.push({
        position,
        tier: index + 1,
        count: group.length,
        firstAdp: byAdp[0]!.adp!,
        lastAdp,
        deadlineRound: Math.max(1, Math.ceil(lastAdp / teams)),
        // Best player by value, not by ADP. They usually agree, and where they
        // do not, the more useful name is the better player.
        headliner: group[0]!.name,
        players: byAdp.map((p) => ({ name: p.name, team: p.team, adp: p.adp! })),
      });
    });
  }

  return {
    tiers: tiers.sort((a, b) => a.lastAdp - b.lastAdp),
    notes: [
      'A deadline is where the LAST player in a group typically goes — before it you have choices, after it you are shopping a visibly worse group.',
      'ADP is an average, not a schedule. One manager starting a run can empty a group two rounds early, so treat these as the middle of a range.',
      'Groups are cut at the biggest drops in projected points under YOUR scoring, so they describe your league rather than a generic board.',
      'Kickers and defenses are left out on purpose: one of each, in the last two rounds, is the whole strategy.',
    ],
  };
}

/**
 * The tiers that empty soonest at positions you still have to fill.
 *
 * This is the draft-night version: given what is already on your roster and
 * where your next pick lands, which deadline is about to pass?
 */
export function urgentDeadlines(
  report: RunwayReport,
  opts: { nextPick: number | null; filled: Partial<Record<Position, number>>; league: League },
): TierRunway[] {
  const { nextPick, filled, league } = opts;
  if (nextPick === null) return [];

  return report.tiers
    .filter((t) => {
      // Already past — nothing to decide.
      if (t.lastAdp < nextPick) return false;
      // A position you have already filled to its starting requirement is not
      // urgent, however thin the tier gets.
      const need = league.rosterSlots[t.position] ?? 0;
      return (filled[t.position] ?? 0) < need + 1;
    })
    // Closest deadline first: those are the decisions being forced now.
    .sort((a, b) => a.lastAdp - b.lastAdp)
    .slice(0, 6);
}

function rosterSize(league: League): number {
  const starters = Object.values(league.rosterSlots).reduce<number>(
    (sum, n) => sum + (n ?? 0),
    0,
  );
  return starters + league.benchSize;
}
