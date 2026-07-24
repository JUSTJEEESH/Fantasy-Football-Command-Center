// ============================================================================
// Coach intent router (§43).
//
// Deterministic. The LLM is not asked "what did the user mean?" for the common
// commands, because during a draft the round trip is too slow and a
// misclassified "who's my pick" is unacceptable. Pattern matching resolves the
// command surface instantly and offline; anything unmatched can optionally be
// escalated to the LLM.
// ============================================================================

export const INTENTS = [
  'WAKE',
  'BRIEFING',
  'NEWS',
  'INJURIES',
  'SLEEPERS',
  'RISKS',
  'RANKINGS',
  'VALUES',
  'MY_TEAM',
  'DRAFT_MODE',
  'MY_PICK',
  'WHY',
  'WHAT_IF',
  'PLAN',
  'RUN_CHECK',
  'WAIT_CHECK',
  'PICK_FLAVOR',
  'MARK_DRAFTED',
  'UNDO',
  'CORRECTION',
  'COMPARE',
  'TRADE',
  'START_SIT',
  'HELP',
  'UNKNOWN',
] as const;

export type Intent = (typeof INTENTS)[number];

export type PickFlavor =
  | 'safest' | 'highest_upside' | 'contrarian' | 'best_value' | 'best_fit' | 'best_overall';

export interface ParsedCommand {
  intent: Intent;
  /** 0..1 — how sure the router is. Low values should ask rather than assume. */
  confidence: number;
  /** Extracted arguments, intent-specific. */
  args: {
    playerNames?: string[];
    flavor?: PickFlavor;
    teamSlot?: number;
    count?: number;
    /** For CORRECTION: the player that was wrongly recorded. */
    wrongPlayer?: string;
    /** For CORRECTION / MARK_DRAFTED: the player that should be recorded. */
    correctPlayer?: string;
  };
  /** The normalized text the router matched against. */
  normalized: string;
  /** True when the intent was resolved using conversation context. */
  usedContext: boolean;
}

/**
 * Conversation memory. Kept tiny on purpose: the follow-ups that matter during
 * a draft are "why?", "what if he's gone?" and "and after that?", all of which
 * only need the last recommendation and the last player discussed.
 */
export interface CoachContext {
  lastIntent?: Intent;
  lastRecommendedPlayerId?: string;
  lastRecommendedPlayerName?: string;
  lastAlternatives?: string[];
  lastDiscussedPlayers?: string[];
  inDraftMode?: boolean;
  /** How many times the user has asked "and after that?" in a row. */
  whatIfDepth?: number;
}

// ---------------------------------------------------------------------------

interface Pattern {
  intent: Intent;
  /** Higher wins when several patterns match. */
  priority: number;
  test: RegExp;
  confidence: number;
}

/**
 * Order matters only via `priority`. Specific commands outrank general ones so
 * that "who should I take" resolves to MY_PICK rather than RANKINGS.
 */
