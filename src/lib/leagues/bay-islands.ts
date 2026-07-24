import type { League, Position, ScoringSettings } from '@/lib/types';

// ============================================================================
// BAY ISLANDS FANTASY — the actual league, encoded exactly.
//
// Transcribed from the ESPN league settings page. Several rules differ from the
// common defaults in ways that genuinely change draft strategy, and each is
// called out below rather than silently absorbed.
//
// Draft: Snake, 2026-08-30 @ 4:00 PM CST, 2 minutes per pick.
// Draft order is set manually by the league manager and is not known until the
// pre-draft party on Aug 8 — see `draftSlot: null` at the bottom.
// ============================================================================

/**
 * Scoring. Four differences from a standard PPR preset, all of which move value:
 *
 *  1. **Passing TDs are worth 6, not 4.** Combined with 1 point per 20 passing
 *     yards, quarterbacks score materially more here than in a default league.
 *  2. **Interceptions are -1, not -2**, and fumbles lost are -1, not -2. Volume
 *     passers and high-usage runners are penalized less for mistakes.
 *  3. **A 3-point bonus for a 100-199 yard rushing game.** This rewards
 *     workhorse backs with weekly ceiling, not just season totals.
 *  4. **Kickers have no penalty for a missed field goal**, and 60+ yarders pay
 *     6. Kicker scoring is pure upside — which still does not justify drafting
 *     one early, but it does mean leg strength beats accuracy here.
 */
export const BAY_ISLANDS_SCORING: ScoringSettings = {
  perStat: {
    // Passing — 1 point per 20 yards
    pass_yds: 0.05,
    pass_td: 6,
    pass_int: -1,
    pass_2pt: 2,

    // Rushing — 1 point per 10 yards
    rush_yds: 0.1,
    rush_td: 6,
    rush_2pt: 2,
    // Counted as "number of 100-199 yard rushing games", 3 points each.
    rush_100_bonus: 3,

    // Receiving — full PPR
    rec_yds: 0.1,
    receptions: 1,
    rec_td: 6,
    rec_2pt: 2,

    fumbles_lost: -1,

    // Kicking — distance-tiered, no penalty for misses
    xp_made: 1,
    fg_0_39: 3,
    fg_40_49: 4,
    fg_50_plus: 5,
    // NOTE: the league also pays 6 for a 60+ yard field goal. No projection
    // source separates 50-59 from 60+, so 50+ is scored at 5 and the rare 60+
    // is a small understatement rather than an invented number.

    // Team defense / special teams
    dst_sack: 1,
    dst_int: 2,
    dst_fum_rec: 2,
    dst_td: 6,
    dst_safety: 2,
    dst_block: 2,
  },

  /**
   * ESPN's points-allowed ladder for this league. Two things differ from the
   * common default: a shutout pays 5 rather than 10, and there are no negative
   * brackets — allowing 40 points simply scores zero. That compresses the range
   * between a great defense and a bad one, which is another reason not to spend
   * an early pick on one.
   */
  dstPointsAllowedTiers: [
    { maxPointsAllowed: 0, points: 5 },
    { maxPointsAllowed: 6, points: 4 },
    { maxPointsAllowed: 13, points: 3 },
    { maxPointsAllowed: 17, points: 1 },
    { maxPointsAllowed: 9999, points: 0 },
  ],
};

/**
 * Roster maximums, straight from the settings page.
 *
 * These are hard caps: the engine must never recommend a player at a position
 * that is already full, because that pick could not legally be made.
 */
export const BAY_ISLANDS_POSITION_LIMITS: Partial<Record<Position, number>> = {
  QB: 4,
  RB: 8,
  WR: 8,
  TE: 3,
  DST: 3,
  K: 3,
};

/**
 * THE MOST IMPORTANT LINE IN THIS FILE: `TE` is absent from `rosterSlots`.
 *
 * This league requires **zero** starting tight ends. A TE can only ever reach
 * your lineup through the single FLEX spot, competing against every RB and WR
 * you own. That collapses league-wide TE demand from roughly 12 starters to
 * barely one or two, which means:
 *
 *   - replacement level at TE is somewhere around TE2, so almost every tight
 *     end in the pool has negative value over replacement;
 *   - drafting a TE is only correct if he would genuinely out-score the RB or
 *     WR you would otherwise flex — for all but the very best, he will not;
 *   - the tight ends other managers reach for in the middle rounds are, in this
 *     format specifically, close to dead roster spots.
 *
 * The engine derives all of this on its own from the slot configuration. It is
 * spelled out here because it is the single biggest strategic difference
 * between this league and a normal one, and it is easy to draft on autopilot.
 */
export const BAY_ISLANDS: League = {
  id: 'bay-islands-2026',
  name: 'Bay Islands Fantasy',
  platform: 'espn',
  season: 2026,
  leagueType: 'redraft',      // keepers explicitly off for 2026 and 2027
  teamCount: 12,
  draftType: 'snake',

  // Unknown until the pre-draft party on Aug 8. Set it in Settings the moment
  // the order is drawn; everything else is already configured.
  draftSlot: null,

  rosterSlots: {
    QB: 1,
    RB: 2,
    WR: 2,
    FLEX: 1,      // RB / WR / TE
    K: 1,
    DST: 1,
    // TE: deliberately omitted — this league starts zero tight ends.
  },
  benchSize: 7,   // 15 total roster spots - 8 starters
  irSlots: 1,

  scoring: BAY_ISLANDS_SCORING,
  positionLimits: BAY_ISLANDS_POSITION_LIMITS,
  adpFormat: 'ppr',
};

/** Roster size 15 → 15 rounds. */
export const BAY_ISLANDS_ROUNDS = 15;

/** 2026-08-30 4:00 PM CST (UTC-6). */
export const BAY_ISLANDS_DRAFT_TIME = '2026-08-30T22:00:00Z';

/**
 * Rules that do not affect draft-day recommendations but are recorded so the
 * in-season features have them when they are built.
 */
export const BAY_ISLANDS_SEASON_RULES = {
  waiverType: 'reverse_standings' as const,
  waiverPeriodDays: 1,
  tradeDeadline: '2026-12-02T17:00:00Z',
  tradeReviewDays: 1,
  vetoVotesRequired: 5,
  regularSeasonMatchups: 14,
  playoffTeams: 6,
  playoffSeedingTiebreaker: 'total_points_for' as const,
  lineupLock: 'individual_gametime' as const,
  observesUndroppableList: true,
  timePerPickSeconds: 120,
};
