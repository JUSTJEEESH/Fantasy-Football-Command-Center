import { z } from 'zod';

// ============================================================================
// Core domain types.
//
// Everything the deterministic engine consumes is defined here and validated
// with Zod at every boundary (external API, CSV, LLM output, localStorage).
// Nothing from outside the process is trusted unparsed.
// ============================================================================

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
export type Position = (typeof POSITIONS)[number];
export const PositionSchema = z.enum(POSITIONS);

/** Lineup slots, including the multi-position ones. */
export const LINEUP_SLOTS = [
  'QB', 'RB', 'WR', 'TE', 'K', 'DST',
  'FLEX',        // RB/WR/TE
  'SUPERFLEX',   // QB/RB/WR/TE
  'WRRB_FLEX',   // RB/WR
  'REC_FLEX',    // WR/TE
  'BENCH',
] as const;
export type LineupSlot = (typeof LINEUP_SLOTS)[number];
export const LineupSlotSchema = z.enum(LINEUP_SLOTS);

/** Which positions may legally fill each slot. */
export const SLOT_ELIGIBILITY: Record<LineupSlot, readonly Position[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DST: ['DST'],
  FLEX: ['RB', 'WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  BENCH: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'],
};

// ---------------------------------------------------------------------------
// Epistemics (PRD §5). Every user-facing claim carries one of these.
// ---------------------------------------------------------------------------

export const CLAIM_KINDS = [
  'FACT',            // verified against a primary source
  'REPORT',          // attributed to a reporter, not independently verified
  'INFERENCE',       // derived by this system
  'RECOMMENDATION',  // an action to take
  'UNCERTAINTY',     // an explicit unknown
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface Claim {
  kind: ClaimKind;
  text: string;
  /** 0..1. Required for INFERENCE and RECOMMENDATION. */
  confidence?: number;
  sources?: SourceRef[];
}

export interface SourceRef {
  name: string;
  url?: string;
  publishedAt?: string;   // ISO
  fetchedAt?: string;     // ISO
  reliability?: number;   // 0..1
}

/** Wraps any value with the provenance needed to render staleness honestly. */
export interface Provenanced<T> {
  value: T;
  source: string;
  /** When the source says this was true. */
  sourceTimestamp?: string;
  /** When we retrieved it. Staleness is measured from here. */
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * A raw stat line. Keys match `StatKey`; anything absent is treated as 0.
 * Projections are stored as stat lines rather than points so a single
 * projection serves every league format.
 */
export const StatLineSchema = z.object({
  pass_att: z.number().optional(),
  pass_cmp: z.number().optional(),
  pass_inc: z.number().optional(),
  pass_yds: z.number().optional(),
  pass_td: z.number().optional(),
  pass_int: z.number().optional(),
  pass_2pt: z.number().optional(),
  pass_300_bonus: z.number().optional(),
  pass_400_bonus: z.number().optional(),
  rush_att: z.number().optional(),
  rush_yds: z.number().optional(),
  rush_td: z.number().optional(),
  rush_2pt: z.number().optional(),
  rush_100_bonus: z.number().optional(),
  targets: z.number().optional(),
  receptions: z.number().optional(),
  rec_yds: z.number().optional(),
  rec_td: z.number().optional(),
  rec_2pt: z.number().optional(),
  rec_100_bonus: z.number().optional(),
  fumbles_lost: z.number().optional(),
  // kicker
  fg_0_39: z.number().optional(),
  fg_40_49: z.number().optional(),
  fg_50_plus: z.number().optional(),
  fg_miss: z.number().optional(),
  xp_made: z.number().optional(),
  xp_miss: z.number().optional(),
  // dst
  dst_sack: z.number().optional(),
  dst_int: z.number().optional(),
  dst_fum_rec: z.number().optional(),
  dst_td: z.number().optional(),
  dst_safety: z.number().optional(),
  dst_block: z.number().optional(),
  dst_pts_allowed: z.number().optional(),
  dst_yds_allowed: z.number().optional(),
});
export type StatLine = z.infer<typeof StatLineSchema>;
export type StatKey = keyof StatLine;

/**
 * Points per unit of each stat, plus position-specific premiums.
 * Fully data-driven: a league with a bespoke rule needs a config change,
 * not a code change (§11).
 */
export const ScoringSettingsSchema = z.object({
  /** points per unit for each stat key */
  perStat: z.record(z.string(), z.number()),
  /**
   * Extra points per reception by position — how TE premium is expressed.
   * e.g. { TE: 0.5 } on top of a 1.0 PPR base. Partial: only the positions
   * that actually get a premium need to appear.
   */
  receptionBonusByPosition: z.partialRecord(PositionSchema, z.number()).optional(),
  /** Thresholds for DST points-allowed brackets, highest first. */
  dstPointsAllowedTiers: z
    .array(z.object({ maxPointsAllowed: z.number(), points: z.number() }))
    .optional(),
});
export type ScoringSettings = z.infer<typeof ScoringSettingsSchema>;

// ---------------------------------------------------------------------------
// League
// ---------------------------------------------------------------------------

export const LeagueSettingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['sleeper', 'espn', 'yahoo', 'nfl', 'manual']).default('manual'),
  season: z.number().int(),
  leagueType: z.enum(['redraft', 'keeper', 'dynasty', 'bestball']).default('redraft'),
  teamCount: z.number().int().min(2).max(32),
  draftType: z.enum(['snake', 'linear', 'auction']).default('snake'),
  /**
   * The user's own draft slot, 1-indexed, or null when the order has not been
   * drawn yet. Null is a real state, not a missing value: leagues that set the
   * order manually often do not announce it until shortly before the draft, and
   * the rest of the configuration is perfectly usable in the meantime.
   */
  draftSlot: z.number().int().min(1).nullable(),
  /**
   * Starting lineup composition. Partial by design — a league that uses no
   * superflex simply omits the key rather than writing a zero.
   * BENCH is specified separately via `benchSize`.
   */
  rosterSlots: z.partialRecord(LineupSlotSchema, z.number().int().min(0)),
  benchSize: z.number().int().min(0).default(6),
  irSlots: z.number().int().min(0).default(1),
  scoring: ScoringSettingsSchema,
  /**
   * Hard roster caps per position, where the league sets them. A player at a
   * capped position cannot legally be drafted, so the engine excludes them
   * entirely rather than merely ranking them low.
   */
  positionLimits: z.partialRecord(PositionSchema, z.number().int().min(0)).optional(),
  /** ADP flavor to prefer when several are available. */
  adpFormat: z.string().default('ppr'),
});
export type League = z.infer<typeof LeagueSettingsSchema>;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerRef {
  id: string;
  name: string;
  position: Position;
  team: string | null;
}

