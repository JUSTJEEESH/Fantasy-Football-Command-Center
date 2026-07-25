import { z } from 'zod';
import { POSITIONS, type Position, type StatLine } from '@/lib/types';
import { guardedFetch, type FetchResult, type SourceDescriptor } from './types';

// ============================================================================
// ESPN Fantasy adapter — draft rankings, ADP, projections, bye weeks.
//
// WHY THIS SOURCE
// ---------------
// The league this app is built for ("Bay Islands Fantasy") is hosted on ESPN,
// and ESPN's own draft board is what the other eleven managers will be looking
// at on August 30. Ranking against a different platform's consensus would
// mean modelling a draft that isn't the one being played.
//
// It is also the only free source that carries all three of the numbers the
// engine actually needs: average draft position, positional draft ranks, and
// season-long projected STAT LINES (not just points).
//
// HONESTY ABOUT WHAT THIS IS
// --------------------------
// This is a public, unauthenticated, read-only JSON endpoint. It is NOT a
// documented public API — ESPN publishes no contract for it and may change or
// withdraw it without notice. That is stated in the descriptor below and
// surfaced in the UI, because a source that can vanish is a different kind of
// dependency than one that can't.
//
// What this adapter does NOT do:
//   - It does not scrape HTML. It reads a JSON endpoint the site itself calls.
//   - It does not authenticate, impersonate a browser, or touch private league
//     data. Everything below is the public league-default view.
//   - It does not poll. Exactly two requests per build, and builds run every
//     three hours.
//
// THE STAT MAPPING PROBLEM
// ------------------------
// ESPN returns projections as a map of numeric stat IDs to values:
//   { "3": 4180.2, "4": 31.5, "24": 355.0, ... }
// The meaning of those IDs is not documented anywhere official. Community
// mappings exist and are widely used, but "widely used" is not "verified", and
// a wrong mapping would silently produce confident, specific, wrong
// projections — exactly the failure this project refuses to ship.
//
// So the mapping is not trusted. It is TESTED, on every single build, against
// evidence ESPN itself provides: each stat row carries `appliedTotal`, the
// fantasy point total ESPN computed from those same raw stats under its own
// PPR rules. Applying the ESPN PPR rulebook to the mapping must reproduce
// `appliedTotal`. If it doesn't, the mapping is wrong, and projections are
// dropped rather than published. See `verifyStatMapping` below.
// ============================================================================

const READ_HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

/** League default id 3 is ESPN's PPR preset — the same scoring family this
 *  league uses for receptions, which keeps `appliedTotal` interpretable. */
const PPR_LEAGUE_DEFAULT = 3;

export const ESPN_DESCRIPTOR: SourceDescriptor = {
  key: 'espn_fantasy',
  name: 'ESPN Fantasy',
  type: 'api',
  reliability: 0.9,
  updateFrequencyMin: 180,
  limitations:
    'Undocumented endpoint with no published contract — ESPN may change or ' +
    'remove it without notice. ADP reflects ESPN drafts only, not a ' +
    'cross-platform consensus. Projections are ESPN\'s own model and are ' +
    'republished here re-scored into this league\'s rules, never as fact.',
  requiresCredential: false,
  termsNote:
    'Public unauthenticated read-only JSON endpoint serving league-default ' +
    '(not private league) data. No HTML scraping, no authentication, no ' +
    'private data. Two requests per build, builds run every three hours.',
};

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** ESPN's position ids. Anything not listed is a non-fantasy position. */
const POSITION_BY_ID: Record<number, Position> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'DST',
};

const StatRowSchema = z.object({
  seasonId: z.number().nullish(),
  /** 0 = actual production, 1 = projection. */
  statSourceId: z.number().nullish(),
  /** 0 = season total, 1 = single scoring period. */
  statSplitTypeId: z.number().nullish(),
  appliedTotal: z.number().nullish(),
  stats: z.record(z.string(), z.number()).nullish(),
});

