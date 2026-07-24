import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePosition, parseHeight, toRawPlayer } from '@/lib/sources/sleeper';
import {
  makeUniquePlayerId,
  importAdpCsv,
  importProjectionsCsv,
  importRankingsCsv,
  parseCsv,
  resolveColumn,
  splitPositionRank,
} from '@/lib/sources/csv-import';
import { decodeXml, parseFeed, stripHtml, toIso } from '@/lib/sources/rss';
import { guardedFetch, searchKey } from '@/lib/sources/types';

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8');

// ---------------------------------------------------------------------------

describe('Sleeper player translation', () => {
  const raw = JSON.parse(fixture('sleeper-players.json')) as Record<string, any>;

  it('translates a standard skill player', () => {
    const player = toRawPlayer(raw['4034']);
    expect(player).toMatchObject({
      externalId: '4034',
      fullName: 'Sample Runningback',
      position: 'RB',
      nflTeam: 'TEN',
      jerseyNumber: 22,
      heightInches: 72,
      weightLbs: 247,
      yearsExp: 7,
      depthChartOrder: 1,
    });
  });

  it('carries injury status through', () => {
    expect(toRawPlayer(raw['6794'])?.injuryStatus).toBe('Questionable');
  });

  it('maps DEF onto our DST position', () => {
    expect(toRawPlayer(raw['PHI'])?.position).toBe('DST');
  });

  it('drops non-fantasy positions rather than mis-filing them', () => {
    expect(toRawPlayer(raw['9001'])).toBeNull();   // long snapper
    expect(toRawPlayer(raw['9002'])).toBeNull();   // offensive tackle
  });

  it('parses both height formats', () => {
    expect(parseHeight('72')).toBe(72);
    expect(parseHeight(`6'1"`)).toBe(73);
    expect(parseHeight(`6'`)).toBe(72);
    expect(parseHeight(null)).toBeUndefined();
    expect(parseHeight('unknown')).toBeUndefined();
  });

  it('normalizes position aliases across sources', () => {
    expect(normalizePosition('DEF')).toBe('DST');
    expect(normalizePosition('D/ST')).toBe('DST');
    expect(normalizePosition('PK')).toBe('K');
    expect(normalizePosition('FB')).toBe('RB');
    expect(normalizePosition('rb')).toBe('RB');
    expect(normalizePosition('OLB')).toBeNull();
    expect(normalizePosition(null)).toBeNull();
  });
});

describe('searchKey', () => {
  it('matches the same player across differing source spellings', () => {
    expect(searchKey('A.J. Brown')).toBe(searchKey('AJ Brown'));
    expect(searchKey('Marvin Harrison Jr.')).toBe(searchKey('Marvin Harrison'));
    expect(searchKey("De'Von Achane")).toBe(searchKey('DeVon Achane'));
  });

  it('keeps genuinely different players distinct', () => {
    expect(searchKey('Michael Thomas')).not.toBe(searchKey('Mike Thomas'));
  });
});

// ---------------------------------------------------------------------------

