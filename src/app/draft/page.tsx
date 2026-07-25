'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useDraft } from '@/hooks/useDraft';
import { PickCard } from '@/components/PickCard';
import { CoachBar } from '@/components/CoachBar';
import { EspnFollow } from '@/components/EspnFollow';
import { parseCommand, type CoachContext } from '@/lib/coach/intents';
import { formatWhatIf, formatWhy, type CoachResponse } from '@/lib/coach/format';
import { describePackFreshness } from '@/lib/draft-pack';
import { analyzeWait } from '@/lib/engine/availability';
import type { PlayerCard } from '@/lib/types';

/**
 * DRAFT WAR ROOM (§13, §28).
 *
 * Everything here runs against the local draft pack. No network request is made
 * to answer any question on this page.
 */
export default function DraftPage() {
  const draft = useDraft();
  const [terse, setTerse] = useState(true);
  const [answer, setAnswer] = useState<CoachResponse | null>(null);
  const [context, setContext] = useState<CoachContext>({ inDraftMode: true });
  const [ambiguous, setAmbiguous] = useState<PlayerCard[] | null>(null);
  const [pendingIntent, setPendingIntent] = useState<'draft' | null>(null);

  const { recommendation, state, pack } = draft;

  const recordPick = useCallback(
    (playerId: string, teamSlot?: number) => {
      draft.dispatch({
        type: 'RECORD_PICK',
        playerId,
        draftSlot: teamSlot,
        entryMethod: 'manual',
      });
      setAmbiguous(null);
      setPendingIntent(null);
      setAnswer(null);
    },
    [draft],
  );

  /**
   * Command handling. Every branch resolves locally — this is the function
   * that must keep working when the venue wifi does not.
   */
  const handleCommand = useCallback(
    (text: string) => {
      const parsed = parseCommand(text, context);
      setAmbiguous(null);

      switch (parsed.intent) {
        case 'MY_PICK':
        case 'WAKE':
        case 'DRAFT_MODE': {
          setAnswer(null);
          if (recommendation?.take) {
            setContext((c) => ({
              ...c,
              lastIntent: 'MY_PICK',
              lastRecommendedPlayerId: recommendation.take!.id,
              lastRecommendedPlayerName: recommendation.take!.name,
              lastAlternatives: recommendation.alternatives.map((a) => a.id),
              whatIfDepth: 0,
            }));
          }
          return;
        }

        case 'WHY': {
          if (!recommendation) return;
          setAnswer(formatWhy(recommendation));
          setContext((c) => ({ ...c, lastIntent: 'WHY' }));
          return;
        }

        case 'WHAT_IF': {
          if (!recommendation) return;
          const depth = (context.whatIfDepth ?? 0) + 1;
          setAnswer(formatWhatIf(recommendation, depth));
          setContext((c) => ({ ...c, lastIntent: 'WHAT_IF', whatIfDepth: depth }));
          return;
        }

        case 'WAIT_CHECK': {
          if (!recommendation?.take || !state) return;
          const target = draft.byId.get(recommendation.take.id);
          if (!target) return;
          const wait = analyzeWait(
            target,
            draft.available.filter((p) => p.position === target.position),
            state.picks.length + 1 + (draft.picksUntilNext ?? 0) + 1,
            state.picks.length + 1,
          );
          setAnswer({
            headline: wait.canWait ? 'You can wait' : 'Take him now',
            lines: [wait.reasoning],
            claims: [
              { kind: 'INFERENCE', text: wait.reasoning, confidence: wait.probability },
            ],
            confidence: wait.probability,
            usedLlm: false,
          });
          return;
        }

        case 'RUN_CHECK': {
          const active = draft.runs.filter((r) => r.isRun);
          setAnswer({
            headline: active.length > 0 ? 'Run in progress' : 'No run right now',
            lines:
              active.length > 0
                ? active.map(
                    (r) =>
                      `${r.countInWindow} ${r.position}s in the last ${r.windowSize} picks — ${r.intensity.toFixed(1)}x the normal rate.`,
                  )
                : ['Picks are spread across positions at roughly normal rates.'],
            claims: active.map((r) => ({
              kind: 'INFERENCE' as const,
              text: `${r.position} run detected at ${r.intensity.toFixed(1)}x baseline.`,
            })),
            usedLlm: false,
          });
          return;
        }

        case 'UNDO': {
          draft.dispatch({ type: 'UNDO_LAST' });
          setAnswer(null);
          return;
        }

        case 'MARK_DRAFTED':
        case 'CORRECTION': {
          const name = parsed.args.correctPlayer ?? parsed.args.playerNames?.[0];
          if (!name) {
            setAnswer({
              headline: "I didn't catch a player name.",
              lines: ['Try: "Bijan Robinson drafted".'],
              claims: [{ kind: 'UNCERTAINTY', text: 'No player name could be parsed.' }],
              usedLlm: false,
            });
            return;
          }
          const found = draft.findPlayer(name);
          if (found.match) {
            recordPick(found.match.id, parsed.args.teamSlot);
          } else if (found.ambiguous) {
            // Never guess between players — one wrong entry corrupts the board.
            setAmbiguous(found.ambiguous);
            setPendingIntent('draft');
          } else {
            setAnswer({
              headline: `I don't have "${name}" on the board.`,
              lines: ['He may already be drafted, or not be in your pack.'],
              claims: [{ kind: 'UNCERTAINTY', text: `No available player matches "${name}".` }],
              usedLlm: false,
            });
          }
          return;
        }

        default: {
          setAnswer({
            headline: "I'm not sure what you're asking for.",
            lines: ['Try "who\'s my pick?", "why?", "undo", or "<player> drafted".'],
            claims: [{ kind: 'UNCERTAINTY', text: 'Command not recognized.' }],
            usedLlm: false,
          });
        }
      }
    },
    [context, draft, recommendation, recordPick, state],
  );

  if (!draft.hydrated) {
    return <p className="mt-8 text-center text-[var(--muted)]">Loading draft…</p>;
  }

  if (!pack || !state) {
    return <NoPack reason={draft.packError} />;
  }

  const freshness = describePackFreshness(pack);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Draft War Room</h1>
          <p className="text-xs text-[var(--muted)]">
            {pack.league.name} · slot {pack.league.draftSlot} of {pack.league.teamCount}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href="/draft/slots" className="btn-ghost px-3 text-xs">
            Seats
          </Link>
          <button
            type="button"
            onClick={() => setTerse((t) => !t)}
            className="btn-ghost px-3 text-xs"
          >
            {terse ? 'Terse' : 'Detailed'}
          </button>
        </div>
      </header>

      {freshness && freshness.level !== 'fresh' && (
        <p
          className={`rounded-lg px-3 py-2 text-xs ${
            freshness.level === 'stale'
              ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
              : 'bg-[var(--warn)]/10 text-[var(--warn)]'
          }`}
        >
          {freshness.label}
        </p>
      )}

      <EspnFollow
        league={pack.league}
        state={state}
        players={pack.players}
        dispatch={draft.dispatch}
      />

      <ClockStrip
        round={draft.round}
        pick={draft.currentPick}
        onClock={draft.onClock}
        picksUntilNext={draft.picksUntilNext}
      />

      {draft.error && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
          <span>{draft.error}</span>
          <button type="button" onClick={draft.clearError} className="shrink-0 underline">
            dismiss
          </button>
        </div>
      )}

      {recommendation && (
        <PickCard
          rec={recommendation}
          terse={terse}
          onClock={draft.onClock}
          picksUntilNextTurn={draft.picksUntilNext}
          onExplain={() => handleCommand('why')}
          onWhatIf={() => handleCommand("what if he's gone")}
        />
      )}

      {answer && <AnswerCard response={answer} onDismiss={() => setAnswer(null)} />}

      {ambiguous && (
        <div className="card">
          <p className="text-sm font-semibold">Which one?</p>
          <div className="mt-2 space-y-2">
            {ambiguous.map((player) => (
              <button
                key={player.id}
                type="button"
                onClick={() => pendingIntent === 'draft' && recordPick(player.id)}
                className="btn-ghost flex w-full items-center justify-between"
              >
                <span>{player.name}</span>
                <span className="text-xs text-[var(--muted)]">
                  {player.position}
                  {player.team ? ` · ${player.team}` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <CoachBar
        onSubmit={handleCommand}
        placeholder={'"who\'s my pick?" · "X drafted" · "undo"'}
      />

      <QuickActions
        onCommand={handleCommand}
        canUndo={state.picks.length > 0}
      />

      <RosterPanel
        roster={draft.roster}
        needs={draft.rosterAnalysis?.weakestPositions ?? []}
      />

      <BoardPanel
        picks={state.picks}
        nameOf={(id) => draft.byId.get(id)?.name ?? id}
        userSlot={state.userSlot}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClockStrip({
  round,
  pick,
  onClock,
  picksUntilNext,
}: {
  round: number;
  pick: number;
  onClock: boolean;
  picksUntilNext: number | null;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-xl px-4 py-3 ${
        onClock ? 'bg-[var(--accent)]/15' : 'bg-[var(--surface)]'
      }`}
    >
      <div>
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Round</p>
        <p className="text-2xl font-bold tabular-nums">{round}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Pick</p>
        <p className="text-2xl font-bold tabular-nums">{pick}</p>
      </div>
      <div className="text-right">
        {onClock ? (
          <p className="text-lg font-bold text-[var(--accent)]">YOU'RE UP</p>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">
              Until your pick
            </p>
            <p className="text-2xl font-bold tabular-nums">{picksUntilNext ?? '—'}</p>
          </>
        )}
      </div>
    </div>
  );
}

function QuickActions({
  onCommand,
  canUndo,
}: {
  onCommand: (text: string) => void;
  canUndo: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" className="btn-ghost" onClick={() => onCommand('my pick')}>
        Who's my pick?
      </button>
      <button type="button" className="btn-ghost" onClick={() => onCommand('is there a run')}>
        Positional run?
      </button>
      <button type="button" className="btn-ghost" onClick={() => onCommand('can I wait')}>
        Can I wait?
      </button>
      <button
        type="button"
        className="btn-ghost"
        disabled={!canUndo}
        onClick={() => onCommand('undo')}
      >
        Undo last pick
      </button>
    </div>
  );
}

function AnswerCard({
  response,
  onDismiss,
}: {
  response: CoachResponse;
  onDismiss: () => void;
}) {
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xl font-bold leading-tight">{response.headline}</h3>
        <button type="button" onClick={onDismiss} className="shrink-0 text-[var(--muted)]">
          ✕
        </button>
      </div>
      <div className="mt-2 space-y-1.5">
        {response.lines.map((line, i) => (
          <p key={i} className="whitespace-pre-wrap text-[15px] leading-snug">
            {line}
          </p>
        ))}
      </div>
      {response.usedLlm && (
        <p className="mt-3 text-[10px] uppercase tracking-widest text-[var(--muted)]">
          Wording by AI · decision by the engine
        </p>
      )}
    </div>
  );
}

function RosterPanel({
  roster,
  needs,
}: {
  roster: PlayerCard[];
  needs: string[];
}) {
  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Your roster ({roster.length})</h3>
        {needs.length > 0 && (
          <p className="text-xs text-[var(--warn)]">Need: {needs.join(', ')}</p>
        )}
      </div>
      {roster.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--muted)]">No picks yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {roster.map((player, i) => (
            <li key={player.id} className="flex items-baseline gap-2 text-sm">
              <span className="w-6 shrink-0 text-xs text-[var(--muted)]">{i + 1}.</span>
              <span className="tag bg-[var(--surface-2)] text-[var(--muted)]">
                {player.position}
              </span>
              <span className="truncate">{player.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BoardPanel({
  picks,
  nameOf,
  userSlot,
}: {
  picks: Array<{ overallPick: number; draftSlot: number; playerId: string; round: number }>;
  nameOf: (id: string) => string;
  userSlot: number;
}) {
  const recent = [...picks].reverse().slice(0, 12);
  return (
    <div className="card">
      <h3 className="text-sm font-semibold">Recent picks</h3>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--muted)]">The board is empty.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {recent.map((pick) => (
            <li
              key={pick.overallPick}
              className={`flex items-baseline gap-2 text-sm ${
                pick.draftSlot === userSlot ? 'text-[var(--accent)]' : ''
              }`}
            >
              <span className="w-10 shrink-0 text-xs tabular-nums text-[var(--muted)]">
                {pick.round}.{String(pick.overallPick).padStart(2, '0')}
              </span>
              <span className="w-14 shrink-0 text-xs text-[var(--muted)]">
                Team {pick.draftSlot}
              </span>
              <span className="truncate">{nameOf(pick.playerId)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoPack({ reason }: { reason?: string | null }) {
  return (
    <div className="card mt-8 text-center">
      <h1 className="text-xl font-bold">No draft pack loaded</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        The war room runs entirely offline, but it needs a snapshot of your league and
        player data first. Set that up once, before draft day.
      </p>
      {reason && (
        <p className="mt-2 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger)]">
          {reason}
        </p>
      )}
      <Link href="/draft/slots" className="btn-ghost mt-3 inline-flex items-center">
        Plan every draft seat
      </Link>
      <Link href="/settings" className="btn-primary mt-4 inline-flex items-center">
        Set up my league
      </Link>
    </div>
  );
}
