# FANTASY COACH — TODO

**Draft day: 2026-08-30.** Everything P0 must work by then. Updated after every milestone.

Legend: `[x]` done & tested · `[~]` partial · `[ ]` not started · `[!]` blocked

**Status: the P0 draft path is built and verified end to end**, including with the
network switched off. 308 unit tests + 15 browser tests passing.

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
- [ ] Ingestion writer (`pnpm ingest`) persisting to Postgres
- [ ] Trend detection over the ADP/ranking time series
- [ ] Scheduled ingestion (cron route)

## Phase 8 — Coach layer ✅
- [x] Intent router: 24 intents, NL variants, conversational context
- [x] Manual draft entry / undo / correction parsing
- [x] Deterministic response formatting with claim tagging
- [x] LLM narration with structured output + invented-number rejection
- [x] Rolling AI budget cap, degrading to template prose
- [ ] Persist `ai_decisions` audit rows (schema exists, writer not wired)

## Phase 9 — UI ✅
- [x] Dark, mobile-first PWA shell + manifest + bottom nav
- [x] Draft War Room, fully offline
- [x] Home readiness screen, Players board, My Team, News, Settings wizard
- [x] CSV import in-browser (file never uploaded)
- [x] Voice input (Web Speech API, degrades to text)
- [x] Draft board persistence across reload / phone lock
- [ ] Desktop three-column war room layout (mobile layout works everywhere today)
- [ ] Service worker for full offline asset caching

## Phase 10–11 — Testing & deploy
- [x] 308 unit tests
- [x] 15 Playwright browser tests at iPhone dimensions, incl. offline draft
- [ ] Deployment docs (Vercel + Supabase)
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
| **ADP data** | Draft Mode's advice quality depends on it entirely | Export a CSV from FantasyPros/Sleeper/ESPN → Settings → Import |
| **Live egress** | Sandbox blocks all data hosts, so adapters are fixture-tested only | Run `pnpm doctor` locally |
| **League details** | Scoring, teams, draft slot drive every recommendation | Settings → league wizard |
| **Projections** | Without them, points are estimated from ADP (labelled as such) | Import a projections CSV, or accept the estimate |
| `ANTHROPIC_API_KEY` | Only affects wording, never advice | Optional |
