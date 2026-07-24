import { describe, expect, it } from 'vitest';
import {
  extractDraftedPlayer,
  extractQuotedOrCapitalized,
  parseCommand,
  parseCorrection,
  splitComparison,
  stripWakeWord,
  type CoachContext,
} from '@/lib/coach/intents';

const intentOf = (text: string, ctx?: CoachContext) => parseCommand(text, ctx).intent;

describe('wake word', () => {
  it('recognizes the bare wake word', () => {
    for (const phrase of ['Coach.', 'coach', 'Hey Coach', 'ok coach!', 'Coach,']) {
      expect(intentOf(phrase)).toBe('WAKE');
    }
  });

  it('strips the wake word before routing', () => {
    expect(stripWakeWord('coach, who is my pick')).toBe('who is my pick');
    expect(stripWakeWord('Hey Coach — injuries')).toBe('— injuries');
  });

  it('routes past the wake word to the real command', () => {
    expect(intentOf('Coach, who\'s my pick?')).toBe('MY_PICK');
    expect(intentOf('coach injuries')).toBe('INJURIES');
  });
});

describe('draft commands', () => {
  it('recognizes every phrasing of the pick question', () => {
    for (const phrase of [
      "who's my pick?",
      'who should I take',
      'who should I draft',
      'my pick',
      'what\'s my pick',
      'who do I take here',
      'give me a pick',
    ]) {
      expect(intentOf(phrase)).toBe('MY_PICK');
    }
  });

  it('enters draft mode', () => {
    for (const phrase of ['draft mode', 'start the draft', 'war room', 'draft time']) {
      expect(intentOf(phrase)).toBe('DRAFT_MODE');
    }
  });

  it('recognizes pick flavors and extracts which one', () => {
    expect(parseCommand('give me the safest pick')).toMatchObject({
      intent: 'PICK_FLAVOR', args: { flavor: 'safest' },
    });
    expect(parseCommand('highest upside pick').args.flavor).toBe('highest_upside');
    expect(parseCommand('give me a contrarian pick').args.flavor).toBe('contrarian');
    expect(parseCommand('best value on the board').args.flavor).toBe('best_value');
  });

  it('recognizes undo', () => {
    for (const phrase of ['undo', 'undo last pick', 'scratch that', 'take that back']) {
      expect(intentOf(phrase)).toBe('UNDO');
    }
  });

  it('recognizes wait-or-reach questions', () => {
    for (const phrase of [
      'should I reach for him',
      'can I wait',
      'how much longer can I wait',
      'do I need to take him now',
    ]) {
      expect(intentOf(phrase)).toBe('WAIT_CHECK');
    }
  });

  it('recognizes run checks', () => {
    expect(intentOf("what's the positional run")).toBe('RUN_CHECK');
    expect(intentOf('is it time to take a QB')).toBe('RUN_CHECK');
    expect(intentOf('is there a run on running backs')).toBe('RUN_CHECK');
  });

  it('recognizes planning questions', () => {
    expect(intentOf('plan my next three picks')).toBe('PLAN');
    expect(parseCommand('plan my next three picks').args.count).toBe(3);
    expect(intentOf('how many picks until I pick again')).toBe('PLAN');
  });
});

describe('conversational follow-ups (§2)', () => {
  const context: CoachContext = {
    lastIntent: 'MY_PICK',
    lastRecommendedPlayerId: 'p1',
    lastRecommendedPlayerName: 'Sample Back',
    lastAlternatives: ['p2', 'p3'],
    inDraftMode: true,
  };

  it('understands a bare "why?"', () => {
    const parsed = parseCommand('why?', context);
    expect(parsed.intent).toBe('WHY');
    expect(parsed.usedContext).toBe(true);
  });

  it('understands "what if he\'s gone?"', () => {
    expect(parseCommand("what if he's gone?", context).intent).toBe('WHAT_IF');
    expect(parseCommand("what if he's gone?", context).usedContext).toBe(true);
  });

  it('understands "and after that?" as continuing down the list', () => {
    expect(intentOf('and after that?', context)).toBe('WHAT_IF');
    expect(intentOf('then who?', context)).toBe('WHAT_IF');
    expect(intentOf('next best?', context)).toBe('WHAT_IF');
  });

  it('tracks how deep the user has gone down the alternatives', () => {
    const deeper = parseCommand('and after that?', { ...context, whatIfDepth: 2 });
    expect(deeper.args.count).toBe(3);
  });

  it('lowers confidence for a follow-up with no prior recommendation', () => {
    const orphan = parseCommand('why?', {});
    expect(orphan.intent).toBe('WHY');
    expect(orphan.usedContext).toBe(false);
    expect(orphan.confidence).toBeLessThan(0.6);
  });
});

