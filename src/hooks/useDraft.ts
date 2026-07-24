'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DraftRecommendation, DraftState, PlayerCard } from '@/lib/types';
import {
  DraftError,
  createDraftState,
  currentOverallPick,
  detectRuns,
  draftReducer,
  draftedPlayerIds,
  isUserOnClock,
  picksUntilNextTurn,
  roundForOverallPick,
  userRoster,
  type DraftAction,
} from '@/lib/engine/draft-state';
import { recommend } from '@/lib/engine/recommend';
import { analyzeRoster } from '@/lib/engine/roster';
import { searchKey } from '@/lib/sources/types';
import {
  loadDraftState,
  loadPackResult,
  saveDraftState,
  type DraftPack,
} from '@/lib/draft-pack';

/**
 * The entire draft runs through this hook, and every computation in it is
 * local. There is no fetch anywhere in this file — that is what makes the war
 * room work with the wifi off.
 */
export function useDraft() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [packError, setPackError] = useState<string | null>(null);

  useEffect(() => {
    const result = loadPackResult();
    const loadedPack = result.pack;
    setPack(loadedPack);
    if (!loadedPack && 'reason' in result && result.reason) {
      setPackError(result.reason);
    }

    // Resume an in-progress draft. A locked phone or a dead tab must not cost
    // the board.
    const savedState = loadDraftState();
    if (savedState) {
      setState(savedState);
    } else if (loadedPack) {
      // A draft cannot start without knowing which slot is yours — the whole
      // board depends on it. Say so plainly instead of guessing at slot 1.
      if (loadedPack.league.draftSlot === null) {
        setPackError(
          'Your draft slot has not been set yet. Add it in Settings as soon as ' +
            'your league draws the order — everything else is already configured.',
        );
      } else {
        setState(
          createDraftState({
            leagueId: loadedPack.league.id,
            teamCount: loadedPack.league.teamCount,
            rounds: rosterSize(loadedPack),
            userSlot: loadedPack.league.draftSlot,
            draftType:
              loadedPack.league.draftType === 'auction'
                ? 'linear'
                : loadedPack.league.draftType,
          }),
        );
      }
    }
    setHydrated(true);
  }, []);

  const dispatch = useCallback(
    (action: DraftAction) => {
      setState((current) => {
        if (!current) return current;
        try {
          const next = draftReducer(current, action);
          saveDraftState(next);
          setError(null);
          return next;
        } catch (err) {
          setError(err instanceof DraftError ? err.message : String(err));
          return current;
        }
      });
    },
    [],
  );

  const players = pack?.players ?? [];
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const drafted = useMemo(
    () => (state ? draftedPlayerIds(state) : new Set<string>()),
    [state],
  );

  const available = useMemo(
    () => players.filter((p) => !drafted.has(p.id)),
    [players, drafted],
  );

  const roster = useMemo(
    () =>
      state
        ? userRoster(state)
            .map((id) => byId.get(id))
            .filter((p): p is PlayerCard => Boolean(p))
        : [],
    [state, byId],
  );

  /**
   * The recommendation. Recomputed synchronously on every board change —
   * it takes single-digit milliseconds, so there is no loading state and no
   * spinner to watch while a timer runs.
   */
  const recommendation: DraftRecommendation | null = useMemo(() => {
    if (!state || !pack) return null;
    return recommend({
      state,
      league: pack.league,
      players,
      dataFetchedAt: pack.dataFetchedAt,
    });
  }, [state, pack, players]);

  const runs = useMemo(
    () => (state ? detectRuns(state, (id) => byId.get(id)?.position) : []),
    [state, byId],
  );

  const rosterAnalysis = useMemo(
    () => (pack ? analyzeRoster(roster, pack.league) : null),
    [roster, pack],
  );

  /**
   * Resolve a spoken or typed name to a player.
   *
   * Returns `ambiguous` rather than picking one when several players match —
   * recording the wrong player and only noticing three rounds later is a much
   * worse outcome than one extra tap.
   */
  const findPlayer = useCallback(
    (query: string): { match?: PlayerCard; ambiguous?: PlayerCard[] } => {
      const key = searchKey(query);
      if (!key) return {};

      const exact = available.filter((p) => searchKey(p.name) === key);
      if (exact.length === 1) return { match: exact[0] };
      if (exact.length > 1) return { ambiguous: exact };

      const partial = available.filter((p) => searchKey(p.name).includes(key));
      if (partial.length === 1) return { match: partial[0] };
      if (partial.length > 1) {
        return { ambiguous: partial.slice(0, 6) };
      }
      return {};
    },
    [available],
  );

  return {
    hydrated,
    pack,
    packError,
    state,
    error,
    clearError: () => setError(null),
    dispatch,
    players,
    available,
    roster,
    rosterAnalysis,
    recommendation,
    runs,
    findPlayer,
    byId,
    // Derived board facts, computed here so no component recomputes them.
    currentPick: state ? currentOverallPick(state) : 0,
    round: state ? roundForOverallPick(currentOverallPick(state), state.teamCount) : 0,
    onClock: state ? isUserOnClock(state) : false,
    picksUntilNext: state ? picksUntilNextTurn(state) : null,
  };
}

function rosterSize(pack: DraftPack): number {
  const starters = Object.entries(pack.league.rosterSlots)
    .filter(([slot]) => slot !== 'BENCH')
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  return starters + pack.league.benchSize;
}
