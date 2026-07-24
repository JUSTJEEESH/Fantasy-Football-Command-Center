'use client';

import type { DraftRecommendation } from '@/lib/types';

/**
 * The screen the entire product exists to render (§18, §49).
 *
 * Designed to be read in one glance, at arm's length, in a dim room, with a
 * timer running: the action is enormous, everything else is subordinate, and
 * nothing requires scrolling.
 */
export function PickCard({
  rec,
  terse,
  onClock = true,
  picksUntilNextTurn,
  onExplain,
  onWhatIf,
}: {
  rec: DraftRecommendation;
  terse: boolean;
  /**
   * Whether it is actually the user's turn. When it isn't, the card is framed
   * as a preview — telling someone to "TAKE" a player they cannot draft for
   * another 19 picks would be advice they can't act on.
   */
  onClock?: boolean;
  picksUntilNextTurn?: number | null;
  onExplain?: () => void;
  onWhatIf?: () => void;
}) {
  if (!rec.take) {
    return (
      <div className="card">
        <p className="text-xl font-semibold">No pick available</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Every player in your pack has been drafted.
        </p>
      </div>
    );
  }

  const confidencePct = Math.round(rec.confidence * 100);

  return (
    <div className={`card ${onClock ? 'border-[var(--accent)]/40' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--muted)]">
            {onClock
              ? 'Take'
              : `Best available — you pick in ${picksUntilNextTurn ?? '?'}`}
          </p>
          <h2 className="mt-0.5 break-words text-4xl font-black leading-none tracking-tight">
            {rec.take.name}
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {rec.take.position}
            {rec.take.team ? ` · ${rec.take.team}` : ''} · Round {rec.round}, pick{' '}
            {rec.overallPick}
          </p>
        </div>
        <ConfidenceDial value={confidencePct} />
      </div>

      {onClock ? (
        <VerdictBanner verdict={rec.verdict} />
      ) : (
        <p className="mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--muted)]">
          Not your turn — this is who leads the board right now, not an instruction.
        </p>
      )}

      <ul className="mt-3 space-y-1.5">
        {rec.reasons.slice(0, terse ? 1 : 3).map((reason, i) => (
          <li key={i} className="claim-INFERENCE text-[15px] leading-snug">
            {reason}
          </li>
        ))}
      </ul>

      {rec.alternatives.length > 0 && (
        <div className="mt-4 rounded-xl bg-[var(--surface-2)] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--muted)]">
            If he's gone
          </p>
          <ol className="mt-1.5 space-y-1">
            {rec.alternatives.map((alt, i) => (
              <li key={alt.id} className="flex items-baseline gap-2 text-[15px]">
                <span className="text-[var(--muted)]">{i + 2}.</span>
                <span className="font-medium">{alt.name}</span>
                <span className="text-xs text-[var(--muted)]">
                  {alt.position}
                  {alt.team ? ` · ${alt.team}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {rec.avoid.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--danger)]">
            Avoid
          </p>
          {rec.avoid.slice(0, 2).map((entry) => (
            <p key={entry.player.id} className="mt-1 text-sm leading-snug">
              <span className="font-medium">{entry.player.name}</span>
              <span className="text-[var(--muted)]"> — {entry.reason}</span>
            </p>
          ))}
        </div>
      )}

      {/* Uncertainty is shown, never buried: this is the honesty contract. */}
      {(rec.riskFactors.length > 0 || rec.staleness) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[var(--muted)]">
            Risks &amp; data freshness
          </summary>
          <ul className="mt-2 space-y-1">
            {rec.riskFactors.map((risk, i) => (
              <li key={i} className="claim-UNCERTAINTY text-[13px] text-[var(--muted)]">
                {risk}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onExplain}>
          Why?
        </button>
        <button type="button" className="btn-ghost flex-1" onClick={onWhatIf}>
          What if he's gone?
        </button>
      </div>
    </div>
  );
}

function VerdictBanner({ verdict }: { verdict: DraftRecommendation['verdict'] }) {
  const config = {
    TAKE_NOW: { text: 'Take him now', className: 'bg-[var(--accent)]/15 text-[var(--accent)]' },
    CAN_WAIT: { text: 'You can probably wait', className: 'bg-sky-400/15 text-sky-300' },
    REACH: { text: 'This would be a reach', className: 'bg-[var(--warn)]/15 text-[var(--warn)]' },
    NO_PICK_AVAILABLE: { text: '', className: '' },
  }[verdict];

  if (!config.text) return null;

  return (
    <div className={`mt-3 rounded-lg px-3 py-2 text-sm font-semibold ${config.className}`}>
      {config.text}
    </div>
  );
}

/**
 * Confidence is always shown, and deliberately never reads as certainty —
 * the engine caps it at 95%.
 */
function ConfidenceDial({ value }: { value: number }) {
  const tone =
    value >= 75 ? 'text-[var(--accent)]' : value >= 50 ? 'text-[var(--warn)]' : 'text-[var(--danger)]';
  return (
    <div className="shrink-0 text-right">
      <p className={`text-3xl font-bold tabular-nums leading-none ${tone}`}>{value}%</p>
      <p className="mt-1 text-[10px] uppercase tracking-widest text-[var(--muted)]">
        Confidence
      </p>
    </div>
  );
}
