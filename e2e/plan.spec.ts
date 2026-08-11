import { test, expect } from '@playwright/test';

// ============================================================================
// The draft plan, and the trap underneath it.
//
// The plan is only as right as the league it was built for. A generic 12-team
// PPR template has a required tight end slot; Bay Islands does not. Build a
// board under the wrong one and the page confidently inverts its single most
// valuable conclusion — "never spend a pick on a tight end" becomes a list of
// seven tight ends to target — with no warning, because both answers are
// correct for the league they were given.
//
// So these tests do NOT configure the league first. They check that someone
// who opens the app and taps the obvious button gets the right answer.
// ============================================================================

test.use({ viewport: { width: 390, height: 844 } });

test.describe('draft plan', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: /Use the shipped player board/i }).click();
    await expect(page.getByText(/Board built from data fetched/i)).toBeVisible({
      timeout: 20_000,
    });
  });

  test('builds the board for the real league without being told to', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByText('Bay Islands Fantasy', { exact: false })).toBeVisible();
  });

  test('states the league rules that actually change how you draft', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByText(/Passing touchdowns are worth 6/i)).toBeVisible();
    // The zero-TE fact died at the 2026-08-08 party — a mandatory TE was voted
    // in, so the plan must NOT still preach the old fade.
    await expect(page.getByText(/never required to start a tight end/i)).toHaveCount(0);
  });

  test('reflects the amended roster: nine starters including a TE', async ({ page }) => {
    await page.goto('/plan');
    // 9 starters + 6 bench = 15 rounds, shown in the header line.
    await expect(page.getByText(/15 rounds/)).toBeVisible();
  });

  // The two below need a board big enough to analyse. A fixture build ships
  // six players on purpose, and the honest response to six players is to
  // conclude nothing — which is itself asserted in the unit tests.
  test('explains what the analysis could not use', async ({ page }) => {
    await page.goto('/plan');
    const section = page.getByText(/What this is built on/i);
    if ((await section.count()) === 0) test.skip(true, 'board too small to analyse');
    await expect(page.getByText(/Ranked \d+ players|too few/i).first()).toBeVisible();
  });

  test('says what to do instead of just showing numbers', async ({ page }) => {
    await page.goto('/plan');
    const verdicts = page.getByText(/Where the market is wrong/i);
    if ((await verdicts.count()) === 0) test.skip(true, 'board too small to analyse');
    await expect(
      page.getByText(/Let someone else take them|priced about right/i).first(),
    ).toBeVisible();
  });

  test('puts a pick number on when each group of players runs out', async ({ page }) => {
    await page.goto('/plan');
    const section = page.locator('section', { hasText: 'Deadlines' }).first();
    if ((await section.count()) === 0) test.skip(true, 'board too small for deadlines');

    // A deadline is only useful if it names a round AND a pick. Asserted on
    // the row's own text rather than on a text node, since the round and the
    // pick live in nested spans.
    const row = section.getByRole('button').first();
    expect(await row.innerText()).toMatch(/R\d+\s+pick \d+/);

    // Tapping one has to show who is actually in the group — the deadline is
    // useless without the shopping list it applies to.
    await row.click();
    await expect(section.getByText(/ADP \d+\.\d/).first()).toBeVisible();
  });

  test('does not put a kicker deadline on the sheet', async ({ page }) => {
    await page.goto('/plan');
    const section = page.locator('section', { hasText: 'Deadlines' }).first();
    if ((await section.count()) === 0) test.skip(true, 'board too small for deadlines');
    // One kicker, last two rounds, no planning required.
    await expect(section.getByText(/^K\d/)).toHaveCount(0);
  });
});
