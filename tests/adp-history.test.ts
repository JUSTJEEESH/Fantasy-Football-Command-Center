import { describe, expect, it } from 'vitest';
import {
  appendSnapshot,
  computeTrends,
  HISTORY_DAYS,
  type AdpHistory,
} from '../scripts/adp-history';
import type { PlayerPackEntry } from '@/lib/static-data';

// ============================================================================
// The deployment is its own ADP database: every build reads the history the
// previous build published, appends today, and republishes. The failure modes
// worth testing are the quiet ones — a trend claimed from too little data, a
// gap in builds shrinking the window arithmetic, intra-day jitter dressed up
// as movement.
// ============================================================================

function player(id: string, adp?: number): PlayerPackEntry {
  return { id, name: id, position: 'RB', team: 'ATL', ...(adp !== undefined ? { adp } : {}) };
}

describe('appending a day', () => {
  it('records one sample per player per day, ADP-less players excluded', () => {
    const history = appendSnapshot({}, '2026-07-25', [player('a', 12.5), player('b')]);
    expect(history['2026-07-25']).toEqual({ a: 12.5 });
  });

  it('replaces the same day rather than stacking eight builds of jitter', () => {
    let history = appendSnapshot({}, '2026-07-25', [player('a', 12.5)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 12.9)]);
    expect(history['2026-07-25']).toEqual({ a: 12.9 });
    expect(Object.keys(history)).toHaveLength(1);
  });

  it('prunes by date, not by entry count', () => {
    // Two entries, but one is far older than the window — a gap in builds must
    // not stretch retention.
    let history: AdpHistory = { '2026-01-01': { a: 50 } };
    history = appendSnapshot(history, '2026-07-25', [player('a', 12)]);
    expect(history['2026-01-01']).toBeUndefined();
    expect(Object.keys(history)).toHaveLength(1);
  });

  it(`keeps ${HISTORY_DAYS} days`, () => {
    let history: AdpHistory = {};
    for (let d = 1; d <= 25; d++) {
      history = appendSnapshot(history, `2026-07-${String(d).padStart(2, '0')}`, [player('a', d)]);
    }
    const days = Object.keys(history).sort();
    expect(days[0]).toBe('2026-07-04');
    expect(days[days.length - 1]).toBe('2026-07-25');
  });
});

describe('claiming a trend', () => {
  it('claims nothing from a single day', () => {
    const history = appendSnapshot({}, '2026-07-25', [player('a', 12)]);
    expect(computeTrends(history, '2026-07-25').size).toBe(0);
  });

  it('claims nothing from two samples a day apart', () => {
    // Two points one day apart is a coin flip, not a trend.
    let history = appendSnapshot({}, '2026-07-24', [player('a', 20)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 12)]);
    expect(computeTrends(history, '2026-07-25').size).toBe(0);
  });

  it('reports a rise as a negative delta — drafted earlier', () => {
    let history = appendSnapshot({}, '2026-07-20', [player('a', 60)]);
    history = appendSnapshot(history, '2026-07-23', [player('a', 55)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 48)]);
    const trend = computeTrends(history, '2026-07-25').get('a');
    expect(trend).toEqual({ delta: -12, spanDays: 5 });
  });

  it('looks back only within the window', () => {
    // A month-old sample outside the 7-day window must not be the baseline.
    let history: AdpHistory = { '2026-07-10': { a: 100 } };
    history = appendSnapshot(history, '2026-07-21', [player('a', 60)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 55)]);
    const trend = computeTrends(history, '2026-07-25').get('a');
    expect(trend).toEqual({ delta: -5, spanDays: 4 });
  });

  it('handles a player who appears mid-window', () => {
    let history = appendSnapshot({}, '2026-07-19', [player('a', 40)]);
    history = appendSnapshot(history, '2026-07-22', [player('a', 40), player('rookie', 90)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 40), player('rookie', 80)]);
    const trends = computeTrends(history, '2026-07-25');
    expect(trends.get('rookie')).toEqual({ delta: -10, spanDays: 3 });
    expect(trends.get('a')).toEqual({ delta: 0, spanDays: 6 });
  });

  it('says nothing about a player missing from the latest day', () => {
    let history = appendSnapshot({}, '2026-07-20', [player('gone', 60)]);
    history = appendSnapshot(history, '2026-07-25', [player('a', 12)]);
    expect(computeTrends(history, '2026-07-25').get('gone')).toBeUndefined();
  });
});
