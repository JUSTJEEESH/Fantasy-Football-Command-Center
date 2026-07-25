import type { PlayerPackEntry } from '../src/lib/static-data';

// ============================================================================
// ADP over time.
//
// The site rebuilds every three hours from now until the draft, and each build
// fetches a fresh ADP. Those snapshots are a time series nobody was keeping:
// who is rising in real drafts and who is falling is exactly the thing worth
// knowing in the weeks before draft night, and it cannot be seen in any single
// build.
//
// Each deploy publishes data/adp-history.json alongside the pack; the next
// build reads it back from the live branch, appends today, prunes the tail,
// and republishes. The deployment is its own database — no server involved.
//
// Honesty notes:
//  - One sample per calendar day. Eight-a-day sampling would record intra-day
//    jitter, and a "trend" made of jitter is noise wearing a costume.
//  - A player needs samples spanning at least 3 days before any trend is
//    claimed; two points a day apart is a coin flip.
//  - The first build has no history, so it claims nothing. The feature earns
//    its data honestly over the following days.
// ============================================================================

/** ISO date (yyyy-mm-dd) → player id → that day's ADP. */
export type AdpHistory = Record<string, Record<string, number>>;

export const HISTORY_DAYS = 21;

/** How far back the trend looks. */
export const TREND_WINDOW_DAYS = 7;

/** Minimum span between first and last sample before a trend is claimed. */
const MIN_SPAN_DAYS = 3;

/** Append today's snapshot, replacing any earlier sample from the same day. */
export function appendSnapshot(
  history: AdpHistory,
  day: string,
  players: PlayerPackEntry[],
): AdpHistory {
  const snapshot: Record<string, number> = {};
  for (const player of players) {
    if (player.adp !== undefined) snapshot[player.id] = player.adp;
  }

  const merged: AdpHistory = { ...history, [day]: snapshot };

  // Prune by date arithmetic, not entry count — a gap in builds must not
  // stretch the window silently.
  const cutoff = shiftDay(day, -HISTORY_DAYS);
  for (const key of Object.keys(merged)) {
    if (key < cutoff) delete merged[key];
  }
  return merged;
}

export interface AdpTrend {
  /** Picks moved over the window. Negative = being drafted EARLIER (rising). */
  delta: number;
  /** Days between the two samples the delta spans. */
  spanDays: number;
}

/**
 * Per-player ADP movement over the trend window.
 *
 * The delta is measured from the oldest in-window sample to today. Sign
 * follows ADP itself: a player who moves from pick 60 to pick 48 has a delta
 * of −12 — drafted twelve picks earlier, i.e. rising.
 */
export function computeTrends(
  history: AdpHistory,
  today: string,
): Map<string, AdpTrend> {
  const days = Object.keys(history).sort();
  const windowStart = shiftDay(today, -TREND_WINDOW_DAYS);
  const inWindow = days.filter((d) => d >= windowStart && d <= today);
  const out = new Map<string, AdpTrend>();
  if (inWindow.length < 2) return out;

  const latestDay = inWindow[inWindow.length - 1]!;
  const latest = history[latestDay]!;

  for (const [playerId, adpNow] of Object.entries(latest)) {
    // Oldest in-window sample that has this player.
    const firstDay = inWindow.find((d) => history[d]![playerId] !== undefined);
    if (!firstDay || firstDay === latestDay) continue;

    const spanDays = dayDiff(firstDay, latestDay);
    if (spanDays < MIN_SPAN_DAYS) continue;

    const delta = round1(adpNow - history[firstDay]![playerId]!);
    out.set(playerId, { delta, spanDays });
  }
  return out;
}

function shiftDay(day: string, byDays: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + byDays);
  return date.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
