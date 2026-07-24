# Changelog

All notable changes to Fantasy Coach. Newest first.

## [Unreleased]

### 2026-07-24 — Deployed to GitHub Pages

**Added**
- Static export build (`pnpm build:static`) and a GitHub Actions workflow that
  tests, builds and publishes to GitHub Pages on every push to `main`. The site
  is only deployed if the whole suite passes first.
- `pnpm preview:static` — a dependency-free server that serves the export under
  its real `/<repo>/` sub-path, because serving it from the domain root hides
  precisely the bugs that break a Pages deployment.
- CI runs the browser suite against **both** deployments — the server build and
  the static export — so a Pages-specific breakage cannot pass as green.
- CI spins up a real Postgres so the integration tests exercise actual SQL.

**Fixed** (all three would have shipped a broken or blank site)
- No `.nojekyll`: GitHub Pages runs Jekyll by default, which silently ignores
  directories beginning with an underscore. That would have stripped `_next/`
  and served nothing but 404s, with no error explaining why.
- The web app manifest and its icon pointed at `/`, which resolves outside the
  project sub-path — the installed app would have loaded no icon and launched
  to the wrong URL. The manifest is now generated with the base path applied.
- The CI config built both bundles concurrently into the same `.next`
  directory. They clobbered each other and produced a server build that started
  cleanly and then misbehaved. The builds are now explicitly sequenced, static
  first, so `.next` is left in the state `pnpm start` expects.

**Note**
- The news feed needs a server and a database, so it is unavailable on the
  static deployment and says exactly that rather than rendering an empty list.

### 2026-07-24 — Bay Islands Fantasy encoded, and slot planning

**Added**
- `src/lib/leagues/bay-islands.ts` — the real league, transcribed from the ESPN
  settings page. Four scoring rules differ from a standard PPR preset and each
  moves value: passing TDs pay 6 rather than 4, passing yards are 1 per 20,
  interceptions and lost fumbles cost 1 rather than 2, and a 100-199 yard
  rushing game pays a 3-point bonus. Kickers have no penalty for a missed field
  goal, and the defense points-allowed ladder tops out at 5 with no negative
  brackets.
- **The league requires zero starting tight ends.** A TE can only reach the
  lineup through the single FLEX spot, against every RB and WR on the roster.
  The engine derives the consequence on its own — replacement level at TE lands
  around TE2, so nearly every tight end in the pool sits below it — and the app
  states it in words in the positional landscape.
- Position maximums (QB 4, RB 8, WR 8, TE 3, K 3, DST 3) enforced as hard caps.
  A capped position is excluded from consideration entirely, because that pick
  could not legally be made.
- `draftSlot` may now be null. The order is drawn manually at the Aug 8 party,
  and the app refuses to assume a seat rather than quietly defaulting to one.
- **Slot planner** (`/draft/slots`): simulates a full 15-round draft from each
  of the twelve seats, showing the picks that seat owns, its longest wait, its
  opening picks, who is realistically available at its first pick, and the
  roster shape it produces. Confirming a seat configures the war room.
- Slot-agnostic positional landscape: the scarcity facts that follow from the
  league's rules and the player pool rather than from where you pick.

**Fixed**
- CSV import generated player ids from the normalized search key, which strips
  digits, suffixes and punctuation. Two players who normalize to the same name —
  the NFL has repeatedly had two active Mike Williamses — collided into one
  board entry, silently corrupting every roster count downstream. Ids are now
  guaranteed unique.
- The settings form defaulted the draft slot to 1, so loading a league preset
  silently kept a seat the user was never assigned.

### 2026-07-24 — Phases 3–9: engine, adapters, Coach layer, and the war room

**Added**
- **Database**: 31-table Postgres/Supabase schema. Provenance columns
  (`source_timestamp`, `fetched_at`) on every fact table; ADP and rankings kept as
  append-only time series so movement is a query rather than a guess. Migration
  runner verified idempotent against local PostgreSQL 16.
- **Deterministic engine** (pure TypeScript, no I/O, runs identically on server and in
  the browser): configurable scoring, replacement level and VOR, tiering, positional
  scarcity, draft value scoring, roster fit, run detection, availability simulation,
  and the recommendation engine with six flavors, confidence, and reasons.