const EspnPlayerSchema = z.object({
  id: z.number(),
  fullName: z.string().nullish(),
  defaultPositionId: z.number().nullish(),
  proTeamId: z.number().nullish(),
  injuryStatus: z.string().nullish(),
  ownership: z
    .object({
      averageDraftPosition: z.number().nullish(),
      percentOwned: z.number().nullish(),
    })
    .nullish(),
  draftRanksByRankType: z
    .record(z.string(), z.object({ rank: z.number().nullish() }))
    .nullish(),
  stats: z.array(StatRowSchema).nullish(),
});

/** The envelope is validated loosely on purpose: one malformed player row
 *  should cost that row, not the entire draft board. Each entry is validated
 *  individually in `buildRows`. */
const PlayerListSchema = z.object({
  players: z.array(z.unknown()).nullish(),
});

const ProTeamsSchema = z.object({
  settings: z
    .object({
      proTeams: z
        .array(
          z.object({
            id: z.number(),
            abbrev: z.string().nullish(),
            byeWeek: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

// ---------------------------------------------------------------------------
// The stat mapping, and the proof that it is right
// ---------------------------------------------------------------------------

/**
 * ESPN stat id → the engine's own stat key. Treated as a hypothesis, not as
 * knowledge: `verifyStatMapping` has to confirm it before anything derived
 * from it is published.
 */
export const ESPN_STAT_IDS: Record<string, keyof StatLine> = {
  '0': 'pass_att',
  '1': 'pass_cmp',
  '3': 'pass_yds',
  '4': 'pass_td',
  '20': 'pass_int',
  '23': 'rush_att',
  '24': 'rush_yds',
  '25': 'rush_td',
  '58': 'targets',
  '53': 'receptions',
  '42': 'rec_yds',
  '43': 'rec_td',
  '72': 'fumbles_lost',
};

/**
 * ESPN's own PPR rulebook, used ONLY to check the mapping against
 * `appliedTotal`. This is deliberately not the league's scoring — the point is
 * to reproduce ESPN's arithmetic, not to compute anything the app will show.
 */
const ESPN_PPR_WEIGHTS: Partial<Record<keyof StatLine, number>> = {
  pass_yds: 0.04,
  pass_td: 4,
  pass_int: -2,
  rush_yds: 0.1,
  rush_td: 6,
  receptions: 1,
  rec_yds: 0.1,
  rec_td: 6,
  fumbles_lost: -2,
};

/** Only these positions score through the stat ids this adapter maps. */
export const MAPPED_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE'];

export interface MappingVerdict {
  ok: boolean;
  /** How many player rows the check could be run against. */
  sampleSize: number;
  /** Share of the sample whose reconstruction landed within tolerance. */
  agreement: number;
  /** Median absolute difference, in fantasy points, across the sample. */
  medianError: number;
  /**
   * Per-position agreement. When the mapping breaks, it almost never breaks
   * uniformly — a renumbered reception id wrecks WR and RB while leaving QB
   * intact. Reporting the split turns "something is wrong" into "this is what
   * is wrong", which is the difference between a fixable build and a mystery.
   */
  byPosition: Array<{ position: Position; sampleSize: number; agreement: number }>;
  reason?: string;
}

/**
 * Rebuild ESPN's `appliedTotal` from the raw stat map using ESPN_STAT_IDS and
 * ESPN's PPR weights. If the mapping is correct, the two agree to within
 * rounding on essentially every row. If an id has been misassigned — receptions
 * read from the wrong key, say — the totals diverge immediately and loudly.
 *
 * A skipped or half-matched mapping cannot pass this: leaving out a scoring
 * stat leaves its whole contribution missing from the reconstruction.
 *
 * The sample is restricted to the positions the mapping actually covers.
 * Kickers and defenses score through an entirely separate family of stat ids
 * that this adapter does not map and could not use — field goals by distance,
 * sacks, points allowed. Their rows reconstruct to roughly zero against a real
 * total, which is not evidence about the mapping under test; including them
 * just buries the signal. (The first live run failed at 81% agreement with a
 * median error of 0.6 points — a mapping that is plainly correct, outvoted by
 * the ~16% of the board that is kickers and defenses.) They are excluded from
 * the proof AND from the published projections, since an unscoreable
 * projection is no projection at all.
 */
export function verifyStatMapping(
  rows: Array<{ stats: Record<string, number>; appliedTotal: number; position?: Position }>,
): MappingVerdict {
  // Rows with no scoring production carry no information about the mapping —
  // 0 reconstructs to 0 under any mapping at all.
  const usable = rows.filter(
    (r) =>
      Math.abs(r.appliedTotal) > 20 &&
      (r.position === undefined || MAPPED_POSITIONS.includes(r.position)),
  );
  if (usable.length < 25) {
    return {
      ok: false,
      sampleSize: usable.length,
      agreement: 0,
      medianError: Number.NaN,
      byPosition: [],
      reason:
        `Only ${usable.length} scoring rows available; too few to confirm the ` +
        'stat mapping. Projections withheld.',
    };
  }

  const errors: number[] = [];
  const perPosition = new Map<Position, { n: number; agreed: number }>();
  let agreed = 0;
  for (const row of usable) {
    let total = 0;
    for (const [id, value] of Object.entries(row.stats)) {
      const key = ESPN_STAT_IDS[id];
      if (!key) continue;
      total += (ESPN_PPR_WEIGHTS[key] ?? 0) * value;
    }
    const error = Math.abs(total - row.appliedTotal);
    errors.push(error);
    // 2% of the total, floored at 2 points, absorbs ESPN's rounding and any
    // fringe scoring category (return TDs, 2-pointers) without absorbing a
    // genuinely misassigned stat id, which shifts totals by far more.
    const within = error <= Math.max(2, Math.abs(row.appliedTotal) * 0.02);
    if (within) agreed++;

    if (row.position) {
      const bucket = perPosition.get(row.position) ?? { n: 0, agreed: 0 };
      bucket.n++;
      if (within) bucket.agreed++;
      perPosition.set(row.position, bucket);
    }
  }

  errors.sort((a, b) => a - b);
  const medianError = errors[Math.floor(errors.length / 2)] ?? Number.NaN;
  const agreement = agreed / usable.length;
  const byPosition = [...perPosition.entries()]
    .map(([position, b]) => ({ position, sampleSize: b.n, agreement: b.agreed / b.n }))
    .sort((a, b) => a.position.localeCompare(b.position));

  return {
    ok: agreement >= 0.9,
    sampleSize: usable.length,
    agreement,
    medianError,
    byPosition,
    reason:
      agreement >= 0.9
        ? undefined
        : `Reconstructed ESPN's own point totals for only ${(agreement * 100).toFixed(0)}% ` +
          `of ${usable.length} scoring players at ${MAPPED_POSITIONS.join('/')} ` +
          `(median error ${medianError.toFixed(1)} pts; by position ` +
          byPosition
            .map((b) => `${b.position} ${(b.agreement * 100).toFixed(0)}%`)
            .join(', ') +
          '). The stat-id mapping no longer matches what ESPN is sending, so ' +
          'projections were dropped rather than published wrong.',
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface EspnPlayerRow {
  espnId: number;
  name: string;
  position: Position;
  /** ESPN pro-team abbreviation, or null for free agents. */
  team: string | null;
  /** Average draft position across ESPN leagues. Lower drafts earlier. */
  adp?: number;
  /** Percent of ESPN leagues in which the player is rostered. */
  percentOwned?: number;
  /** ESPN's PPR draft rank. */
  draftRank?: number;
  injuryStatus?: string | null;
  /**
   * Season projection as a raw stat line, ready to be scored under any
   * league's rules. Absent whenever the mapping check failed.
   */
  projectedStats?: StatLine;
}

export interface EspnByeWeeks {
  /** Team abbreviation → bye week. */
  byTeam: Record<string, number>;
  /** ESPN pro-team id → abbreviation, needed to resolve player teams. */
  abbrevById: Record<number, string>;
}

// ---------------------------------------------------------------------------

export class EspnProvider {
  readonly descriptor = ESPN_DESCRIPTOR;

  /**
   * Team abbreviations and bye weeks in one request. Both come from the same
   * pro-team settings block, so fetching them together avoids a second call
   * and guarantees they agree with each other.
   */
  async fetchProTeams(season: number): Promise<FetchResult<EspnByeWeeks>> {
    const fetchedAt = new Date().toISOString();
    const url = `${READ_HOST}/seasons/${season}?view=proTeamSchedules_wl`;
    const res = await guardedFetch(url, { sourceKey: this.descriptor.key, timeoutMs: 30_000 });
    if (!res.ok) return { ok: false, fetchedAt, error: res.error, items: [], warnings: [] };

    let parsed: z.infer<typeof ProTeamsSchema>;
    try {
      parsed = ProTeamsSchema.parse(JSON.parse(res.body));
    } catch (err) {
      return {
        ok: false,
        fetchedAt,
        error: `ESPN pro-team payload did not match the expected shape: ${String(err)}`,
        items: [],
        warnings: [],
      };
    }

    const teams = parsed.settings?.proTeams ?? [];
    const byTeam: Record<string, number> = {};
    const abbrevById: Record<number, string> = {};
    for (const team of teams) {
      if (!team.abbrev) continue;
      const abbrev = normalizeTeam(team.abbrev);
      abbrevById[team.id] = abbrev;
      // Bye week 0 means "no bye recorded yet" — the schedule is published in
      // May, so an early-offseason build legitimately has none. Recording a 0
      // would look like a real week-zero bye, so it is left absent instead.
      if (team.byeWeek && team.byeWeek > 0) byTeam[abbrev] = team.byeWeek;
    }

    if (Object.keys(abbrevById).length === 0) {
      return {
        ok: false,
        fetchedAt,
        error: 'ESPN returned no pro teams — the response shape has changed.',
        items: [],
        warnings: [],
      };
    }

    return { ok: true, fetchedAt, items: [{ byTeam, abbrevById }], warnings: [] };
  }

  /**
   * The draft board: ADP, draft ranks, and season projections for the top
   * `limit` players by ESPN's own PPR draft ranking.
   */
  async fetchDraftBoard(
    season: number,
    opts: { limit?: number; abbrevById?: Record<number, string> } = {},
  ): Promise<FetchResult<EspnPlayerRow> & { mapping?: MappingVerdict }> {
    const fetchedAt = new Date().toISOString();
    const limit = opts.limit ?? 700;

    // ESPN takes the query as a JSON header rather than query params. Sorting
    // by PPR draft rank means the `limit` cut keeps the players who actually
    // get drafted instead of an arbitrary slice of the league's ~2000 players.
    const filter = {
      players: {
        limit,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' },
      },
    };

    const url = `${READ_HOST}/seasons/${season}/segments/0/leaguedefaults/${PPR_LEAGUE_DEFAULT}?view=kona_player_info`;
    const res = await guardedFetch(url, {
      sourceKey: this.descriptor.key,
      timeoutMs: 60_000,
      headers: { 'x-fantasy-filter': JSON.stringify(filter) },
    });
    if (!res.ok) return { ok: false, fetchedAt, error: res.error, items: [], warnings: [] };

    let parsed: z.infer<typeof PlayerListSchema>;
    try {
      parsed = PlayerListSchema.parse(JSON.parse(res.body));
    } catch (err) {
      return {
        ok: false,
        fetchedAt,
        error: `ESPN player payload did not match the expected shape: ${String(err)}`,
        items: [],
        warnings: [],
      };
    }

    const entries = parsed.players ?? [];
    if (entries.length === 0) {
      return {
        ok: false,
        fetchedAt,
        error: 'ESPN returned an empty player list.',
        items: [],
        warnings: [],
      };
    }

    return buildRows(entries, { season, fetchedAt, abbrevById: opts.abbrevById ?? {} });
  }
}

// ---------------------------------------------------------------------------
// Row assembly, shared with the tests so the fixture path exercises the real
// code rather than a parallel implementation of it.
// ---------------------------------------------------------------------------

export function buildRows(
  entries: unknown[],
  ctx: { season: number; fetchedAt: string; abbrevById: Record<number, string> },
): FetchResult<EspnPlayerRow> & { mapping?: MappingVerdict } {
  const warnings: string[] = [];

  // Validate each entry on its own so a single unexpected row is a skipped
  // player rather than a failed build.
  const parsed: Array<z.infer<typeof EspnPlayerSchema>> = [];
  let malformed = 0;
  for (const entry of entries) {
    const wrapper = z.object({ player: EspnPlayerSchema.nullish() }).safeParse(entry);
    if (!wrapper.success || !wrapper.data.player) {
      malformed++;
      continue;
    }
    parsed.push(wrapper.data.player);
  }
  if (malformed > 0) {
    warnings.push(`${malformed} ESPN player rows did not match the expected shape and were skipped.`);
  }

  // Pass one: collect every projection row, so the mapping can be judged on
  // the whole population before any of it is trusted.
  const proofRows: Array<{
    stats: Record<string, number>;
    appliedTotal: number;
    position?: Position;
  }> = [];
  for (const player of parsed) {
    const projection = seasonProjection(player, ctx.season);
    if (projection?.stats && projection.appliedTotal != null) {
      proofRows.push({
        stats: projection.stats,
        appliedTotal: projection.appliedTotal,
        position: POSITION_BY_ID[player.defaultPositionId ?? -1],
      });
    }
  }
  const mapping = verifyStatMapping(proofRows);

  // Pass two: build the rows, attaching projections only if the mapping held.
  const items: EspnPlayerRow[] = [];
  for (const player of parsed) {
    if (!player.fullName) continue;

    const position = POSITION_BY_ID[player.defaultPositionId ?? -1];
    if (!position || !POSITIONS.includes(position)) continue;

    const teamId = player.proTeamId ?? 0;
    const team = teamId > 0 ? (ctx.abbrevById[teamId] ?? null) : null;

    const row: EspnPlayerRow = {
      espnId: player.id,
      name: player.fullName,
      position,
      team,
      injuryStatus: player.injuryStatus ?? null,
    };

    const adp = player.ownership?.averageDraftPosition;
    // ESPN reports undrafted players as ADP 0, which would sort them first —
    // the exact opposite of what the number means. Treated as absent.
    if (adp != null && adp > 0) row.adp = adp;

    const owned = player.ownership?.percentOwned;
    if (owned != null && owned >= 0) row.percentOwned = owned;

    const rank = player.draftRanksByRankType?.PPR?.rank;
    if (rank != null && rank > 0) row.draftRank = rank;

    // Kickers and defenses are deliberately left without projections: their
    // scoring runs through stat ids this adapter does not map, so anything
    // produced for them would be a fabrication wearing a projection's clothes.
    if (mapping.ok && MAPPED_POSITIONS.includes(position)) {
      const projection = seasonProjection(player, ctx.season);
      if (projection?.stats) {
        const line = toStatLine(projection.stats);
        if (line) row.projectedStats = line;
      }
    }

    items.push(row);
  }

  if (!mapping.ok && mapping.reason) warnings.push(mapping.reason);

  return { ok: true, fetchedAt: ctx.fetchedAt, items, mapping, warnings };
}

/** The season-long projection row, as opposed to actuals or weekly splits. */
function seasonProjection(
  player: z.infer<typeof EspnPlayerSchema> | null | undefined,
  season: number,
): z.infer<typeof StatRowSchema> | undefined {
  return (player?.stats ?? []).find(
    (s) =>
      s.statSourceId === 1 &&      // projected, not actual
      s.statSplitTypeId === 0 &&   // full season, not a single week
      (s.seasonId == null || s.seasonId === season),
  );
}

/** Translate the verified id map into a StatLine, dropping unknown ids. */
function toStatLine(stats: Record<string, number>): StatLine | null {
  const line: Record<string, number> = {};
  for (const [id, value] of Object.entries(stats)) {
    const key = ESPN_STAT_IDS[id];
    if (!key || !Number.isFinite(value)) continue;
    line[key] = value;
  }
  return Object.keys(line).length > 0 ? (line as StatLine) : null;
}

/** ESPN uses a few abbreviations that differ from every other source. */
const TEAM_ALIASES: Record<string, string> = {
  WSH: 'WAS',
  JAX: 'JAX',
  LAR: 'LAR',
  LV: 'LV',
};

export function normalizeTeam(abbrev: string): string {
  const upper = abbrev.toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}
