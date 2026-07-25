# FANTASY COACH — TODO

**Draft day: 2026-08-30.** Everything P0 must work by then. Updated after every milestone.

Legend: `[x]` done & tested · `[~]` partial · `[ ]` not started · `[!]` blocked

**Status: the P0 draft path is built and verified end to end**, including with the
network switched off. 520 unit/integration tests + 52 browser tests passing.

Real ADP, real projections and real bye weeks now ship in the build — the board
no longer needs a CSV to exist. Verified against the live deployment: 600
players, 515 with ESPN ADP, 358 with ESPN projections re-scored under Bay
Islands rules, 600 with bye weeks, all six positions present.

`pnpm rehearse` drafts all twelve seats against the deployed pack. Latest run:
all twelve rosters legal and startable.

**Your league (Bay Islands Fantasy) is encoded exactly** — scoring, roster,
position caps, 15 rounds. Load it in Settings with one tap. Draft slot is left
blank until your Aug 8 party; the slot planner has a plan for all twelve seats
in the meantime.

---

## Phase 0 — Discovery ✅
- [x] Inspect environment (Node 22, pnpm 10, PG 16, Docker)
- [x] Probe egress policy — **all fantasy data hosts blocked in sandbox**
- [x] Start local Postgres, create `fantasy_coach` dev DB

## Phase 1–2 — Architecture & PRD ✅
- [x] `ARCHITECTURE.md`, `PRD.md`, `.env.example`, `.gitignore`, `CHANGELOG.md`
- [x] Scaffold: Next.js 16, React 19, strict TS, Tailwind, Vitest, Playwright

## Phase 3 — Database ✅
- [x] 31-table schema with provenance columns on every fact table
- [x] Append-only ADP/rankings time series
- [x] Migration runner (`pnpm db:migrate`), verified idempotent against local PG
- [ ] Seed script with realistic dev data (`pnpm db:seed`)

## Phase 6 — Deterministic engine ✅
- [x] Scoring: data-driven, custom rules are config not code
- [x] Replacement level + value over replacement
- [x] Tiering (local-median gap detection)
- [x] Positional scarcity (binomial tier-exhaustion model)
- [x] Draft value score with named, auditable components
- [x] Roster fit, marginal lineup value, needs, bye conflicts
- [x] Run detection (rate-relative, not raw counts)
- [x] Availability simulation with stated assumptions
- [x] Unit tests for all of the above

## Phase 7 — Draft Mode ✅
- [x] Snake/linear pick math
- [x] Board reducer: record / undo / correct, never mutating prior state
- [x] Recommendation engine: 6 flavors, confidence, reasons, avoid list
- [x] Reach-or-wait verdict
- [x] 12-team mock draft simulation across seeds and draft slots

## Phase 4–5 — Data & news ✅ (code) / ⚠️ (live verification)
- [x] Source adapter interfaces + registry shape
- [x] Sleeper adapter (players, league, rosters, live draft picks)
- [x] CSV import (ADP / rankings / projections) — the guaranteed path
- [x] RSS news adapter (RSS 2.0 + Atom)
- [x] Dedup → canonical event, preserving all attribution
- [x] Classification + fantasy impact score + confidence
- [x] Player linking that refuses ambiguous matches
- [x] `pnpm doctor` live connectivity + parser-sanity check
- [!] **Live verification of Sleeper + RSS adapters** — blocked by sandbox egress.
      Run `pnpm doctor` on your own machine; it does the real requests.
- [x] Ingestion writer (`pnpm ingest`) persisting to Postgres, verified against local PG
- [x] Build-time data pack: real players + real news baked into the static
      deployment, rebuilt every 3 hours by a scheduled workflow
- [x] News feed UI: impact-ordered, attributed, with the reasoning shown
- [x] Home briefing populated from the same data
- [x] ESPN adapter: real ADP, PPR draft ranks, season projections and bye weeks,
      with the undocumented stat-id mapping re-verified against ESPN's own point
      totals on every build
- [x] Feeds fall back through alternate URLs; an empty parse counts as a failure
      instead of a silent success (this is what hid the dead ESPN feed)
- [x] Repeated coverage of one player groups behind a lead story
- [x] News items carry board context (ADP, tier, in reach / gone / yours)
- [x] "My board" filter actually filters to your board
- [x] Surname linking refuses a match preceded by another person's first name
- [x] Draft plan page: rules, deadlines, positional mispricing, targets, fades,
      bye stacks
