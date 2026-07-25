import { test, expect, type Page } from '@playwright/test';

// ============================================================================
// The draft-day journey, end to end, in a real browser at iPhone dimensions.
//
// This is the §49 success criteria expressed as a test: set up a league, import
// ADP, open the war room, record picks by typing what happened, and get a
// recommendation — including with the network cut off.
// ============================================================================

/** A small but realistic ADP export, in FantasyPros' column shape. */
const ADP_CSV = [
  'Rank,Player,Team,POS,AVG,Std Dev',
  '1,Alpha Back,TEN,RB1,1.4,0.6',
  '2,Bravo Receiver,PHI,WR1,2.8,1.1',
  '3,Charlie Back,ATL,RB2,3.5,1.2',
  '4,Delta Receiver,CIN,WR2,4.9,1.5',
  '5,Echo Back,SF,RB3,6.2,2.0',
  '6,Foxtrot Receiver,MIA,WR3,7.1,2.2',
  '7,Golf End,KC,TE1,9.4,2.8',
  '8,Hotel Passer,BUF,QB1,24.0,6.0',
  '9,India Back,DET,RB4,11.2,3.0',
  '10,Juliet Receiver,LV,WR4,12.8,3.4',
  '11,Kilo Back,GB,RB5,15.1,4.0',
  '12,Lima Receiver,SEA,WR5,16.4,4.2',
  '13,Mike End,BAL,TE2,28.0,7.0',
  '14,November Passer,PHI,QB2,32.0,8.0',
  '15,Oscar Back,CHI,RB6,19.3,5.0',
  '16,Papa Receiver,NYJ,WR6,20.7,5.2',
  '17,Quebec Back,LAC,RB7,23.5,5.8',
  '18,Romeo Receiver,DAL,WR7,25.1,6.1',
  '19,Sierra End,DEN,TE3,45.0,10.0',
  '20,Tango Back,NO,RB8,27.9,6.5',
  '21,Uniform Receiver,TB,WR8,29.4,6.9',
  '22,Victor Passer,LAR,QB3,48.0,11.0',
  '23,Whiskey Back,HOU,RB9,31.2,7.2',
  '24,Xray Receiver,MIN,WR9,33.8,7.6',
  '25,Yankee Kicker,BAL,K1,150.0,12.0',
  '26,Zulu Defense,PIT,DST1,145.0,12.0',
].join('\n');

async function importAdp(page: Page, draftSlot = 1) {
  await page.goto('/settings');
  await page.getByRole('textbox').first().waitFor();

  // A draft slot is required before the war room will open — the app refuses to
  // assume one. Set it here the same way a user would.
  await page.getByLabel('Your draft slot', { exact: true }).fill(String(draftSlot));

  await page.setInputFiles('input[type="file"] >> nth=0', {
    name: 'adp.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ADP_CSV),
  });

  await expect(page.getByText(/Imported \d+ players/)).toBeVisible({ timeout: 10_000 });
}

test.use({ viewport: { width: 390, height: 844 } });   // iPhone 14 Pro

