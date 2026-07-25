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
    await expect(page.getByText(/never required to start a tight end/i)).toBeVisible();
    await expect(page.getByText(/Passing touchdowns are worth 6/i)).toBeVisible();
  });

  test('does not tell you to chase the position your league never starts', async ({ page }) => {
    await page.goto('/plan');
    const targets = page.locator('section', { hasText: 'Targets' }).first();
    if ((await targets.count()) === 0) test.skip(true, 'no targets in this build');

    // Under the wrong league this section filled with tight ends.
    const text = await targets.innerText();
    const teLines = text.split('\n').filter((l) => /·\s*TE\b|TE\s*·/.test(l));
    expect(teLines).toEqual([]);
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
});
