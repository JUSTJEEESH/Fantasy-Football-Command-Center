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
import {
  fetchEspnLeague,
  parsePastedSnapshot,
  slotOfTeam,
  snapshotUrl,
  type EspnLeagueResult,
  type EspnLeagueSnapshot,
} from '@/lib/sources/espn-league';
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
  const [espnBusy, setEspnBusy] = useState(false);
  const [espnStatus, setEspnStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [espnSnapshot, setEspnSnapshot] = useState<EspnLeagueSnapshot | null>(null);
  const [pasteText, setPasteText] = useState('');

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

  /**
   * One request answers everything at once: is the league reachable from THIS
   * browser (the only place the answer matters), is it public, has the draft
   * order been drawn, and what are the team names. The outcome is reported in
   * the exact words of what happened — especially the two failure modes that
   * are rules of the web rather than bugs (private league, CORS).
   */
  const handleEspnCheck = async () => {
    const id = (league.espnLeagueId ?? '').trim();
    if (!id) {
      setEspnStatus({
        kind: 'error',
        text: 'Enter your league id first — the number after leagueId= in any ESPN league URL.',
      });
      return;
    }
    setEspnBusy(true);
    setEspnSnapshot(null);
    try {
      applySnapshotResult(await fetchEspnLeague(id, league.season));
    } finally {
      setEspnBusy(false);
    }
  };

  /** Same downstream handling whether the snapshot was fetched or pasted. */
  const applySnapshotResult = (result: EspnLeagueResult) => {
    if (!result.ok) {
      setEspnStatus({ kind: 'error', text: result.detail });
      return;
    }
    setEspnSnapshot(result.snapshot);
    const name = result.snapshot.leagueName ?? 'your league';
    setEspnStatus({
      kind: 'ok',
      text: result.snapshot.draftOrder
        ? `Connected to ${name}. The draft order is published — tap your team below to set your slot.`
        : `Connected to ${name}. ESPN has not published the draft order yet; check back after it is drawn.`,
    });
  };

  const handlePaste = () => {
    setEspnSnapshot(null);
    applySnapshotResult(parsePastedSnapshot(pasteText));
  };

  /** Tap your own team in the fetched order → your slot is set and saved. */
  const handlePickMyTeam = (teamId: number) => {
    if (!espnSnapshot) return;
    const slot = slotOfTeam(espnSnapshot, teamId);
    if (slot === null) {
      setEspnStatus({ kind: 'error', text: 'That team has no slot in the published order.' });
      return;
    }
    const nextLeague = { ...league, draftSlot: slot };
    setLeague(nextLeague);
    const pack = loadPack();
    if (pack) savePack({ ...pack, league: nextLeague });
    const teamName = espnSnapshot.teams.find((t) => t.id === teamId)?.name ?? `team ${teamId}`;
    setEspnStatus({
      kind: 'ok',
      text: `You are ${teamName}, drafting from slot ${slot}. Saved.`,
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
                'Bay Islands Fantasy loaded with the post-party rules: mandatory TE, ' +
                '9 starters, 6 bench, and your seat — pick 10 — already set.',
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
        <h2 className="text-sm font-semibold">Your ESPN league</h2>
        <p className="text-xs text-[var(--muted)]">
          Link the league itself: import the draft order the moment it is drawn, and
          follow picks live on draft night. Needs the league id — the number after{' '}
          <span className="font-mono">leagueId=</span> in any ESPN league URL — and the
          league set to publicly viewable (League Settings → Basic Settings), because a
          browser cannot log in to ESPN on your behalf.
        </p>

        <Field label="ESPN league id">
          <input
            type="text"
            inputMode="numeric"
            className="input"
            placeholder="e.g. 1234567"
            value={league.espnLeagueId ?? ''}
            onChange={(e) => updateLeague('espnLeagueId', e.target.value || undefined)}
          />
        </Field>

        <button
          type="button"
          className="btn-ghost w-full"
          disabled={espnBusy}
          onClick={handleEspnCheck}
        >
          {espnBusy ? 'Checking…' : 'Test connection & get draft order'}
        </button>

        {espnStatus && (
          <p
            className={`rounded-lg px-3 py-2 text-sm ${
              espnStatus.kind === 'ok'
                ? 'bg-[var(--surface-2)]'
                : 'bg-[var(--danger)]/10 text-[var(--danger)]'
            }`}
          >
            {espnStatus.text}
          </p>
        )}

        <details className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            League private? Paste it instead
          </summary>
          <div className="mt-2 space-y-2 text-xs text-[var(--muted)]">
            <p>
              If your league manager keeps the league private, your own logged-in
              browser can still read it — the app just can&apos;t do it for you.
              While logged in to ESPN,{' '}
              {league.espnLeagueId ? (
                <a
                  className="text-sky-400 underline"
                  href={snapshotUrl(league.espnLeagueId, league.season)}
                  target="_blank"
                  rel="noreferrer"
                >
                  open your league&apos;s data page
                </a>
              ) : (
                <span>enter your league id above, then open the link that appears here</span>
              )}
              , select everything (Ctrl/Cmd+A), copy, and paste it below. It is
              league data only — no password, no cookies, and it never leaves this
              device.
            </p>
            <textarea
              className="input h-24 w-full font-mono text-[11px]"
              placeholder='Starts with {"draftDetail": …'
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <button type="button" className="btn-ghost w-full" onClick={handlePaste}>
              Import pasted league
            </button>
          </div>
        </details>

        {espnSnapshot?.draftOrder && (
          <div className="space-y-1">
            <p className="text-xs text-[var(--muted)]">
              The draft order, first pick at the top. Tap your team:
            </p>
            {espnSnapshot.draftOrder.map((teamId, index) => {
              const team = espnSnapshot.teams.find((t) => t.id === teamId);
              return (
                <button
                  key={teamId}
                  type="button"
                  onClick={() => handlePickMyTeam(teamId)}
                  className="flex w-full items-baseline gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-left"
                >
                  <span className="w-8 shrink-0 text-sm font-bold tabular-nums">
                    {index + 1}
                  </span>
                  <span className="truncate">{team?.name ?? `Team ${teamId}`}</span>
                </button>
              );
            })}
          </div>
        )}
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

/**
 * The league this app is for.
 *
 * Deliberately Bay Islands rather than a generic 12-team PPR template. The
 * generic default was a trap with teeth: it has a required TE slot and
 * standard scoring, so building a board before loading the real league
 * silently scored every player under the wrong rules — and inverted the single
 * biggest edge this league has. The plan page went from "never spend a pick on
 * a tight end" to listing seven tight ends as targets, with no warning, because
 * both answers are correct for the league they were given.
 *
 * The draft slot stays null: that is genuinely unknown until the August 8
 * party, and guessing a seat would build a whole board around a position
 * nobody was assigned.
 */
const DEFAULT_LEAGUE: League = BAY_ISLANDS;


