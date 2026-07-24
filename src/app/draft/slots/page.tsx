'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { loadPack, savePack, type DraftPack } from '@/lib/draft-pack';
import {
  analyzePositionalLandscape,
  planAllSlots,
  type SlotPlan,
} from '@/lib/engine/slot-planner';
import type { Position } from '@/lib/types';

/**
 * SLOT PLANNER.
 *
 * Bay Islands sets its draft order manually and does not announce it until the
 * pre-draft party. That means the plan cannot be "prepare for my slot" — it has
 * to be "prepare for all twelve, then pick one up on the night".
 *
 * Everything here runs locally against the draft pack.
 */
export default function SlotPlannerPage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const loaded = loadPack();
    setPack(loaded);
    setSelected(loaded?.league.draftSlot ?? null);
    setHydrated(true);
  }, []);

  const rounds = useMemo(() => {
    if (!pack) return 15;
    const starters = Object.entries(pack.league.rosterSlots)
      .filter(([slot]) => slot !== 'BENCH')
      .reduce((sum, [, n]) => sum + (n ?? 0), 0);
    return starters + pack.league.benchSize;
  }, [pack]);

  // Simulating twelve full drafts is real work, so it is memoized on the pack.
  const result = useMemo(
    () => (pack && pack.players.length > 0 ? planAllSlots(pack.players, pack.league, { rounds }) : null),
    [pack, rounds],
  );

  const landscape = useMemo(
    () => (pack && pack.players.length > 0 ? analyzePositionalLandscape(pack.players, pack.league) : null),
    [pack],
  );

  const confirmSlot = (slot: number) => {
    if (!pack) return;
    const updated = { ...pack, league: { ...pack.league, draftSlot: slot } };
    savePack(updated);
    setPack(updated);
    setSelected(slot);
    setSaved(true);
  };

  if (!hydrated) return <p className="mt-8 text-center text-[var(--muted)]">Loading…</p>;

  if (!pack || pack.players.length === 0) {
    return (
      <div className="card mt-8 text-center">
        <h1 className="text-xl font-bold">No player data yet</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          The slot planner simulates a full draft from each of the twelve seats, so it
          needs your ADP import first.
        </p>
        <Link href="/settings" className="btn-primary mt-4 inline-flex items-center">
          Import data
        </Link>
      </div>
    );
  }

  const plan = selected ? result?.plans.find((p) => p.slot === selected) : undefined;

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">Slot planner</h1>
        <p className="text-sm text-[var(--muted)]">
          Your league draws the order at the party on Aug 8. Until then, here is the
          plan for every seat.
        </p>
      </header>

      {pack.league.draftSlot === null ? (
        <p className="rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-sm text-[var(--warn)]">
          Draft slot not set. Tap a seat below to see its plan — and confirm it once you
          know.
        </p>
      ) : (
        <p className="rounded-lg bg-[var(--accent)]/10 px-3 py-2 text-sm text-[var(--accent)]">
          Drafting from seat {pack.league.draftSlot}.
          {saved && ' Saved — the war room is configured.'}
        </p>
      )}

      {landscape && <LandscapeCard landscape={landscape} />}

      <section className="card">
        <h2 className="text-sm font-semibold">Pick a seat</h2>
        <div className="mt-2 grid grid-cols-6 gap-1.5">
          {Array.from({ length: pack.league.teamCount }, (_, i) => i + 1).map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => setSelected(slot)}
              className={`min-h-[44px] rounded-lg text-sm font-semibold ${
                selected === slot
                  ? 'bg-[var(--accent)] text-[#08130c]'
                  : 'bg-[var(--surface-2)] text-[var(--text)]'
              }`}
            >
              {slot}
            </button>
          ))}
        </div>
      </section>

      {plan && (
        <SlotDetail
          plan={plan}
          isConfirmed={pack.league.draftSlot === plan.slot}
          onConfirm={() => confirmSlot(plan.slot)}
        />
      )}

      {result && (
        <section className="card">
          <h2 className="text-sm font-semibold">Seats by simulated roster strength</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Projected starting points from one simulation per seat. The spread between
            seats is usually small — treat this as texture, not a verdict.
          </p>
          <ul className="mt-2 space-y-1">
            {result.ranking.map((entry, i) => (
              <li key={entry.slot} className="flex items-center gap-3 text-sm">
                <span className="w-5 shrink-0 text-xs text-[var(--muted)]">{i + 1}.</span>
                <span className="flex-1">Seat {entry.slot}</span>
                <span className="tabular-nums text-[var(--muted)]">
                  {entry.points.toFixed(0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result && (
        <details className="card text-sm">
          <summary className="cursor-pointer font-semibold">
            What this simulation assumes
          </summary>
          <ul className="mt-2 space-y-1 text-[var(--muted)]">
            {result.assumptions.map((assumption, i) => (
              <li key={i} className="claim-UNCERTAINTY text-[13px]">
                {assumption}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SlotDetail({
  plan,
  isConfirmed,
  onConfirm,
}: {
  plan: SlotPlan;
  isConfirmed: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-lg font-bold">Seat {plan.slot}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{plan.summary}</p>
      </div>

      <div className="rounded-xl bg-[var(--surface-2)] p-3">
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
          Your picks
        </p>
        <p className="mt-1 text-sm tabular-nums">
          {plan.picks.slice(0, 8).join(' · ')}
          {plan.picks.length > 8 ? ' …' : ''}
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Longest wait between picks: {plan.longestGap}
        </p>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
          Opening picks in simulation
        </p>
        <ol className="mt-1.5 space-y-1.5">
          {plan.earlyPicks.map((pick) => (
            <li key={pick.overallPick} className="text-sm">
              <span className="text-[var(--muted)]">R{pick.round}.{String(pick.overallPick).padStart(2, '0')}</span>{' '}
              <span className="font-medium">{pick.playerName}</span>{' '}
              <span className="text-xs text-[var(--muted)]">{pick.position}</span>
            </li>
          ))}
        </ol>
      </div>

      {plan.realisticTargets.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
            Realistically available at pick {plan.picks[0]}
          </p>
          <ul className="mt-1.5 space-y-1">
            {plan.realisticTargets.map((target) => (
              <li key={target.name} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{target.name}</span>
                <span className="text-xs text-[var(--muted)]">{target.position}</span>
                <span className="w-10 text-right tabular-nums text-[var(--muted)]">
                  {Math.round(target.probability * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
          Roster shape produced
        </p>
        <p className="mt-1 text-sm">
          {Object.entries(plan.rosterShape)
            .sort(([a], [b]) => POSITION_ORDER.indexOf(a as Position) - POSITION_ORDER.indexOf(b as Position))
            .map(([position, count]) => `${count} ${position}`)
            .join(' · ')}
        </p>
      </div>

      <button
        type="button"
        onClick={onConfirm}
        disabled={isConfirmed}
        className={isConfirmed ? 'btn-ghost w-full' : 'btn-primary w-full'}
      >
        {isConfirmed ? `Seat ${plan.slot} is set` : `This is my seat — set slot ${plan.slot}`}
      </button>
    </section>
  );
}

function LandscapeCard({
  landscape,
}: {
  landscape: ReturnType<typeof analyzePositionalLandscape>;
}) {
  return (
    <section className="card">
      <h2 className="text-sm font-semibold">
        What holds regardless of where you pick
      </h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Positional scarcity comes from your league&apos;s rules and the player pool, not
        from your seat. This is true on Aug 8 whether you draw 1st or 12th.
      </p>
      <ul className="mt-3 space-y-2">
        {landscape
          .filter((edge) => edge.position !== 'K' && edge.position !== 'DST')
          .map((edge) => (
            <li key={edge.position} className="text-sm">
              <span className="tag mr-2 bg-[var(--surface-2)] text-[var(--muted)]">
                {edge.position}
              </span>
              <span className="text-[var(--muted)]">{edge.note}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}

const POSITION_ORDER: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
