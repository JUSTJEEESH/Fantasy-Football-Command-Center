'use client';

import { useEffect, useState } from 'react';
import { SCORING_PRESETS, type ScoringPreset } from '@/lib/engine/scoring';
import { assignTiers } from '@/lib/engine/valuation';
import {
  importAdpCsv,
  importRankingsCsv,
  makeUniquePlayerId,
} from '@/lib/sources/csv-import';
import { searchKey } from '@/lib/sources/types';
import {
  buildDraftPack,
  clearDraftState,
  clearPack,
  loadPack,
  savePack,
} from '@/lib/draft-pack';
import { BAY_ISLANDS } from '@/lib/leagues/bay-islands';
import type { League, LineupSlot, PlayerCard, Position } from '@/lib/types';

/**
 * League setup wizard + data import (§11).
 *
 * Deliberately importable-from-CSV first: there is no free, terms-clean ADP
 * API, so the path that always works is the one made most prominent.
 */
export default function SettingsPage() {
  const [league, setLeague] = useState<League>(DEFAULT_LEAGUE);
  // null = custom scoring (e.g. a loaded league preset), not one of the presets.
  const [preset, setPreset] = useState<ScoringPreset | null>('ppr');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [packSummary, setPackSummary] = useState<string | null>(null);

  useEffect(() => {
    const pack = loadPack();
    if (pack) {
      setLeague(pack.league);
      setPackSummary(
        `${pack.players.length} players · ${pack.players.filter((p) => p.adp !== undefined).length} with ADP`,
      );
    }
  }, []);

  const updateLeague = <K extends keyof League>(key: K, value: League[K]) =>
    setLeague((current) => ({ ...current, [key]: value }));

  const updateSlot = (slot: LineupSlot, count: number) =>
    setLeague((current) => ({
      ...current,
      rosterSlots: { ...current.rosterSlots, [slot]: count },
    }));

  const applyPreset = (next: ScoringPreset) => {
    setPreset(next);
    updateLeague('scoring', SCORING_PRESETS[next]());
  };

  /**
   * Import ADP (and optionally rankings) and build the offline draft pack.
   * Everything below happens in the browser — the file is never uploaded.
   */
  const handleAdpFile = async (file: File) => {
    setWarnings([]);
    const text = await file.text();
    const result = importAdpCsv(text, { format: league.adpFormat, source: file.name });

    if (!result.ok) {
      setStatus({ kind: 'error', text: result.error ?? 'Import failed.' });
      return;
    }

    // Ids must be unique even when two players normalize to the same name.
    const nextId = makeUniquePlayerId();

    const players: PlayerCard[] = result.items
      .filter((row) => row.position)
      .map((row) => ({
        id: nextId(row.position as string, row.playerName),
        name: row.playerName,
        position: row.position as Position,
        team: row.nflTeam ?? null,
        adp: row.adp,
        adpStdev: row.adpStdev,
        adpSource: row.source,
        adpFetchedAt: result.fetchedAt,
        // Without a projection source we derive a points estimate from ADP so
        // the engine has something to rank with. It is explicitly an estimate,
        // and importing real projections replaces it.
        projectedPoints: estimatePointsFromAdp(row.adp, row.position as Position),
        fetchedAt: result.fetchedAt,
      }));

    const tiers = assignTiers(players);
    for (const player of players) player.tier = tiers.get(player.id);

    const pack = buildDraftPack({
      league,
      players,
      dataFetchedAt: result.fetchedAt,
      sources: [{ key: file.name, fetchedAt: result.fetchedAt }],
    });

    const saved = savePack(pack);
    if (!saved.ok) {
      setStatus({ kind: 'error', text: saved.error ?? 'Could not save the pack.' });
      return;
    }

    setWarnings(result.warnings.slice(0, 8));
    setPackSummary(`${players.length} players · ${players.length} with ADP`);
    setStatus({
      kind: 'ok',
      text: `Imported ${players.length} players. Draft mode now works offline.`,
    });
  };

  const handleRankingsFile = async (file: File) => {
    const pack = loadPack();
    if (!pack) {
      setStatus({ kind: 'error', text: 'Import ADP first — rankings attach to those players.' });
      return;
    }
    const result = importRankingsCsv(await file.text(), { format: league.adpFormat });
    if (!result.ok) {
      setStatus({ kind: 'error', text: result.error ?? 'Import failed.' });
      return;
    }

    const byKey = new Map(result.items.map((r) => [searchKey(r.playerName), r]));
    let matched = 0;
    for (const player of pack.players) {
      const ranking = byKey.get(searchKey(player.name));
      if (!ranking) continue;
      matched++;
      player.consensusRank = ranking.overallRank ?? player.consensusRank;
      player.positionRank = ranking.positionRank ?? player.positionRank;
      if (ranking.tier !== undefined) player.tier = ranking.tier;
    }

    savePack(pack);
    setStatus({
      kind: matched > 0 ? 'ok' : 'error',
      text:
        matched > 0
          ? `Matched ${matched} of ${result.items.length} ranked players.`
          : 'No players matched — check that the names use the same format.',
    });
  };

  const saveLeagueOnly = () => {
    const pack = loadPack();
    if (!pack) {
      setStatus({
        kind: 'info',
        text: 'League saved locally. Import ADP to complete the draft pack.',
      });
      savePack(buildDraftPack({ league, players: [] }));
      return;
    }
    savePack({ ...pack, league });
    setStatus({ kind: 'ok', text: 'League settings updated.' });
  };

  return (
    <div className="space-y-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-[var(--muted)]">
          League rules drive every recommendation. Get these right first.
        </p>
      </header>

      {status && (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${
            status.kind === 'ok'
              ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
              : status.kind === 'error'
                ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
                : 'bg-[var(--surface-2)] text-[var(--muted)]'
          }`}
        >
          {status.text}
        </p>
      )}

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold">Load your league</h2>
        <p className="text-xs text-[var(--muted)]">
          Bay Islands Fantasy is already encoded from your ESPN settings — scoring,
          roster, position caps and all. Loading it overwrites the fields below.
        </p>
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => {
            setLeague({ ...BAY_ISLANDS, draftSlot: league.draftSlot ?? null });
            setPreset(null);
            setStatus({
              kind: 'ok',
              text:
                'Bay Islands Fantasy loaded. Note: this league starts ZERO tight ends — ' +
                'a TE only plays through your single FLEX spot.',
            });
          }}
        >
          Load Bay Islands Fantasy
        </button>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">League</h2>

        <Field label="Name">
          <input
            value={league.name}
            onChange={(e) => updateLeague('name', e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Teams">
            <input
              type="number"
              min={2}
              max={32}
              value={league.teamCount}
              onChange={(e) => updateLeague('teamCount', Number(e.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Your draft slot">
            <input
              type="number"
              min={1}
              max={league.teamCount}
              placeholder="Not drawn yet"
              value={league.draftSlot ?? ''}
              onChange={(e) =>
                updateLeague(
                  'draftSlot',
                  e.target.value === '' ? null : Number(e.target.value),
                )
              }
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Draft type">
            <select
              value={league.draftType}
              onChange={(e) => updateLeague('draftType', e.target.value as League['draftType'])}
              className={inputClass}
            >
              <option value="snake">Snake</option>
              <option value="linear">Linear</option>
              <option value="auction">Auction</option>
            </select>
          </Field>
          <Field label="League type">
            <select
              value={league.leagueType}
              onChange={(e) => updateLeague('leagueType', e.target.value as League['leagueType'])}
              className={inputClass}
            >
              <option value="redraft">Redraft</option>
              <option value="keeper">Keeper</option>
              <option value="dynasty">Dynasty</option>
              <option value="bestball">Best ball</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Scoring</h2>
        <div className="grid grid-cols-2 gap-2">
          {(['standard', 'half_ppr', 'ppr', 'te_premium'] as ScoringPreset[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => applyPreset(option)}
              className={`btn ${
                preset === option ? 'btn-primary' : 'btn-ghost'
              }`}
            >
              {PRESET_LABELS[option]}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)]">
          Custom scoring is supported by the engine — a rule change is configuration, not
          code. Presets cover the common formats.
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Starting lineup</h2>
        <div className="grid grid-cols-3 gap-2">
          {(['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST'] as LineupSlot[]).map(
            (slot) => (
              <Field key={slot} label={slot}>
                <input
                  type="number"
                  min={0}
                  max={4}
                  value={league.rosterSlots[slot] ?? 0}
                  onChange={(e) => updateSlot(slot, Number(e.target.value))}
                  className={inputClass}
                />
              </Field>
            ),
          )}
          <Field label="Bench">
            <input
              type="number"
              min={0}
              max={20}
              value={league.benchSize}
              onChange={(e) => updateLeague('benchSize', Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <button type="button" className="btn-primary w-full" onClick={saveLeagueOnly}>
          Save league
        </button>
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Player data</h2>
        <p className="text-xs text-[var(--muted)]">
          There is no free, terms-clean ADP API, so CSV import is the reliable path.
          Export ADP from FantasyPros, Sleeper, ESPN, or any tool you already use.
          The file is parsed in your browser and never uploaded.
        </p>

        {packSummary && (
          <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm">{packSummary}</p>
        )}

        <FileInput label="Import ADP (required)" onFile={handleAdpFile} />
        <FileInput label="Import rankings / tiers (optional)" onFile={handleRankingsFile} />

        {warnings.length > 0 && (
          <details className="text-xs text-[var(--muted)]">
            <summary className="cursor-pointer">
              {warnings.length} row{warnings.length === 1 ? '' : 's'} skipped
            </summary>
            <ul className="mt-1 space-y-0.5">
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold text-[var(--danger)]">Reset</h2>
        <button
          type="button"
          className="btn-ghost w-full"
          onClick={() => {
            clearDraftState();
            setStatus({ kind: 'info', text: 'Draft board cleared. Player data kept.' });
          }}
        >
          Clear draft board
        </button>
        <button
          type="button"
          className="btn-ghost w-full text-[var(--danger)]"
          onClick={() => {
            clearPack();
            clearDraftState();
            setPackSummary(null);
            setStatus({ kind: 'info', text: 'Everything cleared.' });
          }}
        >
          Clear all local data
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

const inputClass =
  'min-h-[44px] w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none focus:border-[var(--accent)]';

const PRESET_LABELS: Record<ScoringPreset, string> = {
  standard: 'Standard',
  half_ppr: 'Half PPR',
  ppr: 'Full PPR',
  te_premium: 'TE Premium',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

function FileInput({
  label,
  onFile,
}: {
  label: string;
  onFile: (file: File) => void | Promise<void>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--muted)]">{label}</span>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
          event.target.value = '';
        }}
        className="block w-full text-sm file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-[var(--accent)] file:px-4 file:font-medium file:text-[#08130c]"
      />
    </label>
  );
}

const DEFAULT_LEAGUE: League = {
  id: 'my-league',
  name: 'My League',
  platform: 'manual',
  season: 2026,
  leagueType: 'redraft',
  teamCount: 12,
  draftType: 'snake',
  // Deliberately null rather than 1. Defaulting to a seat means the app would
  // happily build a whole draft board around a slot the user was never
  // assigned, and they would have no reason to notice.
  draftSlot: null,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  benchSize: 6,
  irSlots: 1,
  scoring: SCORING_PRESETS.ppr(),
  adpFormat: 'ppr',
};

/**
 * Rough season-points estimate derived from ADP, used only when no projection
 * source has been imported.
 *
 * This is an approximation of the market's implied value, NOT a projection, and
 * it is labelled as such wherever it surfaces. Importing real projections
 * overwrites it. It exists so that a user with nothing but an ADP file still
 * gets sensible tiering and value-over-replacement rather than a blank board.
 */
function estimatePointsFromAdp(adp: number, position: Position): number {
  // Positional scales approximate typical PPR season totals for the top player
  // at each position, decaying with draft cost.
  const top: Record<Position, number> = {
    QB: 400, RB: 330, WR: 320, TE: 260, K: 150, DST: 145,
  };
  const decay: Record<Position, number> = {
    QB: 0.0016, RB: 0.0075, WR: 0.0065, TE: 0.0085, K: 0.0009, DST: 0.001,
  };
  const base = top[position];
  return Math.round(base * Math.exp(-decay[position] * adp) * 10) / 10;
}
