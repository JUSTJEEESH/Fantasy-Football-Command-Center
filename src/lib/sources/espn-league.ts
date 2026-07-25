import { z } from 'zod';
import type { DraftState, PlayerCard } from '@/lib/types';
import type { DraftAction } from '@/lib/engine/draft-state';

// ============================================================================
// Live link to an ESPN league: draft order before the draft, pick-by-pick
// follow during it.
//
// This reads the same public league endpoint the ESPN site itself uses:
//   .../seasons/{season}/segments/0/leagues/{leagueId}?view=mDraftDetail...
//
// WHAT CAN AND CANNOT WORK — stated here because it shapes everything below:
//
//  · A browser CANNOT send ESPN's auth cookies to another origin. `Cookie` is
//    a forbidden header in fetch(); no code in this file could change that.
//    So a PRIVATE league cannot be live-synced from the deployed app, full
//    stop. The league must be set to publicly viewable (ESPN → League
//    Settings → Basic Settings → League Visibility) for the link to work.
//    That setting exposes rosters and picks, not anyone's account.
//
//  · Even for a public league, the browser only gets the response if ESPN's
//    CORS headers allow it. That cannot be verified from this codebase's
//    development sandbox (no egress), so it is verified where it matters:
//    the Test Connection button runs this exact request from the user's own
//    browser and reports precisely what happened. If ESPN blocks it, the
//    message says so and manual entry — which needs no network at all —
//    remains the path. Sync is an accelerant, never a dependency.
//
//  · Matching is by ESPN player id, which the draft pack now carries. An id
//    cannot confuse two players who share a surname. A pick whose id is not
//    on the board pauses the sync and names the pick, rather than guessing.
// ============================================================================

const READ_HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

const TeamSchema = z.object({
  id: z.number(),
  // ESPN has shipped both a single `name` and a `location`/`nickname` pair.
  name: z.string().nullish(),
  location: z.string().nullish(),
  nickname: z.string().nullish(),
  abbrev: z.string().nullish(),
});

const PickSchema = z.object({
  overallPickNumber: z.number(),
  playerId: z.number(),
  teamId: z.number(),
});

