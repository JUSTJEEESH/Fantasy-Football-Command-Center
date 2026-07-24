'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { loadDraftState, loadPack, type DraftPack } from '@/lib/draft-pack';
import { analyzeRoster, fillLineup } from '@/lib/engine/roster';
import { userRoster } from '@/lib/engine/draft-state';
import type { DraftState, LineupSlot, PlayerCard } from '@/lib/types';

/** MY TEAM (§27) — roster analysis from the local board. */
export default function TeamPage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [state, setState] = useState<DraftState | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPack(loadPack());
    setState(loadDraftState());
    setHydrated(true);
  }, []);

  const roster = useMemo(() => {
    if (!pack || !state) return [];
    const byId = new Map(pack.players.map((p) => [p.id, p]));
    return userRoster(state)
      .map((id) => byId.get(id))
      .filter((p): p is PlayerCard => Boolean(p));
  }, [pack, state]);

  const analysis = useMemo(
    () => (pack ? analyzeRoster(roster, pack.league) : null),
    [roster, pack],
  );

  const lineup = useMemo(
    () => (pack ? fillLineup(roster, pack.league.rosterSlots) : null),
    [roster, pack],
  );

  if (!hydrated) return <p className="mt-8 text-center text-[var(--muted)]">Loading…</p>;

  if (!pack || roster.length === 0) {
    return (
      <div className="card mt-8 text-center">
        <h1 className="text-xl font-bold">No roster yet</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Your team fills in as you draft.
        </p>
        <Link href="/draft" className="btn-primary mt-4 inline-flex items-center">
          Go to draft
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">My team</h1>
        <p className="text-xs text-[var(--muted)]">
          {roster.length} of {analysis?.total ?? '?'} roster spots filled
        </p>
      </header>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Projected starters</h2>
          <p className="text-2xl font-bold tabular-nums text-[var(--accent)]">
            {analysis?.startingPoints.toFixed(0) ?? '—'}
          </p>
        </div>
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
          Season points, your scoring
        </p>

        {lineup && (
          <ul className="mt-3 space-y-1">
            {[...lineup.starters.entries()].map(([slot, players]) =>
              players.map((player, i) => (
                <li key={`${slot}-${player.id}`} className="flex items-center gap-3 text-sm">
                  <span className="tag w-16 shrink-0 justify-center bg-[var(--surface-2)] text-[var(--muted)]">
                    {slotLabel(slot, i, players.length)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{player.name}</span>
                  <span className="shrink-0 tabular-nums text-[var(--muted)]">
                    {player.projectedPoints?.toFixed(0) ?? '—'}
                  </span>
                </li>
              )),
            )}
          </ul>
        )}
      </div>

      {analysis && analysis.unfilledSlots.length > 0 && (
        <div className="card border-[var(--warn)]/40">
          <h2 className="text-sm font-semibold text-[var(--warn)]">Holes to fill</h2>
          <p className="mt-1 text-sm">{analysis.unfilledSlots.join(', ')}</p>
        </div>
      )}

      {analysis && analysis.weakestPositions.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold">Weakest positions</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {analysis.weakestPositions.join(', ')} — where an upgrade would add the most.
          </p>
        </div>
      )}

      {analysis && analysis.byeConflicts.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold">Bye week clashes</h2>
          <ul className="mt-1 space-y-1 text-sm text-[var(--muted)]">
            {analysis.byeConflicts.map((conflict) => (
              <li key={conflict.week}>
                Week {conflict.week}: {conflict.playerIds.length} starters out
              </li>
            ))}
          </ul>
        </div>
      )}

      {lineup && lineup.bench.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold">Bench</h2>
          <ul className="mt-2 space-y-1">
            {lineup.bench.map((player) => (
              <li key={player.id} className="flex items-center gap-3 text-sm">
                <span className="tag w-11 shrink-0 justify-center bg-[var(--surface-2)] text-[var(--muted)]">
                  {player.position}
                </span>
                <span className="min-w-0 flex-1 truncate">{player.name}</span>
                <span className="shrink-0 tabular-nums text-[var(--muted)]">
                  {player.projectedPoints?.toFixed(0) ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function slotLabel(slot: LineupSlot, index: number, total: number): string {
  return total > 1 ? `${slot}${index + 1}` : slot;
}
