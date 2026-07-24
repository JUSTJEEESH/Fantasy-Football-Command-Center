# Changelog

All notable changes to Fantasy Coach. Newest first.

## [Unreleased]

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
