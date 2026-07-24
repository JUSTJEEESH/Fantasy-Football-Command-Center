'use client';

import Link from 'next/link';
import {
  eventTypeLabel,
  relativeTime,
  type NewsEventView,
  type NewsPack,
} from '@/lib/static-data';

/**
 * The morning briefing (§21).
 *
 * Answers "what do I need to know right now?" and nothing else. Sections with
 * nothing in them are omitted rather than padded — an empty section would imply
 * we checked and found nothing noteworthy, which is a different claim from
 * having nothing to show.
 */
export function Briefing({ pack }: { pack: NewsPack | null }) {
  if (!pack) {
    return (
      <div className="card">
        <h2 className="text-sm font-semibold">Briefing unavailable</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          The news data could not be loaded, so I can&apos;t tell you what happened.
          That is not the same as nothing having happened.
        </p>
      </div>
    );
  }

  if (!pack.ok) {
    return (
      <div className="card border-[var(--danger)]/40">
        <h2 className="text-sm font-semibold text-[var(--danger)]">
          No news collected
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{pack.reason}</p>
      </div>
    );
  }

  // Each event appears in at most one section. A briefing that lists the same
  // ACL tear under "biggest news" and again under "injuries" is padding, and
  // padding is exactly what makes a digest feel like noise.
  const used = new Set<string>();
  const take = (
    predicate: (event: NewsEventView) => boolean,
    limit = 3,
  ): NewsEventView[] => {
    const picked = pack.events
      .filter((event) => !used.has(event.id) && predicate(event))
      .slice(0, limit);
    for (const event of picked) used.add(event.id);
    return picked;
  };

  const critical = take((e) => e.fantasyImpact === 'CRITICAL');
  const injuries = take(
    (e) => ['injury', 'practice'].includes(e.eventType) && e.playerDirection.includes('NEGATIVE'),
  );
  const risers = take((e) => e.playerDirection.includes('POSITIVE'));
  const rest = take(() => true);

  if (pack.events.length === 0) {
    return (
      <div className="card">
        <h2 className="text-sm font-semibold">Quiet right now</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {pack.rawItemCount} headlines checked, nothing cleared the fantasy-relevance
          bar. That is a real answer, not an empty screen.
        </p>
      </div>
    );
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Your briefing</h2>
        <Link href="/news" className="text-xs text-sky-400 underline">
          all {pack.events.length} →
        </Link>
      </div>

      {critical.length > 0 && (
        <Section title="Biggest news" tone="danger">
          {critical.map((event) => (
            <BriefingRow key={event.id} event={event} />
          ))}
        </Section>
      )}

      {injuries.length > 0 && (
        <Section title="Injuries to know">
          {injuries.map((event) => (
            <BriefingRow key={event.id} event={event} />
          ))}
        </Section>
      )}

      {risers.length > 0 && (
        <Section title="Trending up" tone="accent">
          {risers.map((event) => (
            <BriefingRow key={event.id} event={event} />
          ))}
        </Section>
      )}

      {critical.length === 0 && injuries.length === 0 && risers.length === 0 && rest.length > 0 && (
        <Section title="Worth knowing">
          {rest.map((event) => (
            <BriefingRow key={event.id} event={event} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  tone = 'muted',
  children,
}: {
  title: string;
  tone?: 'danger' | 'accent' | 'muted';
  children: React.ReactNode;
}) {
  const color =
    tone === 'danger'
      ? 'text-[var(--danger)]'
      : tone === 'accent'
        ? 'text-[var(--accent)]'
        : 'text-[var(--muted)]';
  return (
    <section>
      <h3 className={`text-[10px] font-semibold uppercase tracking-widest ${color}`}>
        {title}
      </h3>
      <ul className="mt-1.5 space-y-2">{children}</ul>
    </section>
  );
}

function BriefingRow({ event }: { event: NewsEventView }) {
  const player = event.players[0];
  return (
    <li className="text-sm leading-snug">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {player && <span className="font-semibold">{player.name}</span>}
        <span className="text-[11px] text-[var(--muted)]">
          {eventTypeLabel(event.eventType)} · {relativeTime(event.firstReportedAt)}
          {event.sources.length > 1 ? ` · ${event.sources.length} sources` : ''}
        </span>
      </div>
      <p className="text-[var(--muted)]">{event.headline}</p>
    </li>
  );
}
