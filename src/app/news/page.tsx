'use client';

import { useEffect, useState } from 'react';

interface NewsEvent {
  id: string;
  headline: string;
  classification: string;
  fantasyImpact: string;
  impactScore: number;
  confidence: number;
  summary?: string;
  firstReportedAt?: string;
  sources: Array<{ name: string; url?: string; publishedAt?: string }>;
}

interface NewsPayload {
  events: NewsEvent[];
  fetchedAt: string | null;
  degraded?: string;
}

/**
 * NEWS (§21, §30).
 *
 * Unlike the draft screens this one genuinely needs the server, since news
 * lives in the database. When it is unavailable the page says exactly that,
 * rather than rendering an empty list that reads as "nothing happened today".
 */
export default function NewsPage() {
  const [payload, setPayload] = useState<NewsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/news')
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then((data: NewsPayload) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-3">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">News</h1>
        {payload?.fetchedAt && (
          <p className="text-xs text-[var(--muted)]">
            Last ingested {formatAge(payload.fetchedAt)}
          </p>
        )}
      </header>

      {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {error && (
        <div className="card border-[var(--danger)]/40">
          <h2 className="font-semibold text-[var(--danger)]">News is unavailable</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {error}. This means I can&apos;t tell you what happened — not that nothing
            happened. Draft mode is unaffected; it runs from your local pack.
          </p>
        </div>
      )}

      {payload?.degraded && (
        <p className="rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-sm text-[var(--warn)]">
          {payload.degraded}
        </p>
      )}

      {payload && payload.events.length === 0 && !payload.degraded && (
        <div className="card">
          <p className="text-sm text-[var(--muted)]">
            No fantasy-relevant news has been ingested yet. Run{' '}
            <code className="rounded bg-[var(--surface-2)] px-1">pnpm ingest</code> to
            populate the feed.
          </p>
        </div>
      )}

      {payload?.events.map((event) => (
        <article key={event.id} className="card">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-[15px] font-semibold leading-snug">{event.headline}</h2>
            <ImpactBadge impact={event.fantasyImpact} />
          </div>

          {event.summary && (
            <p className="mt-2 text-sm text-[var(--muted)]">{event.summary}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
            <span>{event.classification.replace('_', ' ')}</span>
            <span>·</span>
            <span>Confidence {Math.round(event.confidence * 100)}%</span>
            {event.firstReportedAt && (
              <>
                <span>·</span>
                <span>{formatAge(event.firstReportedAt)}</span>
              </>
            )}
          </div>

          {/* Attribution is never dropped, even after dedup (§5). */}
          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
            {event.sources.map((source, i) => (
              <a
                key={i}
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sky-400 underline"
              >
                {source.name}
              </a>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function ImpactBadge({ impact }: { impact: string }) {
  const tone =
    impact === 'CRITICAL'
      ? 'bg-[var(--danger)]/20 text-[var(--danger)]'
      : impact === 'HIGH'
        ? 'bg-[var(--warn)]/20 text-[var(--warn)]'
        : 'bg-[var(--surface-2)] text-[var(--muted)]';
  return <span className={`tag shrink-0 ${tone}`}>{impact}</span>;
}

function formatAge(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
