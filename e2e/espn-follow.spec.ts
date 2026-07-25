import { test, expect, type Page, type Route } from '@playwright/test';

// ============================================================================
// The ESPN league link, end to end with ESPN itself mocked at the network
// layer. This proves every part we control: the settings flow, the draft-order
// import, the live follow applying picks to the board, and the honest failure
// messages. The one thing it cannot prove is ESPN's CORS policy — that is
// exactly what the Test Connection button verifies from the real browser.
// ============================================================================

const ESPN_LEAGUE = /lm-api-reads\.fantasy\.espn\.com\/.*\/leagues\/1234567/;

function leagueBody(picks: Array<{ overallPickNumber: number; playerId: number; teamId: number }>) {
  return {
    id: 1234567,
    seasonId: 2026,
    settings: {
      name: 'Bay Islands Fantasy',
      draftSettings: { pickOrder: [4, 7, 1, 9, 2, 11, 3, 8, 5, 12, 6, 10] },
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      location: 'Team',
      nickname: `${i + 1}`,
    })),
    draftDetail: { drafted: false, inProgress: true, picks },
  };
}

async function buildBoard(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: /Use the shipped player board/i }).click();
  await expect(page.getByText(/Board built from data fetched/i)).toBeVisible({
    timeout: 20_000,
  });
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe('linking the ESPN league', () => {
  test('imports the draft order and sets your slot with one tap', async ({ page }) => {
    await page.route(ESPN_LEAGUE, (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(leagueBody([])) }),
    );

    await buildBoard(page);
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /Test connection/i }).click();

    await expect(page.getByText(/Connected to Bay Islands Fantasy/i)).toBeVisible();
    await expect(page.getByText(/draft order is published/i)).toBeVisible();

    // Team 9 sits fourth in the published order.
    await page.getByRole('button', { name: /Team 9/ }).click();
    await expect(page.getByText(/drafting from slot 4\. Saved\./i)).toBeVisible();
  });

  test('says plainly when the league is private, and what to change', async ({ page }) => {
    await page.route(ESPN_LEAGUE, (route: Route) => route.fulfill({ status: 401, body: '{}' }));

    await buildBoard(page);
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /Test connection/i }).click();

    await expect(page.getByText(/league is private/i)).toBeVisible();
    await expect(page.getByText(/League Visibility/i)).toBeVisible();
  });

  test('names the browser wall when the request is blocked outright', async ({ page }) => {
    await page.route(ESPN_LEAGUE, (route: Route) => route.abort());

    await buildBoard(page);
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /Test connection/i }).click();

    await expect(page.getByText(/blocked or could not complete/i)).toBeVisible();
  });

  test('reports an unknown league id as exactly that', async ({ page }) => {
    await page.route(ESPN_LEAGUE, (route: Route) => route.fulfill({ status: 404, body: '{}' }));

    await buildBoard(page);
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /Test connection/i }).click();

    await expect(page.getByText(/no league 1234567/i)).toBeVisible();
  });
});

test.describe('following the draft live', () => {
  test('picks made in the ESPN room land on the board by themselves', async ({ page }) => {
    // A shipped pack whose players carry ESPN ids, served in place of the
    // fixture one, so the id-matching path runs in a real browser.
    const shipped = {
      generatedAt: new Date().toISOString(),
      ok: true,
      sources: [{ key: 'sleeper', name: 'Sleeper', ok: true, itemCount: 3 }],
      season: 2026,
      players: [
        { id: 'RB-a', name: 'Alpha Back', position: 'RB', team: 'DET', adp: 1.5, espnId: 111 },
        { id: 'RB-b', name: 'Bravo Back', position: 'RB', team: 'ATL', adp: 2.5, espnId: 222 },
        { id: 'WR-c', name: 'Charlie Wideout', position: 'WR', team: 'LAR', adp: 3.5, espnId: 333 },
      ],
    };
    await page.route('**/data/players.json', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shipped) }),
    );
    // Two picks already made in the ESPN room by other teams.
    await page.route(ESPN_LEAGUE, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          leagueBody([
            { overallPickNumber: 1, playerId: 111, teamId: 4 },
            { overallPickNumber: 2, playerId: 222, teamId: 7 },
          ]),
        ),
      }),
    );

    await buildBoard(page);
    await page.getByLabel('Your draft slot', { exact: true }).fill('3');
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /^Save league$/i }).click();

    await page.goto('/draft');
    await page.getByRole('button', { name: 'Follow', exact: true }).click();

    // Both picks arrive without a single tap, and the clock advances to
    // pick 3 — which is ours.
    await expect(page.getByText(/2 picks synced/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/pick 3/i).first()).toBeVisible();
  });


  test('the war room applies ESPN picks, and halts honestly on an unknown player', async ({
    page,
  }) => {
    // First response: one pick, by a player id the fixture board cannot know.
    await page.route(ESPN_LEAGUE, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          leagueBody([{ overallPickNumber: 1, playerId: 999001, teamId: 4 }]),
        ),
      }),
    );

    await buildBoard(page);
    await page.getByLabel('Your draft slot', { exact: true }).fill('3');
    await page.getByPlaceholder('e.g. 1234567').fill('1234567');
    await page.getByRole('button', { name: /^Save league$/i }).click();

    await page.goto('/draft');
    await expect(page.getByRole('heading', { name: 'Draft War Room' })).toBeVisible();

    // The panel only exists because a league id is saved.
    await expect(page.getByText('Follow ESPN draft')).toBeVisible();
    await page.getByRole('button', { name: 'Follow', exact: true }).click();

    // Fixture players carry no ESPN ids, so the sync must halt at pick 1 with
    // instructions — not guess, not crash, not silently skip.
    await expect(page.getByText(/pick 1 is a player not on your board/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Record that pick manually/i)).toBeVisible();
  });
});
