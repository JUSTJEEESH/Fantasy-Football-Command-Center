import { normalizePosition } from './sleeper';
import { searchKey } from './types';
import type { FetchResult, RawAdp, RawProjection, RawRanking, SourceDescriptor } from './types';

// ============================================================================
// CSV import — the guaranteed ADP and rankings path.
//
// There is no free, terms-clean, programmatic source of consensus ADP. Rather
// than fabricate one or scrape a site that forbids it, the system imports a CSV
// the user exports themselves from wherever they already have access
// (FantasyPros, Sleeper, ESPN, a spreadsheet). Draft Mode is designed to be
// fully effective with nothing but this.
//
// The parser is deliberately forgiving about column naming because every
// provider names things differently, and deliberately strict about values:
// a row it cannot understand is reported as a warning, never guessed at.
// ============================================================================

export const CSV_DESCRIPTOR: SourceDescriptor = {
  key: 'csv',
  name: 'CSV import',
  type: 'csv',
  reliability: 0.9,
  updateFrequencyMin: 1440,
  limitations:
    'Only as fresh as the file you exported. Carries no provenance beyond the ' +
    'import time, so re-export before draft day.',
  requiresCredential: false,
  termsNote:
    'User-supplied file exported from a service they already have access to. ' +
    'No automated retrieval, so no site terms are implicated.',
};

/** Header aliases seen across the common providers. */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'player', 'player name', 'playername', 'full name', 'player_name'],
  position: ['position', 'pos', 'player position'],
  team: ['team', 'tm', 'nfl team', 'team abbr'],
  adp: ['adp', 'avg', 'average', 'average draft position', 'avg pick', 'rank'],
  stdev: ['stdev', 'std dev', 'std', 'sd', 'deviation'],
  minPick: ['best', 'min', 'earliest', 'high'],
  maxPick: ['worst', 'max', 'latest', 'low'],
  sampleSize: ['n', 'count', 'samples', 'sample size'],
  auction: ['auction', 'auction value', 'value', 'salary', '$'],
  overallRank: ['overall rank', 'rank', 'rk', 'overall', 'ovr'],
  positionRank: ['position rank', 'pos rank', 'posrank', 'pos rk'],
  tier: ['tier'],
  expert: ['expert', 'analyst', 'source'],
  bye: ['bye', 'bye week'],
};

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes, embedded
 * commas and newlines. Written by hand rather than pulled in as a dependency
 * because the format is small and a parser is one less thing to keep updated.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0]!.map((h) => h.trim());
  const dataRows = nonEmpty.slice(1).map((r) => {
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = (r[idx] ?? '').trim();
    });
    return record;
  });

  return { headers, rows: dataRows };
}

/** Find the actual column name for a logical field, case/spacing insensitive. */
export function resolveColumn(
  headers: string[],
  logical: keyof typeof COLUMN_ALIASES,
): string | null {
  const aliases = COLUMN_ALIASES[logical] ?? [];
  const normalized = headers.map((h) => ({ raw: h, key: h.toLowerCase().trim() }));
  for (const alias of aliases) {
    const hit = normalized.find((h) => h.key === alias);
    if (hit) return hit.raw;
  }
  // Fall back to a contains match, longest header first to prefer specificity.
  for (const alias of aliases) {
    const hit = [...normalized]
      .sort((a, b) => b.key.length - a.key.length)
      .find((h) => h.key.includes(alias));
    if (hit) return hit.raw;
  }
  return null;
}

/**
 * Some exports put position and rank in one cell ("RB1", "WR12"), and some put
 * the team in the name cell ("Bijan Robinson ATL"). Split those apart.
 */
export function splitPositionRank(
  value: string,
): { position: string; rank: number } | null {
  const match = value.trim().match(/^([A-Za-z/]+)\s*(\d+)$/);
  if (!match) return null;
  return { position: match[1]!.toUpperCase(), rank: Number(match[2]) };
}

