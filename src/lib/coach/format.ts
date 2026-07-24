import type { DraftRecommendation, PlayerCard } from '@/lib/types';
import type { Claim } from '@/lib/types';

// ============================================================================
// Deterministic response formatting (§18, §44).
//
// Every Coach answer is generated here first, without any model call. The LLM
// may later rephrase it, but this output is always correct, always instant, and
// always available — including on a dead network at a draft party.
//
// Voice: calm, direct, action first. The answer to "what should I do?" comes
// before any statistic, and only statistics that changed the answer appear.
// ============================================================================

export interface CoachResponse {
  /** The single line that answers the question. Rendered largest in the UI. */
  headline: string;
  /** Supporting lines. Kept to three or fewer during a draft. */
  lines: string[];
  /** Structured claims, each tagged FACT / INFERENCE / RECOMMENDATION / etc. */
  claims: Claim[];
  /** Rendered as a badge; absent when nothing is stale. */
  staleness?: string;
  /** 0..1 where meaningful. */
  confidence?: number;
  /** Whether an LLM was involved in producing this text. */
  usedLlm: boolean;
}

/**
 * The draft-day answer (§18). Terse by construction: everything a person needs
 * to act, formatted to be read at arm's length in a loud room.
 */
export function formatDraftPick(
  rec: DraftRecommendation,
  opts: { terse?: boolean } = {},
): CoachResponse {
  if (!rec.take) {
    return {
      headline: 'No pick available.',
      lines: ['Every player in the pool has been drafted.'],
      claims: [{ kind: 'UNCERTAINTY', text: 'No players remain to recommend.' }],
      usedLlm: false,
    };
  }

  const confidencePct = Math.round(rec.confidence * 100);
  const lines: string[] = [];

  // One sentence of reasoning during a draft; up to three when asked for depth.
  const reasonCount = opts.terse ? 1 : 3;
  lines.push(...rec.reasons.slice(0, reasonCount));

  if (rec.alternatives.length > 0) {
    lines.push(
      `If gone: ${rec.alternatives.map((a, i) => `${i + 2}. ${a.name}`).join('  ')}`,
    );
  }

  if (rec.avoid.length > 0) {
    const first = rec.avoid[0]!;
    lines.push(`Avoid: ${first.player.name} — ${first.reason}`);
  }

  lines.push(verdictLine(rec));

  const claims: Claim[] = [
    {
      kind: 'RECOMMENDATION',
      text: `Take ${rec.take.name} (${rec.take.position}${rec.take.team ? `, ${rec.take.team}` : ''}).`,
      confidence: rec.confidence,
    },
    ...rec.reasons.map(
      (reason): Claim => ({ kind: 'INFERENCE', text: reason, confidence: rec.confidence }),
    ),
    ...rec.riskFactors.map((risk): Claim => ({ kind: 'UNCERTAINTY', text: risk })),
  ];

  return {
    headline: `TAKE: ${rec.take.name.toUpperCase()}`,
    lines,
    claims,
    staleness: rec.staleness,
    confidence: rec.confidence,
    usedLlm: false,
  };
}

function verdictLine(rec: DraftRecommendation): string {
  switch (rec.verdict) {
    case 'TAKE_NOW':
      return 'Verdict: take him now.';
    case 'CAN_WAIT':
      return 'Verdict: you can probably wait — see the odds above.';
    case 'REACH':
      return 'Verdict: this would be a reach. Consider the alternatives.';
    default:
      return '';
  }
}

/** "Why?" — the fuller explanation, still in plain language. */
export function formatWhy(rec: DraftRecommendation): CoachResponse {
  if (!rec.take) {
    return {
      headline: "There's no recommendation to explain yet.",
      lines: ['Ask "who\'s my pick?" first.'],
      claims: [],
      usedLlm: false,
    };
  }

  const lines = [...rec.reasons];
  if (rec.riskFactors.length > 0) {
    lines.push(`Risks: ${rec.riskFactors.join(' ')}`);
  }

  return {
    headline: `Why ${rec.take.name}`,
    lines,
    claims: rec.reasons.map((reason) => ({
      kind: 'INFERENCE' as const,
      text: reason,
      confidence: rec.confidence,
    })),
    staleness: rec.staleness,
    confidence: rec.confidence,
    usedLlm: false,
  };
}

