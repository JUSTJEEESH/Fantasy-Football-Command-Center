import { scoreStatLine } from '@/lib/engine/scoring';
import { assignTiers } from '@/lib/engine/valuation';
import { StatLineSchema, type League, type PlayerCard, type Position } from '@/lib/types';
import type { PlayerPack, PlayerPackEntry } from '@/lib/static-data';

// ============================================================================
// Turning the shipped data pack into a draft pack.
//
// Until now the only way to get a draft pack was to import a CSV. That meant
// the 600 real players baked into the deployment were visible on the Players
// screen and invisible to the engine — the war room would open empty unless
// you had a spreadsheet ready. This module closes that gap: it takes the pack
// the build produced and the league you configured, and produces the
// PlayerCards the engine ranks.
//
// Everything here is derivation, not invention. Each field below traces to a
// specific record from a specific source, and where a value is inferred rather
// than reported, `summary.notes` says so in words the UI shows.
// ============================================================================

export interface PackBuildSummary {
  players: number;
  withAdp: number;
  withProjection: number;
  withBye: number;
  withInjuryDesignation: number;
  /** Human-readable statements about what is real and what is inferred. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Injury designation → season-long availability risk
// ---------------------------------------------------------------------------

/**
 * Designations are reported facts. The RISK NUMBER is an inference from them,
 * and it is the only thing the engine consumes, so the mapping is stated
 * explicitly here rather than buried in a formula.
 *
 * The scale is "probability-weighted concern about missing time this season",
 * matching how `injuryRisk` is used in the recommendation weights. 0.2 is the
 * engine's no-information default, so anything at 0.2 means "nothing reported".
 */
const INJURY_RISK: Array<{ match: RegExp; risk: number; label: string }> = [
  // Sleeper says "IR". ESPN says "INJURY_RESERVE". The pattern has to cover
  // both spellings and the "injured reserve" wording as well.
  { match: /\b(IR|INJUR\w*\s*RESERVE)\b/, risk: 0.85, label: 'on injured reserve' },
  { match: /\b(PUP|NFI)\b/, risk: 0.8, label: 'on the PUP/NFI list' },
  { match: /\bDNR\b/, risk: 0.8, label: 'did not report' },
  { match: /\bOUT\b/, risk: 0.6, label: 'ruled out' },
  { match: /\b(SUS|SUSPENSION|SUSPENDED)\b/, risk: 0.5, label: 'suspended' },
  { match: /\bDOUBTFUL\b/, risk: 0.5, label: 'doubtful' },
  { match: /\b(QUESTIONABLE|DAY.?TO.?DAY)\b/, risk: 0.35, label: 'questionable' },
  { match: /\b(COV|COVID)\b/, risk: 0.3, label: 'on the COVID list' },
];

/** Nothing reported. Matches the engine's own default so the two agree. */
export const BASELINE_INJURY_RISK = 0.2;

export function injuryRiskFor(status: string | null | undefined): {
  risk: number;
  label: string | null;
} {
  if (!status) return { risk: BASELINE_INJURY_RISK, label: null };
  const normalized = status.toUpperCase().replace(/[_-]+/g, ' ');
  // ACTIVE is a positive report, not an absence of one, but it says nothing
  // about durability, so it lands on the same baseline as "no designation".
  if (/\bACTIVE\b/.test(normalized)) return { risk: BASELINE_INJURY_RISK, label: null };
  for (const rule of INJURY_RISK) {
    if (rule.match.test(normalized)) return { risk: rule.risk, label: rule.label };
  }
  // An unrecognized designation is still a designation — something is being
  // reported about this player. Nudging above baseline is more honest than
  // discarding it, but it must not be treated as a known severity.
  return { risk: 0.3, label: status.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Depth chart → role certainty
// ---------------------------------------------------------------------------

/**
 * How sure we are of a player's workload, by position and depth chart slot.
 *
 * The shape differs by position because the positions differ: a WR3 is a
 * starter in three-receiver sets, an RB2 is a committee back, and a QB2 is
 * not on the field at all. Flattening those into one curve would systematically
 * misprice backup quarterbacks against backup receivers.
 *
 * 0.6 is the engine's no-information default.
 */
const ROLE_BY_DEPTH: Record<Position, number[]> = {
  //          1st    2nd    3rd    4th
  QB: [0.95, 0.15, 0.08],
  RB: [0.85, 0.5, 0.25, 0.12],
  WR: [0.88, 0.78, 0.6, 0.3, 0.15],
  TE: [0.82, 0.3, 0.15],
  K: [0.9, 0.2],
  DST: [0.9],
};

export const BASELINE_ROLE_CERTAINTY = 0.6;

export function roleCertaintyFor(
  position: Position,
  depthChartOrder: number | undefined,
  percentOwned: number | undefined,
): number {
  const curve = ROLE_BY_DEPTH[position];

  if (depthChartOrder && depthChartOrder >= 1) {
    const fromDepth = curve[depthChartOrder - 1] ?? 0.08;
    // A player rostered nearly everywhere has a role the market is sure about,
    // which is evidence a stale depth chart can't override downward. This only
    // ever raises certainty, never lowers it.
    if (percentOwned !== undefined && percentOwned >= 90) {
      return Math.max(fromDepth, 0.8);
    }
    return fromDepth;
  }

  // No depth chart entry. Ownership is the only signal left, and it is a weak
  // one — it reflects perceived value, not confirmed workload — so it moves
  // the baseline rather than replacing it.
  if (percentOwned === undefined) return BASELINE_ROLE_CERTAINTY;
  if (percentOwned >= 95) return 0.8;
  if (percentOwned >= 70) return 0.68;
  if (percentOwned >= 30) return BASELINE_ROLE_CERTAINTY;
  return 0.45;
}

// ---------------------------------------------------------------------------
// ADP → points, when there is no projection
// ---------------------------------------------------------------------------

/**
 * Rough season-points estimate derived from ADP, used only when no projection
 * is available for that player.
 *
 * This is an approximation of the market's implied value, NOT a projection. It
 * exists so a board still tiers sensibly, and every surface that shows it says
 * where it came from.
 */
export function estimatePointsFromAdp(adp: number, position: Position): number {
  const top: Record<Position, number> = {
    QB: 400, RB: 330, WR: 320, TE: 260, K: 150, DST: 145,
  };
  const decay: Record<Position, number> = {
    QB: 0.0016, RB: 0.0075, WR: 0.0065, TE: 0.0085, K: 0.0009, DST: 0.001,
  };
  return Math.round(top[position] * Math.exp(-decay[position] * adp) * 10) / 10;
}

// ---------------------------------------------------------------------------

/**
 * Build the engine's player cards from a shipped data pack.
 *
 * The league matters: projections arrive as STAT LINES, so they are scored
 * under this league's rules. In Bay Islands that means six-point passing
 * touchdowns and a 100-yard rushing bonus, which move quarterbacks and
 * volume backs relative to any generic ranking.
 */
export function playersFromPack(
  pack: PlayerPack,
  league: League,
): { players: PlayerCard[]; summary: PackBuildSummary } {
  const players: PlayerCard[] = [];
  let withAdp = 0;
  let withProjection = 0;
  let withBye = 0;
  let withInjuryDesignation = 0;

  for (const entry of pack.players) {
    const card = cardFor(entry, league, pack.generatedAt);
    if (card.adp !== undefined) withAdp++;
    // Counts real projections only. A points value derived from ADP is not a
    // projection, and conflating the two here would overstate the pack on the
    // very screen that exists to tell you what you're working with.
    if (entry.projectedStats && card.projectedPoints !== undefined) withProjection++;
    if (card.byeWeek) withBye++;
    if (entry.injuryStatus && !/^active$/i.test(entry.injuryStatus)) withInjuryDesignation++;
    players.push(card);
  }

  // Rank order drives the board. Real ADP first, ESPN's draft rank next, and
  // Sleeper's popularity ordering only as a last resort — it is not ADP and is
  // never presented as one.
  players.sort((a, b) => sortKey(a) - sortKey(b));

  const tiers = assignTiers(players);
  for (const player of players) player.tier = tiers.get(player.id);

  const projectedFromEspn = pack.players.some((p) => p.projectedStats);
  const notes: string[] = [];

  if (projectedFromEspn) {
    notes.push(
      `${withProjection} projections are ESPN's, re-scored under your league's rules — ` +
        `${league.scoring.perStat.pass_td ?? 4}-point passing TDs and your PPR settings, ` +
        `not ESPN's defaults. The rest are estimated from ADP.`,
    );
    // Season projections are totals, so they carry no count of how many
    // individual games cleared a yardage threshold. Rather than invent that
    // count, the bonus is left out and said out loud. It under-credits volume
    // rushers by roughly the same amount across the position, so the ordering
    // within RB is largely unaffected even though the totals are low.
    const bonusRules = ['rush_100_bonus', 'rec_100_bonus', 'pass_300_bonus', 'pass_400_bonus']
      .filter((k) => (league.scoring.perStat[k] ?? 0) !== 0);
    if (bonusRules.length > 0) {
      notes.push(
        'Your yardage bonuses are not included in projected points — a season ' +
          'total does not say how many individual games cleared the threshold, ' +
          'and guessing at it would be inventing a number.',
      );
    }
  } else {
    notes.push(
      'No projections were available in this build, so points are estimated from ' +
        'ADP. That is a read of the market, not a forecast.',
    );
  }

  if (withAdp > 0) {
    notes.push(`ADP is from ESPN drafts (${withAdp} players) — the platform your league uses.`);
  } else {
    notes.push('No ADP in this build. Availability and reach/wait advice will be weak.');
  }

  if (withBye === 0) {
    notes.push('No bye weeks published yet, so bye-stacking warnings are switched off.');
  }

  notes.push(
    `Injury risk and role certainty are inferred from ${withInjuryDesignation} reported ` +
      'designations and Sleeper depth charts — they are estimates derived from ' +
      'reported facts, not reported facts themselves.',
  );

  return {
    players,
    summary: {
      players: players.length,
      withAdp,
      withProjection,
      withBye,
      withInjuryDesignation,
      notes,
    },
  };
}

/** Sort position: lower is drafted earlier. */
function sortKey(p: PlayerCard): number {
  if (p.adp !== undefined) return p.adp;
  if (p.consensusRank !== undefined) return p.consensusRank;
  // Push everything unranked behind everything ranked, preserving the relative
  // order the pack arrived in.
  return 10_000;
}

function cardFor(entry: PlayerPackEntry, league: League, fetchedAt: string): PlayerCard {
  const { risk, label } = injuryRiskFor(entry.injuryStatus);

  const card: PlayerCard = {
    id: entry.id,
    name: entry.name,
    position: entry.position,
    team: entry.team,
    injuryStatus: entry.injuryStatus ?? null,
    injuryRisk: risk,
    roleCertainty: roleCertaintyFor(entry.position, entry.depthChartOrder, entry.percentOwned),
    // Freshness is the pack's, not now — the data is as old as the build.
    fetchedAt,
  };

  if (entry.age !== undefined) card.age = entry.age;
  if (entry.yearsExp !== undefined) card.yearsExp = entry.yearsExp;
  if (entry.byeWeek) card.byeWeek = entry.byeWeek;

  if (entry.adp !== undefined) {
    card.adp = entry.adp;
    card.adpSource = entry.adpSource ?? 'ESPN';
  }
  if (entry.espnRank !== undefined) {
    card.consensusRank = entry.espnRank;
  }

  // Projections: score the raw stat line under THIS league's rules. This is
  // the whole reason the pack ships stats instead of points.
  if (entry.projectedStats) {
    const parsed = StatLineSchema.safeParse(entry.projectedStats);
    if (parsed.success) {
      const points = scoreStatLine(parsed.data, league.scoring, entry.position);
      if (Number.isFinite(points)) {
        card.projectedPoints = Math.round(points * 10) / 10;
        // Range, not certainty. A wide band is the honest representation of a
        // single-model point estimate, and the engine already reads floor and
        // ceiling separately for its upside and safe-pick flavors.
        card.floorPoints = Math.round(points * 0.72 * 10) / 10;
        card.ceilingPoints = Math.round(points * 1.28 * 10) / 10;
      }
    }
  }

  if (card.projectedPoints === undefined && entry.adp !== undefined) {
    card.projectedPoints = estimatePointsFromAdp(entry.adp, entry.position);
  }

  // Nothing beyond the designation itself is asserted; the label exists so the
  // UI can say "ruled out" rather than printing a raw enum at the user.
  if (label) card.injuryNote = label;

  return card;
}
