# FANTASY COACH — TODO

**Draft day: 2026-08-30.** Everything P0 must work by then. Updated after every milestone.

Legend: `[x]` done & tested · `[~]` partial · `[ ]` not started · `[!]` blocked

---

## Phase 0 — Discovery ✅
- [x] Inspect environment (Node 22, pnpm 10, PG 16, Docker)
- [x] Probe egress policy — **all fantasy data hosts blocked in sandbox** (see CHANGELOG)
- [x] Start local Postgres, create `fantasy_coach` dev DB

## Phase 1–2 — Architecture & PRD ✅
- [x] `ARCHITECTURE.md`
- [x] `PRD.md`
- [x] `.env.example`
- [x] `.gitignore` (blocks `.env*`)
- [x] `CHANGELOG.md`
- [x] Project scaffold + toolchain

## Phase 3 — Database
- [ ] SQL migrations for all tables
- [ ] Migration runner (`pnpm db:migrate`)
- [ ] Indexes for hot paths
- [ ] Seed script with realistic dev data (`pnpm db:seed`)
- [ ] Verify against local Postgres

## Phase 6 — Deterministic engine (P0 core)
- [ ] Scoring config + projection→points
- [ ] Replacement level / VOR
- [ ] Tiers
- [ ] Positional scarcity
- [ ] Draft value score
- [ ] Roster fit / needs
- [ ] Run detection
- [ ] Availability simulation
- [ ] Unit tests for all of the above

## Phase 7 — Draft Mode (highest priority)
- [ ] Snake order + pick math
- [ ] Board reducer: pick / undo / correction
- [ ] Recommendation engine (6 flavors + confidence + reasons)
- [ ] Reach-or-wait verdict
- [ ] 12-team mock draft simulation test

## Phase 4–5 — Data & news
- [ ] Source registry
- [ ] Sleeper adapter (players, league, live draft)
- [ ] CSV import (ADP/rankings) — the guaranteed path
- [ ] RSS news adapter
- [ ] Dedup → canonical event
- [ ] Classification + fantasy impact score
- [ ] Player linking
- [ ] Trend detection
- [ ] `pnpm doctor` live connectivity check
- [!] Live verification of every adapter — **blocked in sandbox, must run on user's machine**

## Phase 8 — Coach layer
- [ ] Intent router + NL variants
- [ ] Conversational context
- [ ] LLM narration w/ structured output + template fallback
- [ ] AI decision audit log + cost tracking

## Phase 9 — UI
- [ ] App shell, dark, mobile-first, PWA
- [ ] Draft War Room (mobile + desktop layouts)
- [ ] Home / News / Players / Rankings / My Team / Watchlist / Settings
- [ ] League setup wizard
- [ ] Voice input
- [ ] Offline draft pack

## Phase 10–11 — Testing & deploy
- [ ] Full test suite green
- [ ] Airplane-mode draft rehearsal on a phone
- [ ] Deployment docs (Vercel + Supabase)

---

## Blocked / needs the user

| What | Why it matters | Action |
| --- | --- | --- |
| Live egress | Sandbox blocks all data hosts; adapters unverified against live endpoints | Run `pnpm doctor` locally |
| League details | Scoring, teams, draft slot drive every recommendation | Fill in the setup wizard |
| ADP source | No free terms-clean API | Export a CSV (FantasyPros/Sleeper/ESPN) or add `FANTASYPROS_API_KEY` |
| `ANTHROPIC_API_KEY` | Enables conversational prose (advice works without it) | Optional |
