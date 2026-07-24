import { z } from 'zod';
import { POSITIONS, type Position } from '@/lib/types';
import {
  guardedFetch,
  type DraftPickSummary,
  type FetchResult,
  type LeagueProvider,
  type LeagueSummary,
  type PlayerDataProvider,
  type RawPlayer,
  type RosterSummary,
  type SourceDescriptor,
} from './types';

// ============================================================================
// Sleeper adapter.
//
// Sleeper publishes a read-only REST API with no key and no authentication.
// It is the single best free source available for this project: it provides
// the full NFL player master list, league settings, rosters, and — critically
// for draft night — live draft picks.
//
// Terms: the API is public and Sleeper documents it for third-party use, asking
// only that clients stay under ~1000 requests/minute and cache the (very large)
// player list rather than re-fetching it. Both are respected below.
//
// It does NOT provide ADP, projections, or rankings. That gap is filled by the
// CSV importer, not by inventing numbers.
// ============================================================================

const BASE = 'https://api.sleeper.app/v1';

export const SLEEPER_DESCRIPTOR: SourceDescriptor = {
  key: 'sleeper',
  name: 'Sleeper',
  type: 'api',
  reliability: 0.95,
  updateFrequencyMin: 60,
  limitations:
    'No ADP, projections, or expert rankings. Player list is ~5MB and must be ' +
    'cached (fetch at most once per day). Undocumented response fields may change.',
  requiresCredential: false,
  termsNote:
    'Public read-only API, published for third-party client use. Rate limit ' +
    'guidance (<1000 req/min) and player-list caching guidance are respected.',
};

// ---------------------------------------------------------------------------
// Schemas — Sleeper's payloads are loose, so everything optional is optional.
// ---------------------------------------------------------------------------

const SleeperPlayerSchema = z.object({
  player_id: z.string(),
  full_name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  position: z.string().nullish(),
  fantasy_positions: z.array(z.string()).nullish(),
  team: z.string().nullish(),
  number: z.number().nullish(),
  age: z.number().nullish(),
  birth_date: z.string().nullish(),
  height: z.string().nullish(),      // "72" or "6'0\""
  weight: z.string().nullish(),
  college: z.string().nullish(),
  years_exp: z.number().nullish(),
  status: z.string().nullish(),
  injury_status: z.string().nullish(),
  depth_chart_order: z.number().nullish(),
  search_rank: z.number().nullish(),
});

const SleeperLeagueSchema = z.object({
  league_id: z.string(),
  name: z.string(),
  season: z.string(),
  total_rosters: z.number(),
  scoring_settings: z.record(z.string(), z.number()).nullish(),
  roster_positions: z.array(z.string()).nullish(),
  draft_id: z.string().nullish(),
});

const SleeperRosterSchema = z.object({
  roster_id: z.number(),
  owner_id: z.string().nullish(),
  players: z.array(z.string()).nullish(),
});

const SleeperDraftPickSchema = z.object({
  pick_no: z.number(),
  round: z.number(),
  draft_slot: z.number(),
  player_id: z.string(),
  roster_id: z.number().nullish(),
});

// ---------------------------------------------------------------------------

export class SleeperProvider implements PlayerDataProvider, LeagueProvider {
  readonly descriptor = SLEEPER_DESCRIPTOR;

  readonly capabilities = {
    readLeague: true,
    readRosters: true,
    readDraft: true,
    liveDraftSync: true,
  };

  /**
   * The full NFL player master list. This response is several megabytes, so
   * Sleeper explicitly asks that it be fetched at most daily — call this from
   * scheduled ingestion, never from a request handler.
   */
  async fetchPlayers(): Promise<FetchResult<RawPlayer>> {
    const fetchedAt = new Date().toISOString();
    const res = await guardedFetch(`${BASE}/players/nfl`, {
      sourceKey: this.descriptor.key,
      timeoutMs: 60_000,          // it really is that big
    });
    if (!res.ok) return fail(fetchedAt, res.error);

    const warnings: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return fail(fetchedAt, 'Sleeper returned a body that is not valid JSON.');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return fail(fetchedAt, 'Sleeper player list was not an object.');
    }

    const items: RawPlayer[] = [];
    let skipped = 0;

    for (const raw of Object.values(parsed as Record<string, unknown>)) {
      const result = SleeperPlayerSchema.safeParse(raw);
      if (!result.success) {
        skipped++;
        continue;
      }
      const player = toRawPlayer(result.data);
      if (player) items.push(player);
      else skipped++;
    }

    if (skipped > 0) {
      warnings.push(
        `${skipped} entries skipped (non-fantasy positions, or missing name/position).`,
      );
    }