describe('manual draft entry (§19)', () => {
  it('records a pick from a bare statement', () => {
    const parsed = parseCommand('Bijan Robinson drafted');
    expect(parsed.intent).toBe('MARK_DRAFTED');
    expect(parsed.args.correctPlayer).toBe('Bijan Robinson');
  });

  it('handles "was drafted" and "just went"', () => {
    expect(extractDraftedPlayer('Puka Nacua was drafted')).toBe('Puka Nacua');
    expect(extractDraftedPlayer('Sample Back is off the board')).toBe('Sample Back');
  });

  it('attributes a pick to a team', () => {
    const parsed = parseCommand('Team 4 took Sample Back');
    expect(parsed.intent).toBe('MARK_DRAFTED');
    expect(parsed.args.teamSlot).toBe(4);
    expect(parsed.args.correctPlayer).toBe('Sample Back');
  });

  it('parses a correction with both players', () => {
    const parsed = parseCommand('Correction: Team 4 took Sample Back, not Sample Receiver');
    expect(parsed.intent).toBe('CORRECTION');
    expect(parsed.args.correctPlayer).toBe('Sample Back');
    expect(parsed.args.wrongPlayer).toBe('Sample Receiver');
  });

  it('parses a bare "actually took"', () => {
    expect(parseCorrection('actually took Sample Receiver')).toMatchObject({
      correct: 'Sample Receiver',
    });
  });

  it('parses "I meant"', () => {
    expect(parseCorrection('I meant Sample Back')).toMatchObject({ correct: 'Sample Back' });
  });

  it('returns null when there is no correction to parse', () => {
    expect(parseCorrection('who is my pick')).toBeNull();
  });
});

describe('information commands', () => {
  const cases: Array<[string, string]> = [
    ["what's new?", 'BRIEFING'],
    ['give me my morning briefing', 'BRIEFING'],
    ['what happened today', 'BRIEFING'],
    ['catch me up', 'BRIEFING'],
    ['any injuries I need to know about?', 'INJURIES'],
    ['who is banged up', 'INJURIES'],
    ["who's rising?", 'SLEEPERS'],
    ["who are today's biggest sleepers", 'SLEEPERS'],
    ['who should I be targeting', 'SLEEPERS'],
    ["who's falling?", 'RISKS'],
    ['who should I avoid', 'RISKS'],
    ['show me my roster', 'MY_TEAM'],
    ['how strong is my team', 'MY_TEAM'],
    ['what position am I weakest at', 'MY_TEAM'],
    ['evaluate this trade', 'TRADE'],
    ['start sit', 'START_SIT'],
    ['who should I flex', 'START_SIT'],
    ['help', 'HELP'],
    ['what can you do', 'HELP'],
  ];

  for (const [phrase, expected] of cases) {
    it(`routes "${phrase}" to ${expected}`, () => {
      expect(intentOf(phrase)).toBe(expected);
    });
  }
});

describe('player comparison', () => {
  it('extracts both players', () => {
    const parsed = parseCommand('Compare Sample Back and Sample Receiver');
    expect(parsed.intent).toBe('COMPARE');
    expect(parsed.args.playerNames).toEqual(['Sample Back', 'Sample Receiver']);
  });

  it('handles "versus" and "vs"', () => {
    expect(splitComparison('Sample Back vs Sample Receiver')).toEqual([
      'Sample Back', 'Sample Receiver',
    ]);
    expect(splitComparison('Compare Sample Back versus Sample Receiver')).toEqual([
      'Sample Back', 'Sample Receiver',
    ]);
  });
});

describe('name extraction', () => {
  it('prefers quoted names', () => {
    expect(extractQuotedOrCapitalized('is "de\'von achane" available')).toEqual([
      "de'von achane",
    ]);
  });

  it('falls back to capitalized spans', () => {
    expect(extractQuotedOrCapitalized('What about Sample Back this round')).toContain(
      'Sample Back',
    );
  });

  it('does not treat a leading command word as a name', () => {
    expect(extractQuotedOrCapitalized('Compare Sample Back and X')).not.toContain(
      'Compare Sample',
    );
  });
});

describe('unknown input', () => {
  it('reports UNKNOWN with zero confidence rather than guessing', () => {
    const parsed = parseCommand('what is the airspeed velocity of an unladen swallow');
    expect(parsed.intent).toBe('UNKNOWN');
    expect(parsed.confidence).toBe(0);
  });

  it('handles empty input', () => {
    expect(parseCommand('').intent).toBe('UNKNOWN');
  });
});

describe('router performance', () => {
  it('resolves fast enough for draft-day use', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) parseCommand("coach, who's my pick?");
    expect((performance.now() - start) / 1000).toBeLessThan(1);
  });
});
