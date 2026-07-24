import { guardedFetch, type FetchResult, type NewsProvider, type RawNewsItem, type SourceDescriptor } from './types';

// ============================================================================
// RSS news adapter.
//
// RSS is published expressly for syndication, which makes it the one news
// channel that is unambiguously permitted. We take only what the feed gives —
// headline, summary, timestamp, link — and never fetch or store article bodies.
// The link always goes back to the publisher.
// ============================================================================

/**
 * The default registry. Reliability weights reflect proximity to the primary
 * record: official league/team feeds are near-authoritative, national outlets
 * are strong, aggregators are weaker because they repeat others' reporting.
 *
 * These URLs are the publishers' documented public feeds. They are seeded into
 * the news_sources table, where any of them can be disabled without a deploy.
 */
export const DEFAULT_RSS_SOURCES: Array<SourceDescriptor & { url: string }> = [
  {
    key: 'espn_nfl',
    name: 'ESPN NFL',
    type: 'rss',
    url: 'https://www.espn.com/espn/rss/nfl/news',
    reliability: 0.88,
    updateFrequencyMin: 15,
    limitations: 'Headline and summary only; not fantasy-specific, so most items filter out as noise.',
    requiresCredential: false,
    termsNote: 'Public RSS feed published for syndication. Bodies are never fetched or stored.',
  },
  {
    key: 'cbs_nfl',
    name: 'CBS Sports NFL',
    type: 'rss',
    url: 'https://www.cbssports.com/rss/headlines/nfl/',
    reliability: 0.82,
    updateFrequencyMin: 15,
    limitations: 'Headline-level detail only.',
    requiresCredential: false,
    termsNote: 'Public RSS feed published for syndication.',
  },
  {
    key: 'yahoo_nfl',
    name: 'Yahoo Sports NFL',
    type: 'rss',
    url: 'https://sports.yahoo.com/nfl/rss.xml',
    reliability: 0.80,
    updateFrequencyMin: 15,
    limitations: 'Headline-level detail only.',
    requiresCredential: false,
    termsNote: 'Public RSS feed published for syndication.',
  },
  {
    key: 'profootballtalk',
    name: 'ProFootballTalk',
    type: 'rss',
    url: 'https://profootballtalk.nbcsports.com/feed/',
    reliability: 0.85,
    updateFrequencyMin: 10,
    limitations: 'Fast on breaking news but mixes in transactional and off-field items.',
    requiresCredential: false,
    termsNote: 'Public RSS feed published for syndication.',
  },
];

export class RssNewsProvider implements NewsProvider {
  constructor(readonly descriptor: SourceDescriptor & { url: string }) {}

  async fetchNews(): Promise<FetchResult<RawNewsItem>> {
    const fetchedAt = new Date().toISOString();
    const res = await guardedFetch(this.descriptor.url, {
      sourceKey: this.descriptor.key,
      accept: 'application/rss+xml, application/xml, text/xml',
      timeoutMs: 12_000,
    });
    if (!res.ok) {
      return { ok: false, items: [], fetchedAt, error: res.error, warnings: [] };
    }

    const items = parseFeed(res.body, this.descriptor.key);
    return {
      ok: true,
      items,
      fetchedAt,
      warnings: items.length === 0 ? ['Feed parsed but contained no items.'] : [],
    };
  }
}

// ---------------------------------------------------------------------------
// Feed parsing
//
// Handles both RSS 2.0 (<item>) and Atom (<entry>) without an XML dependency.
// Feeds are small and structurally simple; a targeted parser avoids pulling in
// a library and its update treadmill for a handful of tags.
// ---------------------------------------------------------------------------

export function parseFeed(xml: string, sourceKey: string): RawNewsItem[] {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = isAtom
    ? matchAll(xml, /<entry[\s\S]*?<\/entry>/gi)
    : matchAll(xml, /<item[\s\S]*?<\/item>/gi);

  const items: RawNewsItem[] = [];
  for (const block of blocks) {
    const title = decodeXml(tag(block, 'title'));
    if (!title) continue;

    const summary = decodeXml(
      tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content'),
    );
    const link = isAtom ? atomLink(block) : decodeXml(tag(block, 'link'));
    const published =
      tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated');

    items.push({
      externalId: decodeXml(tag(block, 'guid') ?? tag(block, 'id')) ?? link ?? undefined,
      sourceKey,
      title,
      summary: summary ? stripHtml(summary) : undefined,
      url: link ?? undefined,
      author: decodeXml(tag(block, 'author') ?? tag(block, 'dc:creator')) ?? undefined,
      publishedAt: published ? toIso(published) : undefined,
      sourceTimestamp: published ? toIso(published) : undefined,
    });
  }
  return items;
}

function matchAll(text: string, regex: RegExp): string[] {
  return text.match(regex) ?? [];
}

function tag(block: string, name: string): string | null {
  const escaped = name.replace(':', '\\:');
  const cdata = new RegExp(
    `<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escaped}>`,
    'i',
  );
  const cdataMatch = block.match(cdata);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const plain = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 'i');
  const match = block.match(plain);
  return match ? match[1]!.trim() : null;
}

/** Atom links live in an attribute, and alternate/self must be distinguished. */
function atomLink(block: string): string | null {
  const alternate = block.match(
    /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i,
  );
  if (alternate) return alternate[1]!;
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return any ? any[1]! : null;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeXml(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')      // last, so &amp;lt; decodes correctly
    .trim();
}

/** Returns an ISO string, or undefined rather than a wrong date. */
export function toIso(value: string): string | undefined {
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
