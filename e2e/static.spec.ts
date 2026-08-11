import { test, expect } from '@playwright/test';
const ADP_CSV = ['Rank,Player,Team,POS,AVG,Std Dev',
'1,Alpha Back,TEN,RB1,1.4,0.6','2,Bravo Receiver,PHI,WR1,2.8,1.1','3,Charlie Back,ATL,RB2,3.5,1.2',
'4,Delta Receiver,CIN,WR2,4.9,1.5','5,Echo Back,SF,RB3,6.2,2.0','6,Foxtrot Receiver,MIA,WR3,7.1,2.2',
'7,Golf End,KC,TE1,9.4,2.8','8,Hotel Passer,BUF,QB1,24.0,6.0','9,India Back,DET,RB4,11.2,3.0',
'10,Juliet Receiver,LV,WR4,12.8,3.4','11,Kilo Back,GB,RB5,15.1,4.0','12,Lima Receiver,SEA,WR5,16.4,4.2',
'13,Yankee Kicker,BAL,K1,150.0,12.0','14,Zulu Defense,PIT,DST1,145.0,12.0'].join('\n');

// Served exactly as GitHub Pages will: under a /<repo>/ sub-path.
const SITE = 'http://localhost:3222/Fantasy-Football-Command-Center';
test.use({ viewport: { width: 390, height: 844 } });

test('static build: full draft flow works', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });

  await page.goto(`${SITE}/settings/`);
  await page.getByRole('button', { name: 'Load Bay Islands Fantasy' }).click();
  await expect(page.getByText(/post-party rules/)).toBeVisible();
  await page.getByLabel('Your draft slot', { exact: true }).fill('7');
  await page.setInputFiles('input[type="file"] >> nth=0', { name:'adp.csv', mimeType:'text/csv', buffer: Buffer.from(ADP_CSV) });
  await expect(page.getByText(/Imported 14 players/)).toBeVisible();

  await page.goto(`${SITE}/draft/`);
  await expect(page.getByText('Draft War Room')).toBeVisible();
  await expect(page.locator('h2').first()).not.toBeEmpty();

  // Record a pick, offline.
  await context.setOffline(true);
  await page.getByLabel('Ask Coach').fill('Alpha Back drafted');
  await page.getByLabel('Send').click();
  await expect(page.getByText('Team 1')).toBeVisible();
  await page.getByRole('button', { name: 'Why?' }).click();
  await expect(page.getByRole('heading', { name: /^Why / })).toBeVisible();
  await context.setOffline(false);

  // Slot planner
  await page.goto(`${SITE}/draft/slots/`);
  await expect(page.getByRole('heading', { name: 'Slot planner' })).toBeVisible();
  // The zero-TE warning must be GONE: the league voted a mandatory TE in on
  // 2026-08-08, and stale strategy text would now be coaching the wrong draft.
  await expect(page.getByText(/starts ZERO tight ends/)).toHaveCount(0);

  // The feed is populated from data baked in at build time.
  await page.goto(`${SITE}/news/`);
  await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeVisible();
  await expect(page.getByText(/merged into \d+ events/)).toBeVisible();
  await expect(page.getByText('Needs your attention')).toBeVisible();

  // Navigation between pages. The player board is reached from Home rather
  // than from the tab bar — five tabs is the limit before the targets get too
  // small for a thumb, and Plan earned one of them.
  await page.getByRole('link', { name: /Plan/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Draft plan' })).toBeVisible();

  await page.goto(`${SITE}/`);
  await page.getByRole('link', { name: /Player board/ }).click();
  await expect(page.getByRole('heading', { name: 'Player board' })).toBeVisible();

  // Resource failures during the deliberate offline segment are expected — the
  // point of that segment is that the app keeps working without the network.
  // What must be empty is genuine script errors.
  const realErrors = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(e),
  );
  expect(realErrors).toEqual([]);
});
