/**
 * pnpm rehearse [path/to/players.json]
 *
 * The dress rehearsal. Runs a complete 15-round Bay Islands draft — all twelve
 * seats, every round — against a real player pack, and reports what the engine
 * actually did with real numbers rather than fixtures.
 *
 * This exists because passing tests and a working draft are different claims.
 * The tests prove each part behaves; this proves the parts together produce a
 * roster a person would be willing to take to a draft party. It reads the pack
 * the deployment ships, so what it exercises is what you would get on the night.
 *
 * It asserts nothing and mocks nothing. It prints, and the printout is the
 * evidence. Where the data is thin, it says which numbers were missing rather
 * than quietly ranking on defaults.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAY_ISLANDS, BAY_ISLANDS_ROUNDS } from '../src/lib/leagues/bay-islands';
import { playersFromPack } from '../src/lib/pack-from-static';
import {
  createDraftState,
  draftReducer,
  isUserOnClock,
} from '../src/lib/engine/draft-state';
import { recommend } from '../src/lib/engine/recommend';
import { analyzeRoster } from '../src/lib/engine/roster';
import type { PlayerPack } from '../src/lib/static-data';
import type { DraftState, PlayerCard, Position } from '../src/lib/types';

const TEAMS = 12;
const packPath =
  process.argv[2] ?? join(process.cwd(), 'public', 'data', 'players.json');

/** Deterministic RNG so a rehearsal can be re-run and compared. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plausible opponent: mostly best-available by ADP, sometimes reaching,
 * sometimes filling a need, and never taking a kicker in round three. This is
 * not a model of any real manager — it exists so the board depletes the way a
 * real draft depletes rather than in perfect ADP order.
 */
