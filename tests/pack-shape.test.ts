import { describe, expect, it } from 'vitest';
import { POSITION_FLOORS, takeWithPositionFloors } from '../scripts/build-data';
import type { Position } from '@/lib/types';

// ============================================================================
// The board has to contain every position a league can start.
//
// This is here because of a bug that no unit test could have caught and that a
// full draft simulation caught immediately: the pack was built by taking
// Sleeper's top 600 players by popularity, and Sleeper ranks team defenses so
// far down that not one of them made the cut. Twelve simulated rosters were
// drafted and none could field the DST this league requires.
//
// "600 players" is not the same claim as "a draftable board".
// ============================================================================

/** A source ordering with the shape that caused the bug: defenses and kickers
 *  ranked far below every skill player, as Sleeper actually ranks them. */
function sleeperLikeOrdering(): Array<{ position: Position; id: string }> {
  const rows: Array<{ position: Position; id: string }> = [];
  const skill: Position[] = ['QB', 'RB', 'WR', 'TE'];
  for (let i = 0; i < 800; i++) {
    rows.push({ position: skill[i % 4]!, id: `skill-${i}` });
  }
  // Ranked last, exactly as Sleeper ranks them.
  for (let i = 0; i < 32; i++) rows.push({ position: 'K', id: `k-${i}` });
  for (let i = 0; i < 32; i++) rows.push({ position: 'DST', id: `dst-${i}` });
  return rows;
}

function mixOf(rows: Array<{ position: Position }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.position] = (acc[r.position] ?? 0) + 1;
    return acc;
  }, {});
}

describe('positional floors on the shipped board', () => {
  it('keeps defenses that a popularity ordering buries', () => {
    const taken = takeWithPositionFloors(sleeperLikeOrdering(), 600);
    const mix = mixOf(taken);
    expect(mix.DST).toBe(32);
    expect(mix.K).toBe(32);
  });

  it('is what a flat cut fails to do', () => {
    // The old behaviour, stated as a test so the regression is unmistakable.
    const flat = sleeperLikeOrdering().slice(0, 600);
    expect(mixOf(flat).DST ?? 0).toBe(0);
  });

  it('honours every floor at once', () => {
    const taken = takeWithPositionFloors(sleeperLikeOrdering(), 600);
    const mix = mixOf(taken);
    for (const [position, floor] of Object.entries(POSITION_FLOORS)) {
      const available = sleeperLikeOrdering().filter((r) => r.position === position).length;
      expect(mix[position] ?? 0).toBeGreaterThanOrEqual(Math.min(floor, available));
    }
  });

  it('spends the remaining budget on the best players available', () => {
    const taken = takeWithPositionFloors(sleeperLikeOrdering(), 600);
    expect(taken.length).toBe(600);
    // The floors total well under 600, so the surplus has to go to skill
    // players — the floors must not become quotas that cap the board.
    const mix = mixOf(taken);
    const floorTotal = Object.values(POSITION_FLOORS).reduce((a, b) => a + b, 0);
    expect((mix.WR ?? 0) + (mix.RB ?? 0)).toBeGreaterThan(
      POSITION_FLOORS.WR + POSITION_FLOORS.RB,
    );
    expect(floorTotal).toBeLessThan(600);
  });

  it('preserves rank order in the output', () => {
    const source = sleeperLikeOrdering();
    const taken = takeWithPositionFloors(source, 600);
    const positions = taken.map((t) => source.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('does not invent players when a source is short', () => {
    const tiny = [
      { position: 'RB' as Position, id: 'a' },
      { position: 'DST' as Position, id: 'b' },
    ];
    const taken = takeWithPositionFloors(tiny, 600);
    expect(taken.length).toBe(2);
  });

  it('floors cover every position the app supports', () => {
    // A new position added to the app without a floor here would reintroduce
    // exactly the original bug for that position.
    const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
    for (const position of positions) {
      expect(POSITION_FLOORS[position]).toBeGreaterThan(0);
    }
  });
});
