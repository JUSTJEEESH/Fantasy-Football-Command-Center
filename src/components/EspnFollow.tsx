'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchEspnLeague,
  parsePastedSnapshot,
  planSync,
  snapshotUrl,
  type EspnLeagueSnapshot,
  type SyncPlan,
} from '@/lib/sources/espn-league';
import type { DraftAction } from '@/lib/engine/draft-state';
import type { DraftState, League, PlayerCard } from '@/lib/types';

/**
 * Follow the ESPN draft room from the war room.
 *
 * While enabled, this polls the league's public draft feed and records the
 * other eleven teams' picks as they happen, so the recommendation is always
 * computed against the real board — no typing while the clock runs.
 *
 * Design rules, in order of importance:
 *  1. Manual entry keeps working exactly as before. Sync is an accelerant;
 *     the moment it hits anything it does not fully understand it STOPS and
 *     says what happened, rather than degrading quietly.
 *  2. It never rewrites recorded history. A disagreement between the local
 *     board and ESPN is reported as a conflict for a human to resolve.
 *  3. Losing the network mid-draft costs nothing but the syncing itself —
 *     everything already recorded is local.
 */
export function EspnFollow({
  league,
  state,
  players,
  dispatch,
}: {
  league: League;
  state: DraftState;
  players: PlayerCard[];
  dispatch: (action: DraftAction) => void;
}) {
  const [following, setFollowing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [applied, setApplied] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // The poll reads current state through a ref: a setInterval closure holding
  // a stale DraftState would re-apply picks it already made.
  const stateRef = useRef(state);
  stateRef.current = state;

  /** One snapshot in, board caught up — identical for fetched and pasted. */
  const applySnapshot = useCallback(
    (snapshot: EspnLeagueSnapshot): 'ok' | 'stop' => {
      const plan: SyncPlan = planSync(stateRef.current, snapshot, players);
      setLastSyncAt(new Date());

      switch (plan.status) {
        case 'in-sync':
          setMessage(null);
          return 'ok';
        case 'apply':
          for (const action of plan.actions) dispatch(action);
          setApplied((n) => n + plan.count);
          setMessage(null);
          return 'ok';
        case 'unmatched':
          for (const action of plan.actions) dispatch(action);
          setApplied((n) => n + plan.count);
          setMessage(
            `ESPN pick ${plan.overallPick} is a player not on your board ` +
              `(ESPN id ${plan.espnPlayerId}). Record that pick manually — sync will ` +
              'resume on its own once the pick exists locally.',
          );
          return 'ok';
        case 'conflict':
          setMessage(plan.detail);
          return 'stop';
      }
    },
    [players, dispatch],
  );

  const syncOnce = useCallback(async (): Promise<'ok' | 'stop'> => {
    const leagueId = league.espnLeagueId;
    if (!leagueId) return 'stop';

    const result = await fetchEspnLeague(leagueId, league.season);
    if (!result.ok) {
      setMessage(result.detail);
      // A blocked or private league will not fix itself between polls.
      return result.kind === 'blocked' ? 'ok' : 'stop';
    }
    return applySnapshot(result.snapshot);
  }, [league.espnLeagueId, league.season, applySnapshot]);

  const handlePasteText = (text: string) => {
    const result = parsePastedSnapshot(text);
    if (!result.ok) {
      setMessage(result.detail);
      return;
    }
    applySnapshot(result.snapshot);
    setPasteText('');
  };

  /**
   * One-click sync: read the league JSON straight off the clipboard.
   *
   * This exists because the paste loop runs against a two-minute pick clock.
   * With it, catching up is: refresh the ESPN tab, Ctrl+A Ctrl+C, switch back,
   * ONE click. The browser will ask permission the first time; a refusal falls
   * back to the textarea below, stated rather than silent.
   */
  const handleClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setMessage('The clipboard is empty. Copy the league data page first, then tap again.');
        return;
      }
      handlePasteText(text);
    } catch {
      setMessage(
        'The browser refused clipboard access. Paste into the box below instead — same result.',
      );
    }
  };

  useEffect(() => {
    if (!following) return;
    let cancelled = false;

    const tick = async () => {
      const outcome = await syncOnce();
      if (!cancelled && outcome === 'stop') setFollowing(false);
    };

    void tick();
    // ESPN draft rooms give each pick tens of seconds; 12s keeps the board a
    // few seconds behind reality without hammering anyone.
    const interval = setInterval(tick, 12_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [following, syncOnce]);

  if (!league.espnLeagueId) return null;

  // A board with no ESPN ids at all cannot match a single pick — sync would
  // halt at pick 1 and never advance. Two real ways to get here: a pack built
  // before ids were shipped, or a CSV-imported board (CSVs carry no ids).
  // Offering the Follow button anyway would be promising a feature that is
  // guaranteed to fail; saying which board this is and how to fix it is not.
  const linkable = players.some((p) => p.espnId !== undefined);
  if (!linkable) {
    return (
      <div className="card space-y-1">
        <h2 className="text-sm font-semibold">Follow ESPN draft</h2>
        <p className="text-xs text-[var(--muted)]">
          Your board has no ESPN player ids, so picks from the ESPN room cannot be
          matched. If you built the board before ids shipped, rebuild it once —
          Settings → <span className="font-medium">Use the shipped player board</span>.
          A CSV-imported board cannot carry ids; manual entry works as always.
        </p>
      </div>
    );
  }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Follow ESPN draft</h2>
          <p className="text-xs text-[var(--muted)]">
            {following
              ? `Live — checking every 12s${lastSyncAt ? `, last ${lastSyncAt.toLocaleTimeString()}` : ''}${applied > 0 ? ` · ${applied} picks synced` : ''}`
              : applied > 0
                ? `${applied} picks synced${lastSyncAt ? ` · last ${lastSyncAt.toLocaleTimeString()}` : ''}`
                : 'Records the other teams’ picks for you as they happen.'}
          </p>
        </div>
        <button
          type="button"
          className={following ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
          onClick={() => {
            setMessage(null);
            setFollowing((f) => !f);
          }}
        >
          {following ? 'Following' : 'Follow'}
        </button>
      </div>

      {message && (
        <p className="rounded-lg bg-[var(--warn)]/10 px-3 py-2 text-sm text-[var(--warn)]">
          {message}
        </p>
      )}

      {/* The private-league path: the app cannot carry your ESPN login, but
          your own logged-in tab can. Open the data link, copy, paste — every
          pick made so far lands at once. */}
      <button
        type="button"
        onClick={() => setPasteOpen((o) => !o)}
        className="text-xs text-[var(--muted)] underline underline-offset-2"
      >
        {pasteOpen ? 'Hide paste sync' : 'League private? Paste to sync'}
      </button>
      {pasteOpen && (
        <div className="space-y-2 text-xs text-[var(--muted)]">
          <p>
            In a tab where you are logged in to ESPN,{' '}
            <a
              className="text-sky-400 underline"
              href={snapshotUrl(league.espnLeagueId, league.season)}
              target="_blank"
              rel="noreferrer"
            >
              open the league data page
            </a>
            , copy everything, paste here. All picks made so far sync in one go.
          </p>
          <button type="button" className="btn-primary w-full" onClick={handleClipboard}>
            Sync from clipboard
          </button>
          <textarea
            className="input h-20 w-full font-mono text-[11px]"
            placeholder='…or paste here. Starts with {"draftDetail": …'
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost w-full"
            onClick={() => handlePasteText(pasteText)}
          >
            Sync pasted picks
          </button>
        </div>
      )}
    </div>
  );
}