function opponentPick(
  available: PlayerCard[],
  roster: PlayerCard[],
  round: number,
  rand: () => number,
): PlayerCard {
  const byAdp = available.slice(0, 60);
  const sensible = byAdp.filter(
    (p) => round >= BAY_ISLANDS_ROUNDS - 2 || (p.position !== 'K' && p.position !== 'DST'),
  );
  const pool = sensible.length > 0 ? sensible : byAdp;

  const roll = rand();
  if (roll < 0.35) {
    const counts: Partial<Record<Position, number>> = {};
    for (const p of roster) counts[p.position] = (counts[p.position] ?? 0) + 1;
    const needed = (['RB', 'WR', 'QB'] as Position[]).find(
      (pos) => (counts[pos] ?? 0) < (pos === 'RB' || pos === 'WR' ? 2 : 1),
    );
    const pick = needed ? pool.find((p) => p.position === needed) : undefined;
    if (pick) return pick;
  }
  if (roll < 0.5) {
    return pool[Math.min(3 + Math.floor(rand() * 8), pool.length - 1)] ?? pool[0]!;
  }
  return pool[Math.min(Math.floor(rand() * 3), pool.length - 1)] ?? pool[0]!;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function slotOfPick(pickNumber: number): number {
  const round = Math.ceil(pickNumber / TEAMS);
  const indexInRound = ((pickNumber - 1) % TEAMS) + 1;
  return round % 2 === 1 ? indexInRound : TEAMS + 1 - indexInRound;
}

function runOneSeat(
  seat: number,
  players: PlayerCard[],
  seed: number,
): { roster: PlayerCard[]; confidences: number[]; firstFive: string[] } {
  const rand = mulberry32(seed);
  const byId = new Map(players.map((p) => [p.id, p]));

  let state: DraftState = createDraftState({
    leagueId: BAY_ISLANDS.id,
    teamCount: TEAMS,
    rounds: BAY_ISLANDS_ROUNDS,
    userSlot: seat,
  });

  const confidences: number[] = [];
  const firstFive: string[] = [];

  for (let pick = 1; pick <= TEAMS * BAY_ISLANDS_ROUNDS; pick++) {
    const drafted = new Set(state.picks.map((p) => p.playerId));
    const available = players.filter((p) => !drafted.has(p.id));

    let chosen: PlayerCard | undefined;
    if (isUserOnClock(state)) {
      const rec = recommend({
        state,
        league: BAY_ISLANDS,
        players,
        riskTolerance: 0.5,
        dataFetchedAt: new Date().toISOString(),
      });
      if (!rec.take) {
        throw new Error(`No recommendation at pick ${pick} for seat ${seat}`);
      }
      confidences.push(rec.confidence);
      chosen = byId.get(rec.take.id);
      if (firstFive.length < 5 && chosen) {
        firstFive.push(
          `R${Math.ceil(pick / TEAMS)} ${chosen.name} (${chosen.position}` +
            `${chosen.team ? ` ${chosen.team}` : ''}` +
            `${chosen.adp !== undefined ? `, ADP ${chosen.adp.toFixed(1)}` : ''})`,
        );
      }
    } else {
      const slot = slotOfPick(pick);
      const opponentRoster = state.picks
        .filter((p) => p.draftSlot === slot)
        .map((p) => byId.get(p.playerId))
        .filter((p): p is PlayerCard => Boolean(p));
      chosen = opponentPick(available, opponentRoster, Math.ceil(pick / TEAMS), rand);
    }

    if (!chosen) throw new Error(`Nothing available at pick ${pick}`);
    state = draftReducer(state, {
      type: 'RECORD_PICK',
      playerId: chosen.id,
      entryMethod: 'simulated',
    });
  }

  const roster = state.picks
    .filter((p) => p.draftSlot === seat)
    .map((p) => byId.get(p.playerId))
    .filter((p): p is PlayerCard => Boolean(p));

  return { roster, confidences, firstFive };
}

function main(): void {
  const raw = readFileSync(packPath, 'utf8');
  const pack = JSON.parse(raw) as PlayerPack;

  console.log('='.repeat(70));
  console.log('DRESS REHEARSAL — Bay Islands Fantasy, 12 teams, 15 rounds');
  console.log('='.repeat(70));
  console.log(`Pack:        ${packPath}`);
  console.log(`Fetched:     ${pack.generatedAt}`);
  console.log(`Pack status: ${pack.ok ? 'ok' : `FAILED — ${pack.reason ?? 'no reason given'}`}`);
  if (pack.reason && pack.ok) console.log(`Note:        ${pack.reason}`);
  for (const source of pack.sources) {
    console.log(
      `  ${source.ok ? '✓' : '✗'} ${source.name}: ${source.itemCount}` +
        (source.error ? `\n      ${source.error}` : ''),
    );
  }

  const { players, summary } = playersFromPack(pack, BAY_ISLANDS);
  console.log('\n--- What the engine is working with ---');
  console.log(
    `${summary.players} players · ${summary.withAdp} with real ADP · ` +
      `${summary.withProjection} with real projections · ${summary.withBye} with a bye week · ` +
      `${summary.withInjuryDesignation} carrying an injury designation`,
  );
  for (const note of summary.notes) console.log(`  · ${note}`);

  console.log('\n--- Top of the board ---');
  for (const p of players.slice(0, 10)) {
    console.log(
      `  ${String(p.adp?.toFixed(1) ?? '—').padStart(5)}  ` +
        `${p.name.padEnd(24)} ${p.position.padEnd(3)} ${(p.team ?? '—').padEnd(4)} ` +
        `bye ${String(p.byeWeek ?? '—').padStart(2)}  ` +
        `${p.projectedPoints !== undefined ? `${p.projectedPoints.toFixed(0)} pts` : 'no points'}` +
        `  tier ${p.tier ?? '—'}`,
    );
  }

  console.log('\n--- Full drafts, all twelve seats ---');
  const allConfidences: number[] = [];
  const problems: string[] = [];

  for (let seat = 1; seat <= TEAMS; seat++) {
    // A fresh copy per seat: the engine annotates cards, and one seat's draft
    // must not colour the next one's.
    const fresh = playersFromPack(pack, BAY_ISLANDS).players;
    const { roster, confidences, firstFive } = runOneSeat(seat, fresh, 1000 + seat);
    allConfidences.push(...confidences);
    const medianSeat = median(confidences);

    const counts: Partial<Record<Position, number>> = {};
    for (const p of roster) counts[p.position] = (counts[p.position] ?? 0) + 1;

    const analysis = analyzeRoster(roster, BAY_ISLANDS);
    const shape = (['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as Position[])
      .map((pos) => `${pos}${counts[pos] ?? 0}`)
      .join(' ');

    // The failure that actually matters: a roster that cannot field a lineup.
    for (const required of ['QB', 'RB', 'WR', 'K', 'DST'] as Position[]) {
      const need = required === 'RB' || required === 'WR' ? 2 : 1;
      if ((counts[required] ?? 0) < need) {
        problems.push(`Seat ${seat}: only ${counts[required] ?? 0} ${required}, needs ${need}`);
      }
    }
    if (roster.length !== BAY_ISLANDS_ROUNDS) {
      problems.push(`Seat ${seat}: drafted ${roster.length} players, expected ${BAY_ISLANDS_ROUNDS}`);
    }

    console.log(
      `\nSeat ${String(seat).padStart(2)}  ${shape}  ` +
        `starters ${analysis.startingPoints.toFixed(0)} pts  ` +
        `median confidence ${medianSeat.toFixed(2)}` +
        (analysis.byeConflicts.length > 0
          ? `  ⚠ bye stack wk ${analysis.byeConflicts.map((c) => c.week).join(',')}`
          : ''),
    );
    for (const line of firstFive) console.log(`        ${line}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  if (problems.length === 0) {
    console.log('✓ All twelve seats produced a legal, startable roster.');
  } else {
    console.log(`✗ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`   ${p}`);
  }
  // A distribution rather than a count against some threshold. Confidence here
  // measures how clear-cut a pick was, and most picks in a real draft are close
  // calls — so a low median is information about the board, not a defect. What
  // would be a defect is a flat distribution, which would mean the number is
  // not discriminating between an obvious pick and a coin flip.
  const sorted = [...allConfidences].sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.floor((sorted.length - 1) * q)] ?? Number.NaN;
  console.log(
    `Recommendation confidence across ${sorted.length} picks: ` +
      `min ${pct(0).toFixed(2)} · p25 ${pct(0.25).toFixed(2)} · ` +
      `median ${pct(0.5).toFixed(2)} · p75 ${pct(0.75).toFixed(2)} · max ${pct(1).toFixed(2)}`,
  );
  if (pct(1) - pct(0) < 0.1) {
    console.log(
      '  ⚠ Confidence barely varies across picks — it is not distinguishing an ' +
        'obvious pick from a close call.',
    );
  }
  console.log('='.repeat(70));

  process.exitCode = problems.length === 0 ? 0 : 1;
}

main();
