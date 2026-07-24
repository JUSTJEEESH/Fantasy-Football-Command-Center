import { z } from 'zod';
import type { DraftState, League, PlayerCard } from '@/lib/types';
import { LeagueSettingsSchema } from '@/lib/types';

// ============================================================================
// The draft pack — the offline snapshot that makes draft night network-optional.
//
// This is the single most important reliability decision in the product. A
// draft party is a loud room on congested wifi and there is a timer running.
// Everything needed to answer "who's my pick?" is serialized here, stored in
// the browser, and read by the engine locally. No request is made to answer a
// question during a draft.
// ============================================================================

export const DRAFT_PACK_VERSION = 2;
const STORAGE_KEY = 'fantasy-coach:draft-pack';
const STATE_KEY = 'fantasy-coach:draft-state';

export const DraftPackSchema = z.object({
  version: z.number(),
  league: LeagueSettingsSchema,
  players: z.array(z.any()),
  /** When the underlying data was fetched — drives every staleness message. */
  dataFetchedAt: z.string(),
  /** When this pack was assembled. */
  builtAt: z.string(),
  /** Which sources contributed, so the UI can show provenance offline. */
  sources: z.array(z.object({ key: z.string(), fetchedAt: z.string() })),
});

export interface DraftPack {
  version: number;
  league: League;
  players: PlayerCard[];
  dataFetchedAt: string;
  builtAt: string;
  sources: Array<{ key: string; fetchedAt: string }>;
}

export function buildDraftPack(params: {
  league: League;
  players: PlayerCard[];
  dataFetchedAt?: string;
  sources?: Array<{ key: string; fetchedAt: string }>;
}): DraftPack {
  const now = new Date().toISOString();
  // Freshness is the OLDEST component, not the newest: a pack is only as
  // current as its stalest input, and claiming otherwise would overstate it.
  const fetchedAt =
    params.dataFetchedAt ??
    params.players
      .map((p) => p.fetchedAt)
      .filter((t): t is string => Boolean(t))
      .sort()[0] ??
    now;

  return {
    version: DRAFT_PACK_VERSION,
    league: params.league,
    players: params.players,
    dataFetchedAt: fetchedAt,
    builtAt: now,
    sources: params.sources ?? [],
  };
}

// ---------------------------------------------------------------------------
// Browser persistence
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;   // Safari private mode throws on access
  }
}

export function savePack(pack: DraftPack): { ok: boolean; error?: string } {
  const store = storage();
  if (!store) return { ok: false, error: 'Local storage is unavailable in this browser.' };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(pack));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && /quota/i.test(err.message)
          ? 'Not enough browser storage for the draft pack. Free some space and re-sync.'
          : String(err),
    };
  }
}

/**
 * Load the pack, reporting *why* it was rejected.
 *
 * A silent null here once hid a serialization bug that discarded every saved
 * pack — the war room simply said "no pack loaded" with no way to tell that
 * one had been saved seconds earlier. Rejection must always be explicable.
 */
export function loadPackResult():
  | { pack: DraftPack }
  | { pack: null; reason?: string } {
  const store = storage();
  if (!store) return { pack: null, reason: 'Local storage is unavailable.' };

  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return { pack: null };

  let parsed: DraftPack;
  try {
    parsed = JSON.parse(raw) as DraftPack;
  } catch {
    return { pack: null, reason: 'The saved draft pack is corrupt. Re-import your data.' };
  }

  // A pack written by an older build may not match what the engine expects.
  // Discarding is correct: a wrong pack is worse than no pack.
  if (parsed.version !== DRAFT_PACK_VERSION) {
    return {
      pack: null,
      reason: `Saved pack is version ${parsed.version}, this build needs ${DRAFT_PACK_VERSION}. Re-import your data.`,
    };
  }

  const validated = DraftPackSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      pack: null,
      reason: `Saved pack failed validation: ${validated.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    };
  }

  return { pack: parsed };
}

export function loadPack(): DraftPack | null {
  return loadPackResult().pack;
}

export function clearPack(): void {
  storage()?.removeItem(STORAGE_KEY);
}

/**
 * The live draft board is persisted separately and on every mutation, so that
 * a phone locking, a browser tab dying, or a battery swap mid-draft loses
 * nothing.
 */
export function saveDraftState(state: DraftState): void {
  try {
    storage()?.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Never let a persistence failure interrupt a draft in progress.
  }
}

export function loadDraftState(): DraftState | null {
  const raw = storage()?.getItem(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraftState;
  } catch {
    return null;
  }
}

export function clearDraftState(): void {
  storage()?.removeItem(STATE_KEY);
}

// ---------------------------------------------------------------------------

export interface PackFreshness {
  ageHours: number;
  label: string;
  level: 'fresh' | 'aging' | 'stale';
}

/** Never implies currency it cannot prove (§30). */
export function describePackFreshness(
  pack: DraftPack | null,
  now = new Date(),
): PackFreshness | null {
  if (!pack) return null;
  const ageHours = (now.getTime() - new Date(pack.dataFetchedAt).getTime()) / 3_600_000;

  if (ageHours < 12) {
    return {
      ageHours,
      level: 'fresh',
      label: ageHours < 1 ? 'Updated just now' : `Updated ${Math.round(ageHours)}h ago`,
    };
  }
  if (ageHours < 72) {
    return { ageHours, level: 'aging', label: `Last verified ${Math.round(ageHours)}h ago` };
  }
  return {
    ageHours,
    level: 'stale',
    label: `STALE — ${Math.round(ageHours / 24)} days old. Re-sync before drafting.`,
  };
}
