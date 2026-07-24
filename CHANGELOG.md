# Changelog

All notable changes to Fantasy Coach. Newest first.

## [Unreleased]

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
