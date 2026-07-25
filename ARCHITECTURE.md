# FANTASY COACH — Architecture

> Status: living document. Last substantive update: 2026-07-24.
> Target milestone: **fully functional Draft Mode by 2026-08-30**.

---

## 1. Design principles

These are the constraints every decision below is derived from.

1. **Deterministic math, LLM narration.** Rankings, ADP deltas, value-over-replacement,
   scarcity, roster counts, availability probability, and the actual pick recommendation
   are computed by plain TypeScript. The LLM never computes a number it could get wrong;
   it explains numbers the engine already produced. See §6.
2. **Draft Mode must work with no network.** Draft night is a loud room on congested wifi.
   The entire recommendation path runs client-side against a snapshot ("draft pack") stored
   in the browser. A dead API cannot cost you a pick.
3. **Never fake data.** Every value carries provenance and a timestamp. If a source is
   stale or unreachable, the UI says so in words. There is no silent fallback to made-up
   numbers, and no "live" badge without a fresh fetch.
4. **Sources are pluggable.** Adding or losing a data source must not require touching the
   engine. Everything enters through an adapter that emits a normalized record.
5. **Single-user now, multi-user shaped.** Every persisted row is keyed by `user_id` from
   day one, even though there is exactly one user today. No rewrite required later.

---

## 2. Environment findings (Phase 0 discovery, 2026-07-24)

Inspected before any code was written:

| Item | Finding |
| --- | --- |
| Repo | Empty — `README.md` + initial commit only. Nothing to overwrite. |
| Node | v22.22.2 |
| pnpm | 10.33.0 (chosen over npm) |
| Python | 3.11.15 (not needed; stack is TS end-to-end) |
| PostgreSQL | 16.13 installed locally, server was down — started, dev DB `fantasy_coach` created |
| Docker | 29.3.1 available |

### ⚠️ Critical finding: outbound egress is restricted in this build sandbox

The development sandbox routes HTTPS through a policy-enforcing proxy. Probed directly:

| Host | Result |
| --- | --- |
| `api.sleeper.app` | ❌ 403 at CONNECT (policy denial) |
| `www.fantasypros.com` | ❌ blocked |
| `site.api.espn.com`, `api.espn.com` | ❌ blocked |
| `www.rotowire.com` | ❌ blocked |
| `static.nfl.com` | ❌ blocked |
| `www.pro-football-reference.com` | ❌ blocked |
| `registry.npmjs.org` | ✅ reachable |
| `api.github.com` | ✅ reachable |
| `api.anthropic.com` | ✅ reachable |

**Consequence, stated plainly:** no live NFL data can be fetched from this sandbox. This
does not block the build, but it changes how the build is verified:

- Adapters are written against the **real, documented** wire format of each source.
- They are tested against **recorded fixtures** committed under `tests/fixtures/`, not
  against invented endpoints.
- `pnpm doctor` performs a live connectivity + schema check that the user runs **on their
  own machine or on deployment**, where egress is open. Until it passes, the system labels
  ingested data as unverified rather than pretending it works.
- No adapter is marked "done" in `TODO.md` until it has been run against the live host.

This is the honest position: the engine is verifiable here, the network layer is not.

---

## 3. Technology stack

| Layer | Choice | Why |
| --- | --- | --- |
| App framework | **Next.js 16 (App Router) + React 19 + TypeScript (strict)** | One deployable serving PWA UI, API routes, and cron ingestion. Deploys free-tier on Vercel. Server Components keep the mobile payload small. |
| Styling | **Tailwind CSS**, dark-first | Fast iteration, no runtime cost, trivially readable in a dim draft room. |
| Client shell | **PWA** (manifest + service worker), installable to iPhone home screen | §47 asks web vs native. PWA first: one codebase, instant updates without App Store review — which matters when the deadline is fixed at Aug 30 and a native build could be stuck in review. Native iOS stays on the P3 roadmap; the API layer is client-agnostic so a Swift client can be added without server changes. |
| Database | **PostgreSQL 16** (local dev → Supabase in prod) | Relational data with heavy joins; Supabase gives managed PG + auth + free tier for later multi-user. Plain SQL migrations, no ORM lock-in. |
| DB access | `pg` + hand-written SQL in a repository layer | The queries are the interesting part; an ORM would obscure them. Repository interface allows swapping storage. |
| Validation | **Zod** | Every external payload and every LLM structured output is parsed, never trusted. |
| AI | **Anthropic SDK** — Sonnet for reasoning, Haiku for bulk classification | §38 cost control: cheap model for the 500-articles-a-day path, strong model only for draft reasoning. |
| Tests | **Vitest** | Fast, no config. Engine is pure functions, so coverage is cheap. |

