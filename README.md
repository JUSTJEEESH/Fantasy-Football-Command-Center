# Fantasy Coach

A personal AI fantasy football analyst, draft assistant, and news engine.

Open the app, say **"Coach."** It's ready.

> **Built for one deadline: a draft on 2026-08-30.** The draft path is finished
> and verified end to end — including with the network switched off.

---

## What it does

Ask it what to do, in plain language, typed or spoken:

```
"Coach, who's my pick?"

  TAKE: BREECE HALL                             Confidence 88%

  Last back in tier 2 — the next RB is a full tier down, and 6 of the
  11 picks before your next turn are RB-needy.

  If he's gone → 2. Puka Nacua   3. Kyle Pitts
  Avoid        → Player D (ankle, Friday report)
  Verdict      → Take him now

"why?"  ·  "what if he's gone?"  ·  "and after that?"  ·  "can I wait?"
"Player X drafted"  ·  "undo"  ·  "correction: team 4 took A, not Z"
```

It knows your league, your scoring, your draft slot, your roster, who's been
taken, current ADP, tiers, and positional scarcity — and it answers in about a
millisecond, with no network.

## Three things that make it trustworthy

**The engine picks; the AI only talks.** Rankings, value over replacement,
scarcity, availability probability, and the actual recommendation are computed
in plain TypeScript. The language model receives a decision that has already
been made and rewrites it in natural English. It cannot change the pick, and
narration containing any number the engine didn't produce is discarded outright.

**Draft mode works offline.** A draft party is a loud room on bad wifi with a
timer running. Sync a snapshot beforehand and the entire recommendation path
runs in your browser. This is tested with the network genuinely disabled.

**It won't make things up.** Stale data is labelled stale, in words. An unknown
gets "I don't have reliable current information on that." Every news event keeps
every original source attached. When a player name is ambiguous, it asks instead
of guessing.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # DATABASE_URL is the only thing needed to start
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

Then:

1. **Settings** → set your league (teams, scoring, roster slots, draft slot).
2. **Settings → Import ADP** → drop in a CSV. This is the important step.
3. **Draft** → the war room is live.

### Getting ADP data

There is no free, terms-clean ADP API, so CSV import is the primary path — and
the system is designed to be fully effective with nothing else. Export a CSV
from FantasyPros, Sleeper, ESPN, or any tool you already use. Column names are
matched flexibly (`Player`/`Name`, `AVG`/`ADP`, `POS`/`Position`, …), and any
row that can't be parsed is reported rather than silently dropped.

The file is parsed in your browser and never uploaded anywhere.

### Check everything works

```bash
pnpm doctor
```

Runs the real requests against every source and reports, per source, whether the
parser still matches reality — plus a draft-readiness verdict. Run it before
draft day.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` / `pnpm start` | Production build and serve |
| `pnpm test` | Unit + integration tests (315) |
| `pnpm test:e2e` | Browser tests at iPhone dimensions (15) |
| `pnpm test:all` | Both |
| `pnpm db:migrate` | Apply migrations (idempotent) |
| `pnpm ingest [players\|news\|all]` | Fetch from sources into Postgres |
| `pnpm doctor` | Live connectivity + parser sanity check |
| `pnpm typecheck` | Strict TypeScript |

---

## Architecture in one screen

```
sources ──▶ adapters ──▶ news intelligence ──▶ Postgres
(Sleeper,    (isolated,   (dedup, classify,
 RSS, CSV)    killable)    impact score, link)
                                                  │
                                                  ▼
                          DETERMINISTIC ENGINE (pure, no I/O)
                          scoring · VOR · tiers · scarcity ·
                          roster fit · runs · availability ·
                          recommendation
                                                  │
                                                  ▼
                          COACH LAYER  intent router → engine
                          → response → optional LLM rewording
                                                  │
                                                  ▼
                          PWA   war room runs from a local
                                snapshot; no network required
```

Full detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md). Product scope and the
epistemics model are in [`PRD.md`](./PRD.md). Current state and what's left is in
[`TODO.md`](./TODO.md).

**Stack:** Next.js 16 · React 19 · TypeScript (strict) · Tailwind · PostgreSQL /
Supabase · Anthropic SDK · Vitest · Playwright.

---

## Data sources and their limits

| Source | Access | Gives us | Limitation |
| --- | --- | --- | --- |
| Sleeper | Public API, no key | Players, leagues, rosters, **live draft picks** | No ADP or projections |
| CSV import | Your own export | **ADP**, rankings, projections | Only as fresh as your file |
| RSS (ESPN, CBS, Yahoo, PFT) | Public feeds | Headlines with timestamps | Headline-level only |
| Yahoo Fantasy | Official OAuth2 | League, roster, draft | Requires app registration |
| ESPN Fantasy | Your own cookies | League, roster, draft | Unofficial; cookies expire |
| NFL.com Fantasy | — | — | No public API; manual/CSV only |
| FantasyPros, SportsDataIO | Paid keys | Rankings, projections, injuries | Optional upgrades |

Official APIs and public RSS only. No paywall circumvention, no article bodies
stored, per-source rate limits respected, and your credentials used only for your
own leagues. Any source that would require violating its terms is documented as
unavailable rather than quietly scraped.

---

## Status

**Working and tested:** league configuration · player database · ADP and rankings
import · draft board · manual and voice pick entry · undo and correction ·
recommendation engine with six flavors · roster awareness · positional scarcity ·
run detection · availability simulation · mobile UI · offline draft mode ·
news deduplication, classification and impact scoring · Coach command router ·
LLM narration with guardrails.

**Not yet built:** waiver wire · start/sit · trade analyzer · dynasty and keeper
logic · auction drafts · multi-user auth. The schema and adapter boundaries
anticipate all of these; none is needed for draft day.

**Needs verification on your machine:** the development environment blocked
outbound access to every fantasy data host, so the Sleeper and RSS adapters are
tested against recorded fixtures rather than live endpoints. `pnpm doctor`
performs the real check where the network is open.
