'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { describePackFreshness, loadPack, type DraftPack } from '@/lib/draft-pack';

/**
 * The draft-day run sheet.
 *
 * Written for one specific moment: a bar on August 30, a two-minute pick
 * clock, and a person who should be enjoying the party rather than operating
 * software. Every step is something to tap, in order, with the reason attached
 * so nothing has to be remembered or trusted blindly.
 *
 * The page checks the local board and says whether each setup step is already
 * done — a checklist that knows its own state beats a checklist on paper.
 */
export default function GuidePage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPack(loadPack());
    setHydrated(true);
  }, []);

  const freshness = describePackFreshness(pack);
  const hasBoard = (pack?.players.length ?? 0) > 0;
  const hasTeRule = (pack?.league.rosterSlots.TE ?? 0) >= 1;
  const hasSlot = pack?.league.draftSlot != null;
  const setupDone = hasBoard && hasTeRule && hasSlot;

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">Draft day</h1>
        <p className="text-sm text-[var(--muted)]">
          The whole run sheet. Aug 30, 3:00 PM Central, 2 minutes per pick, seat 10.
        </p>
      </header>

      {hydrated && (
        <section
          className={`card ${setupDone ? 'border-[var(--accent)]/40' : 'border-[var(--warn)]/40'}`}
        >
          <h2 className={`text-sm font-semibold ${setupDone ? 'text-[var(--accent)]' : 'text-[var(--warn)]'}`}>
            {setupDone ? 'Setup is done — you are draft-ready' : 'Setup still needed'}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            <CheckRow ok={hasBoard} label="Player board built on this device" />
            <CheckRow ok={hasTeRule} label="Post-party rules loaded (mandatory TE, 6 bench)" />
            <CheckRow ok={hasSlot} label={`Draft seat set${hasSlot ? ` — slot ${pack!.league.draftSlot}` : ''}`} />
          </ul>
          {!setupDone && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Fix all three in one place: Settings → Load Bay Islands Fantasy → Use the
              shipped player board. Two taps.
            </p>
          )}
          {setupDone && freshness && (
            <p className="mt-2 text-xs text-[var(--muted)]">Data: {freshness.label}</p>
          )}
        </section>
      )}

      <Steps
        title="The night before, at home (5 minutes)"
        steps={[
          ['Open this app on the laptop you are bringing', 'Everything lives on the device it was set up on — the bar copy of your board is the one you build now.'],
          ['Settings → Load Bay Islands Fantasy', 'Loads the post-party rules: mandatory TE, 6 bench, your seat 10.'],
          ['Settings → Use the shipped player board', 'Pulls the freshest ADP, projections, byes and injuries into your offline board.'],
          ['Open the Plan tab and read it once', 'Deadlines, targets, fades — the plan you want in your head before the room gets loud.'],
        ]}
      />

      <Steps
        title="When you arrive at the bar (2 minutes)"
        steps={[
          ['Open the app, go to Settings → Use the shipped player board once more', 'One tap re-pulls data as of ~3 hours ago — catches any morning injury news. Skip if the wifi is hopeless; last night’s board is fine.'],
          ['Open the Draft tab', 'The war room. From this moment the app needs no internet at all.'],
          ['Put the ESPN draft room on your phone or a second window', 'You still make your actual picks in ESPN like everyone else. This app is the brain beside it.'],
        ]}
      />

      <Steps
        title="During the draft — the loop"
        steps={[
          ['When anyone else picks: record it', 'Two taps — find the player, tap draft. Or say it out loud with the mic. The board, deadlines and advice update instantly.'],
          ['Fallen behind? “League private? Paste to sync”', 'Open the league data link in a logged-in ESPN tab, copy, paste — every pick made so far lands at once.'],
          ['When you are on the clock: read the Take card', 'The big name is the pick; the reasons underneath are why. Alternatives are listed if the room has you doubting.'],
          ['Make that pick in ESPN, then record it here', 'The app never talks to ESPN for you — you stay in control of your actual pick.'],
          ['Wrong entry? Undo or “correct pick N”', 'Nothing is ever stuck. History is editable until it matches the room.'],
        ]}
      />

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold">If things go sideways</h2>
        <ul className="space-y-1.5 text-sm text-[var(--muted)]">
          <li>
            <span className="text-[var(--text)]">Bar wifi dies:</span> nothing is lost.
            The board, the engine and every recorded pick are on this device. Keep
            recording picks manually; advice keeps working.
          </li>
          <li>
            <span className="text-[var(--text)]">Laptop dies:</span> the same site works
            on your phone — but the board lives per-device, so build it on the phone
            too (Settings, two taps) before draft day as a spare.
          </li>
          <li>
            <span className="text-[var(--text)]">App closed or page refreshed:</span>{' '}
            the draft resumes exactly where it was. State survives reloads and lock
            screens.
          </li>
          <li>
            <span className="text-[var(--text)]">ESPN pick you can’t find here:</span>{' '}
            paste-sync names the pick it can’t match and waits. Record that one by
            hand; it resumes on its own.
          </li>
        </ul>
      </section>

      <section className="card space-y-1">
        <h2 className="text-sm font-semibold">The plan, in one breath</h2>
        <p className="text-sm text-[var(--muted)]">
          From seat 10: best available RB/WR early. The elite TEs are gone by pick
          ~24 — taking one there is now correct, not a reach. The big RB group dries
          up by ~39. Elite QBs last until ~79, where your 6-point-TD scoring makes
          them a discount. Kicker and defense in the last two rounds, never earlier.
          The <Link href="/plan" className="text-sky-400 underline">Plan tab</Link>{' '}
          has the live version with names.
        </p>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Link href="/plan" className="btn-ghost flex items-center justify-center">
          Draft plan
        </Link>
        <Link href="/draft" className="btn-primary flex items-center justify-center">
          War room
        </Link>
      </div>
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className={ok ? 'text-[var(--accent)]' : 'text-[var(--warn)]'}>
        {ok ? '✓' : '○'}
      </span>
      <span className={ok ? '' : 'text-[var(--muted)]'}>{label}</span>
    </li>
  );
}

function Steps({ title, steps }: { title: string; steps: Array<[string, string]> }) {
  return (
    <section className="card space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ol className="space-y-2.5">
        {steps.map(([action, why], i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="w-5 shrink-0 font-bold tabular-nums text-[var(--accent)]">
              {i + 1}
            </span>
            <span>
              <span className="block font-medium">{action}</span>
              <span className="block text-xs leading-snug text-[var(--muted)]">{why}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
