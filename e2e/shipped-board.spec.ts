import { test, expect } from '@playwright/test';

// ============================================================================
// The no-spreadsheet path.
//
// Everything else in the draft flow assumed you arrived with an ADP export.
// This covers the person who didn't: open Settings, tap one button, and get a
// working war room built from the data the deployment already shipped with.
//
// The board these tests build comes from public/data/players.json — real in a
// deployment, fixtures locally. Either way the plumbing under test is the same.
// ============================================================================

test.use({ viewport: { width: 390, height: 844 } });

test.describe('building a draft pack from the shipped data', () => {
  test('one tap produces a pack the war room can open', async ({ page }) => {
    await page.goto('/settings');
    await page.getByLabel('Your draft slot', { exact: true }).fill('4');

    await page.getByRole('button', { name: /Use the shipped player board/i }).click();

    await expect(page.getByText(/Board built from data fetched/i)).toBeVisible({
      timeout: 15_000,
    });

    // The summary has to state what the board is actually made of, not just
    // that something happened.
    await expect(page.getByText(/\d+ players · \d+ with ADP/)).toBeVisible();

    // And the provenance notes have to be on screen before you rely on it.
    await expect(page.getByText(/inferred from/i)).toBeVisible();

    await page.goto('/draft');
    await expect(page.getByText(/no pack loaded/i)).toHaveCount(0);
  });

  test('says why it failed rather than quietly doing nothing', async ({ page }) => {
    // Simulate the pack being unreachable — the offline-first-visit case.
    await page.route('**/data/players.json', (route) => route.abort());

    await page.goto('/settings');
    await page.getByRole('button', { name: /Use the shipped player board/i }).click();

    await expect(page.getByText(/Could not read the shipped player board/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('reports a build that could not fetch players, instead of showing an empty board', async ({
    page,
  }) => {
    await page.route('**/data/players.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: '2026-07-25T00:00:00.000Z',
          ok: false,
          reason: 'Sleeper returned HTTP 503',
          sources: [],
          season: 2026,
          players: [],
        }),
      }),
    );

    await page.goto('/settings');
    await page.getByRole('button', { name: /Use the shipped player board/i }).click();

    await expect(page.getByText(/Sleeper returned HTTP 503/)).toBeVisible({ timeout: 15_000 });
  });
});