- **Source adapters**: Sleeper (players, league, rosters, live draft picks — free, no
  key), CSV import for ADP/rankings/projections, and RSS news. All behind one
  interface so a source can be added or dropped without touching the engine.
- **News intelligence**: fingerprint + similarity deduplication preserving every
  original attribution, deterministic classification with a fantasy impact score, and
  player linking that declines ambiguous matches rather than guessing.
- **Coach layer**: deterministic intent router (24 intents, conversational context for
  "why?" / "what if he's gone?" / "and after that?"), manual draft entry and
  correction parsing, response formatting with claim tagging, and an optional LLM
  narration layer that can reword a decision but never change it.
- **PWA**: dark, mobile-first app with the Draft War Room, Home readiness screen,
  player board, roster analysis, news, and a league setup wizard with in-browser CSV
  import. Voice input via Web Speech API, degrading silently to text.
- **Offline draft pack**: the entire draft path runs from a local snapshot. Verified
  in a real browser with the network switched off.
- `pnpm doctor` — live connectivity and parser-sanity check to run where egress works.
- 308 unit tests and 15 Playwright browser tests at iPhone dimensions.

**Fixed** (each found by a test, not by inspection)
- Tiering used a position-wide mean gap, which made every elite player his own tier;
  now compares against a local median so a gap is judged against its part of the curve.
- Scarcity urgency saturated through `min(1, ratio)` and stopped discriminating; now a
  binomial tier-exhaustion probability multiplied by the cliff cost, so a tier break
  with no drop-off is correctly not urgent.
- The roster-fit multiplier inverted on negative scores, promoting penalized kickers
  once value over replacement went negative in the late rounds.
- Marginal lineup value was measured against an empty slot, making a kicker look worth
  +150 points mid-draft; it is now measured against replacement-level fillers, which is
  the real counterfactual.
- The engine could finish a draft with no starting quarterback; added an endgame
  must-fill constraint with a tighter threshold for K/DST.
- Identical headlines republished months apart merged into one news event, because the
  fingerprint gate ran before the time-window check.
- Intent patterns rejected plurals ("injuries", "sleepers"), and "what if he's gone?"
  routed to MARK_DRAFTED on the word "gone".
- **`Infinity` in the DST points-allowed tiers became `null` under `JSON.stringify`**,
  so every saved draft pack failed validation on reload and the war room silently
  reported "no draft pack loaded". This would have broken draft day. Pack loading now
  reports why it rejected a pack instead of failing silently.
- The war room said "TAKE" even when it was not the user's turn; it now frames the card
  as best-available and says so plainly.

### 2026-07-24 — Phase 0–2: discovery, architecture, product definition

**Added**
- Phase 0 environment discovery: Node 22.22.2, pnpm 10.33.0, PostgreSQL 16.13 (started
  locally, dev DB `fantasy_coach` created), Docker 29.3.1. Repo was empty — nothing overwritten.
- `ARCHITECTURE.md` — stack rationale, system topology, draft-day data flow, AI split
  (deterministic engine vs LLM narration), DB design, source availability/legal table,
  reliability + security posture, deployment.
- `PRD.md` — product promise, epistemics (FACT/REPORT/INFERENCE/RECOMMENDATION/UNCERTAINTY),
  P0–P3 feature set, draft-night flow, command surface, success criteria, milestone plan.
- `.env.example` — every credential documented with what it unlocks and what breaks without it.
- Project scaffold: Next.js 16 + React 19 + TypeScript (strict, `noUncheckedIndexedAccess`),
  Tailwind, Vitest, `pg`, Zod, Anthropic SDK.

**Documented limitation (important)**
- The build sandbox's egress policy blocks every fantasy data host (`api.sleeper.app`,
  `site.api.espn.com`, `fantasypros.com`, `rotowire.com`, `static.nfl.com`,
  `pro-football-reference.com` — all 403 at CONNECT). Live ingestion **cannot be verified
  from here**. Adapters are therefore written against documented wire formats and tested
  against recorded fixtures; `pnpm doctor` performs the live check on the user's own machine
  or on deployment. No adapter is claimed working until that check passes.