const PATTERNS: Pattern[] = [
  // --- draft-critical, highest priority ------------------------------------
  { intent: 'MY_PICK', priority: 100, confidence: 0.95,
    test: /\b(who'?s my pick|who should i (take|draft|pick)|my pick|whats my pick|what'?s my pick|who do i take|give me (a |the )?pick|pick for me)\b/ },
  { intent: 'PICK_FLAVOR', priority: 105, confidence: 0.93,
    test: /\b(safest|safe(st)? pick|highest[- ]upside|most upside|biggest upside|contrarian|boldest|best value|value pick|best fit|best available|bpa)\b/ },
  { intent: 'UNDO', priority: 104, confidence: 0.96,
    test: /\b(undo|take (that|it) back|scratch that|never ?mind that pick|revert)\b/ },
  { intent: 'CORRECTION', priority: 103, confidence: 0.9,
    test: /\b(correction|actually took|not .*, ?it was|i meant|fix (that|the) pick|change (that|the last) pick)\b/ },
  // Deliberately below WHY/WHAT_IF: "what if he's gone?" contains "gone" but is
  // a question about a hypothetical, not an announcement that a pick happened.
  { intent: 'MARK_DRAFTED', priority: 86.5, confidence: 0.9,
    test: /\b(was |just |is )?(drafted|taken|off the board|gone|selected)\b|\btook\b/ },

  { intent: 'DRAFT_MODE', priority: 90, confidence: 0.95,
    test: /\b(draft mode|start (the )?draft|enter draft|war room|begin draft|draft time)\b/ },

  { intent: 'WHY', priority: 88, confidence: 0.9,
    test: /^\s*(why|why him|why not|why that|explain|because\?|reasoning|how come)\b/ },
  { intent: 'WHAT_IF', priority: 87, confidence: 0.88,
    test: /\b(what if|if he'?s gone|if (he|they)'?re? (gone|taken)|and after that|then who|who else|next best|and then)\b/ },
  { intent: 'WAIT_CHECK', priority: 86, confidence: 0.9,
    test: /\b(should i reach|can i wait|how (much )?longer can i wait|wait on|reach for|is it too early|do i need to take him now)\b/ },
  { intent: 'RUN_CHECK', priority: 85, confidence: 0.9,
    test: /\b(positional run|is there a run|run on|is it time (to|for)|are (qb|rb|wr|te)s? going|position(al)? run)\b/ },
  { intent: 'PLAN', priority: 84, confidence: 0.9,
    test: /\b(plan|next (few |three |3 )?picks|how many picks until|when do i pick|strategy for|picks until)\b/ },

  // --- information ---------------------------------------------------------
  { intent: 'COMPARE', priority: 80, confidence: 0.92,
    test: /\b(compare|versus|vs\.?|or)\b.*\b(and|or|vs\.?)\b|^compare\b/ },
  { intent: 'TRADE', priority: 79, confidence: 0.9,
    test: /\b(trade|evaluate this trade|should i trade|trade offer|is this trade)\b/ },
  { intent: 'START_SIT', priority: 78, confidence: 0.9,
    test: /\b(start\/?\s?sit|start or sit|who (should i )?(start|flex)|lineup (advice|help)|sit or start)\b/ },

  // NOTE: these use \w* rather than a trailing \b so that plurals and
  // inflections ("injuries", "sleepers", "busts") match the same rule.
  { intent: 'INJURIES', priority: 70, confidence: 0.92,
    test: /\b(injur\w*|hurt|health\w*|questionable|doubtful|practice report|banged up)\b/ },
  { intent: 'SLEEPERS', priority: 69, confidence: 0.9,
    test: /\b(sleeper\w*|breakout\w*|rising|going up|undervalued|target\w* to (get|draft)|be targeting)\b/ },
  { intent: 'RISKS', priority: 68, confidence: 0.9,
    test: /\b(bust\w*|risk\w*|falling|fade|going down|avoid|overvalued|red flag)\b/ },
  { intent: 'VALUES', priority: 67, confidence: 0.88,
    test: /\b(value\w*|adp value|discount|bargain)\b/ },
  { intent: 'RANKINGS', priority: 66, confidence: 0.88,
    test: /\b(ranking\w*|top \d+|tiers?|board|cheat ?sheet)\b/ },
  { intent: 'MY_TEAM', priority: 65, confidence: 0.9,
    test: /\b(my (team|roster)|show me my|how (strong|good) is my|weakest|my squad|roster analysis)\b/ },

  { intent: 'BRIEFING', priority: 60, confidence: 0.9,
    test: /\b(what'?s new|whats new|briefing|what happened|catch me up|latest|update me|morning|anything i (need to )?know|what'?s the latest)\b/ },
  { intent: 'NEWS', priority: 55, confidence: 0.85,
    test: /\b(news|headlines|what'?s going on|biggest (fantasy )?news)\b/ },

  { intent: 'HELP', priority: 50, confidence: 0.95,
    test: /^\s*(help|what can you do|commands|how do i use|options)\b/ },

  // --- lowest priority: the wake word alone --------------------------------
  { intent: 'WAKE', priority: 10, confidence: 0.95,
    test: /^\s*(hey |ok |yo )?coach[\s.!?,]*$/ },
];

const FLAVOR_PATTERNS: Array<[RegExp, PickFlavor]> = [
  [/\bsafe(st)?\b/, 'safest'],
  [/\b(highest[- ]upside|most upside|biggest upside|upside)\b/, 'highest_upside'],
  [/\b(contrarian|bold(est)?|off[- ]board)\b/, 'contrarian'],
  [/\b(best )?value\b/, 'best_value'],
  [/\b(best )?fit\b/, 'best_fit'],
  [/\b(best available|bpa|best overall)\b/, 'best_overall'],
];

// ---------------------------------------------------------------------------

export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip a leading wake word so "coach, my pick" routes like "my pick". */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*(hey |ok |yo )?coach[\s,.:!?-]*/i, '').trim();
}

