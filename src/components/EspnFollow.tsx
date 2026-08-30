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
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
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
          // Success MUST speak. Before the draft this case is the practice
          // sync — the moment the user is checking whether the whole chain
          // works — and a silent success reads as "nothing happened".
          setMessage({
            tone: 'ok',
            text:
              snapshot.picks.length === 0
                ? '✓ Connection works. ESPN shows no picks yet — you are in sync and ready.'
                : `✓ In sync — all ${snapshot.picks.length} ESPN picks are on your board.`,
          });
          return 'ok';
        case 'apply':
          for (const action of plan.actions) dispatch(action);
          setApplied((n) => n + plan.count);
          setMessage({
            tone: 'ok',
            text: `✓ ${plan.count} pick${plan.count === 1 ? '' : 's'} landed — board is current.`,
          });
          return 'ok';
        case 'unmatched':
          for (const action of plan.actions) dispatch(action);
          setApplied((n) => n + plan.count);
          setMessage({
            tone: 'warn',
            text:
              `ESPN pick ${plan.overallPick} is a player not on your board ` +
              `(ESPN id ${plan.espnPlayerId}). Record that pick manually — sync will ` +
              'resume on its own once the pick exists locally.',
          });
          return 'ok';
        case 'conflict':
          setMessage({ tone: 'warn', text: plan.detail });
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
      setMessage({ tone: 'warn', text: result.detail });
      // A blocked or private league will not fix itself between polls.
      return result.kind === 'blocked' ? 'ok' : 'stop';
    }
    return applySnapshot(result.snapshot);
  }, [league.espnLeagueId, league.season, applySnapshot]);

  const handlePasteText = (text: string) => {
    const result = parsePastedSnapshot(text);
    if (!result.ok) {
      setMessage({ tone: 'warn', text: result.detail });
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
        setMessage({
          tone: 'warn',
          text: 'The clipboard is empty. Copy the league data page first, then tap again.',
        });
        return;
      }
      handlePasteText(text);
    } catch {
      setMessage({
        tone: 'warn',
        text: 'The browser refused clipboard access. Paste into the box below instead — same result.',
      });
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
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Sync picks from ESPN</h2>
        <span className="text-xs text-[var(--muted)]">
          {applied > 0
            ? `${applied} synced${lastSyncAt ? ` · ${lastSyncAt.toLocaleTimeString()}` : ''}`
            : ''}
        </span>
      </div>

      {/* The two-tab loop, in the order it happens. Step 1 opens (or re-opens)
          the data page in its own tab; step 2 lands everything copied there.
          This is the primary control because it is the one that works with the
          league private — which this league permanently is. */}
      <div className="grid grid-cols-2 gap-2">
        <a
          className="btn-ghost flex items-center justify-center text-sm"
          href={snapshotUrl(league.espnLeagueId, league.season)}
          target="_blank"
          rel="noreferrer"
        >
          1 · Open data page
        </a>
        <button type="button" className="btn-primary" onClick={handleClipboard}>
          2 · Sync from clipboard
        </button>
      </div>
      <p className="text-xs text-[var(--muted)]">
        On the data page: refresh, select all (Ctrl/Cmd+A), copy (Ctrl/Cmd+C), come
        back, tap sync. Every pick made so far lands at once.
      </p>

      {message && (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${
            message.tone === 'ok'
              ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
              : 'bg-[var(--warn)]/10 text-[var(--warn)]'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="flex items-center gap-4 text-xs">
        <button
          type="button"
          onClick={() => setPasteOpen((o) => !o)}
          className="text-[var(--muted)] underline underline-offset-2"
        >
          {pasteOpen ? 'Hide paste box' : 'Paste manually instead'}
        </button>
        {/* Auto-follow polls ESPN directly. It can only work if the league is
            publicly viewable — this league is not, so it stays out of the way
            rather than leading the card with a button that cannot succeed. */}
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setFollowing((f) => !f);
          }}
          className={`underline underline-offset-2 ${following ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}
        >
          {following ? 'Auto-follow: on' : 'Auto-follow (public leagues only)'}
        </button>
      </div>

      {pasteOpen && (
        <div className="space-y-2 text-xs text-[var(--muted)]">
          <textarea
            className="input h-20 w-full font-mono text-[11px]"
            placeholder={'Paste the copied league data here. Starts with {'}
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
