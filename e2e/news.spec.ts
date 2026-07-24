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