export function parseCommand(
  input: string,
  context: CoachContext = {},
): ParsedCommand {
  const normalized = normalize(input);
  const body = stripWakeWord(normalized);

  // Bare wake word: the user is opening the app and expects readiness, not an
  // answer to a question they have not asked yet.
  if (body === '' && normalized !== '') {
    return {
      intent: 'WAKE',
      confidence: 0.98,
      args: {},
      normalized,
      usedContext: false,
    };
  }

  const matches = PATTERNS.filter((p) => p.test.test(body)).sort(
    (a, b) => b.priority - a.priority,
  );

  const best = matches[0];
  if (!best) {
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      args: { playerNames: extractQuotedOrCapitalized(input) },
      normalized,
      usedContext: false,
    };
  }

  const args = extractArgs(best.intent, body, input, context);

  // Follow-ups only make sense against a prior recommendation. If there is
  // none, say so rather than answering a question about nothing.
  const contextual = best.intent === 'WHY' || best.intent === 'WHAT_IF';
  const usedContext = contextual && Boolean(context.lastRecommendedPlayerId);

  return {
    intent: best.intent,
    confidence:
      contextual && !context.lastRecommendedPlayerId
        ? best.confidence * 0.5
        : best.confidence,
    args,
    normalized,
    usedContext,
  };
}

function extractArgs(
  intent: Intent,
  body: string,
  original: string,
  context: CoachContext,
): ParsedCommand['args'] {
  const args: ParsedCommand['args'] = {};

  if (intent === 'PICK_FLAVOR') {
    for (const [pattern, flavor] of FLAVOR_PATTERNS) {
      if (pattern.test(body)) {
        args.flavor = flavor;
        break;
      }
    }
  }

  if (intent === 'COMPARE') {
    args.playerNames = splitComparison(original);
  }

  if (intent === 'MARK_DRAFTED') {
    args.correctPlayer = extractDraftedPlayer(original);
    const slot = body.match(/\bteam\s+(\d+)\b/);
    if (slot) args.teamSlot = Number(slot[1]);
  }

  if (intent === 'CORRECTION') {
    const parsed = parseCorrection(original);
    if (parsed) {
      args.wrongPlayer = parsed.wrong;
      args.correctPlayer = parsed.correct;
    }
  }

  if (intent === 'PLAN') {
    const count = body.match(/\b(next\s+)?(\d+|two|three|four|five)\b/);
    if (count) args.count = wordToNumber(count[2]!);
  }

  if (intent === 'WHAT_IF') {
    args.count = (context.whatIfDepth ?? 0) + 1;
  }

  if (!args.playerNames) {
    const names = extractQuotedOrCapitalized(original);
    if (names.length > 0) args.playerNames = names;
  }

  return args;
}

/**
 * Pull player names out of free text.
 *
 * Capitalization is the only reliable signal available offline, and it fails on
 * voice transcription (which lowercases everything). Callers therefore treat
 * these as candidates to resolve against the player index, not as facts — an
 * unresolvable name must produce "I don't know who that is", never a guess.
 */