const LeaguePayloadSchema = z.object({
  id: z.number(),
  seasonId: z.number().nullish(),
  settings: z
    .object({
      name: z.string().nullish(),
      draftSettings: z
        .object({
          pickOrder: z.array(z.number()).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  status: z
    .object({
      teamsJoined: z.number().nullish(),
    })
    .nullish(),
  teams: z.array(TeamSchema).nullish(),
  draftDetail: z
    .object({
      drafted: z.boolean().nullish(),
      inProgress: z.boolean().nullish(),
      picks: z.array(PickSchema).nullish(),
    })
    .nullish(),
});

// ---------------------------------------------------------------------------
// Parsed shape
// ---------------------------------------------------------------------------

export interface EspnTeam {
  id: number;
  name: string;
}

export interface EspnLeagueSnapshot {
  leagueId: number;
  leagueName: string | null;
  season: number | null;
  teams: EspnTeam[];
  /**
   * Team ids in draft-slot order (index 0 drafts first), or null when ESPN
   * has not published the order yet — which is the normal state until shortly
   * before the draft.
   */
  draftOrder: number[] | null;
  draftInProgress: boolean;
  draftComplete: boolean;
  /** Picks made so far, in overall order. */
  picks: Array<{ overallPick: number; espnPlayerId: number; teamId: number }>;
}

export function parseLeaguePayload(json: unknown): EspnLeagueSnapshot {
  const data = LeaguePayloadSchema.parse(json);

  const teams: EspnTeam[] = (data.teams ?? []).map((team) => ({
    id: team.id,
    name:
      team.name?.trim() ||
      [team.location, team.nickname].filter(Boolean).join(' ').trim() ||
      team.abbrev?.trim() ||
      `Team ${team.id}`,
  }));

  const order = data.settings?.draftSettings?.pickOrder;

  return {
    leagueId: data.id,
    leagueName: data.settings?.name ?? null,
    season: data.seasonId ?? null,
    teams,
    draftOrder: order && order.length > 0 ? order : null,
    draftInProgress: data.draftDetail?.inProgress ?? false,
    draftComplete: data.draftDetail?.drafted ?? false,
    picks: (data.draftDetail?.picks ?? [])
      .map((p) => ({
        overallPick: p.overallPickNumber,
        espnPlayerId: p.playerId,
        teamId: p.teamId,
      }))
      // ESPN pre-populates future picks with playerId 0. Those are slots, not
      // selections, and treating them as picks would "draft" 180 ghosts.
      .filter((p) => p.espnPlayerId > 0)
      .sort((a, b) => a.overallPick - b.overallPick),
  };
}

// ---------------------------------------------------------------------------
// Fetching (browser-side)
// ---------------------------------------------------------------------------

export type EspnLinkFailure =
  | 'blocked'      // CORS or network — the browser refused or the request died
  | 'private'      // ESPN answered 401/403: league is not publicly viewable
  | 'not-found'    // 404: no league with that id for that season
  | 'bad-payload'; // reachable but the response shape was not a league

export type EspnLeagueResult =
  | { ok: true; snapshot: EspnLeagueSnapshot }
  | { ok: false; kind: EspnLinkFailure; detail: string };

/**
 * Fetch a league snapshot from the user's own browser.
 *
 * Plain fetch on purpose: this runs client-side, where forbidden headers
 * (User-Agent and friends) throw and no env-based ingest guard applies.
 */
export async function fetchEspnLeague(
  leagueId: string | number,
  season: number,
): Promise<EspnLeagueResult> {
  const url = snapshotUrl(leagueId, season);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    // fetch() rejects with a bare TypeError for BOTH "no network" and "CORS
    // refused" — the browser deliberately hides which. The message reflects
    // that honestly instead of guessing.
    return {
      ok: false,
      kind: 'blocked',
      detail:
        'The browser blocked or could not complete the request. This is either ' +
        'no connectivity, or ESPN refusing cross-site reads (CORS) — the browser ' +
        `hides which on purpose. (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      kind: 'private',
      detail:
        'ESPN answered "not authorized" — the league is private. A browser ' +
        'cannot send ESPN login cookies to another site, so live sync needs the ' +
        'league set to publicly viewable: ESPN → League Settings → Basic ' +
        'Settings → League Visibility. That exposes rosters and picks, not ' +
        "anyone's account.",
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      kind: 'not-found',
      detail: `ESPN has no league ${leagueId} for ${season}. Check the league id in your ESPN URL (leagueId=…).`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      kind: 'bad-payload',
      detail: `ESPN answered HTTP ${res.status}.`,
    };
  }

  try {
    return { ok: true, snapshot: parseLeaguePayload(await res.json()) };
  } catch (err) {
    return {
      ok: false,
      kind: 'bad-payload',
      detail: `ESPN answered, but not with a league in the expected shape: ${String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The paste path — how a PRIVATE league gets in.
//
// The app's fetch cannot carry the user's ESPN login. But the user's own
// browser can: opening the data URL directly in a logged-in tab is a
// first-party navigation, cookies flow, and the league JSON renders as text.
// Copy it, paste it here, and everything downstream — draft order, team list,
// live picks — works identically to the fetch path. The league stays private;
// nothing leaves the user's device; no credential is ever typed anywhere.
// ---------------------------------------------------------------------------

/** The URL to open in a logged-in tab. Shown to the user, never fetched. */
export function snapshotUrl(leagueId: string | number, season: number): string {
  return (
    `${READ_HOST}/seasons/${season}/segments/0/leagues/${leagueId}` +
    `?view=mDraftDetail&view=mSettings&view=mTeam`
  );
}

/** Parse pasted league JSON, with failures explained in the user's terms. */
export function parsePastedSnapshot(text: string): EspnLeagueResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, kind: 'bad-payload', detail: 'Nothing was pasted.' };
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      kind: 'bad-payload',
      detail:
        trimmed.startsWith('<')
          ? 'That looks like a web page, not league data. Open the exact link shown above and copy the whole page — it should look like raw code starting with {.'
          : 'That is not valid JSON. Select everything on the data page (Ctrl/Cmd+A) and copy it whole.',
    };
  }

  // ESPN answers some views as a one-element array.
  const candidate = Array.isArray(json) ? json[0] : json;

  try {
    return { ok: true, snapshot: parseLeaguePayload(candidate) };
  } catch {
    return {
      ok: false,
      kind: 'bad-payload',
      detail:
        'Valid JSON, but not a league snapshot. Make sure you opened the link ' +
        'from this page (it requests the draft views) while logged in to ESPN.',
    };
  }
}

// ---------------------------------------------------------------------------
// Sync planning — pure, so it is testable without a network or a browser
// ---------------------------------------------------------------------------

export type SyncPlan =
  | { status: 'in-sync'; actions: [] }
  | { status: 'apply'; actions: DraftAction[]; count: number }
  | {
      /**
       * ESPN's board and ours disagree about a pick that was already made.
       * Auto-"fixing" recorded history would silently rewrite the user's
       * board, so this stops and names the pick instead.
       */
      status: 'conflict';
      actions: [];
      overallPick: number;
      detail: string;
    }
  | {
      /** ESPN picked a player who is not on our board. Sync cannot proceed
       *  past this pick without inventing an entry, so it names the pick and
       *  waits for a manual record. */
      status: 'unmatched';
      actions: DraftAction[];
      count: number;
      overallPick: number;
      espnPlayerId: number;
    };

/**
 * Diff ESPN's pick list against the local board and produce the actions that
 * bring the board up to date.
 *
 * The local board must be a prefix of ESPN's list (matching by ESPN id where
 * our record has one). Picks recorded manually with a player whose card lacks
 * an espnId are trusted positionally — they were typed by the person sitting
 * in the room, which is better evidence than an id we never had.
 */
export function planSync(
  state: DraftState,
  snapshot: EspnLeagueSnapshot,
  players: PlayerCard[],
): SyncPlan {
  const byEspnId = new Map<number, PlayerCard>();
  for (const player of players) {
    if (player.espnId !== undefined) byEspnId.set(player.espnId, player);
  }
  const cardById = new Map(players.map((p) => [p.id, p]));

  // Verify the shared prefix before adding anything on top of it.
  for (let i = 0; i < Math.min(state.picks.length, snapshot.picks.length); i++) {
    const ours = state.picks[i]!;
    const theirs = snapshot.picks[i]!;
    const ourCard = cardById.get(ours.playerId);
    if (ourCard?.espnId !== undefined && ourCard.espnId !== theirs.espnPlayerId) {
      const theirCard = byEspnId.get(theirs.espnPlayerId);
      return {
        status: 'conflict',
        actions: [],
        overallPick: ours.overallPick,
        detail:
          `Pick ${ours.overallPick}: your board says ${ourCard.name}, ESPN says ` +
          `${theirCard ? theirCard.name : `player #${theirs.espnPlayerId}`}. ` +
          'Fix it with "correct pick" — sync will not rewrite recorded history.',
      };
    }
  }

  if (snapshot.picks.length <= state.picks.length) {
    return { status: 'in-sync', actions: [] };
  }

  const actions: DraftAction[] = [];
  for (const pick of snapshot.picks.slice(state.picks.length)) {
    const card = byEspnId.get(pick.espnPlayerId);
    if (!card) {
      return {
        status: 'unmatched',
        actions,
        count: actions.length,
        overallPick: pick.overallPick,
        espnPlayerId: pick.espnPlayerId,
      };
    }
    actions.push({ type: 'RECORD_PICK', playerId: card.id, entryMethod: 'sync' });
  }

  return { status: 'apply', actions, count: actions.length };
}

/**
 * Where a team sits in the draft order, 1-indexed — what "your draft slot" is
 * once you point at your own team.
 */
export function slotOfTeam(snapshot: EspnLeagueSnapshot, teamId: number): number | null {
  if (!snapshot.draftOrder) return null;
  const index = snapshot.draftOrder.indexOf(teamId);
  return index === -1 ? null : index + 1;
}
