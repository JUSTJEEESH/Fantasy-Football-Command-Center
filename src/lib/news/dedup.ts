import { createHash } from 'node:crypto';
import type { RawNewsItem } from '@/lib/sources/types';

// ============================================================================
// News deduplication (§5).
//
// Four outlets report the same hamstring. The user should see one event with
// four sources attached, not four headlines — but every original attribution
// must survive, because "who said it" is part of how much to trust it.
//
// Two-stage: an exact fingerprint gate (cheap, catches syndicated reprints),
// then token-similarity clustering (catches genuine rewordings). No LLM is
// involved — this runs over hundreds of items per day and must be free.
// ============================================================================

export interface NewsCluster {
  /** The clearest headline in the cluster, used as the canonical one. */
  canonicalTitle: string;
  items: RawNewsItem[];
  /** Pairwise similarity of each item to the canonical, same order as items. */
  similarities: number[];
  earliestPublishedAt?: string;
  latestPublishedAt?: string;
}

/** Stable hash of the normalized headline; identical text always collides. */
export function fingerprint(item: Pick<RawNewsItem, 'title' | 'summary'>): string {
  const normalized = normalizeText(`${item.title} ${item.summary ?? ''}`);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words too common in football headlines to carry signal. Dropping them stops
 * "NFL" and "report" from making unrelated stories look similar.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had',
  'will', 'would', 'could', 'should', 'may', 'might', 'this', 'that', 'these',
  'nfl', 'football', 'report', 'reports', 'says', 'said', 'per', 'via', 'news',
  'update', 'updates', 'week', 'game', 'season', 'team', 'teams',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/** Jaccard similarity over content tokens. */
export function similarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cluster near-duplicate news items.
 *
 * `threshold` is the similarity at which two headlines are treated as the same
 * event. 0.45 is deliberately permissive: over-merging two related injury
 * reports is a much smaller harm than showing the user the same news four
 * times, which is the exact problem this product exists to solve.
 *
 * `windowHours` prevents a rehash of a months-old story from being folded into
 * today's event — same words, different event.
 */
export function clusterNews(
  items: RawNewsItem[],
  opts: { threshold?: number; windowHours?: number } = {},
): NewsCluster[] {
  const threshold = opts.threshold ?? 0.45;
  const windowHours = opts.windowHours ?? 48;

  // Stage 1: collapse exact duplicates by fingerprint, then split each group
  // by time. An identical headline republished months later is a different
  // event, and the fingerprint alone cannot tell the difference.
  const byFingerprint = new Map<string, RawNewsItem[]>();
  for (const item of items) {
    const key = fingerprint(item);
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), item]);
  }
  const exactGroups = [...byFingerprint.values()].flatMap((group) =>
    splitByTimeWindow(group, windowHours),
  );

  // Stage 2: cluster the remaining distinct headlines by similarity.
  const clusters: NewsCluster[] = [];

  for (const group of exactGroups) {
    const representative = group[0]!;
    const text = `${representative.title} ${representative.summary ?? ''}`;

    const match = clusters.find((cluster) => {
      if (!withinWindow(cluster, representative, windowHours)) return false;
      const canonicalText = `${cluster.canonicalTitle} ${cluster.items[0]?.summary ?? ''}`;
      return similarity(canonicalText, text) >= threshold;
    });

    if (match) {
      const canonicalText = `${match.canonicalTitle} ${match.items[0]?.summary ?? ''}`;
      for (const item of group) {
        match.items.push(item);
        match.similarities.push(
          Math.round(similarity(canonicalText, `${item.title} ${item.summary ?? ''}`) * 1000) / 1000,
        );
      }
      updateWindow(match);
    } else {
      const cluster: NewsCluster = {
        canonicalTitle: representative.title,
        items: [...group],
        similarities: group.map(() => 1),
      };
      updateWindow(cluster);
      clusters.push(cluster);
    }
  }

  // Prefer the most informative headline as the canonical one: the longest,
  // which in practice is the one that actually names the player and the injury
  // rather than "Injury update".
  for (const cluster of clusters) {
    const best = [...cluster.items].sort((a, b) => b.title.length - a.title.length)[0];
    if (best) cluster.canonicalTitle = best.title;
  }

  return clusters;
}

/**
 * Split items sharing a fingerprint into runs that fall inside the same time
 * window. Items with no timestamp stay with the first run rather than being
 * dropped — an unknown date is not evidence of a different event.
 */
function splitByTimeWindow(
  group: RawNewsItem[],
  windowHours: number,
): RawNewsItem[][] {
  if (group.length <= 1) return [group];

  const timed = group
    .map((item) => ({ item, time: item.publishedAt ? new Date(item.publishedAt).getTime() : NaN }))
    .filter((x) => !Number.isNaN(x.time))
    .sort((a, b) => a.time - b.time);
  const untimed = group.filter((item) => {
    const t = item.publishedAt ? new Date(item.publishedAt).getTime() : NaN;
    return Number.isNaN(t);
  });

  if (timed.length === 0) return [group];

  const windowMs = windowHours * 3_600_000;
  const runs: RawNewsItem[][] = [];
  let current: RawNewsItem[] = [];
  let anchor = timed[0]!.time;

  for (const { item, time } of timed) {
    if (current.length > 0 && time - anchor > windowMs) {
      runs.push(current);
      current = [];
      anchor = time;
    }
    current.push(item);
  }
  if (current.length > 0) runs.push(current);

  if (untimed.length > 0) runs[0]!.push(...untimed);
  return runs;
}

function withinWindow(
  cluster: NewsCluster,
  item: RawNewsItem,
  windowHours: number,
): boolean {
  if (!item.publishedAt || !cluster.earliestPublishedAt) return true;
  const itemTime = new Date(item.publishedAt).getTime();
  const clusterTime = new Date(cluster.earliestPublishedAt).getTime();
  if (Number.isNaN(itemTime) || Number.isNaN(clusterTime)) return true;
  return Math.abs(itemTime - clusterTime) <= windowHours * 3_600_000;
}

function updateWindow(cluster: NewsCluster): void {
  const times = cluster.items
    .map((i) => i.publishedAt)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return;
  cluster.earliestPublishedAt = new Date(times[0]!).toISOString();
  cluster.latestPublishedAt = new Date(times[times.length - 1]!).toISOString();
}