### Why not a separate backend service

A separate API server would add a deployment, a network hop, and a second thing to keep
alive on draft day, in exchange for no capability this system needs. Next.js route handlers
plus a cron trigger cover ingestion and serving. If load ever justifies it, the engine is
already an isolated pure module and lifts out cleanly.

---

## 4. System topology

```
┌────────────────────────────────────────────────────────────────────────────┐
│  SOURCES (external, rate-limited, unreliable — assumed hostile)            │
│  Sleeper API · ESPN · Yahoo OAuth · RSS feeds · CSV import · manual entry  │
└───────────────┬────────────────────────────────────────────────────────────┘
                │  adapters: one per source, each isolated + individually killable
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  INGESTION LAYER              src/lib/sources/                             │
│  · source registry (reliability, cadence, last-ok, last-error, enabled)    │
│  · fetch → parse → normalize → provenance stamp                            │
│  · one source failing NEVER aborts the run                                 │
└───────────────┬────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  NEWS INTELLIGENCE            src/lib/news/                                │
│  dedup (fingerprint + fuzzy) → canonical event → classify → player-link    │
│  → fantasy impact score → trend detection                                  │
└───────────────┬────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  PERSISTENCE                  PostgreSQL / Supabase                        │
│  every row: created_at · updated_at · source_timestamp · fetched_at        │
└───────────────┬────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  DETERMINISTIC ENGINE         src/lib/engine/     ← PURE, NO I/O            │
│  scoring · projections · VOR · tiers · scarcity · draft value · roster fit │
│  · run detection · availability simulation · recommendation                │
│  Runs identically on server and in the browser. 100% unit-testable.        │
└───────────────┬────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  COACH LAYER                  src/lib/coach/                               │
│  intent router (deterministic) → engine call → response object             │
│  → optional LLM narration (structured output, validated, budget-capped)    │
│  → ai_decisions audit log                                                  │
└───────────────┬────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  UI (PWA)                     src/app/                                     │
│  Home · News · Players · Rankings · DRAFT WAR ROOM · My Team · Watchlist   │
│  Draft War Room holds a local snapshot → works offline, sub-100ms picks    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data flow: the draft-day path (the one that must not fail)

```
BEFORE THE DRAFT (network available)
  ingest players/ADP/rankings/injuries → DB
  build DRAFT PACK  = players + ADP + tiers + projections + league scoring
  ship pack to the browser, persist in localStorage/IndexedDB
                                │
DURING THE DRAFT (network optional)
  pick happens ──▶ platform sync (Sleeper polling)  ─┐
             └──▶ voice/manual: "Player X drafted"  ─┴──▶ DraftState reducer
                                                              │  (pure, in-browser)
                                                              ▼
                                                      recommendation engine
                                                              │  < 10ms
                                                              ▼
                                                  TAKE: X · confidence · reasons
                                                              │
                          (only if online + budget) ──────────┴──▶ LLM re-phrasing
