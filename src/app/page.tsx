'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CoachBar } from '@/components/CoachBar';
import { describePackFreshness, loadPack, type DraftPack } from '@/lib/draft-pack';
import { Briefing } from '@/components/Briefing';
import { loadNewsPack, packFreshness, type NewsPack } from '@/lib/static-data';
import { parseCommand } from '@/lib/coach/intents';
import { HELP_TEXT } from '@/lib/coach/intents';

/**
 * HOME (§27) — answers one question: "what do I need to know right now?"
 *
 * Before the draft that means: is my system ready? After it starts, the draft
 * tab takes over entirely.
 */
export default function HomePage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [news, setNews] = useState<NewsPack | null>(null);
  const [newsLoading, setNewsLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setPack(loadPack());
    setHydrated(true);
    loadNewsPack()
      .then(setNews)
      .finally(() => setNewsLoading(false));
  }, []);

  const freshness = describePackFreshness(pack);
  const newsFreshness = packFreshness(news);
  const daysToDraft = daysUntil(DRAFT_DAY);

  const handleCommand = (text: string) => {
    const parsed = parseCommand(text, { inDraftMode: false });
    switch (parsed.intent) {
      case 'DRAFT_MODE':
      case 'MY_PICK':
        window.location.href = '/draft';
        return;
      case 'HELP':
        setMessage(HELP_TEXT);
        return;
      case 'WAKE':
        setMessage("Ready. Ask me anything — or say \"draft mode\".");
        return;
      case 'MY_TEAM':
        window.location.href = '/team';
        return;
      case 'NEWS':
      case 'BRIEFING':
      case 'INJURIES':
        window.location.href = '/news';
        return;
      case 'RANKINGS':
      case 'VALUES':
      case 'SLEEPERS':
      case 'RISKS':
        window.location.href = '/players';
        return;
      default:
        setMessage(
          "I'm not sure what you're asking for. Say \"help\" to see what I understand.",
        );
    }
  };

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <h1 className="text-3xl font-black tracking-tight">Coach</h1>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-[var(--muted)]">
            {daysToDraft > 0
              ? `${daysToDraft} day${daysToDraft === 1 ? '' : 's'} until your draft.`
              : 'Draft day.'}
          </p>
          {newsFreshness && (
            <span
              className={`text-xs ${
                newsFreshness.level === 'stale'
                  ? 'text-[var(--danger)]'
                  : 'text-[var(--muted)]'
              }`}
            >
              {newsFreshness.label}
            </span>
          )}
        </div>
      </header>

      <CoachBar onSubmit={handleCommand} placeholder='Say "Coach"…' />

      {message && (
        <div className="card">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
            {message}
          </pre>
          <button
            type="button"
            className="mt-3 text-xs text-[var(--muted)] underline"
            onClick={() => setMessage(null)}
          >
            dismiss
          </button>
        </div>
      )}

      {newsLoading ? (
        <div className="card animate-pulse">
          <div className="h-3 w-28 rounded bg-[var(--surface-2)]" />
          <div className="mt-3 h-4 w-full rounded bg-[var(--surface-2)]" />
          <div className="mt-1.5 h-4 w-3/4 rounded bg-[var(--surface-2)]" />
        </div>
      ) : (
        <Briefing pack={news} />
      )}

      {hydrated && <ReadinessCard pack={pack} freshnessLabel={freshness?.label} freshnessLevel={freshness?.level} />}

      <div className="grid grid-cols-2 gap-2">
        <Link href="/draft" className="btn-primary flex items-center justify-center">
          Draft mode
        </Link>
        <Link href="/players" className="btn-ghost flex items-center justify-center">
          Player board
        </Link>
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold">How this works</h2>
        <ul className="mt-2 space-y-2 text-sm text-[var(--muted)]">
          <li>
            <span className="text-[var(--text)]">Recommendations are computed, not generated.</span>{' '}
            The engine picks; the AI only puts it into words.
          </li>
          <li>
            <span className="text-[var(--text)]">Draft mode works offline.</span>{' '}
            Sync a pack before the draft and the war room needs no network.
          </li>
          <li>
            <span className="text-[var(--text)]">Nothing is invented.</span>{' '}
            If data is old, it says so. If it doesn't know, it says that too.
          </li>
        </ul>
      </div>
    </div>
  );
}

function ReadinessCard({
  pack,
  freshnessLabel,
  freshnessLevel,
}: {
  pack: DraftPack | null;
  freshnessLabel?: string;
  freshnessLevel?: string;
}) {
  if (!pack) {
    return (
      <div className="card border-[var(--warn)]/40">
        <h2 className="font-semibold text-[var(--warn)]">Not ready for draft day</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          No draft pack yet. Load your league and tap{' '}
          <span className="font-medium text-[var(--fg)]">Use the shipped player board</span> —
          real players, ESPN ADP and bye weeks are already in the build. After that the
          war room works with no network at all.
        </p>
        <Link href="/settings" className="btn-primary mt-3 inline-flex items-center">
          Set up
        </Link>
      </div>
    );
  }

  const withAdp = pack.players.filter((p) => p.adp !== undefined).length;
  const ready = withAdp > 50;

  return (
    <div className={`card ${ready ? 'border-[var(--accent)]/40' : 'border-[var(--warn)]/40'}`}>
      <h2 className={`font-semibold ${ready ? 'text-[var(--accent)]' : 'text-[var(--warn)]'}`}>
        {ready ? 'Ready for draft day' : 'Partially ready'}
      </h2>
      <dl className="mt-2 space-y-1 text-sm">
        <Row label="League" value={pack.league.name} />
        <Row label="Players" value={`${pack.players.length}`} />
        <Row
          label="With ADP"
          value={`${withAdp}${withAdp <= 50 ? ' — import ADP for reliable advice' : ''}`}
        />
        <Row label="Data" value={freshnessLabel ?? 'unknown'} />
      </dl>
      {freshnessLevel === 'stale' && (
        <p className="mt-2 text-xs text-[var(--danger)]">
          Re-sync before you draft — recommendations are only as current as this snapshot.
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="truncate text-right">{value}</dd>
    </div>
  );
}

/** The deadline the whole project is built around. */
const DRAFT_DAY = '2026-08-30T00:00:00Z';

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}
