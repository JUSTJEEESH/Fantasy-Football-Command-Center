import { test, expect } from '@playwright/test';

// ============================================================================
// The draft-day run sheet. It is a checklist that knows its own state, so the
// tests cover both states: setup missing (fresh device) and setup done.
// ============================================================================

test.use({ viewport: { width: 390, height: 844 } });

test.describe('draft-day guide', () => {
  test('is reachable from Home and says setup is missing on a fresh device', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /Draft-day guide/i }).click();
    await expect(page.getByRole('heading', { name: 'Draft day' })).toBeVisible();
    await expect(page.getByText('Setup still needed')).toBeVisible();
    // And it says where to fix it, in one place.
    await expect(page.getByText(/Fix all three in one place/)).toBeVisible();
  });

  test('flips to draft-ready once the board is built', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Load Bay Islands Fantasy' }).click();
    await page.getByRole('button', { name: /Use the shipped player board/i }).click();
    await expect(page.getByText(/Board built from data fetched/i)).toBeVisible({
      timeout: 20_000,
    });

    await page.goto('/guide');
    await expect(page.getByText('Setup is done — you are draft-ready')).toBeVisible();
    await expect(page.getByText(/slot 10/)).toBeVisible();
  });

  test('covers the whole day: before, arrival, during, and failure modes', async ({
    page,
  }) => {
    await page.goto('/guide');
    await expect(page.getByText(/The night before, at home/)).toBeVisible();
    await expect(page.getByText(/When you arrive at the bar/)).toBeVisible();
    await expect(page.getByText(/During the draft/)).toBeVisible();
    await expect(page.getByText(/Bar wifi dies/)).toBeVisible();
  });
});