export function importAdpCsv(
  text: string,
  opts: { format?: string; source?: string } = {},
): FetchResult<RawAdp> {
  const fetchedAt = new Date().toISOString();
  const { headers, rows } = parseCsv(text);
  const warnings: string[] = [];

  if (headers.length === 0) {
    return { ok: false, items: [], fetchedAt, warnings, error: 'The file is empty.' };
  }

  const nameCol = resolveColumn(headers, 'name');
  const adpCol = resolveColumn(headers, 'adp');
  if (!nameCol) {
    return {
      ok: false, items: [], fetchedAt, warnings,
      error: `No player-name column found. Looked for one of: ${COLUMN_ALIASES.name!.join(', ')}. Found: ${headers.join(', ')}`,
    };
  }
  if (!adpCol) {
    return {
      ok: false, items: [], fetchedAt, warnings,
      error: `No ADP column found. Looked for one of: ${COLUMN_ALIASES.adp!.join(', ')}. Found: ${headers.join(', ')}`,
    };
  }

  const posCol = resolveColumn(headers, 'position');
  const teamCol = resolveColumn(headers, 'team');
  const stdevCol = resolveColumn(headers, 'stdev');
  const minCol = resolveColumn(headers, 'minPick');
  const maxCol = resolveColumn(headers, 'maxPick');
  const sampleCol = resolveColumn(headers, 'sampleSize');
  const auctionCol = resolveColumn(headers, 'auction');

  const items: RawAdp[] = [];
  rows.forEach((row, idx) => {
    const playerName = (row[nameCol] ?? '').trim();
    const adp = toNumber(row[adpCol]);
    if (!playerName) {
      warnings.push(`Row ${idx + 2}: skipped, no player name.`);
      return;
    }
    if (adp === undefined) {
      warnings.push(`Row ${idx + 2} (${playerName}): skipped, ADP "${row[adpCol]}" is not a number.`);
      return;
    }

    // Position may be plain ("RB") or combined with a rank ("RB4").
    let position = posCol ? normalizePosition(row[posCol]) : null;
    if (!position && posCol) {
      const split = splitPositionRank(row[posCol] ?? '');
      if (split) position = normalizePosition(split.position);
    }

    items.push({
      playerName,
      position: position ?? undefined,
      nflTeam: teamCol ? (row[teamCol] || null) : undefined,
      adp,
      adpStdev: stdevCol ? toNumber(row[stdevCol]) : undefined,
      minPick: minCol ? toNumber(row[minCol]) : undefined,
      maxPick: maxCol ? toNumber(row[maxCol]) : undefined,
      sampleSize: sampleCol ? toNumber(row[sampleCol]) : undefined,
      auctionValue: auctionCol ? toNumber(row[auctionCol]) : undefined,
      format: opts.format ?? 'ppr',
      source: opts.source ?? 'csv',
      sourceTimestamp: fetchedAt,
    });
  });

  if (items.length === 0) {
    return {
      ok: false, items, fetchedAt, warnings,
      error: 'No usable rows found — every row was missing a name or a numeric ADP.',
    };
  }

  return { ok: true, items, fetchedAt, warnings };
}

export function importRankingsCsv(
  text: string,
  opts: { format?: string; source?: string } = {},
): FetchResult<RawRanking> {
  const fetchedAt = new Date().toISOString();
  const { headers, rows } = parseCsv(text);
  const warnings: string[] = [];

  const nameCol = resolveColumn(headers, 'name');
  if (!nameCol) {
    return {
      ok: false, items: [], fetchedAt, warnings,
      error: `No player-name column found. Found: ${headers.join(', ')}`,
    };
  }

  const rankCol = resolveColumn(headers, 'overallRank');
  const posRankCol = resolveColumn(headers, 'positionRank');
  const tierCol = resolveColumn(headers, 'tier');
  const posCol = resolveColumn(headers, 'position');
  const teamCol = resolveColumn(headers, 'team');
  const expertCol = resolveColumn(headers, 'expert');

  const items: RawRanking[] = [];
  rows.forEach((row, idx) => {
    const playerName = (row[nameCol] ?? '').trim();
    if (!playerName) {
      warnings.push(`Row ${idx + 2}: skipped, no player name.`);
      return;
    }

    let position = posCol ? normalizePosition(row[posCol]) : null;
    let positionRank = posRankCol ? toNumber(row[posRankCol]) : undefined;
    if (posCol && !position) {
      const split = splitPositionRank(row[posCol] ?? '');
      if (split) {
        position = normalizePosition(split.position);
        positionRank ??= split.rank;
      }
    }

    items.push({
      playerName,
      position: position ?? undefined,
      nflTeam: teamCol ? (row[teamCol] || null) : undefined,
      overallRank: rankCol ? toNumber(row[rankCol]) : undefined,
      positionRank,
      tier: tierCol ? toNumber(row[tierCol]) : undefined,
      expertName: expertCol ? row[expertCol] || undefined : undefined,
      format: opts.format ?? 'ppr',
      source: opts.source ?? 'csv',
      sourceTimestamp: fetchedAt,
    });
  });

  if (items.length === 0) {
    return { ok: false, items, fetchedAt, warnings, error: 'No usable rows found.' };
  }
  return { ok: true, items, fetchedAt, warnings };
}