- [x] Market analysis with real ADP and real projections only
- [x] Bay Islands is the default league — no way to build a board under the
      wrong rules by accident
- [x] ESPN league link: draft-order import + live pick-following in the war
      room, matching by ESPN player id. Requires the league set to publicly
      viewable; Test Connection verifies CORS from the real browser.
- [x] Private-league paste path: draft order and live picks via copy-paste from
      the user's own logged-in tab — no visibility change, no credentials
- [ ] Try the paste flow against the real league (open the link from Settings
      while logged in to ESPN, paste, confirm the order imports)
- [x] Briefing leads with news about players in your draft range, ADP-stamped
- [x] ADP trend series: each deploy snapshots daily ADP and republishes the
      history; plan page shows week-over-week market movers once 3+ days accrue
- [x] ESPN's NFL RSS confirmed retired (all three endpoints: HTTP 200, zero
      items). Replaced with NFL.com; RotoWire added as a fantasy-specific wire.
- [x] NFL.com's feed 404s on both endpoints — removed. Four confirmed-working
      feeds remain (CBS, Yahoo, ProFootballTalk, RotoWire).
- [ ] Find a fifth feed. Needs a URL that can only be verified by deploying,
      so it is worth batching with other work rather than guessing in isolation.

## Phase 8 — Coach layer ✅
- [x] Intent router: 24 intents, NL variants, conversational context
- [x] Manual draft entry / undo / correction parsing
- [x] Deterministic response formatting with claim tagging
- [x] LLM narration with structured output + invented-number rejection
- [x] Rolling AI budget cap, degrading to template prose
- [ ] Persist `ai_decisions` audit rows (schema exists, writer not wired)

## Your league ✅
- [x] Bay Islands scoring encoded exactly (6pt pass TD, 1/20 pass yds, -1 INT
      and fumble, 100yd rush bonus, ESPN DST ladder, no FG-miss penalty)
- [x] Roster: 8 starters / 7 bench / 15 total, **zero required TE**
- [x] Position maximums enforced as hard caps (QB 4, RB 8, WR 8, TE 3, K 3, DST 3)
- [x] Draft slot may be left unset until the order is drawn on Aug 8
- [x] Slot planner: simulated draft and plan for all 12 seats
- [x] Slot-agnostic positional landscape (what's true regardless of your seat)
- [ ] Re-run the planner after your final ADP refresh, closer to Aug 30

## Phase 9 — UI ✅
- [x] Dark, mobile-first PWA shell + manifest + bottom nav
- [x] Draft War Room, fully offline
- [x] Home readiness screen, Players board, My Team, News, Settings wizard
- [x] CSV import in-browser (file never uploaded)
- [x] One-tap draft pack from the shipped board — no spreadsheet required
- [x] Voice input (Web Speech API, degrades to text)
- [x] Draft board persistence across reload / phone lock
- [ ] Desktop three-column war room layout (mobile layout works everywhere today)
- [ ] Service worker for full offline asset caching

## Phase 10–11 — Testing & deploy
- [x] 405 unit + integration tests (integration tests exercise the real SQL)
- [x] 32 Playwright browser tests, incl. offline draft and the live news feed
- [ ] Deployment docs (Vercel + Supabase)
- [x] `pnpm rehearse` — full 15-round draft, all twelve seats, against the
      deployed pack. Caught two bugs 405 passing tests did not.
- [ ] Airplane-mode rehearsal on a real phone

---

## Not built (deliberately deferred past draft day)

Waiver wire · start/sit · trade analyzer · dynasty/keeper logic · auction drafts ·
multi-user auth · push notifications. The schema and adapter boundaries anticipate
all of them; none is needed for August 30.

---

## Blocked / needs you

| What | Why it matters | Action |
| --- | --- | --- |
| ~~**ADP data**~~ | ~~Draft Mode's advice quality depends on it entirely~~ | **Done** — ESPN ADP is fetched every build. Settings → *Use the shipped player board*. CSV import still overrides it. |
| **Live egress** | Sandbox blocks all data hosts, so adapters are fixture-tested only | Run `pnpm doctor` locally |
| **Draft slot** | The board cannot be built without it | After Aug 8: Settings → ESPN league → Test connection → tap your team. (Manual entry still works.) |
| ~~**Projections**~~ | ~~Without them, points are estimated from ADP~~ | **Done** — ESPN season projections, re-scored under Bay Islands rules. Yardage bonuses are excluded and labelled. |
| `ANTHROPIC_API_KEY` | Only affects wording, never advice | Optional |
