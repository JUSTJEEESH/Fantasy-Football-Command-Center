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
import { loadPlayerPack, relativeTime } from '@/lib/static-data';
import { playersFromPack, estimatePointsFromAdp } from '@/lib/pack-from-static';
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
 * Two ways to get a board. The shipped one — real players, ESPN ADP, bye weeks
 * and injury designations, fetched by the build — is one tap and is what most
 * people should use. CSV import stays for anyone who trusts their own numbers
 * more, and it overrides the shipped board entirely.
 */
export default function SettingsPage() {
  const [league, setLeague] = useState<League>(DEFAULT_LEAGUE);
  // null = custom scoring (e.g. a loaded league preset), not one of the presets.
  const [preset, setPreset] = useState<ScoringPreset | null>('ppr');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [packSummary, setPackSummary] = useState<string | null>(null);
  const [packNotes, setPackNotes] = useState<string[]>([]);
  const [loadingShipped, setLoadingShipped] = useState(false);

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
   * Build the offline draft pack from the data the deployment ships with.
   *
   * This is the path that should work for someone who has never exported a
   * spreadsheet in their life: the build already fetched real players, real
   * ESPN ADP, real bye weeks and real injury designations, so the only thing
   * missing was scoring the projections under this league's rules and handing
   * the result to the engine.
   */
  const handleUseShippedData = async () => {
    setLoadingShipped(true);
    setWarnings([]);
    setStatus(null);
    try {
      const shipped = await loadPlayerPack();

      if (!shipped) {
        setStatus({
          kind: 'error',
          text:
            'Could not read the shipped player board. If you are offline, ' +
            'import a CSV instead — a pack you already built still works.',
        });
        return;
      }
      if (!shipped.ok || shipped.players.length === 0) {
        setStatus({
          kind: 'error',
          text: `The last build could not fetch players: ${shipped.reason ?? 'no reason recorded'}.`,
        });
        return;
      }

      const { players, summary } = playersFromPack(shipped, league);
      const saved = savePack(
        buildDraftPack({
          league,
          players,
          dataFetchedAt: shipped.generatedAt,
          sources: shipped.sources
            .filter((s) => s.ok)
            .map((s) => ({ key: s.key, fetchedAt: shipped.generatedAt })),
        }),
      );

      if (!saved.ok) {
        setStatus({ kind: 'error', text: saved.error ?? 'Could not save the pack.' });
        return;
      }

      setPackNotes(summary.notes);
      setPackSummary(
        `${summary.players} players · ${summary.withAdp} with ADP · ` +
          `${summary.withProjection} projected · ${summary.withBye} with a bye week`,
      );
      setStatus({
        kind: 'ok',
        text: `Board built from data fetched ${relativeTime(shipped.generatedAt)}. Draft mode works offline now.`,
      });
    } finally {
      setLoadingShipped(false);
    }
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
          The build ships a player board fetched from Sleeper and ESPN. Loading it
          takes one tap and needs no file. Importing your own CSV overrides it.
        </p>

        {packSummary && (
          <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm">{packSummary}</p>
        )}

        <button
          type="button"
          className="btn-primary w-full"
          disabled={loadingShipped}
          onClick={handleUseShippedData}
        >
          {loadingShipped ? 'Building your board…' : 'Use the shipped player board'}
        </button>

        {/* What the board is made of, stated before you rely on it. */}
        {packNotes.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]">
            {packNotes.map((note, i) => (
              <li key={i}>· {note}</li>
            ))}
          </ul>
        )}

        <p className="pt-1 text-xs text-[var(--muted)]">
          Or import your own numbers — parsed in your browser, never uploaded.
        </p>
        <FileInput label="Import ADP" onFile={handleAdpFile} />
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