export function extractQuotedOrCapitalized(text: string): string[] {
  const quoted = [...text.matchAll(/"([^"]{2,40})"/g)].map((m) => m[1]!.trim());
  if (quoted.length > 0) return quoted;

  const names: string[] = [];
  const pattern = /\b([A-Z][a-z'’.-]+(?:\s+[A-Z][a-z'’.-]+){1,2})\b/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1]!.trim();
    if (!LEADING_WORDS.has(candidate.split(' ')[0]!.toLowerCase())) {
      names.push(candidate);
    }
  }
  return names;
}

/** Sentence-initial words that look like names but aren't. */
const LEADING_WORDS = new Set([
  'coach', 'who', 'what', 'why', 'should', 'compare', 'give', 'show', 'coach,',
  'take', 'draft', 'undo', 'correction', 'team', 'the', 'is', 'my',
]);

export function splitComparison(text: string): string[] {
  const cleaned = text.replace(/^\s*(hey |ok )?coach[\s,.:!?-]*/i, '').replace(/^compare\s+/i, '');
  const parts = cleaned
    .split(/\s+(?:versus|vs\.?|and|or)\s+/i)
    .map((p) => p.replace(/[?.!,]+$/, '').trim())
    .filter((p) => p.length > 1);

  // If splitting produced nothing name-like, fall back to capitalized spans.
  if (parts.length >= 2) return parts;
  return extractQuotedOrCapitalized(text);
}

/** "Bijan Robinson drafted" / "Team 4 took Bijan Robinson" */
export function extractDraftedPlayer(text: string): string | undefined {
  const took = text.match(/\btook\s+(.+?)(?:[.!?]|$)/i);
  if (took) return cleanName(took[1]!);

  const drafted = text.match(
    /^(?:coach[\s,.:!?-]*)?(.+?)\s+(?:was\s+|just\s+|is\s+)?(?:drafted|taken|selected|gone|off the board)\b/i,
  );
  if (drafted) return cleanName(drafted[1]!);

  const names = extractQuotedOrCapitalized(text);
  return names[0];
}

/** "Correction: Team 4 took Player A, not Player Z" */
export function parseCorrection(
  text: string,
): { wrong?: string; correct?: string } | null {
  const notPattern = text.match(/\b(.+?),?\s+not\s+(.+?)(?:[.!?]|$)/i);
  if (notPattern) {
    const correctRaw = notPattern[1]!;
    const took = correctRaw.match(/\btook\s+(.+)$/i);
    return {
      correct: cleanName(took ? took[1]! : correctRaw),
      wrong: cleanName(notPattern[2]!),
    };
  }

  const actually = text.match(/\bactually\s+took\s+(.+?)(?:[.!?]|$)/i);
  if (actually) return { correct: cleanName(actually[1]!) };

  const meant = text.match(/\bi\s+meant\s+(.+?)(?:[.!?]|$)/i);
  if (meant) return { correct: cleanName(meant[1]!) };

  return null;
}

function cleanName(value: string): string {
  return value
    .replace(/^(?:correction[\s:,-]*)/i, '')
    .replace(/\bteam\s+\d+\s+/i, '')
    .replace(/^(?:that|it|the pick)\s+(?:was|is)\s+/i, '')
    .replace(/[.,!?]+$/, '')
    .trim();
}

function wordToNumber(word: string): number {
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  return words[word] ?? Number(word) ?? 3;
}

// ---------------------------------------------------------------------------

export const HELP_TEXT = `What you can say:

DRAFT
  "draft mode"              start the war room
  "who's my pick?"          the recommendation
  "why?"                    the reasoning
  "what if he's gone?"      the fallback
  "and after that?"         keep going down the list
  "safest pick" / "most upside" / "contrarian"
  "should I reach?" / "how long can I wait?"
  "is there a run?"         positional run check
  "plan my next three picks"
  "<player> drafted"        record a pick
  "undo"                    take back the last pick
  "correction: team 4 took X, not Y"

INFORMATION
  "what's new?"             your briefing
  "injuries"                injury report
  "sleepers" / "busts" / "values"
  "rankings"                current board
  "my team"                 roster analysis
  "compare X and Y"
  "evaluate this trade"
  "start/sit"`;
