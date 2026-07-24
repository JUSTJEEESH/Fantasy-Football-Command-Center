import type { Position } from '@/lib/types';
import type { NewsCluster } from './dedup';
import { normalizeText } from './dedup';

// ============================================================================
// News classification and fantasy impact scoring (§6, §7).
//
// Deliberately deterministic and keyword-driven rather than LLM-driven. Two
// reasons: cost (hundreds of items a day, §38) and honesty — a rules engine
// that misses an item produces a visible gap, whereas an LLM that misreads one
// produces a confident wrong classification, which is far worse in a product
// whose whole premise is not making things up.
//
// The LLM's role in the news path is summarizing an already-classified cluster,
// never deciding what the classification is.
// ============================================================================

export const CLASSIFIER_VERSION = '1.0.0';

export type Classification =
  | 'BREAKING' | 'HIGH_IMPACT' | 'IMPORTANT' | 'WATCH' | 'LOW_IMPACT' | 'NOISE';
export type FantasyImpact = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type Direction =
  | 'STRONG_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'STRONG_NEGATIVE';

export type EventType =
  | 'injury' | 'depth_chart' | 'trade' | 'signing' | 'suspension'
  | 'practice' | 'usage' | 'coaching' | 'return' | 'holdout' | 'other';

export interface ClassifiedEvent {
  eventType: EventType;
  classification: Classification;
  fantasyImpact: FantasyImpact;
  /** 0..100 Fantasy Impact Score. */
  impactScore: number;
  /** Direction for the primary player the event is about. */
  playerDirection: Direction;
  /** Direction for the player's team as a unit. */
  teamDirection: Direction;
  positionsAffected: Position[];
  /** 0..1, from source reliability, corroboration, and recency. */
  confidence: number;
  /** Which signals fired, so any classification can be explained and audited. */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Signal vocabulary
// ---------------------------------------------------------------------------

interface Rule {
  eventType: EventType;
  /** Terms that identify this event type. */
  terms: string[];
  /** Base contribution to the impact score, 0..100. */
  baseScore: number;
  direction: Direction;
}

const RULES: Rule[] = [
  // Season-ending injuries: the single highest-impact fantasy event there is.
  { eventType: 'injury', baseScore: 95, direction: 'STRONG_NEGATIVE',
    terms: ['torn acl', 'tears acl', 'achilles', 'season ending', 'season-ending',
            'out for the season', 'placed on ir', 'injured reserve', 'lisfranc',
            'torn pectoral', 'broken leg', 'fractured'] },
  { eventType: 'injury', baseScore: 70, direction: 'NEGATIVE',
    terms: ['will miss', 'expected to miss', 'sidelined', 'ruled out', 'out multiple weeks',
            'undergo surgery', 'underwent surgery', 'sprain', 'high ankle'] },
  { eventType: 'injury', baseScore: 45, direction: 'NEGATIVE',
    terms: ['injury', 'injured', 'hurt', 'hamstring', 'groin', 'concussion',
            'questionable', 'doubtful', 'day to day', 'day-to-day', 'banged up'] },

  { eventType: 'practice', baseScore: 35, direction: 'NEGATIVE',
    terms: ['did not practice', 'limited practice', 'missed practice', 'left practice',
            'dnp', 'limited in practice'] },
  { eventType: 'practice', baseScore: 25, direction: 'POSITIVE',
    terms: ['full practice', 'returned to practice', 'practiced in full',
            'no injury designation'] },

  { eventType: 'return', baseScore: 60, direction: 'STRONG_POSITIVE',
    terms: ['activated', 'cleared to play', 'expected to play', 'will play',
            'off injured reserve', 'return to action'] },

  { eventType: 'depth_chart', baseScore: 75, direction: 'STRONG_POSITIVE',
    terms: ['named starter', 'will start', 'takes over as', 'promoted to starter',
            'wins starting job', 'first-team reps'] },
  { eventType: 'depth_chart', baseScore: 70, direction: 'STRONG_NEGATIVE',
    terms: ['benched', 'demoted', 'loses starting job', 'lost the job',
            'second string', 'backup role', 'healthy scratch'] },

  { eventType: 'usage', baseScore: 55, direction: 'POSITIVE',
    terms: ['workhorse', 'bell cow', 'increased role', 'expanded role', 'lead back',
            'target share', 'more touches', 'goal line work'] },
  { eventType: 'usage', baseScore: 50, direction: 'NEGATIVE',
    terms: ['committee', 'timeshare', 'split carries', 'reduced role',
            'snap count decline', 'fewer touches'] },

  { eventType: 'trade', baseScore: 80, direction: 'NEUTRAL',
    terms: ['traded', 'trade', 'acquired', 'dealt to', 'sends'] },
  { eventType: 'signing', baseScore: 55, direction: 'NEUTRAL',
    terms: ['signs', 'signed', 'agrees to terms', 'contract extension', 'released',
            'waived', 'cut'] },
  { eventType: 'suspension', baseScore: 85, direction: 'STRONG_NEGATIVE',
    terms: ['suspended', 'suspension', 'banned', 'violation of the'] },
  { eventType: 'holdout', baseScore: 50, direction: 'NEGATIVE',
    terms: ['holdout', 'holding out', 'contract dispute', 'did not report'] },
  { eventType: 'coaching', baseScore: 45, direction: 'NEUTRAL',
    terms: ['offensive coordinator', 'head coach', 'fired', 'hired', 'play caller'] },
];

/** Terms that mark an item as having no fantasy relevance at all. */
const NOISE_TERMS = [
  'ticket', 'jersey sales', 'stadium', 'anthem', 'arrested', 'lawsuit',
  'documentary', 'podcast', 'hall of fame', 'retirement ceremony', 'anniversary',
  'draft grade', 'mock draft', 'power rankings', 'best bets', 'odds boost',
  'fantasy advice', 'start em sit em', 'betting preview',
];

const BREAKING_TERMS = [
  'breaking', 'just in', 'sources', 'source says', 'per source', 'reportedly',
  'has learned',
];

const POSITION_TERMS: Record<Position, string[]> = {
  QB: ['quarterback', ' qb '],
  RB: ['running back', ' rb ', 'halfback', 'tailback'],
  WR: ['wide receiver', ' wr ', 'receiver'],
  TE: ['tight end', ' te '],
  K: ['kicker', 'placekicker'],
  DST: ['defense', 'defensive'],
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyCluster(
  cluster: NewsCluster,
  opts: {
    /** Max reliability among the sources that reported it, 0..1. */
    sourceReliability: number;
    /** Fantasy relevance of the linked player, 0..1 (e.g. from ADP). */
    playerImportance?: number;
    now?: Date;
  },
): ClassifiedEvent {
  const now = opts.now ?? new Date();
  const text = ` ${normalizeText(
    `${cluster.canonicalTitle} ${cluster.items.map((i) => i.summary ?? '').join(' ')}`,
  )} `;

  const signals: string[] = [];

  // Noise gate first — cheap, and stops irrelevant items consuming any budget.
  const noiseHit = NOISE_TERMS.find((term) => text.includes(term));
  if (noiseHit) {
    return {
      eventType: 'other',
      classification: 'NOISE',
      fantasyImpact: 'NONE',
      impactScore: 0,
      playerDirection: 'NEUTRAL',
      teamDirection: 'NEUTRAL',
      positionsAffected: [],
      confidence: 0.6,
      signals: [`noise term: "${noiseHit}"`],
    };
  }

  // Strongest matching rule wins; rules are ordered most-severe first within
  // each event type, so an ACL tear never gets scored as a generic "injury".
  let best: Rule | null = null;
  for (const rule of RULES) {
    const hit = rule.terms.find((term) => text.includes(term));
    if (!hit) continue;
    signals.push(`${rule.eventType}: "${hit}"`);
    if (!best || rule.baseScore > best.baseScore) best = rule;
  }

  if (!best) {
    return {
      eventType: 'other',
      classification: 'LOW_IMPACT',
      fantasyImpact: 'LOW',
      impactScore: 10,
      playerDirection: 'NEUTRAL',
      teamDirection: 'NEUTRAL',
      positionsAffected: detectPositions(text),
      confidence: 0.35,
      signals: ['no rule matched — treated as low impact rather than guessed at'],
    };
  }

  // --- Fantasy Impact Score -------------------------------------------------
  // Configurable composition of: severity, who it happened to, how trustworthy
  // the reporting is, how many outlets corroborate, and how fresh it is.
  const playerImportance = opts.playerImportance ?? 0.5;

  const importanceFactor = 0.55 + 0.45 * playerImportance;
  const reliabilityFactor = 0.7 + 0.3 * opts.sourceReliability;

  // Corroboration: several independent outlets reporting the same thing is
  // genuine evidence, with diminishing returns after the third.
  const distinctSources = new Set(cluster.items.map((i) => i.sourceKey)).size;
  const corroborationFactor = 1 + 0.12 * Math.min(3, Math.max(0, distinctSources - 1));

  const ageHours = hoursSince(cluster.latestPublishedAt ?? cluster.earliestPublishedAt, now);
  const recencyFactor =
    ageHours === null ? 0.85 : ageHours <= 6 ? 1 : ageHours <= 24 ? 0.92 : ageHours <= 72 ? 0.8 : 0.6;

  const impactScore = Math.round(
    Math.min(
      100,
      best.baseScore * importanceFactor * reliabilityFactor * corroborationFactor * recencyFactor,
    ),
  );

  if (distinctSources > 1) signals.push(`corroborated by ${distinctSources} sources`);
  if (ageHours !== null && ageHours > 72) signals.push('older than 72 hours');

  const isBreaking =
    BREAKING_TERMS.some((term) => text.includes(term)) &&
    (ageHours === null || ageHours <= 12) &&
    impactScore >= 55;

  return {
    eventType: best.eventType,
    classification: toClassification(impactScore, isBreaking),
    fantasyImpact: toFantasyImpact(impactScore),
    impactScore,
    playerDirection: best.direction,
    teamDirection: teamDirectionFor(best),
    positionsAffected: detectPositions(text),
    confidence: computeConfidence(opts.sourceReliability, distinctSources, ageHours),
    signals,
  };
}

function toClassification(score: number, isBreaking: boolean): Classification {
  if (isBreaking) return 'BREAKING';
  if (score >= 75) return 'HIGH_IMPACT';
  if (score >= 55) return 'IMPORTANT';
  if (score >= 35) return 'WATCH';
  if (score >= 15) return 'LOW_IMPACT';
  return 'NOISE';
}

function toFantasyImpact(score: number): FantasyImpact {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 38) return 'MEDIUM';
  if (score >= 15) return 'LOW';
  return 'NONE';
}

/**
 * A player's loss is often his team's loss but his backup's gain, so team
 * direction is not simply the player's direction. Depth-chart and usage events
 * are zero-sum within a team and so read as team-neutral.
 */
function teamDirectionFor(rule: Rule): Direction {
  if (rule.eventType === 'depth_chart' || rule.eventType === 'usage') return 'NEUTRAL';
  if (rule.direction === 'STRONG_NEGATIVE') return 'NEGATIVE';
  if (rule.direction === 'STRONG_POSITIVE') return 'POSITIVE';
  return rule.direction;
}

function detectPositions(text: string): Position[] {
  const found: Position[] = [];
  for (const [position, terms] of Object.entries(POSITION_TERMS) as Array<
    [Position, string[]]
  >) {
    if (terms.some((term) => text.includes(term))) found.push(position);
  }
  return found;
}

function computeConfidence(
  reliability: number,
  distinctSources: number,
  ageHours: number | null,
): number {
  const corroboration = Math.min(1, 0.55 + 0.15 * (distinctSources - 1));
  const recency = ageHours === null ? 0.85 : ageHours <= 24 ? 1 : ageHours <= 72 ? 0.9 : 0.75;
  return Math.round(Math.min(0.95, reliability * corroboration * recency + 0.15) * 100) / 100;
}

function hoursSince(timestamp: string | undefined, now: Date): number | null {
  if (!timestamp) return null;
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}

// ---------------------------------------------------------------------------
// Player linking
// ---------------------------------------------------------------------------

export interface PlayerNameIndex {
  /** searchKey -> player id. */
  byKey: Map<string, string>;
  /** last-name searchKey -> player ids (ambiguous when more than one). */
  byLastName: Map<string, string[]>;
}

export function buildPlayerNameIndex(
  players: Array<{ id: string; name: string }>,
  toKey: (name: string) => string,
): PlayerNameIndex {
  const byKey = new Map<string, string>();
  const byLastName = new Map<string, string[]>();

  for (const player of players) {
    byKey.set(toKey(player.name), player.id);
    const parts = player.name.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if (last && parts.length > 1) {
      const key = toKey(last);
      byLastName.set(key, [...(byLastName.get(key) ?? []), player.id]);
    }
  }

  return { byKey, byLastName };
}

/**
 * Link a headline to players.
 *
 * Full-name matches only, plus unambiguous last-name matches. A last name
 * shared by several players is deliberately dropped rather than guessed —
 * attaching an ACL tear to the wrong Johnson is exactly the class of error
 * this product must never make.
 */
export function linkPlayers(
  text: string,
  index: PlayerNameIndex,
  toKey: (name: string) => string,
): Array<{ playerId: string; matchType: 'full' | 'last'; confidence: number }> {
  const normalized = normalizeText(text);
  const words = normalized.split(' ');
  const found = new Map<string, { matchType: 'full' | 'last'; confidence: number }>();

  // Full names: scan two- and three-word windows.
  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const candidate = words.slice(i, i + size).join(' ');
      const playerId = index.byKey.get(toKey(candidate));
      if (playerId) found.set(playerId, { matchType: 'full', confidence: 0.95 });
    }
  }

  // Unambiguous last names, only if no full-name match already covers them.
  for (const word of words) {
    if (word.length < 4) continue;
    const matches = index.byLastName.get(toKey(word));
    if (matches && matches.length === 1) {
      const playerId = matches[0]!;
      if (!found.has(playerId)) {
        found.set(playerId, { matchType: 'last', confidence: 0.7 });
      }
    }
  }

  return [...found.entries()].map(([playerId, meta]) => ({ playerId, ...meta }));
}