/** "What if he's gone?" — walk down the alternatives. */
export function formatWhatIf(
  rec: DraftRecommendation,
  depth: number,
): CoachResponse {
  const index = depth - 1;
  const alternative = rec.alternatives[index];

  if (!alternative) {
    return {
      headline: "That's as far down the list as I'd go.",
      lines: [
        'Past this point the options are close enough that roster fit should decide it.',
      ],
      claims: [
        {
          kind: 'UNCERTAINTY',
          text: 'Remaining candidates are separated by less than the model can resolve.',
        },
      ],
      usedLlm: false,
    };
  }

  return {
    headline: `Then take ${alternative.name.toUpperCase()}`,
    lines: [
      `${alternative.name} — ${alternative.position}${alternative.team ? `, ${alternative.team}` : ''}.`,
    ],
    claims: [
      {
        kind: 'RECOMMENDATION',
        text: `Fallback ${depth}: ${alternative.name}.`,
        confidence: Math.max(0.2, rec.confidence - 0.1 * depth),
      },
    ],
    confidence: Math.max(0.2, rec.confidence - 0.1 * depth),
    usedLlm: false,
  };
}

/** Player comparison (§22). */
export function formatComparison(
  a: PlayerCard,
  b: PlayerCard,
  verdict: { winner: PlayerCard; reason: string; confidence: number },
): CoachResponse {
  const row = (label: string, left: unknown, right: unknown) =>
    `${label.padEnd(14)} ${String(left ?? '—').padEnd(10)} ${String(right ?? '—')}`;

  return {
    headline: `${verdict.winner.name.toUpperCase()}`,
    lines: [
      verdict.reason,
      '',
      row('', a.name, b.name),
      row('Projected', fmt(a.projectedPoints), fmt(b.projectedPoints)),
      row('Floor', fmt(a.floorPoints), fmt(b.floorPoints)),
      row('Ceiling', fmt(a.ceilingPoints), fmt(b.ceilingPoints)),
      row('ADP', fmt(a.adp), fmt(b.adp)),
      row('Tier', a.tier, b.tier),
      row('Injury risk', pct(a.injuryRisk), pct(b.injuryRisk)),
      row('Role certainty', pct(a.roleCertainty), pct(b.roleCertainty)),
    ],
    claims: [
      { kind: 'RECOMMENDATION', text: verdict.reason, confidence: verdict.confidence },
    ],
    confidence: verdict.confidence,
    usedLlm: false,
  };
}

/**
 * The honest answer when the system does not know something (§45).
 * Exported because several call sites need exactly this wording rather than
 * each inventing their own hedge.
 */
export function formatUnknown(subject?: string): CoachResponse {
  return {
    headline: "I don't have reliable current information on that.",
    lines: subject
      ? [`Nothing in my data covers ${subject}. I'd rather say so than guess.`]
      : ["I'd rather say so than guess."],
    claims: [
      {
        kind: 'UNCERTAINTY',
        text: subject
          ? `No reliable data available for ${subject}.`
          : 'No reliable data available.',
      },
    ],
    usedLlm: false,
  };
}

export function formatStaleWarning(fetchedAt: string | undefined, now = new Date()): string | undefined {
  if (!fetchedAt) return 'Data freshness unknown.';
  const ageHours = (now.getTime() - new Date(fetchedAt).getTime()) / 3_600_000;
  if (ageHours < 1) return undefined;
  if (ageHours < 24) return `Last verified ${Math.round(ageHours)} hours ago.`;
  return `STALE — last verified ${Math.round(ageHours / 24)} days ago.`;
}

function fmt(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(1);
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}