describe('CSV parsing', () => {
  it('parses a simple file', () => {
    const { headers, rows } = parseCsv('Name,Pos\nAlice,RB\nBob,WR\n');
    expect(headers).toEqual(['Name', 'Pos']);
    expect(rows).toEqual([
      { Name: 'Alice', Pos: 'RB' },
      { Name: 'Bob', Pos: 'WR' },
    ]);
  });

  it('handles quoted fields with commas', () => {
    const { rows } = parseCsv('Name,Team\n"Smith, John",PHI\n');
    expect(rows[0]!.Name).toBe('Smith, John');
  });

  it('handles escaped quotes', () => {
    const { rows } = parseCsv('Name,Note\n"He said ""hi""",x\n');
    expect(rows[0]!.Note).toBe('x');
    expect(rows[0]!.Name).toBe('He said "hi"');
  });

  it('handles CRLF line endings from Windows exports', () => {
    const { rows } = parseCsv('Name,Pos\r\nAlice,RB\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Pos).toBe('RB');
  });

  it('ignores blank lines', () => {
    expect(parseCsv('Name\nAlice\n\n\nBob\n').rows).toHaveLength(2);
  });

  it('returns empty for an empty file', () => {
    expect(parseCsv('').rows).toEqual([]);
  });
});

describe('column resolution', () => {
  it('matches exact aliases regardless of case and spacing', () => {
    expect(resolveColumn(['Player Name', 'AVG'], 'name')).toBe('Player Name');
    expect(resolveColumn(['  POS  '], 'position')).toBe('  POS  ');
  });

  it('falls back to a contains match', () => {
    expect(resolveColumn(['Consensus ADP (PPR)'], 'adp')).toBe('Consensus ADP (PPR)');
  });

  it('returns null when nothing matches', () => {
    expect(resolveColumn(['Foo', 'Bar'], 'name')).toBeNull();
  });

  it('splits a combined position-rank cell', () => {
    expect(splitPositionRank('RB4')).toEqual({ position: 'RB', rank: 4 });
    expect(splitPositionRank('WR12')).toEqual({ position: 'WR', rank: 12 });
    expect(splitPositionRank('RB')).toBeNull();
  });
});

describe('ADP import', () => {
  it('imports a FantasyPros-shaped export', () => {
    const csv = [
      'Rank,Player,Team,POS,AVG,Std Dev,Best,Worst,N',
      '1,Sample Back,TEN,RB1,1.4,0.6,1,3,412',
      '2,Sample Receiver,PHI,WR1,2.8,1.1,1,6,398',
    ].join('\n');

    const result = importAdpCsv(csv, { format: 'ppr', source: 'fantasypros' });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      playerName: 'Sample Back',
      position: 'RB',
      nflTeam: 'TEN',
      adp: 1.4,
      adpStdev: 0.6,
      minPick: 1,
      maxPick: 3,
      sampleSize: 412,
      format: 'ppr',
      source: 'fantasypros',
    });
  });

  it('handles a minimal two-column export', () => {
    const result = importAdpCsv('Player,ADP\nSample Back,1.4\n');
    expect(result.ok).toBe(true);
    expect(result.items[0]!.adp).toBe(1.4);
  });

  it('strips currency decoration from auction values', () => {
    const result = importAdpCsv('Player,ADP,Auction\nSample Back,1.4,"$62"\n');
    expect(result.items[0]!.auctionValue).toBe(62);
  });

  it('reports a missing name column instead of guessing', () => {
    const result = importAdpCsv('Foo,Bar\n1,2\n');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no player-name column/i);
  });

  it('reports a missing ADP column instead of guessing', () => {
    const result = importAdpCsv('Player,Team\nSample Back,TEN\n');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no adp column/i);
  });

  it('skips unparseable rows with a specific warning, keeping the rest', () => {
    const csv = 'Player,ADP\nGood Player,12\nBad Player,not-a-number\n,45\n';
    const result = importAdpCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/Bad Player/);
    expect(result.warnings.join(' ')).toMatch(/no player name/i);
  });

  it('fails clearly when no row is usable', () => {
    const result = importAdpCsv('Player,ADP\nA,x\nB,y\n');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no usable rows/i);
  });
});

describe('player id generation', () => {
  it('gives distinct ids to different players', () => {
    const nextId = makeUniquePlayerId();
    expect(nextId('RB', 'Bijan Robinson')).not.toBe(nextId('RB', 'Breece Hall'));
  });

  it('does not collide two real players who share a name', () => {
    // The NFL has repeatedly had two active players with the same name. Merging
    // them into one board entry silently corrupts every roster count that
    // follows, so a collision must produce a second id, not a duplicate.
    const nextId = makeUniquePlayerId();
    const first = nextId('WR', 'Mike Williams');
    const second = nextId('WR', 'Mike Williams');
    expect(second).not.toBe(first);
  });

  it('does not collide names that differ only in stripped characters', () => {
    // searchKey removes digits, suffixes and punctuation to match across
    // sources, which means the normalized key alone is not unique.
    const nextId = makeUniquePlayerId();
    expect(nextId('RB', 'Player One')).not.toBe(nextId('RB', 'Player 1'));
  });

  it('keeps the first id stable and readable', () => {
    const nextId = makeUniquePlayerId();
    expect(nextId('RB', 'Bijan Robinson')).toBe('RB-bijanrobinson');
  });

  it('separates players of different positions with the same name', () => {
    const nextId = makeUniquePlayerId();
    expect(nextId('QB', 'Josh Allen')).not.toBe(nextId('WR', 'Josh Allen'));
  });
});

