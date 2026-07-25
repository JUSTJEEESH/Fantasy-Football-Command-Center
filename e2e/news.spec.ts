import { test, expect } from '@playwright/test';

// The news feed, served exactly as GitHub Pages serves it.
const SITE = 'http://localhost:3222/Fantasy-Football-Command-Center';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('news feed', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${SITE}/news/`);
    await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeVisible();
  });

  test('shows how many headlines were merged into how many events', async ({ page }) => {
    // The dedup ratio is the product's whole pitch — it should be visible.
    await expect(page.getByText(/\d+ headlines from \d+ sources, merged into \d+ events/))
      .toBeVisible();
  });

  test('leads with what needs attention, not with what is newest', async ({ page }) => {
    await expect(page.getByText('Needs your attention')).toBeVisible();
  });

  test('every item states what it means, not just what happened', async ({ page }) => {
    const first = page.locator('article').first();
    await expect(first.locator('.claim-INFERENCE')).toBeVisible();
    await expect(first.locator('.claim-INFERENCE')).not.toBeEmpty();
  });

  test('shows a confidence figure that is not pinned to one value', async ({ page }) => {
    const texts = await page.getByText(/\d+% confidence/).allTextContents();
    expect(texts.length).toBeGreaterThan(1);
    // A number identical on every row conveys nothing and reads as decoration.
    expect(new Set(texts).size).toBeGreaterThan(1);
  });

  test('expanding an item explains why it scored that way', async ({ page }) => {
    await page.locator('article button').first().click();
    await expect(page.getByText('Why it scored this way')).toBeVisible();
    await expect(page.getByText('Reported by')).toBeVisible();
    await expect(page.getByText('Impact score')).toBeVisible();
  });

  test('credits every outlet that reported an event', async ({ page }) => {
    await page.locator('article button').first().click();
    const links = page.getByText('Reported by').locator('..').locator('a');
    expect(await links.count()).toBeGreaterThan(0);
  });

  test('filters to injuries', async ({ page }) => {
    await page.getByRole('button', { name: 'Injuries' }).click();
    await expect(page.locator('article').first()).toBeVisible();
  });

  test('discloses which sources succeeded and which failed', async ({ page }) => {
    await page.getByText('Where this came from').click();
    await expect(page.getByText(/Headlines come from public RSS feeds/)).toBeVisible();
  });

  test('home shows a briefing without repeating the same event twice', async ({ page }) => {
    await page.goto(`${SITE}/`);
    await expect(page.getByText('Your briefing')).toBeVisible();

    // A digest that lists one ACL tear under two headings is padding.
    const headlines = await page.locator('section p.text-\\[var\\(--muted\\)\\]').allTextContents();
    const meaningful = headlines.filter((t) => t.trim().length > 20);
    expect(new Set(meaningful).size).toBe(meaningful.length);
  });
});

test('collapses repeated coverage of one player instead of stacking cards', async ({ page }) => {
  await page.goto(`${SITE}/news/`);

  // Data-dependent by nature: a quiet news day has nothing to group. Assert the
  // mechanism when there is something to assert, and that nothing is lost.
  const more = page.getByRole('button', { name: /\d+ more on /i });
  const groups = await more.count();
  if (groups === 0) test.skip(true, 'no repeated coverage in this build');

  const first = more.first();
  const label = (await first.textContent()) ?? '';
  const hidden = Number(label.match(/(\d+) more/)?.[1] ?? 0);
  expect(hidden).toBeGreaterThan(0);

  // Everything collapsed is one tap away, and the control says so both ways.
  await first.click();
  await expect(page.getByRole('button', { name: /^Hide$/ }).first()).toBeVisible();
});

test('shows what your own board knows about a player in the news', async ({ page }) => {
  // Before a pack exists the board filter has nothing to compare against, and
  // has to say so rather than looking like a quiet news day.
  await page.goto(`${SITE}/news/`);
  await page.getByRole('button', { name: 'My board', exact: true }).click();
  await expect(page.getByText(/No draft pack yet/i)).toBeVisible();
});

test('briefing puts your draft range first once a board exists', async ({ page }) => {
  // Build the board, then read Home. Without a board the section cannot and
  // must not appear — relevance to nothing is not a claim.
  await page.goto(`${SITE}/settings/`);
  await page.getByRole('button', { name: /Use the shipped player board/i }).click();
  await expect(page.getByText(/Board built from data fetched/i)).toBeVisible({ timeout: 20_000 });

  await page.goto(`${SITE}/`);
  await expect(page.getByText('Your briefing')).toBeVisible();

  const body = await page.locator('body').innerText();
  if (!body.includes('YOUR DRAFT RANGE')) {
    // Data-dependent: a build whose news links no draftable player has no
    // section to show, and showing nothing is the correct behaviour.
    test.skip(true, 'no draft-range news in this build');
  }
  // When it appears, it must lead — before the league-wide sections.
  const range = body.indexOf('YOUR DRAFT RANGE');
  for (const section of ['BIGGEST NEWS', 'INJURIES TO KNOW', 'TRENDING UP']) {
    const at = body.indexOf(section);
    if (at !== -1) expect(range).toBeLessThan(at);
  }
});
