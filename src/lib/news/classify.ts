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
    terms: ['activated', 'cleared to play', 'fully cleared', 'cleared for',
            'expected to play', 'will play', 'off injured reserve',
            'return to action'] },

  // NOTE: every phrase here must be unambiguously positive. A bare "starting
  // job" would also match "loses starting job" and, because this rule scores
  // higher than the benching rule, would invert the meaning of a demotion.
  { eventType: 'depth_chart', baseScore: 75, direction: 'STRONG_POSITIVE',
    terms: ['named starter', 'named starting', 'named the starting', 'will start',
            'takes over as', 'promoted to starter', 'wins starting job',
            'wins the starting job', 'gets the start', 'atop the depth chart',
            'first-team reps', 'first team reps'] },
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

/**
 * Terms that mark an item as having no fantasy relevance at all.
 *
 * The other-sport and business entries earn their place: a general NFL feed
 * carries plenty of neither. "MLB trade deadline predictions" matched the trade
 * rule and scored as a real transaction, and a story about a team's operating
 * loss was surfaced as fantasy-relevant news. Both are noise by any reading.
 */
const NOISE_TERMS = [
  'ticket', 'jersey sales', 'stadium', 'anthem', 'arrested', 'lawsuit',
  'documentary', 'podcast', 'hall of fame', 'retirement ceremony', 'anniversary',
  'draft grade', 'mock draft', 'power rankings', 'best bets', 'odds boost',
  'fantasy advice', 'start em sit em', 'betting preview',
  // Other sports leaking into a general sports feed.
  'mlb', 'nba', 'nhl', 'wnba', 'premier league', 'world cup', 'ncaa tournament',
  'formula 1', 'golf', 'tennis', 'ufc', 'boxing', 'nascar',
  // Business and off-field items.
  'operating loss', 'revenue', 'valuation', 'sponsorship', 'naming rights',
  'ownership stake', 'sells minority', 'stock', 'earnings',
  // Speculative filler.
  'predictions', 'way too early', 'what if', 'debate', 'ranking the',
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

  // Match the HEADLINE first, and only fall back to the body.
  //
  // Scoring against title-plus-summary as one blob let background context drive
  // the rating: a human-interest piece about a quarterback whose blurb happened
  // to mention his past ACL tear scored 98/100 as a fresh season-ending injury.
  // The headline states what happened; the body often references what already
  // did. A body-only match is still worth reporting, but at a discount and
  // labelled as context rather than as the event.
  const headline = ` ${normalizeText(cluster.canonicalTitle)} `;

  const matchIn = (haystack: string): Rule | null => {
    let found: Rule | null = null;
    for (const rule of RULES) {
      const hit = rule.terms.find((term) => haystack.includes(term));
      if (!hit) continue;
      signals.push(`${rule.eventType}: "${hit}"`);
      if (!found || rule.baseScore > found.baseScore) found = rule;
    }
    return found;
  };

  let best = matchIn(headline);
  let contextOnly = false;

  if (!best) {
    best = matchIn(text);
    if (best) {
      contextOnly = true;
      signals.push('matched on article context, not the headline — scored down');
    }
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

  // A rule that only fired on the body describes context, not the event.
  const contextFactor = contextOnly ? 0.55 : 1;

  const impactScore = Math.round(
    Math.min(
      100,
      best.baseScore *
        importanceFactor *
        reliabilityFactor *
        corroborationFactor *
        recencyFactor *
        contextFactor,
    ),
  );

  if (distinctSources > 1) signals.push(`corroborated by ${distinctSources} sources`);
  if (ageHours !== null && ageHours > 72) signals.push('older than 72 hours');

  const isBreaking =
    BREAKING_TERMS.some((term) => text.includes(term)) &&
    (ageHours === null || ageHours <= 12) &&
    impactScore >= 55;

  // A context-only match tells us the article mentions an injury, not that one
  // just happened. Asserting "his value drops sharply — plan for a replacement"
  // off a rehab retrospective is exactly the confident-but-wrong claim this
  // system is built to avoid, so the direction is withheld rather than guessed.
  const playerDirection = contextOnly ? 'NEUTRAL' : best.direction;

  return {
    eventType: best.eventType,
    classification: toClassification(impactScore, isBreaking),
    fantasyImpact: toFantasyImpact(impactScore),
    impactScore,
    playerDirection,
    teamDirection: contextOnly ? 'NEUTRAL' : teamDirectionFor(best),
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

/**
 * Confidence that the event is real and correctly characterized.
 *
 * Calibrated to actually spread across its range. An earlier version added a
 * flat +0.15 and let corroboration reach 1.0 at three sources, so anything
 * widely reported pinned to the 0.95 ceiling — every item in the feed displayed
 * the same number, which tells the reader nothing and reads as decoration
 * rather than a measurement.
 *
 * Roughly: a lone aggregator report lands near 0.45, a single strong national
 * outlet near 0.6, and the same story from four independent outlets near 0.9.
 * It never reaches 1.0, because a keyword classifier is never certain.
 */
function computeConfidence(
  reliability: number,
  distinctSources: number,
  ageHours: number | null,
): number {
  // Independent corroboration is the strongest signal, with diminishing
  // returns — the third outlet adds much less than the second.
  const corroboration = 1 - Math.pow(0.55, Math.max(0, distinctSources - 1));
  const base = 0.45 + 0.25 * reliability + 0.3 * corroboration;

  const recency = ageHours === null ? 0.92 : ageHours <= 24 ? 1 : ageHours <= 72 ? 0.95 : 0.85;

  return Math.round(Math.min(0.93, base * recency) * 100) / 100;
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
  players: Array<{ id: string; name: string; position?: string }>,
  toKey: (name: string) => string,
): PlayerNameIndex {
  const byKey = new Map<string, string>();
  const byLastName = new Map<string, string[]>();

  for (const player of players) {
    // Team defenses are named after their teams ("Carolina Panthers"), and a
    // team name appears in a huge share of NFL headlines that have nothing to
    // do with fantasy. Indexing them meant "Steelers Friday Night Happy Hour"
    // linked the Steelers DST, which then satisfied the has-a-linked-player
    // test that keeps chatter out of the feed — 32 junk items in one build.
    // Worse, "Panthers put Nic Scourton on injured reserve" filed as an INJURY
    // against the Carolina Panthers defense, which is not what happened.
    //
    // A defense is a fantasy asset, but it is never the subject of a news item
    // in the way a player is. Linking it by team nickname buys nothing and
    // costs the feed its signal.
    if (player.position === 'DST') continue;

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

  // Words already accounted for by a full-name match. Without this, a first
  // name that happens to be another player's surname produces a confident,
  // completely wrong link: "Patrick Mahomes" matched Tim Patrick on the word
  // "patrick", and the story was filed against a player it never mentioned.
  const consumed = new Set<number>();

  // Full names: scan longest windows first so a three-word name wins over the
  // two-word window inside it.
  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const candidate = words.slice(i, i + size).join(' ');
      const playerId = index.byKey.get(toKey(candidate));
      if (!playerId) continue;
      found.set(playerId, { matchType: 'full', confidence: 0.95 });
      for (let offset = 0; offset < size; offset++) consumed.add(i + offset);
    }
  }

  // Unambiguous last names, ignoring any word already inside a full name.
  words.forEach((word, i) => {
    if (consumed.has(i) || word.length < 4) return;
    const matches = index.byLastName.get(toKey(word));
    if (matches && matches.length === 1) {
      const playerId = matches[0]!;
      if (!found.has(playerId)) {
        found.set(playerId, { matchType: 'last', confidence: 0.7 });
      }
    }
  });

  return [...found.entries()].map(([playerId, meta]) => ({ playerId, ...meta }));
}
