import { describe, expect, it } from 'vitest';
import {
  clusterNews,
  fingerprint,
  normalizeText,
  similarity,
  tokenize,
} from '@/lib/news/dedup';
import {
  buildPlayerNameIndex,
  classifyCluster,
  linkPlayers,
} from '@/lib/news/classify';
import { searchKey } from '@/lib/sources/types';
import type { RawNewsItem } from '@/lib/sources/types';

function item(
  sourceKey: string,
  title: string,
  opts: { summary?: string; publishedAt?: string } = {},
): RawNewsItem {
  return {
    sourceKey,
    title,
    summary: opts.summary,
    publishedAt: opts.publishedAt ?? '2026-08-26T18:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------

describe('fingerprinting', () => {
  it('collides on identical content', () => {
    expect(fingerprint({ title: 'Player X out' })).toBe(
      fingerprint({ title: 'Player X out' }),
    );
  });

  it('ignores punctuation and case differences', () => {
    expect(fingerprint({ title: 'Player X: OUT!' })).toBe(
      fingerprint({ title: 'player x out' }),
    );
  });

  it('differs on genuinely different content', () => {
    expect(fingerprint({ title: 'Player X out' })).not.toBe(
      fingerprint({ title: 'Player Y out' }),
    );
  });
});

describe('similarity', () => {
  it('scores rewordings of the same event highly', () => {
    const score = similarity(
      'Sample Back leaves practice with hamstring injury',
      'Sample Back exits Wednesday practice with hamstring issue',
    );
    expect(score).toBeGreaterThan(0.4);
  });

  it('scores unrelated stories low', () => {
    expect(
      similarity(
        'Sample Back leaves practice with hamstring injury',
        'Sample Receiver signs a four-year contract extension',
      ),
    ).toBeLessThan(0.15);
  });

  it('drops football stopwords so boilerplate does not create false matches', () => {
    const tokens = tokenize('NFL news report: the team said this week');
    expect(tokens.has('nfl')).toBe(false);
    expect(tokens.has('report')).toBe(false);
    expect(tokens.has('said')).toBe(false);
  });

  it('normalizes accents', () => {
    expect(normalizeText('Añdré')).toBe('andre');
  });
});

describe('clustering (§5)', () => {
  it('merges four outlets reporting one hamstring into one event', () => {
    const items = [
      item('espn', 'Sample Back leaves practice with hamstring injury'),
      item('cbs', 'Sample Back exits Wednesday practice with hamstring'),
      item('yahoo', 'Sample Back suffers hamstring issue at practice'),
      item('pft', 'Sample Back hamstring injury forces early practice exit'),
    ];
    const clusters = clusterNews(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.items).toHaveLength(4);
  });

  it('preserves every original source reference', () => {
    const items = [
      item('espn', 'Sample Back leaves practice with hamstring injury'),
      item('cbs', 'Sample Back exits Wednesday practice with hamstring'),
    ];
    const sources = clusterNews(items)[0]!.items.map((i) => i.sourceKey);
    expect(sources).toContain('espn');
    expect(sources).toContain('cbs');
  });

  it('keeps unrelated stories in separate clusters', () => {
    const clusters = clusterNews([
      item('espn', 'Sample Back leaves practice with hamstring injury'),
      item('cbs', 'Sample Quarterback signs a four-year contract extension'),
      item('yahoo', 'Sample End named the starting tight end'),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it('merges two outlets whose blurbs differ but headlines agree', () => {
    // Regression: averaging in a near-zero summary similarity dragged a clear
    // 0.50 title match below threshold, and the same ACL tear was published as
    // two separate events.
    const clusters = clusterNews([
      item('espn', 'Marcus Fielding suffers torn ACL, out for the season', {
        summary: "The running back was carted off during Wednesday's practice.",
      }),
      item('cbs', 'Marcus Fielding tears ACL and is out for the season, sources say', {
        summary: 'A season-ending knee injury ends the back\'s year before it starts.',
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.items).toHaveLength(2);
  });

  it('still keeps genuinely different stories apart when summaries differ', () => {
    const clusters = clusterNews([
      item('espn', 'Marcus Fielding suffers torn ACL', { summary: 'Carted off.' }),
      item('cbs', 'Dorian Vance signs a contract extension', { summary: 'Terms undisclosed.' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('collapses exact syndicated reprints', () => {
    const headline = 'Sample Back placed on injured reserve';
    const clusters = clusterNews([
      item('espn', headline),
      item('cbs', headline),
      item('yahoo', headline),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.items).toHaveLength(3);
  });

  it('does not merge a months-old rehash into today\'s event', () => {
    const clusters = clusterNews([
      item('espn', 'Sample Back suffers hamstring injury', {
        publishedAt: '2026-08-26T18:00:00.000Z',
      }),
      item('cbs', 'Sample Back suffers hamstring injury', {
        publishedAt: '2026-05-01T18:00:00.000Z',
      }),
    ], { windowHours: 48 });
    expect(clusters.length).toBeGreaterThan(1);
  });

  it('picks the most informative headline as canonical', () => {
    const clusters = clusterNews([
      item('espn', 'Injury update'),
      item('cbs', 'Sample Back leaves practice early with a hamstring injury'),
    ], { threshold: 0.05 });
    expect(clusters[0]!.canonicalTitle).toMatch(/hamstring/);
  });

  it('records the reporting window', () => {
    const clusters = clusterNews([
      item('espn', 'Sample Back hamstring injury', { publishedAt: '2026-08-26T10:00:00.000Z' }),
      item('cbs', 'Sample Back hamstring injury', { publishedAt: '2026-08-26T14:00:00.000Z' }),
    ]);
    expect(clusters[0]!.earliestPublishedAt).toBe('2026-08-26T10:00:00.000Z');
    expect(clusters[0]!.latestPublishedAt).toBe('2026-08-26T14:00:00.000Z');
  });

  it('handles an empty input', () => {
    expect(clusterNews([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('classification (§6, §7)', () => {
  const now = new Date('2026-08-26T20:00:00.000Z');

  const classify = (
    titles: Array<[string, string]>,
    opts: { reliability?: number; importance?: number; publishedAt?: string } = {},
  ) =>
    classifyCluster(
      clusterNews(
        titles.map(([source, title]) =>
          item(source, title, { publishedAt: opts.publishedAt ?? '2026-08-26T18:00:00.000Z' }),
        ),
        { threshold: 0.01 },
      )[0]!,
      {
        sourceReliability: opts.reliability ?? 0.85,
        playerImportance: opts.importance ?? 0.8,
        now,
      },
    );

  it('rates a torn ACL as critical', () => {
    const result = classify([['espn', 'Sample Back suffers a torn ACL, out for the season']]);
    expect(result.eventType).toBe('injury');
    expect(result.fantasyImpact).toBe('CRITICAL');
    expect(result.playerDirection).toBe('STRONG_NEGATIVE');
    expect(result.impactScore).toBeGreaterThan(80);
  });

  it('rates a missed practice as a watch item, not a crisis', () => {
    const result = classify([['espn', 'Sample Back did not practice Wednesday']]);
    expect(['WATCH', 'IMPORTANT', 'LOW_IMPACT']).toContain(result.classification);
    expect(result.impactScore).toBeLessThan(60);
  });

  it('scores an ACL tear far above a missed practice', () => {
    const acl = classify([['espn', 'Sample Back suffers a torn ACL']]);
    const dnp = classify([['espn', 'Sample Back did not practice Wednesday']]);
    expect(acl.impactScore).toBeGreaterThan(dnp.impactScore * 1.5);
  });

  it('recognizes a positive depth-chart move', () => {
    const result = classify([['espn', 'Sample Back named starter for Week 1']]);
    expect(result.eventType).toBe('depth_chart');
    expect(result.playerDirection).toBe('STRONG_POSITIVE');
  });

  it('recognizes the common "named starting <position>" phrasing', () => {
    // "named starter" alone missed the way this is actually written, and a
    // starting-job win was scoring as unclassified noise.
    for (const headline of [
      'Dorian Vance named starting quarterback for Week 1',
      'Dorian Vance named the starting running back',
      'Dorian Vance wins the starting job',
      'Dorian Vance sits atop the depth chart',
    ]) {
      const result = classify([['espn', headline]]);
      expect(result.eventType).toBe('depth_chart');
      expect(result.playerDirection).toBe('STRONG_POSITIVE');
    }
  });

  it('does not let a positive depth-chart phrase invert a demotion', () => {
    const result = classify([['espn', 'Jonah Priest benched, loses starting job to a rookie']]);
    expect(result.playerDirection).toBe('STRONG_NEGATIVE');
  });

  it('recognizes a benching as strongly negative', () => {
    const result = classify([['espn', 'Sample Back benched, loses starting job']]);
    expect(result.playerDirection).toBe('STRONG_NEGATIVE');
  });

  it('treats a depth-chart change as team-neutral — one player gains, another loses', () => {
    const result = classify([['espn', 'Sample Back named starter for Week 1']]);
    expect(result.teamDirection).toBe('NEUTRAL');
  });

  it('filters betting and listicle content as noise', () => {
    for (const headline of [
      'NFL power rankings: where every team stands',
      'Best bets and odds boost for Week 1',
      'Start em sit em: fantasy advice for Week 1',
      // Other sports and business items leak into general sports feeds and
      // matched real rules: "MLB trade deadline" scored as a transaction.
      'MLB trade deadline predictions and Aaron Rodgers reunites with a coach',
      'The Green Bay Packers announce an operating loss for 2025',
      'NBA free agency: where the biggest names land',
    ]) {
      expect(classify([['espn', headline]]).classification).toBe('NOISE');
    }
  });

  it('raises the score when several outlets corroborate', () => {
    const single = classify([['espn', 'Sample Back suffers a hamstring injury']]);
    const many = classify([
      ['espn', 'Sample Back suffers a hamstring injury'],
      ['cbs', 'Sample Back suffers a hamstring injury'],
      ['yahoo', 'Sample Back suffers a hamstring injury'],
    ]);
    expect(many.impactScore).toBeGreaterThan(single.impactScore);
    expect(many.confidence).toBeGreaterThan(single.confidence);
  });

  it('weighs source reliability into confidence', () => {
    const trusted = classify([['espn', 'Sample Back suffers a hamstring injury']], { reliability: 0.95 });
    const shaky = classify([['blog', 'Sample Back suffers a hamstring injury']], { reliability: 0.4 });
    expect(trusted.confidence).toBeGreaterThan(shaky.confidence);
  });

  it('discounts old news', () => {
    const fresh = classify([['espn', 'Sample Back suffers a torn ACL']], {
      publishedAt: '2026-08-26T18:00:00.000Z',
    });
    const old = classify([['espn', 'Sample Back suffers a torn ACL']], {
      publishedAt: '2026-08-01T18:00:00.000Z',
    });
    expect(old.impactScore).toBeLessThan(fresh.impactScore);
  });

  it('scales impact with how relevant the player is', () => {
    const star = classify([['espn', 'Sample Back suffers a hamstring injury']], { importance: 1 });
    const scrub = classify([['espn', 'Sample Back suffers a hamstring injury']], { importance: 0 });
    expect(star.impactScore).toBeGreaterThan(scrub.impactScore);
  });

  it('spreads confidence across a meaningful range', () => {
    // A number that reads the same on every item is decoration, not a
    // measurement. One weak source must land far below four strong ones.
    const lone = classify([['blog', 'Sample Back suffers a hamstring injury']], {
      reliability: 0.5,
    });
    const many = classify(
      [
        ['espn', 'Sample Back suffers a hamstring injury'],
        ['cbs', 'Sample Back suffers a hamstring injury'],
        ['yahoo', 'Sample Back suffers a hamstring injury'],
        ['pft', 'Sample Back suffers a hamstring injury'],
      ],
      { reliability: 0.9 },
    );
    expect(many.confidence - lone.confidence).toBeGreaterThan(0.2);
    expect(lone.confidence).toBeLessThan(0.7);
    expect(many.confidence).toBeGreaterThan(0.8);
  });

  it('never claims confidence it has not earned', () => {
    const result = classify([['blog', 'Something happened to somebody']], { reliability: 0.3 });
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it('admits when no rule matched instead of guessing an impact', () => {
    const result = classify([['espn', 'Sample Back spoke to reporters on Tuesday afternoon']]);
    expect(result.eventType).toBe('other');
    expect(result.signals.join(' ')).toMatch(/no rule matched/);
  });

  it('explains itself — every classification lists the signals that fired', () => {
    const result = classify([['espn', 'Sample Back suffers a torn ACL, placed on IR']]);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.join(' ')).toMatch(/injury/);
  });

  it('detects the positions a story concerns', () => {
    const result = classify([['espn', 'Starting running back injured, backup gets carries']]);
    expect(result.positionsAffected).toContain('RB');
  });
});

// ---------------------------------------------------------------------------

describe('player linking', () => {
  const players = [
    { id: 'p1', name: 'Sample Runningback' },
    { id: 'p2', name: 'Sample Wideout' },
    { id: 'p3', name: 'Jordan Smith' },
    { id: 'p4', name: 'Taylor Smith' },     // deliberately shares a last name
  ];
  const index = buildPlayerNameIndex(players, searchKey);

  it('links a full name', () => {
    const links = linkPlayers('Sample Runningback leaves practice', index, searchKey);
    expect(links.map((l) => l.playerId)).toContain('p1');
    expect(links.find((l) => l.playerId === 'p1')!.matchType).toBe('full');
  });

  it('links an unambiguous last name with lower confidence', () => {
    const links = linkPlayers('Wideout expected to play Sunday', index, searchKey);
    const match = links.find((l) => l.playerId === 'p2');
    expect(match?.matchType).toBe('last');
    expect(match!.confidence).toBeLessThan(0.95);
  });

  it('does not link a first name that is another player\'s surname', () => {
    // Regression: "Patrick Mahomes" linked Tim Patrick on the word "patrick",
    // filing a story against a player it never mentioned.
    const withMahomes = buildPlayerNameIndex(
      [
        { id: 'mahomes', name: 'Patrick Mahomes' },
        { id: 'patrick', name: 'Tim Patrick' },
      ],
      searchKey,
    );
    const links = linkPlayers(
      'Patrick Mahomes fully cleared for training camp',
      withMahomes,
      searchKey,
    );
    expect(links.map((l) => l.playerId)).toEqual(['mahomes']);
  });

  it('still links a bare surname when it stands alone', () => {
    const withMahomes = buildPlayerNameIndex(
      [
        { id: 'mahomes', name: 'Patrick Mahomes' },
        { id: 'patrick', name: 'Tim Patrick' },
      ],
      searchKey,
    );
    const links = linkPlayers('Patrick returns to practice', withMahomes, searchKey);
    expect(links.map((l) => l.playerId)).toEqual(['patrick']);
  });

  it('refuses to guess when a last name is ambiguous', () => {
    // Attaching an injury to the wrong Smith is exactly the error to avoid.
    const links = linkPlayers('Smith suffered a hamstring injury', index, searchKey);
    expect(links.map((l) => l.playerId)).not.toContain('p3');
    expect(links.map((l) => l.playerId)).not.toContain('p4');
  });

  it('resolves the ambiguity when the full name is present', () => {
    const links = linkPlayers('Jordan Smith suffered a hamstring injury', index, searchKey);
    expect(links.map((l) => l.playerId)).toEqual(['p3']);
  });

  it('links nobody when nobody is mentioned', () => {
    expect(linkPlayers('League announces new schedule format', index, searchKey)).toEqual([]);
  });

  it('links several players in one story', () => {
    const links = linkPlayers(
      'Sample Runningback out, Sample Wideout expected to see more work',
      index, searchKey,
    );
    expect(links.map((l) => l.playerId).sort()).toEqual(['p1', 'p2']);
  });
});
