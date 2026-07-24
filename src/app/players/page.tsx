'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { loadPack, type DraftPack } from '@/lib/draft-pack';
import { loadPlayerPack, packFreshness, type PlayerPack } from '@/lib/static-data';
import { computeReplacementLevels, valueOverReplacement } from '@/lib/engine/valuation';
import { searchKey } from '@/lib/sources/types';
import { POSITIONS, type PlayerCard, type Position } from '@/lib/types';

type SortKey = 'value' | 'adp' | 'projected';

/** Player board / rankings (§27). Reads the local pack; no network. */
export default function PlayersPage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  // Shipped with the build so the board is never blank before a CSV import.
  const [fallback, setFallback] = useState<PlayerPack | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<Position | 'ALL'>('ALL');
  const [sort, setSort] = useState<SortKey>('value');

  useEffect(() => {
    const local = loadPack();
    setPack(local);
    setHydrated(true);
    // Only needed when the user has not imported their own ADP yet.
    if (!local || local.players.length === 0) {
      void loadPlayerPack().then(setFallback);
    }
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

  // Without an imported CSV, show the real NFL player list that ships with the
  // build. It has no ADP and no projections, so it is explicitly presented as a
  // roster reference rather than a draft board — claiming otherwise would be
  // passing off one platform's popularity ordering as consensus value.
  if (!pack || pack.players.length === 0) {
    return <FallbackBoard pack={fallback} loading={fallback === null} />;
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

function FallbackBoard({
  pack,
  loading,
}: {
  pack: PlayerPack | null;
  loading: boolean;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<Position | 'ALL'>('ALL');

  const rows = useMemo(() => {
    if (!pack) return [];
    const key = searchKey(query);
    return pack.players
      .filter((p) => position === 'ALL' || p.position === position)
      .filter((p) => !key || searchKey(p.name).includes(key))
      .slice(0, 250);
  }, [pack, query, position]);

  if (loading) {
    return <p className="mt-8 text-center text-[var(--muted)]">Loading players…</p>;
  }

  if (!pack || !pack.ok || pack.players.length === 0) {
    return (
      <div className="card mt-8 text-center">
        <h1 className="text-xl font-bold">No player data</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {pack?.reason ?? 'Import an ADP file to build your board.'}
        </p>
        <Link href="/settings" className="btn-primary mt-4 inline-flex items-center">
          Import data
        </Link>
      </div>
    );
  }

  const freshness = packFreshness(pack);

  return (
    <div className="space-y-3">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">Players</h1>
        <p className="text-xs text-[var(--muted)]">
          {pack.players.length} NFL players · {freshness?.label ?? ''}
        </p>
      </header>

      <div className="card border-[var(--warn)]/40">
        <h2 className="text-sm font-semibold text-[var(--warn)]">
          Reference list, not a draft board
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          These are real players and teams from Sleeper, ordered by that platform&apos;s
          own popularity ranking. That is <strong>not</strong> consensus ADP and carries
          no projections, so no value or tier is shown. Import an ADP CSV and this
          becomes a ranked board with value over replacement.
        </p>
        <Link href="/settings" className="btn-primary mt-3 inline-flex items-center">
          Import ADP
        </Link>
      </div>

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

      <ul className="space-y-1">
        {rows.map((player) => (
          <li
            key={player.id}
            className="flex items-center gap-3 rounded-xl bg-[var(--surface)] px-3 py-2.5"
          >
            <span className="tag w-11 shrink-0 justify-center bg-[var(--surface-2)] text-[var(--muted)]">
              {player.position}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{player.name}</p>
              <p className="text-xs text-[var(--muted)]">
                {player.team ?? 'FA'}
                {player.injuryStatus ? ` · ${player.injuryStatus}` : ''}
                {player.depthChartOrder ? ` · depth ${player.depthChartOrder}` : ''}
              </p>
            </div>
            {player.sleeperRank !== undefined && (
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">#{player.sleeperRank}</p>
                <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  Sleeper
                </p>
              </div>
            )}
          </li>
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
