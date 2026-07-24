import type { Position } from '@/lib/types';

// ============================================================================
// Source adapter contracts.
//
// Every external system enters the application through one of these. The rule
// is that an adapter fetches and normalizes, and does nothing else: no scoring,
// no ranking, no persistence decisions. That keeps sources swappable and means
// losing one never requires touching the engine.
// ============================================================================

export interface SourceDescriptor {
  key: string;
  name: string;
  type: 'rss' | 'api' | 'csv' | 'manual';
  /**
   * 0..1 trust weight. Feeds news confidence, so it should reflect how often
   * the source is right and how close it is to the primary record:
   * official team/league feeds > national beat reporters > aggregators.
   */
  reliability: number;
  updateFrequencyMin: number;
  /** Documented, honest statement of what this source cannot provide. */
  limitations: string;
  /** True if the source needs a credential the user must supply. */
  requiresCredential: boolean;
  credentialEnvVars?: string[];
  /** Terms-of-service note; why we believe this access is permitted. */
  termsNote: string;
}

export interface FetchResult<T> {
  ok: boolean;
  items: T[];
  /** When we retrieved this. Staleness is always measured from here. */
  fetchedAt: string;
  error?: string;
  /** Non-fatal problems: partial parses, skipped records, rate-limit warnings. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Normalized records
// ---------------------------------------------------------------------------

export interface RawPlayer {
  externalId: string;
  source: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  position: Position;
  nflTeam: string | null;
  jerseyNumber?: number;
  age?: number;
  birthDate?: string;
  heightInches?: number;
  weightLbs?: number;
  college?: string;
  yearsExp?: number;
  status?: string;
  injuryStatus?: string | null;
  depthChartOrder?: number;
  sourceTimestamp?: string;
}

export interface RawAdp {
  /** Whatever name/id the source gave us; resolved to a player downstream. */
  playerName: string;
  externalId?: string;
  position?: Position;
  nflTeam?: string | null;
  adp: number;
  adpStdev?: number;
  minPick?: number;
  maxPick?: number;
  sampleSize?: number;
  auctionValue?: number;
  format: string;
  source: string;
  sourceTimestamp?: string;
}

export interface RawRanking {
  playerName: string;
  externalId?: string;
  position?: Position;
  nflTeam?: string | null;
  overallRank?: number;
  positionRank?: number;
  tier?: number;
  expertName?: string;
  format: string;
  source: string;
  sourceTimestamp?: string;
}

export interface RawProjection {
  playerName: string;
  externalId?: string;
  position?: Position;
  /** Stat line, not points — points depend on the league's scoring. */
  statLine: Record<string, number>;
  gamesProjected?: number;
  format?: string;
  source: string;
  sourceTimestamp?: string;
}

export interface RawNewsItem {
  externalId?: string;
  sourceKey: string;
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  publishedAt?: string;
  sourceTimestamp?: string;
}

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export interface PlayerDataProvider {
  descriptor: SourceDescriptor;
  fetchPlayers(): Promise<FetchResult<RawPlayer>>;
}

export interface AdpProvider {
  descriptor: SourceDescriptor;
  fetchAdp(format: string): Promise<FetchResult<RawAdp>>;
}

export interface NewsProvider {
  descriptor: SourceDescriptor;
  fetchNews(): Promise<FetchResult<RawNewsItem>>;
}

// ---------------------------------------------------------------------------
// League platform integration (§12)
// ---------------------------------------------------------------------------

export interface LeagueSummary {
  platformLeagueId: string;
  name: string;
  season: number;
  teamCount: number;
  scoringRaw: unknown;      // platform-shaped; translated by the adapter
  rosterPositions: string[];
}

export interface RosterSummary {
  platformTeamId: string;
  ownerName?: string;
  playerExternalIds: string[];
}

export interface DraftPickSummary {
  overallPick: number;
  round: number;
  draftSlot: number;
  playerExternalId: string;
  platformTeamId?: string;
}

/**
 * The abstraction that keeps the app from being welded to one platform (§12).
 * A provider that cannot do something returns `supported: false` rather than
 * throwing or, worse, inventing data.
 */
export interface LeagueProvider {
  descriptor: SourceDescriptor;
  capabilities: {
    readLeague: boolean;
    readRosters: boolean;
    readDraft: boolean;
    liveDraftSync: boolean;
  };
  getLeague(leagueId: string): Promise<FetchResult<LeagueSummary>>;
  getRosters(leagueId: string): Promise<FetchResult<RosterSummary>>;
  getDraftPicks(draftId: string): Promise<FetchResult<DraftPickSummary>>;
}

// ---------------------------------------------------------------------------
// Fetch plumbing shared by every network-backed adapter
// ---------------------------------------------------------------------------

export class SourceError extends Error {
  constructor(
    message: string,
    readonly sourceKey: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/**
 * Guarded fetch used by every adapter.
 *
 * Honesty rules enforced here rather than left to each adapter:
 *  - network access can be switched off entirely (`INGEST_NETWORK_ENABLED=0`),
 *    in which case adapters fail loudly instead of silently returning nothing
 *    that could be mistaken for "no news today";
 *  - a timeout is always applied, because draft-day cannot hang on a slow feed;
 *  - failures return a result, never throw, so one dead source cannot abort a
 *    whole ingestion run (§33).
 */
export async function guardedFetch(
  url: string,
  opts: {
    sourceKey: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
    accept?: string;
  },
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  if (process.env.INGEST_NETWORK_ENABLED === '0') {
    return {
      ok: false,
      error:
        'Network ingestion is disabled (INGEST_NETWORK_ENABLED=0). No data was ' +
        'fetched — this is a configuration state, not an empty result.',
    };
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FantasyCoach/0.1 (personal use)',
        Accept: opts.accept ?? 'application/json',
        ...opts.headers,
      },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${url}` };
    }
    return { ok: true, body: await res.text() };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `${message} (${url})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a player name for cross-source matching. */
export function searchKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')     // strip accents
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z]/g, '');
}
