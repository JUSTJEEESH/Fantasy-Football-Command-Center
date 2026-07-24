import type { League, PlayerCard, Position } from '@/lib/types';
import { SCORING_PRESETS } from '@/lib/engine/scoring';
import { assignTiers } from '@/lib/engine/valuation';

// ============================================================================
// Deterministic mock player pool for tests.
//
// IMPORTANT: these are SYNTHETIC players with invented names. They exist to
// exercise the engine's math, never to stand in for real data. Nothing in the
// application reads from this file — it is test-only, precisely so that fake
// numbers can never leak into a real recommendation.
// ============================================================================

/** Deterministic PRNG so every test run sees the identical pool. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NFL_TEAMS = [
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU',
  'IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI',
  'PIT','SEA','SF','TB','TEN','WAS',
];

/**
 * Position pool sizes and scoring shapes chosen to mirror the real distribution
 * of fantasy production: RBs and WRs are deep, TE falls off a cliff after a
 * handful, QBs are flat and plentiful (which is exactly why VOR should push
 * them down the board).
 */
const POSITION_CONFIG: Record<
  Position,
  { count: number; top: number; decay: number; floorRatio: number; ceilRatio: number }
> = {
  QB:  { count: 32, top: 400, decay: 0.985, floorRatio: 0.82, ceilRatio: 1.18 },
  RB:  { count: 70, top: 330, decay: 0.972, floorRatio: 0.62, ceilRatio: 1.42 },
  WR:  { count: 90, top: 320, decay: 0.978, floorRatio: 0.68, ceilRatio: 1.36 },
  TE:  { count: 32, top: 260, decay: 0.945, floorRatio: 0.70, ceilRatio: 1.32 },
  K:   { count: 32, top: 150, decay: 0.992, floorRatio: 0.85, ceilRatio: 1.15 },
  DST: { count: 32, top: 145, decay: 0.988, floorRatio: 0.80, ceilRatio: 1.22 },
};

export interface MockPoolOptions {
  seed?: number;
  fetchedAt?: string;
}

/**
 * Build a realistic synthetic pool: projections decay within position, ADP is
 * derived from a global points ordering with market noise (so ADP and value
 * disagree, as they do in reality), and tiers come from the real tier engine.
 */
export function buildMockPool(opts: MockPoolOptions = {}): PlayerCard[] {
  const rand = mulberry32(opts.seed ?? 20260830);
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const players: PlayerCard[] = [];

  for (const [position, cfg] of Object.entries(POSITION_CONFIG) as Array<
    [Position, (typeof POSITION_CONFIG)[Position]]
  >) {
    for (let i = 0; i < cfg.count; i++) {
      const base = cfg.top * Math.pow(cfg.decay, i * (1 + i / cfg.count));
      // Small per-player noise so tier boundaries aren't perfectly regular.
      const proj = Math.round((base * (0.97 + rand() * 0.06)) * 10) / 10;
      const rank = i + 1;
      players.push({
        id: `${position}-${rank}`,
        name: `${position} Player ${rank}`,
        position,
        team: NFL_TEAMS[Math.floor(rand() * NFL_TEAMS.length)] ?? 'FA',
        byeWeek: 5 + Math.floor(rand() * 10),
        projectedPoints: proj,
        floorPoints: Math.round(proj * cfg.floorRatio * 10) / 10,
        ceilingPoints: Math.round(proj * cfg.ceilRatio * 10) / 10,
        gamesProjected: 17,
        positionRank: rank,
        roleCertainty: clamp01(0.92 - i * 0.012 + (rand() - 0.5) * 0.15),
        injuryRisk: clamp01(0.08 + rand() * 0.35 + (position === 'RB' ? 0.08 : 0)),
        breakoutProbability: clamp01(rand() * 0.4 + (i > 15 ? 0.15 : 0)),
        bustProbability: clamp01(rand() * 0.35),
        scheduleEase: clamp01(0.3 + rand() * 0.4),
        trendScore: Math.round((rand() - 0.5) * 20 * 10) / 10,
        fetchedAt,
      });
    }
  }

  // ADP: rank everyone by a market-value proxy (VOR-ish, since the real market
  // is roughly VOR-aware), then perturb. K/DST are pushed to the very end,
  // which is what actually happens in real drafts.
  const positionBaseline: Record<Position, number> = {
    QB: 250, RB: 130, WR: 135, TE: 110, K: 130, DST: 125,
  };
  const marketOrder = [...players].sort((a, b) => {
    const va = (a.projectedPoints ?? 0) - positionBaseline[a.position];
    const vb = (b.projectedPoints ?? 0) - positionBaseline[b.position];
    const penalty = (p: PlayerCard) => (p.position === 'K' || p.position === 'DST' ? -300 : 0);
    return vb + penalty(b) - (va + penalty(a));
  });

  marketOrder.forEach((p, idx) => {
    const trueAdp = idx + 1;
    // Market noise grows with ADP — consensus is tight at the top, loose later.
    const noise = (rand() - 0.5) * (4 + trueAdp * 0.12);
    p.adp = Math.round(Math.max(1, trueAdp + noise) * 10) / 10;
    p.adpStdev = Math.round((2 + trueAdp * 0.1) * 10) / 10;
    p.adpSource = 'mock';
    p.adpFetchedAt = fetchedAt;
    p.consensusRank = trueAdp;
  });

  const tiers = assignTiers(players);
  for (const p of players) p.tier = tiers.get(p.id);

  return players;
}

export function buildMockLeague(overrides: Partial<League> = {}): League {
  return {
    id: 'league-test',
    name: 'Test League',
    platform: 'manual',
    season: 2026,
    leagueType: 'redraft',
    teamCount: 12,
    draftType: 'snake',
    draftSlot: 5,
    rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    benchSize: 6,
    irSlots: 1,
    scoring: SCORING_PRESETS.ppr(),
    adpFormat: 'ppr',
    ...overrides,
  };
}

function clamp01(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}