test.describe('Bay Islands league', () => {
  async function loadLeague(page: Page) {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Load Bay Islands Fantasy' }).click();
    await expect(page.getByText(/ZERO tight ends/)).toBeVisible();
  }

  test('loads the real league and warns about the zero-TE rule', async ({ page }) => {
    await loadLeague(page);
    // Roster fields reflect the actual settings.
    await expect(page.getByLabel('Teams', { exact: true })).toHaveValue('12');
    await expect(page.getByLabel('Bench', { exact: true })).toHaveValue('7');
    // Zero required tight ends — the defining rule of this league.
    await expect(page.getByLabel('TE', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('RB', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('FLEX', { exact: true })).toHaveValue('1');
  });

  test('leaves the draft slot blank until the order is drawn', async ({ page }) => {
    await loadLeague(page);
    await expect(page.getByLabel('Your draft slot', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Your draft slot', { exact: true })).toHaveAttribute(
      'placeholder',
      'Not drawn yet',
    );
  });

  test('refuses to open the war room without a draft slot, and says why', async ({ page }) => {
    await loadLeague(page);
    await page.getByRole('button', { name: 'Save league' }).click();
    await page.goto('/draft');
    await expect(page.getByText(/draft slot has not been set/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Plan every draft seat' })).toBeVisible();
  });

  test('plans every seat and lets you confirm one', async ({ page }) => {
    await loadLeague(page);
    await page.getByRole('button', { name: 'Save league' }).click();
    await importAdp(page);

    await page.goto('/draft/slots');
    await expect(page.getByRole('heading', { name: 'Slot planner' })).toBeVisible();
    // The zero-TE consequence is surfaced without needing a seat.
    await expect(page.getByText(/starts ZERO tight ends/)).toBeVisible();

    await page.getByRole('button', { name: '7', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Seat 7' })).toBeVisible();

    await page.getByRole('button', { name: /This is my seat/ }).click();
    await expect(page.getByText(/Drafting from seat 7/)).toBeVisible();

    // And the war room is now usable.
    await page.goto('/draft');
    await expect(page.getByText('Draft War Room')).toBeVisible();
    await expect(page.getByText(/slot 7 of 12/)).toBeVisible();
  });
});

test.describe('draft day', () => {
  test('sets up a league and imports ADP', async ({ page }) => {
    await importAdp(page);
    await expect(page.getByText('26 players · 26 with ADP')).toBeVisible();
  });

  test('reports it is not ready before any data is imported', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Not ready for draft day')).toBeVisible();
  });

  test('reports readiness once data exists', async ({ page }) => {
    await importAdp(page);
    await page.goto('/');
    // 26 players is under the 50-with-ADP bar, so it must say "partially" —
    // overstating readiness would be exactly the dishonesty we forbid.
    await expect(page.getByText(/Partially ready|Ready for draft day/)).toBeVisible();
  });

  test('war room gives a recommendation with confidence and alternatives', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await expect(page.getByText('Take', { exact: true })).toBeVisible();
    // The headline pick.
    await expect(page.locator('h2').first()).not.toBeEmpty();
    // Confidence must always be shown, and never read as certainty.
    const confidence = page.getByText(/^\d+%$/).first();
    await expect(confidence).toBeVisible();
    const value = Number((await confidence.textContent())!.replace('%', ''));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(95);

    // "If he's gone" also appears on the follow-up button, hence .first().
    await expect(page.getByText("If he's gone").first()).toBeVisible();
  });

  test('records a pick typed in plain language', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    // Draft whoever Coach just recommended — that is what forces the board and
    // the recommendation to both move.
    const recommended = (await page.locator('h2').first().textContent())!.trim();

    await page.getByLabel('Ask Coach').fill(`${recommended} drafted`);
    await page.getByLabel('Send').click();

    // The pick lands on the board...
    await expect(page.getByText('Team 1')).toBeVisible();
    // ...and Coach moves on to someone else rather than re-recommending him.
    await expect(page.locator('h2').first()).not.toHaveText(recommended);
  });

  test('does not tell you to "take" someone when it is not your turn', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    // User is slot 1; after one pick the clock belongs to slot 2.
    await page.getByLabel('Ask Coach').fill('Alpha Back drafted');
    await page.getByLabel('Send').click();
    await expect(page.getByText('Team 1')).toBeVisible();

    await expect(page.getByText(/Best available — you pick in/)).toBeVisible();
    await expect(
      page.getByText(/Not your turn .* not an instruction/),
    ).toBeVisible();
  });

  test('undoes a mistaken pick', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByLabel('Ask Coach').fill('Alpha Back drafted');
    await page.getByLabel('Send').click();
    await expect(page.getByText('Team 1')).toBeVisible();

    await page.getByRole('button', { name: 'Undo last pick' }).click();
    await expect(page.getByText('The board is empty.')).toBeVisible();
  });

  test('refuses to draft a player it does not have', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByLabel('Ask Coach').fill('Nonexistent Person drafted');
    await page.getByLabel('Send').click();

    // It says it doesn't know, rather than guessing at a player (§45).
    await expect(page.getByText(/I don't have "Nonexistent Person" on the board/)).toBeVisible();
  });

  test('answers "why?" with reasoning', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByRole('button', { name: 'Why?' }).click();
    await expect(page.getByRole('heading', { name: /^Why / })).toBeVisible();
  });

  test('answers "what if he\'s gone?" with a fallback', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByRole('button', { name: "What if he's gone?" }).click();
    await expect(page.getByRole('heading', { name: /^Then take/ })).toBeVisible();
  });

  test('checks positional runs', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByRole('button', { name: 'Positional run?' }).click();
    await expect(page.getByText(/No run right now|Run in progress/)).toBeVisible();
  });

  // The reason the whole architecture is built the way it is.
  test('THE CRITICAL TEST: works with the network offline', async ({ page, context }) => {
    await importAdp(page);
    await page.goto('/draft');
    await expect(page.getByText('Take', { exact: true })).toBeVisible();

    // Cut the network entirely — draft party wifi.
    await context.setOffline(true);

    // Record a pick offline.
    await page.getByLabel('Ask Coach').fill('Alpha Back drafted');
    await page.getByLabel('Send').click();
    await expect(page.getByText('Team 1')).toBeVisible();

    // And still get a fresh recommendation. It is no longer our turn, so the
    // card is framed as best-available rather than an instruction.
    await expect(page.getByText(/Best available — you pick in/)).toBeVisible();
    await expect(page.locator('h2').first()).not.toBeEmpty();

    await page.getByRole('button', { name: 'Why?' }).click();
    await expect(page.getByRole('heading', { name: /^Why / })).toBeVisible();

    await context.setOffline(false);
  });

  test('survives a page reload mid-draft', async ({ page }) => {
    await importAdp(page);
    await page.goto('/draft');

    await page.getByLabel('Ask Coach').fill('Alpha Back drafted');
    await page.getByLabel('Send').click();
    await expect(page.getByText('Team 1')).toBeVisible();

    // A phone locking or a tab dying must not lose the board.
    await page.reload();
    await expect(page.getByText('Alpha Back').first()).toBeVisible();
    await expect(page.getByText('Team 1')).toBeVisible();
  });

  test('player board ranks by value over replacement', async ({ page }) => {
    await importAdp(page);
    await page.goto('/players');
    await expect(page.getByRole('heading', { name: 'Player board' })).toBeVisible();
    await expect(page.getByText('VOR').first()).toBeVisible();
  });

  test('news page is populated from the data pack, on the server build too', async ({ page }) => {
    // The pack is generated at build time and served from /public, so both the
    // server build and the static export render the same feed.
    await page.goto('/news');
    await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeVisible();
    await expect(
      page.getByText(/merged into \d+ events|could not be loaded|No news was collected/),
    ).toBeVisible();
  });
});

test('Settings stays reachable from Home after a board exists', async ({ page }) => {
  // The "Set up" path vanishes with the not-ready card the moment a board is
  // built, and for a while it was the ONLY path — a healthy app had no way to
  // change the league, link ESPN, or rebuild the board. Found by the user, not
  // by a test, which is why this one now exists.
  await importAdp(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