/**
 * The engine's view of a player: everything needed to rank, value, and
 * recommend. Assembled by the repository layer from several tables, or by
 * the CSV importer, or shipped inside an offline draft pack.
 */
export interface PlayerCard extends PlayerRef {
  byeWeek?: number | null;
  age?: number | null;
  yearsExp?: number | null;

  /** Season-long projected fantasy points in THIS league's scoring. */
  projectedPoints?: number;
  floorPoints?: number;
  ceilingPoints?: number;
  gamesProjected?: number;

  /** Consensus average draft position (lower = earlier). */
  adp?: number;
  adpStdev?: number;
  adpSource?: string;
  adpFetchedAt?: string;

  consensusRank?: number;
  positionRank?: number;
  /** Tier within position; 1 = best. */
  tier?: number;

  /** 0..1 — how certain the player's role/workload is. */
  roleCertainty?: number;
  /** 0..1 — probability-weighted injury concern. */
  injuryRisk?: number;
  breakoutProbability?: number;
  bustProbability?: number;

  injuryStatus?: string | null;
  /** Plain-English rendering of the designation, e.g. "on injured reserve". */
  injuryNote?: string;
  /** Composite from news + ADP movement; positive = trending up. */
  trendScore?: number;

  /** Strength of schedule, 0..1 where higher = easier. */
  scheduleEase?: number;
  playoffScheduleEase?: number;

  /** Most recent time any component of this card was refreshed. */
  fetchedAt?: string;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface DraftPick {
  overallPick: number;   // 1-indexed
  round: number;
  pickInRound: number;
  draftSlot: number;     // which team made it
  playerId: string;
  entryMethod: 'manual' | 'voice' | 'sync' | 'simulated';
  at: string;            // ISO
}

export interface DraftState {
  leagueId: string;
  teamCount: number;
  rounds: number;
  draftType: 'snake' | 'linear';
  /** The user's slot. */
  userSlot: number;
  picks: DraftPick[];
  status: 'pending' | 'active' | 'complete';
}

export type PickVerdict = 'TAKE_NOW' | 'CAN_WAIT' | 'REACH' | 'NO_PICK_AVAILABLE';

export interface RecommendationFlavor {
  key:
    | 'best_overall'
    | 'best_fit'
    | 'best_value'
    | 'safest'
    | 'highest_upside'
    | 'contrarian';
  label: string;
  playerId: string | null;
  playerName: string | null;
  score: number;
  rationale: string;
}

export interface DraftRecommendation {
  /** The pick this recommendation is for. */
  overallPick: number;
  round: number;
  take: PlayerRef | null;
  /** 0..1 */
  confidence: number;
  /** Short, human sentences — never a statistics dump. */
  reasons: string[];
  alternatives: PlayerRef[];
  avoid: Array<{ player: PlayerRef; reason: string }>;
  verdict: PickVerdict;
  flavors: RecommendationFlavor[];
  /** Picks until the user's next turn; null if they have no further pick. */
  picksUntilNextTurn: number | null;
  riskFactors: string[];
  engineVersion: string;
  computedAt: string;
  /** Set when the underlying data is older than its freshness threshold. */
  staleness?: string;
}