/**
 * Projections import. Any column whose header matches a known stat key becomes
 * part of the stat line; points columns are deliberately ignored, since points
 * must be derived from the user's own scoring settings.
 */
const STAT_ALIASES: Record<string, string> = {
  'pass yds': 'pass_yds', 'passing yards': 'pass_yds', 'pass_yds': 'pass_yds', 'py': 'pass_yds',
  'pass td': 'pass_td', 'passing td': 'pass_td', 'pass_td': 'pass_td', 'ptd': 'pass_td',
  'int': 'pass_int', 'interceptions': 'pass_int', 'pass_int': 'pass_int',
  'rush yds': 'rush_yds', 'rushing yards': 'rush_yds', 'rush_yds': 'rush_yds', 'ry': 'rush_yds',
  'rush td': 'rush_td', 'rushing td': 'rush_td', 'rush_td': 'rush_td', 'rtd': 'rush_td',
  'rush att': 'rush_att', 'carries': 'rush_att', 'att': 'rush_att',
  'rec': 'receptions', 'receptions': 'receptions', 'catches': 'receptions',
  'rec yds': 'rec_yds', 'receiving yards': 'rec_yds', 'rec_yds': 'rec_yds',
  'rec td': 'rec_td', 'receiving td': 'rec_td', 'rec_td': 'rec_td',
  'targets': 'targets', 'tgt': 'targets',
  'fl': 'fumbles_lost', 'fumbles': 'fumbles_lost', 'fumbles lost': 'fumbles_lost',
};

export function importProjectionsCsv(
  text: string,
  opts: { source?: string } = {},
): FetchResult<RawProjection> {
  const fetchedAt = new Date().toISOString();
  const { headers, rows } = parseCsv(text);
  const warnings: string[] = [];

  const nameCol = resolveColumn(headers, 'name');
  if (!nameCol) {
    return {
      ok: false, items: [], fetchedAt, warnings,
      error: `No player-name column found. Found: ${headers.join(', ')}`,
    };
  }
  const posCol = resolveColumn(headers, 'position');

  const statColumns = headers
    .map((h) => ({ header: h, key: STAT_ALIASES[h.toLowerCase().trim()] }))
    .filter((c): c is { header: string; key: string } => Boolean(c.key));

  if (statColumns.length === 0) {
    return {
      ok: false, items: [], fetchedAt, warnings,
      error:
        'No recognizable stat columns found. Projections must be imported as ' +
        'stat lines (yards, TDs, receptions) — not as fantasy points, which ' +
        'depend on your league scoring.',
    };
  }

  const items: RawProjection[] = [];
  rows.forEach((row, idx) => {
    const playerName = (row[nameCol] ?? '').trim();
    if (!playerName) {
      warnings.push(`Row ${idx + 2}: skipped, no player name.`);
      return;
    }
    const statLine: Record<string, number> = {};
    for (const col of statColumns) {
      const value = toNumber(row[col.header]);
      if (value !== undefined) statLine[col.key] = value;
    }
    items.push({
      playerName,
      position: posCol ? (normalizePosition(row[posCol]) ?? undefined) : undefined,
      statLine,
      source: opts.source ?? 'csv',
      sourceTimestamp: fetchedAt,
    });
  });

  if (items.length === 0) {
    return { ok: false, items, fetchedAt, warnings, error: 'No usable rows found.' };
  }
  return { ok: true, items, fetchedAt, warnings };
}

/**
 * Build stable, guaranteed-unique player ids from imported rows.
 *
 * Names alone are not unique. `searchKey` deliberately strips suffixes and
 * punctuation so "Marvin Harrison Jr." matches "Marvin Harrison" across
 * sources — but that also means two genuinely different players can normalize
 * to the same key. The NFL has had several simultaneous Mike Williamses and
 * Chris Johnsons; a collision silently merges them into one board entry, and
 * every roster count downstream is then wrong.
 *
 * On collision this appends a counter rather than dropping the row, because a
 * second player with the same name is still a real player you might draft.
 */
export function makeUniquePlayerId(): (position: string, name: string) => string {
  const seen = new Map<string, number>();
  return (position, name) => {
    const base = `${position}-${searchKey(name)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

/** Strip currency/percent decoration, but refuse to guess at real garbage. */
function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[$,%\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned.toLowerCase() === 'null') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