```

The reducer, the engine, and the rendered recommendation require **zero** network calls.
Platform sync and LLM phrasing are strictly additive enhancements. If both are dead, the
app still tells you who to take and why, from the snapshot in your pocket.

---

## 6. AI architecture

### Division of responsibility

| Computed by code (never the LLM) | Handled by the LLM |
| --- | --- |
| ADP, ranking, tier, projection | Turning a structured recommendation into a sentence |
| Value over replacement, scarcity | Interpreting a free-text question into an intent |
| Roster counts, positional need | Summarizing a news cluster |
| Availability probability | Explaining *why* a factor matters, in plain language |
| Which player to take, and confidence | Conversational follow-ups ("why?", "what if he's gone?") |

The recommendation is **already decided** before the LLM is called. The LLM receives the
decision and its inputs, and writes prose. It cannot change the pick. This makes the system
auditable and makes hallucinated numbers structurally impossible in the pick path.

### Structured output contract

Every LLM call requests a JSON object matching a Zod schema; the response is parsed and
rejected on mismatch, falling back to a deterministic template. A failed or unaffordable AI
call degrades the *prose*, never the *advice*.

### Cost control (§38)

- Bulk news classification uses deterministic filters first (keyword gates, dedup,
  player-link check). Only items that survive reach a model, and they go to Haiku in batches.
- Sonnet is reserved for draft reasoning and multi-turn conversation.
- Every call records tokens + estimated cost to `ai_usage`; a rolling 24h budget
  (`COACH_DAILY_AI_BUDGET_USD`) hard-stops the LLM layer, which degrades to templates
  rather than to failure.

### Audit log (§32)

`ai_decisions` stores, per recommendation: timestamp, league, draft state hash, roster,
available-player set, engine inputs, chosen player, alternatives, confidence, model,
prompt version, and (later) outcome. This is what makes "how good was Coach?" answerable
after the season.

---

## 7. Database design

Full DDL lives in `db/migrations/`. Shape and rationale:

**Identity & config** — `users`, `leagues`, `league_settings` (scoring stored as JSONB so a
custom scoring rule never requires a migration), `teams`, `user_preferences` (risk tolerance,
strategy leanings, positional biases).

**Players & facts** — `players` (biographical + team + status), `player_teams` (history),
`depth_charts`, `player_stats`, `player_projections`, `player_rankings`, `player_adp`,
`player_injuries`. ADP and rankings are **append-only time series**, not mutable columns —
that is what makes "moved up 18 spots in 72 hours" a query rather than a guess.

**News** — `news_sources` (the registry: reliability score, cadence, last success, last
error, rate limit, enabled flag), `news_items` (raw, one row per source article),
`news_events` (canonical deduplicated event), `news_event_items` (which raw items merged
into the event — original attribution is never discarded), `news_player_links`.

**Draft** — `drafts`, `draft_picks`, `draft_recommendations`.

**Derived & ops** — `player_trends`, `watchlists`, `alerts`, `ai_decisions`, `ai_usage`,
`system_logs`, `ingest_runs`.

**Provenance columns on every fact table:** `created_at`, `updated_at`, `source_timestamp`
(when the source says it happened), `fetched_at` (when we retrieved it). The UI reads
`fetched_at` to render staleness, and refuses to imply freshness it cannot prove.

---

## 8. Data sources — availability, cost, and legal position

Researched for §47.5–47.8. **Nothing here is scraped in violation of terms.**

| Source | Access | Cost | Gives us | Limitation |
| --- | --- | --- | --- | --- |
| **Sleeper API** | Public REST, no key, no auth | Free | Player master list, leagues, rosters, **live draft picks**, transactions | Undocumented but stable and publicly promoted; asks for ≤1000 calls/min. No ADP endpoint, no projections. |
| **ESPN Fantasy (league defaults)** | Public, unauthenticated, read-only JSON | Free | **ADP**, PPR draft ranks, **season projections as raw stat lines**, **bye weeks** | Undocumented — ESPN publishes no contract and may change or withdraw it. ADP is ESPN-only, not a cross-platform consensus. Stat-id meanings are unpublished, so every build re-derives ESPN's own point totals to prove the mapping before publishing projections. Two requests per build. |
| **ESPN Fantasy (private league)** | Your own `espn_s2`/`SWID` cookies | Free | League/roster/draft data | Unofficial API. Cookies expire. Your own credentials for your own league only. |
| **Yahoo Fantasy** | Official OAuth2 API | Free (registration required) | League, roster, draft, transactions | Genuine OAuth flow + token refresh. The most legally solid league integration. |
| **NFL Fantasy** | No public API | — | — | Manual/CSV path only. Documented as a limitation, not faked. |
| **RSS feeds** (ESPN, CBS, NFL.com, Rotoworld, team sites) | Public RSS | Free | Headlines + summaries with timestamps | Headline-level detail only; full articles are not redistributed. RSS is published *for* syndication — this is the intended use. |
| **FantasyPros API** | Keyed, paid tier | $ | Consensus rankings + ADP — the best single quality upgrade | Requires paid key. System runs without it. |
| **SportsDataIO** | Keyed, paid | $$ | Injuries, projections, depth charts | Optional. |
| **The Odds API** | Keyed, free tier | Free/$ | Vegas implied totals for start/sit | P2 feature. |
| **CSV / manual import** | — | Free | ADP + rankings from any provider you can legally export | **The guaranteed-available fallback.** Draft Mode is fully functional from CSV alone. |

**Terms-of-service position:** official/public APIs and RSS only; no circumvention of paywalls
or bot protection; no republishing article bodies; per-source rate limits respected in the
registry; user's own credentials used only for the user's own leagues. Any source that
requires violating its terms is not implemented — it is documented as unavailable.

**Deliberate consequence:** *consensus* ADP — an average across platforms — still has no free,
terms-clean, programmatic source. What is available free is **ESPN's own ADP**, which for this
project is arguably the better number anyway: the league drafts on ESPN, so ESPN's ADP describes
the draft that will actually happen rather than an aggregate of drafts that won't. It is labelled
as ESPN's throughout, never as consensus. CSV import remains as the override for anyone who
trusts their own export more, and the FantasyPros adapter is ready if a key is ever bought.

**On trusting an undocumented endpoint.** ESPN's projections arrive as a map of numeric stat ids
to values, with no published key. Adopting a community mapping on faith would risk shipping
confident, specific, wrong projections — the single worst failure available to this system.
Instead the mapping is treated as a hypothesis and tested on every build against evidence ESPN
itself supplies: each projection row carries `appliedTotal`, the points ESPN computed from those
same stats under its own PPR rules. Applying the ESPN rulebook through the mapping must reproduce
that total on at least 90% of a real sample. If it does not, projections are dropped and the
failure is reported in the build log and in the app's source panel. ADP and draft ranks are
unaffected, since they require no mapping. See `src/lib/sources/espn.ts`.

---

## 9. Reliability posture (§33)

- **Ingestion:** every adapter runs inside its own try/catch with a timeout; a failure is
  recorded to `ingest_runs` + `news_sources.last_error` and the run continues. One dead
  source never takes down a briefing.
- **Serving:** if the DB is unreachable, the Draft War Room still runs from its local pack.
- **AI:** unavailable or over budget → deterministic template prose. Advice quality is
  unchanged; only the wording gets blunter.
- **Staleness:** the UI renders relative age on every panel. Past a per-source threshold it
  is labeled `STALE`, and Coach says "last verified N hours ago" in words rather than
  implying currency.

---

## 10. Security (§34)

- Secrets live only in environment variables; `.env*` is git-ignored, `.env.example` documents
  every key and states what breaks without it.
- No key is ever referenced in client components. Platform credentials and the Anthropic key
  are used exclusively inside route handlers and scripts.
- Admin/ingest endpoints require `ADMIN_TOKEN`.
- Single-user deploys should stay behind a private Vercel deployment; Supabase Auth + RLS is
  the documented path when multi-user arrives (schema is already `user_id`-keyed).

---

## 11. Deployment

- **Prod:** Vercel (app + cron-triggered ingestion routes) + Supabase (Postgres).
- **Ingestion cadence:** players/ADP/rankings daily; news every 15 min; injuries hourly and
  every 5 min on practice-report days.
- **Draft day:** open the War Room and hit *Sync Pack* before the draft starts. That single
  action makes the rest of the night network-optional.

---

## 12. Future expansion (§46)

The schema and adapter boundaries already anticipate: dynasty/keeper (`league_settings` JSONB
+ `player_teams` history), auction (`draft_picks.price`), best-ball, waivers/FAAB, start/sit
(`player_stats` weekly + odds/weather adapters), multi-user SaaS (`user_id` everywhere +
Supabase RLS), and a native iOS client (the Coach API is transport-agnostic JSON).

None of these are built. They are simply not walled off.
