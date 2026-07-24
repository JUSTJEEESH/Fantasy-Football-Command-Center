'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  eventTypeLabel,
  impactSentence,
  loadNewsPack,
  packFreshness,
  relativeTime,
  type NewsEventView,
  type NewsPack,
} from '@/lib/static-data';

type Filter = 'all' | 'injury' | 'roles' | 'linked';

/**
 * NEWS (§21, §30).
 *
 * The feed is impact-ordered rather than chronological, because the question
 * this page answers is "what actually matters", not "what is newest". Each item
 * leads with what it means for a player and carries every outlet that reported
 * it — deduplication must not cost attribution.
 */
export default function NewsPage() {
  const [pack, setPack] = useState<NewsPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadNewsPack()
      .then((data) => {
        if (!cancelled) setPack(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const events = useMemo(() => {
    if (!pack) return [];
    switch (filter) {
      case 'injury':
        return pack.events.filter((e) =>
          ['injury', 'practice', 'return'].includes(e.eventType),
        );
      case 'roles':
        return pack.events.filter((e) =>
          ['depth_chart', 'usage', 'trade', 'signing'].includes(e.eventType),
        );
      case 'linked':
        return pack.events.filter((e) => e.players.length > 0);
      default:
        return pack.events;
    }
  }, [pack, filter]);

  const freshness = packFreshness(pack);

  const headline = events.filter((e) => ['CRITICAL', 'HIGH'].includes(e.fantasyImpact));
  const rest = events.filter((e) => !['CRITICAL', 'HIGH'].includes(e.fantasyImpact));

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold">News</h1>
          {freshness && (
            <span
              className={`text-xs ${
                freshness.level === 'stale'
                  ? 'text-[var(--danger)]'
                  : freshness.level === 'aging'
                    ? 'text-[var(--warn)]'
                    : 'text-[var(--muted)]'
              }`}
            >
              {freshness.label}
            </span>
          )}
        </div>
        {pack?.ok && (
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            {pack.rawItemCount} headlines from {pack.sources.filter((s) => s.ok).length}{' '}
            sources, merged into {pack.events.length} events
          </p>
        )}
      </header>

      {loading && <SkeletonFeed />}

      {!loading && !pack && (
        <Notice
          tone="danger"
          title="News data could not be loaded"
          body="The feed file is missing from this deployment. That means I can't tell you what happened — not that nothing happened. Draft mode is unaffected; it runs from your local pack."
        />
      )}

      {!loading && pack && !pack.ok && (
        <Notice
          tone="danger"
          title="No news was collected in the last build"
          body={
            pack.reason ??
            'Every source failed during the build. This is a system fault, not an absence of news.'
          }
        />
      )}

      {!loading && pack?.ok && pack.events.length === 0 && (
        <Notice
          tone="muted"
          title="Nothing fantasy-relevant in the window"
          body={`${pack.rawItemCount} headlines were checked and none cleared the relevance bar. An empty feed here means "nothing worth your attention", not "nothing was fetched".`}
        />
      )}

      {pack?.ok && pack.events.length > 0 && (
        <>
          <FilterBar value={filter} onChange={setFilter} />

          {headline.length > 0 && (
            <section className="space-y-2">
              <SectionLabel>Needs your attention</SectionLabel>
              {headline.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  expanded={expanded === event.id}
                  onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
                />
              ))}
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-2">
              <SectionLabel>Worth knowing</SectionLabel>
              {rest.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  expanded={expanded === event.id}
                  onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
                />
              ))}
            </section>
          )}

          {events.length === 0 && (
            <p className="py-8 text-center text-sm text-[var(--muted)]">
              Nothing matches this filter.
            </p>
          )}
        </>
      )}

      {pack && <SourceFooter pack={pack} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EventCard({
  event,
  expanded,
  onToggle,
}: {
  event: NewsEventView;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article className="card p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-3">
          <ImpactRail impact={event.fantasyImpact} direction={event.playerDirection} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="tag bg-[var(--surface-2)] text-[var(--muted)]">
                {eventTypeLabel(event.eventType)}
              </span>
              {event.players.slice(0, 2).map((p) => (
                <span key={p.name} className="tag bg-[var(--accent)]/15 text-[var(--accent)]">
                  {p.name}
                  {p.position ? ` · ${p.position}` : ''}
                </span>
              ))}
              {event.sources.length > 1 && (
                <span className="tag bg-sky-400/15 text-sky-300">
                  {event.sources.length} sources
                </span>
              )}
            </div>

            <h2 className="mt-1.5 text-[15px] font-semibold leading-snug">
              {event.headline}
            </h2>

            {/* The "so what" — derived from the classification, never invented. */}
            <p className="claim-INFERENCE mt-2 text-[13px] leading-snug text-[var(--muted)]">
              {impactSentence(event)}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[var(--muted)]">
              <span>{relativeTime(event.firstReportedAt)}</span>
              <span>·</span>
              <span>{Math.round(event.confidence * 100)}% confidence</span>
              <span>·</span>
              <span className="underline">{expanded ? 'less' : 'details'}</span>
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
          {event.summary && (
            <p className="text-[13px] leading-relaxed text-[var(--muted)]">{event.summary}</p>
          )}

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
            <Detail label="Impact score" value={`${Math.round(event.impactScore)} / 100`} />
            <Detail label="Classification" value={event.classification.replace('_', ' ')} />
            <Detail label="Direction" value={event.playerDirection.replace('_', ' ').toLowerCase()} />
            {event.positions.length > 0 && (
              <Detail label="Positions" value={event.positions.join(', ')} />
            )}
          </dl>

          {/* Why it was classified this way — the rating is explicable, not a
              black box, which is the whole point of doing it in code. */}
          {event.signals.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
                Why it scored this way
              </p>
              <ul className="mt-1 space-y-0.5">
                {event.signals.map((signal, i) => (
                  <li key={i} className="text-[12px] text-[var(--muted)]">
                    · {signal}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
              Reported by
            </p>
            <ul className="mt-1 space-y-1">
              {event.sources.map((source, i) => (
                <li key={i} className="text-[12px]">
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-sky-400 underline"
                    >
                      {source.name}
                    </a>
                  ) : (
                    <span>{source.name}</span>
                  )}
                  <span className="text-[var(--muted)]">
                    {' '}
                    · {relativeTime(source.publishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}

/** Colour-coded spine: severity by height of colour, direction by hue. */
function ImpactRail({ impact, direction }: { impact: string; direction: string }) {
  const tone =
    direction.includes('NEGATIVE')
      ? 'bg-[var(--danger)]'
      : direction.includes('POSITIVE')
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--muted)]';

  const height =
    impact === 'CRITICAL' ? 'h-full' : impact === 'HIGH' ? 'h-2/3' : impact === 'MEDIUM' ? 'h-1/2' : 'h-1/4';

  return (
    <div className="flex w-1 shrink-0 self-stretch rounded-full bg-[var(--surface-2)]">
      <div className={`w-full rounded-full ${tone} ${height}`} />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function FilterBar({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (next: Filter) => void;
}) {
  const options: Array<[Filter, string]> = [
    ['all', 'All'],
    ['injury', 'Injuries'],
    ['roles', 'Roles & moves'],
    ['linked', 'My board'],
  ];
  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`min-h-[36px] shrink-0 rounded-lg px-3 text-sm ${
            value === key
              ? 'bg-[var(--accent)] text-[#08130c]'
              : 'bg-[var(--surface-2)] text-[var(--muted)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pt-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">
      {children}
    </h2>
  );
}

function Notice({
  tone,
  title,
  body,
}: {
  tone: 'danger' | 'muted';
  title: string;
  body: string;
}) {
  return (
    <div
      className={`card ${tone === 'danger' ? 'border-[var(--danger)]/40' : ''}`}
    >
      <h2
        className={`font-semibold ${
          tone === 'danger' ? 'text-[var(--danger)]' : ''
        }`}
      >
        {title}
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}

function SkeletonFeed() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card animate-pulse">
          <div className="h-3 w-24 rounded bg-[var(--surface-2)]" />
          <div className="mt-2 h-4 w-full rounded bg-[var(--surface-2)]" />
          <div className="mt-1.5 h-4 w-2/3 rounded bg-[var(--surface-2)]" />
        </div>
      ))}
    </div>
  );
}

/** Every source is listed, including the ones that failed. */
function SourceFooter({ pack }: { pack: NewsPack }) {
  return (
    <details className="card text-sm">
      <summary className="cursor-pointer font-semibold">Where this came from</summary>
      <ul className="mt-2 space-y-1">
        {pack.sources.map((source) => (
          <li key={source.key} className="flex items-baseline gap-2 text-[13px]">
            <span className={source.ok ? 'text-[var(--accent)]' : 'text-[var(--danger)]'}>
              {source.ok ? '✓' : '✗'}
            </span>
            <span className="flex-1">{source.name}</span>
            <span className="text-[var(--muted)]">
              {source.ok ? `${source.itemCount} items` : (source.error ?? 'failed')}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-[var(--muted)]">
        Headlines come from public RSS feeds and are shown with attribution and a
        link back to the publisher. Article text is never copied or stored. This
        deployment has no server, so the feed is rebuilt on a schedule — it is as
        current as the build time shown above, and never claims otherwise.
      </p>
    </details>
  );
}