describe('rankings import', () => {
  it('imports overall rank, position rank and tier', () => {
    const csv = 'Rank,Player,POS,Team,Tier\n1,Sample Back,RB1,TEN,1\n2,Sample End,TE3,KC,2\n';
    const result = importRankingsCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      playerName: 'Sample Back', position: 'RB', positionRank: 1, tier: 1,
    });
    expect(result.items[1]!.position).toBe('TE');
    expect(result.items[1]!.positionRank).toBe(3);
  });
});

describe('projections import', () => {
  it('imports a stat line', () => {
    const csv = 'Player,POS,Rush Yds,Rush TD,Rec,Rec Yds\nSample Back,RB,1100,9,55,450\n';
    const result = importProjectionsCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.items[0]!.statLine).toEqual({
      rush_yds: 1100, rush_td: 9, receptions: 55, rec_yds: 450,
    });
  });

  it('refuses a points-only file, explaining why', () => {
    const result = importProjectionsCsv('Player,POS,FPTS\nSample Back,RB,280\n');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stat lines/i);
    expect(result.error).toMatch(/league scoring/i);
  });
});

// ---------------------------------------------------------------------------

describe('RSS parsing', () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Example NFL</title>
      <item>
        <title><![CDATA[Sample Back leaves practice with hamstring injury]]></title>
        <description><![CDATA[<p>The running back <b>exited</b> Wednesday's session early.</p>]]></description>
        <link>https://example.com/a</link>
        <guid>https://example.com/a</guid>
        <pubDate>Wed, 26 Aug 2026 18:30:00 GMT</pubDate>
      </item>
      <item>
        <title>Sample Receiver signs extension</title>
        <description>Terms were not disclosed &amp; the deal is pending.</description>
        <link>https://example.com/b</link>
        <pubDate>Wed, 26 Aug 2026 12:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  it('parses RSS 2.0 items', () => {
    const items = parseFeed(rss, 'example');
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Sample Back leaves practice with hamstring injury');
    expect(items[0]!.url).toBe('https://example.com/a');
    expect(items[0]!.publishedAt).toBe('2026-08-26T18:30:00.000Z');
  });

  it('strips HTML from summaries', () => {
    const items = parseFeed(rss, 'example');
    expect(items[0]!.summary).toBe("The running back exited Wednesday's session early.");
  });

  it('decodes entities', () => {
    expect(parseFeed(rss, 'example')[1]!.summary).toBe(
      'Terms were not disclosed & the deal is pending.',
    );
  });

  it('parses Atom feeds', () => {
    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Sample End named starter</title>
          <summary>He takes over as the primary tight end.</summary>
          <link rel="alternate" href="https://example.com/c"/>
          <id>tag:example.com,2026:c</id>
          <published>2026-08-26T10:00:00Z</published>
        </entry>
      </feed>`;
    const items = parseFeed(atom, 'atom');
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.com/c');
    expect(items[0]!.externalId).toBe('tag:example.com,2026:c');
  });

  it('returns nothing for a malformed feed rather than throwing', () => {
    expect(parseFeed('<html><body>not a feed</body></html>', 'x')).toEqual([]);
    expect(parseFeed('', 'x')).toEqual([]);
  });

  it('omits an unparseable date rather than inventing one', () => {
    const bad = `<rss><channel><item><title>T</title><pubDate>garbage</pubDate></item></channel></rss>`;
    expect(parseFeed(bad, 'x')[0]!.publishedAt).toBeUndefined();
    expect(toIso('nonsense')).toBeUndefined();
  });

  it('decodes nested entities in the right order', () => {
    expect(decodeXml('&amp;lt;tag&amp;gt;')).toBe('&lt;tag&gt;');
  });

  it('collapses whitespace when stripping HTML', () => {
    expect(stripHtml('<p>a</p>\n\n  <p>b</p>')).toBe('a b');
  });
});

// ---------------------------------------------------------------------------

describe('guardedFetch honesty', () => {
  it('refuses to run when ingestion is disabled, and says so explicitly', async () => {
    const previous = process.env.INGEST_NETWORK_ENABLED;
    process.env.INGEST_NETWORK_ENABLED = '0';
    try {
      const result = await guardedFetch('https://example.com', { sourceKey: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The distinction that matters: a config state must never look like
        // "there was no news today".
        expect(result.error).toMatch(/disabled/i);
        expect(result.error).toMatch(/not an empty result/i);
      }
    } finally {
      if (previous === undefined) delete process.env.INGEST_NETWORK_ENABLED;
      else process.env.INGEST_NETWORK_ENABLED = previous;
    }
  });
});