    return { ok: true, items, fetchedAt, warnings };
  }

  async getLeague(leagueId: string): Promise<FetchResult<LeagueSummary>> {
    const fetchedAt = new Date().toISOString();
    const res = await guardedFetch(`${BASE}/league/${leagueId}`, {
      sourceKey: this.descriptor.key,
    });
    if (!res.ok) return fail(fetchedAt, res.error);

    const parsed = SleeperLeagueSchema.safeParse(safeJson(res.body));
    if (!parsed.success) {
      return fail(fetchedAt, `Unexpected league payload: ${parsed.error.message}`);
    }

    return {
      ok: true,
      fetchedAt,
      warnings: [],
      items: [
        {
          platformLeagueId: parsed.data.league_id,
          name: parsed.data.name,
          season: Number(parsed.data.season),
          teamCount: parsed.data.total_rosters,
          scoringRaw: parsed.data.scoring_settings ?? {},
          rosterPositions: parsed.data.roster_positions ?? [],
        },
      ],
    };
  }

  async getRosters(leagueId: string): Promise<FetchResult<RosterSummary>> {
    const fetchedAt = new Date().toISOString();
    const res = await guardedFetch(`${BASE}/league/${leagueId}/rosters`, {
      sourceKey: this.descriptor.key,
    });
    if (!res.ok) return fail(fetchedAt, res.error);

    const parsed = z.array(SleeperRosterSchema).safeParse(safeJson(res.body));
    if (!parsed.success) {
      return fail(fetchedAt, `Unexpected rosters payload: ${parsed.error.message}`);
    }

    return {
      ok: true,
      fetchedAt,
      warnings: [],
      items: parsed.data.map((r) => ({
        platformTeamId: String(r.roster_id),
        ownerName: r.owner_id ?? undefined,
        playerExternalIds: r.players ?? [],
      })),
    };
  }

  /**
   * Live draft picks. Polled during a draft to keep the board in sync without
   * the user typing anything — but the manual path (§19) remains authoritative
   * if this is unavailable.
   */
  async getDraftPicks(draftId: string): Promise<FetchResult<DraftPickSummary>> {
    const fetchedAt = new Date().toISOString();
    const res = await guardedFetch(`${BASE}/draft/${draftId}/picks`, {
      sourceKey: this.descriptor.key,
      timeoutMs: 8_000,           // draft night: fail fast, fall back to manual
    });
    if (!res.ok) return fail(fetchedAt, res.error);

    const parsed = z.array(SleeperDraftPickSchema).safeParse(safeJson(res.body));
    if (!parsed.success) {
      return fail(fetchedAt, `Unexpected draft picks payload: ${parsed.error.message}`);
    }

    return {
      ok: true,
      fetchedAt,
      warnings: [],
      items: parsed.data
        .map((p) => ({
          overallPick: p.pick_no,
          round: p.round,
          draftSlot: p.draft_slot,
          playerExternalId: p.player_id,
          platformTeamId: p.roster_id != null ? String(p.roster_id) : undefined,
        }))
        .sort((a, b) => a.overallPick - b.overallPick),
    };
  }

  /** Resolve a username to a user id, needed to list a user's leagues. */
  async getUserId(username: string): Promise<string | null> {
    const res = await guardedFetch(`${BASE}/user/${encodeURIComponent(username)}`, {
      sourceKey: this.descriptor.key,
    });
    if (!res.ok) return null;
    const parsed = z.object({ user_id: z.string() }).safeParse(safeJson(res.body));
    return parsed.success ? parsed.data.user_id : null;
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export function toRawPlayer(
  raw: z.infer<typeof SleeperPlayerSchema>,
): RawPlayer | null {
  const position = normalizePosition(raw.position ?? raw.fantasy_positions?.[0]);
  if (!position) return null;

  const fullName =
    raw.full_name ??
    [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  if (!fullName) return null;

  return {
    externalId: raw.player_id,
    source: 'sleeper',
    fullName,
    firstName: raw.first_name ?? undefined,
    lastName: raw.last_name ?? undefined,
    position,
    nflTeam: raw.team ?? null,
    jerseyNumber: raw.number ?? undefined,
    age: raw.age ?? undefined,
    birthDate: raw.birth_date ?? undefined,
    heightInches: parseHeight(raw.height),
    weightLbs: raw.weight ? Number(raw.weight) || undefined : undefined,
    college: raw.college ?? undefined,
    yearsExp: raw.years_exp ?? undefined,
    status: raw.status ?? undefined,
    injuryStatus: raw.injury_status ?? null,
    depthChartOrder: raw.depth_chart_order ?? undefined,
  };
}

/** Map a source's position string onto our six fantasy positions. */
export function normalizePosition(value: string | null | undefined): Position | null {
  if (!value) return null;
  const upper = value.toUpperCase().trim();
  if ((POSITIONS as readonly string[]).includes(upper)) return upper as Position;
  // Common aliases across sources.
  if (upper === 'DEF' || upper === 'D/ST' || upper === 'DST') return 'DST';
  if (upper === 'PK') return 'K';
  if (upper === 'FB') return 'RB';
  return null;
}

/** Sleeper reports height as inches ("72") or feet-inches ("6'0\""). */
export function parseHeight(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const feetInches = value.match(/^(\d+)'\s*(\d+)?/);
  if (feetInches) {
    return Number(feetInches[1]) * 12 + Number(feetInches[2] ?? 0);
  }
  const inches = Number(value);
  return Number.isFinite(inches) && inches > 0 ? inches : undefined;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function fail<T>(fetchedAt: string, error: string): FetchResult<T> {
  return { ok: false, items: [], fetchedAt, error, warnings: [] };
}
