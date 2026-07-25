import { describe, expect, it } from 'vitest';
import {
  eventTypeLabel,
  impactSentence,
  packFreshness,
  relativeTime,
  groupByPlayer,
  type NewsEventView,
} from '@/lib/static-data';

function event(overrides: Partial<NewsEventView> = {}): NewsEventView {
  return {
    id: 'e1',
    headline: 'Something happened',
    eventType: 'injury',
    classification: 'HIGH_IMPACT',
    fantasyImpact: 'HIGH',
    impactScore: 70,
    confidence: 0.8,
    playerDirection: 'NEGATIVE',
    positions: [],
    players: [{ name: 'Sample Back', position: 'RB', team: 'TEN' }],
    sources: [],
    signals: [],
    ...overrides,
  };
}

describe('impact sentence', () => {
  it('warns plainly on a season-ending injury', () => {
    const text = impactSentence(event({ playerDirection: 'STRONG_NEGATIVE' }));
    expect(text).toMatch(/drops sharply/);
    expect(text).toMatch(/Sample Back/);
  });

  it('treats a missed practice as a signal, not a verdict', () => {
    expect(impactSentence(event({ eventType: 'practice' }))).toMatch(/not a verdict/i);
  });

  it('does not call a trade "no impact" just because direction is neutral', () => {
    // A trade changes everything about a player's situation; it simply does not
    // point reliably up or down yet. Saying "no impact" would mislead.
    const text = impactSentence(
      event({ eventType: 'trade', playerDirection: 'NEUTRAL' }),
    );
    expect(text).toMatch(/changes materially/i);
    expect(text).not.toMatch(/no clear directional/i);
  });

  it('is positive about a promotion', () => {
    expect(impactSentence(event({ playerDirection: 'STRONG_POSITIVE' }))).toMatch(
      /gains real value/,
    );
  });

  it('handles an event with no linked player', () => {
    expect(impactSentence(event({ players: [] }))).toBeTruthy();
  });
});

describe('freshness reporting', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const meta = (generatedAt: string) => ({
    generatedAt,
    ok: true,
    sources: [],
  });

  it('calls a recent build fresh', () => {
    expect(packFreshness(meta('2026-08-30T09:00:00Z'), now)!.level).toBe('fresh');
  });

  it('calls a day-old build aging', () => {
    expect(packFreshness(meta('2026-08-29T12:00:00Z'), now)!.level).toBe('aging');
  });

  it('shouts about a week-old build', () => {
    const result = packFreshness(meta('2026-08-23T12:00:00Z'), now)!;
    expect(result.level).toBe('stale');
    expect(result.label).toMatch(/STALE/);
  });

  it('never implies freshness it cannot prove', () => {
    expect(packFreshness(meta('not-a-date'), now)!.level).toBe('stale');
  });
});

describe('formatting helpers', () => {
  it('renders relative times', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    expect(relativeTime('2026-08-30T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-08-30T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-08-28T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime(undefined, now)).toBe('time unknown');
  });

  it('labels event types in plain English', () => {
    expect(eventTypeLabel('depth_chart')).toBe('Depth chart');
    expect(eventTypeLabel('unknown_thing')).toBe('Other');
  });
});

// ---------------------------------------------------------------------------

describe('grouping repeated coverage of one player', () => {
  const event = (id: string, player: string | null, impact = 50): NewsEventView => ({
    id,
    headline: `${player ?? 'Someone'} story ${id}`,
    eventType: 'injury',
    classification: 'IMPORTANT',
    fantasyImpact: 'MEDIUM',
    impactScore: impact,
    confidence: 0.7,
    playerDirection: 'NEUTRAL',
    positions: [],
    players: player ? [{ name: player }] : [],
    sources: [{ name: 'Test' }],
    signals: [],
  });

  it('collapses one player\'s coverage behind a lead story', () => {
    // The real case: Mahomes being cleared produced seven separate events.
    const groups = groupByPlayer([
      event('a', 'Patrick Mahomes', 57),
      event('b', 'Patrick Mahomes', 51),
      event('c', 'Patrick Mahomes', 50),
      event('d', 'Lamar Jackson', 41),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.lead.id).toBe('a');
    expect(groups[0]!.more.map((e) => e.id)).toEqual(['b', 'c']);
    expect(groups[1]!.lead.id).toBe('d');
  });

  it('loses nothing — every event is still reachable', () => {
    const input = [
      event('a', 'Patrick Mahomes'),
      event('b', 'Patrick Mahomes'),
      event('c', null),
      event('d', 'Lamar Jackson'),
      event('e', null),
    ];
    const groups = groupByPlayer(input);
    const seen = groups.flatMap((g) => [g.lead.id, ...g.more.map((e) => e.id)]);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never lumps unlinked stories together', () => {
    // They share no player, so grouping them by "nobody" would be wrong.
    const groups = groupByPlayer([event('a', null), event('b', null)]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.more.length === 0)).toBe(true);
  });

  it('keeps the strongest item as the lead', () => {
    // The feed is impact-ordered, so the first occurrence is the strongest.
    const groups = groupByPlayer([
      event('strong', 'Player One', 90),
      event('weak', 'Player One', 10),
    ]);
    expect(groups[0]!.lead.id).toBe('strong');
  });

  it('preserves feed order', () => {
    const groups = groupByPlayer([
      event('a', 'First'),
      event('b', 'Second'),
      event('c', 'First'),
      event('d', 'Third'),
    ]);
    expect(groups.map((g) => g.player)).toEqual(['First', 'Second', 'Third']);
  });

  it('leaves a feed with no repeats untouched', () => {
    const groups = groupByPlayer([event('a', 'One'), event('b', 'Two')]);
    expect(groups.every((g) => g.more.length === 0)).toBe(true);
  });
});
