'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { loadPack, type DraftPack } from '@/lib/draft-pack';
import { computeReplacementLevels, valueOverReplacement } from '@/lib/engine/valuation';
import { searchKey } from '@/lib/sources/types';
import { POSITIONS, type PlayerCard, type Position } from '@/lib/types';

type SortKey = 'value' | 'adp' | 'projected';

/** Player board / rankings (§27). Reads the local pack; no network. */
export default function PlayersPage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<Position | 'ALL'>('ALL');
  const [sort, setSort] = useState<SortKey>('value');

  useEffect(() => {
    setPack(loadPack());
    setHydrated(true);
  }, []);

  const rows = useMemo(() => {
    if (!pack) return [];
    const replacement = computeReplacementLevels(pack.players, pack.league);
    const key = searchKey(query);

    return pack.players
      .filter((p) => position === 'ALL' || p.position === position)
      .filter((p) => !key || searchKey(p.name).includes(key))
      .map((p) => ({ player: p, vor: valueOverReplacement(p, replacement) }))
      .sort((a, b) => {
        if (sort === 'adp') return (a.player.adp ?? 9999) - (b.player.adp ?? 9999);
        if (sort === 'projected')
          return (b.player.projectedPoints ?? 0) - (a.player.projectedPoints ?? 0);
        return b.vor - a.vor;
      })
      .slice(0, 200);
  }, [pack, query, position, sort]);

  if (!hydrated) return <p className="mt-8 text-center text-[var(--muted)]">Loading…</p>;

  if (!pack || pack.players.length === 0) {
    return (
      <div className="card mt-8 text-center">
        <h1 className="text-xl font-bold">No player data</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Import an ADP file to build your board.
        </p>
        <Link href="/settings" className="btn-primary mt-4 inline-flex items-center">
          Import data
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">Player board</h1>
        <p className="text-xs text-[var(--muted)]">
          {pack.players.length} players · ranked for {pack.league.name}
        </p>
      </header>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search players…"
        autoCorrect="off"
        spellCheck={false}
        className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 outline-none focus:border-[var(--accent)]"
      />

      <div className="flex gap-1 overflow-x-auto pb-1">
        {(['ALL', ...POSITIONS] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setPosition(option)}
            className={`min-h-[36px] shrink-0 rounded-lg px-3 text-sm ${
              position === option
                ? 'bg-[var(--accent)] text-[#08130c]'
                : 'bg-[var(--surface-2)] text-[var(--muted)]'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        {(
          [
            ['value', 'Value'],
            ['adp', 'ADP'],
            ['projected', 'Projected'],
          ] as Array<[SortKey, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSort(key)}
            className={`min-h-[32px] flex-1 rounded-lg text-xs ${
              sort === key ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="space-y-1">
        {rows.map(({ player, vor }) => (
          <PlayerRow key={player.id} player={player} vor={vor} />
        ))}
      </ul>

      {rows.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--muted)]">No players match.</p>
      )}
    </div>
  );
}

function PlayerRow({ player, vor }: { player: PlayerCard; vor: number }) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-[var(--surface)] px-3 py-2.5">
      <span className="tag w-11 shrink-0 justify-center bg-[var(--surface-2)] text-[var(--muted)]">
        {player.position}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{player.name}</p>
        <p className="text-xs text-[var(--muted)]">
          {player.team ?? 'FA'}
          {player.tier !== undefined ? ` · Tier ${player.tier}` : ''}
          {player.byeWeek ? ` · Bye ${player.byeWeek}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">
          {player.adp !== undefined ? player.adp.toFixed(1) : '—'}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">ADP</p>
      </div>
      <div className="w-14 shrink-0 text-right">
        <p
          className={`text-sm font-semibold tabular-nums ${
            vor > 0 ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
          }`}
        >
          {vor > 0 ? '+' : ''}
          {vor.toFixed(0)}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">VOR</p>
      </div>
    </li>
  );
}
