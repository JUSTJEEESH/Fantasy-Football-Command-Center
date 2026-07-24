# FANTASY COACH — Product Requirements

> One user. One goal. **Win the draft on 2026-08-30, then win the season.**

---

## 1. Problem

Fantasy research is spread across twenty sites, hundreds of beat reporters, and a dozen
ranking sets that disagree. The work of *gathering* swamps the work of *deciding*. On draft
night the timer runs and there is no time to read anything.

Fantasy Coach collapses that: it continuously gathers, deduplicates, and scores information,
understands one specific league, and answers the only question that matters — **what should
I do right now?**

## 2. Product promise

> Open the app. Say "Coach." It is ready.

The user should never have to restate context. Follow-ups (*"why?"*, *"what if he's gone?"*,
*"and after that?"*) resolve against the live conversation.

## 3. Non-goals (for v1)

Multi-user SaaS · native iOS · DFS · betting · league chat analysis · automated lineup
setting. Architecturally allowed for; deliberately not built before the draft.

---

## 4. Users

**Primary (only) user:** the owner. Redraft league, drafting 2026-08-30. Wants direct,
confident, honest advice and hates being handed 47 statistics instead of an answer.

---

## 5. The epistemics requirement (§3, §45) — a first-class feature

Every claim the system makes is tagged with one of five kinds, and the UI renders them
differently:

| Kind | Meaning | Example |
| --- | --- | --- |
| **FACT** | Verified against a primary source | "Player X missed Wednesday practice." *(official injury report)* |
| **REPORT** | Someone reported it; attributed, not verified | "Beat reporter Y says X is expected to play." |
| **INFERENCE** | The system derived it | "Likely reduced practice workload; projection materially unchanged." |
| **RECOMMENDATION** | An action | "Hold X at his tier; re-check Friday's report." |
| **UNCERTAINTY** | Explicit unknown | "Severity unknown. Sources disagree." |

Hard rules, enforced in code and prompt:
- An inference is never rendered as a fact.
- News is never invented. If nothing happened, the briefing says nothing happened.
- Data older than its freshness threshold is labeled and *spoken* as stale
  ("last verified 6 hours ago").
- When sources conflict, both are shown and the disagreement is stated.
- Unknown means "I don't have reliable current information on that." Never a guess.

---

## 6. Feature set

### P0 — must work before draft day

| # | Feature | Definition of done |
| --- | --- | --- |
| P0-1 | **League configuration** | Wizard covering teams, scoring (PPR/half/standard/custom/superflex/TE-premium), roster slots, draft type, draft position, keepers. Scoring engine is data-driven — a custom rule needs no code change. |
| P0-2 | **Player database** | Every player with position, team, bye, status, depth-chart role, injury state; all fields provenance-stamped. |
| P0-3 | **ADP + rankings** | Time-series ADP and consensus rankings, imported via CSV (guaranteed) or API (if keyed). Movement over time is queryable. |
| P0-4 | **Draft board** | Live board: round, pick, on-the-clock, every roster, drafted vs available. |
| P0-5 | **Manual draft entry** | "Player X drafted" / "Team 4 took Player Z" / "Undo last pick" / "Correction: …". Voice or text. Works with zero platform integration. |
| P0-6 | **Recommendation engine** | On demand, < 100 ms, offline: one pick + confidence + reasons + 2 alternatives + who to avoid + reach-or-wait. |
| P0-7 | **Roster awareness** | Recommendations account for current roster construction, starters vs bench, flex, bye clashes — not raw best-available. |
| P0-8 | **Positional scarcity** | Tier-break awareness: how many players remain in the current tier at each position, and what the cliff costs. |
| P0-9 | **Run detection** | Detect positional runs, judge whether to react, quantify dry-up risk before the next turn. |
| P0-10 | **Mobile UI** | Thumb-reachable, dark, readable at arm's length in a dim room. |
| P0-11 | **"Coach, who's my pick?"** | Answers in one screen, no scrolling, no jargon. |
| P0-12 | **Explanation** | "Why?" produces 1–3 sentences a human would actually say. |

### P1 — high value

News aggregation · injury monitoring · breaking-news draft alerts · player trends
(ADP/ranking/role movement) · sleeper detection · value detection · morning briefing ·
player comparison.

### P2 — after the draft

Waiver wire + FAAB · start/sit · trade analyzer · season-long coaching.

### P3 — future

Multi-user · native iOS · Siri/Watch · commercial product.

---

## 7. Core user flows

### 7.1 Draft night (the flow the product exists for)

```
Pre-draft  → open War Room → "Sync Pack" → snapshot cached locally (network no longer required)
Draft opens → "Coach, draft mode." → board initialized from league config
Each pick  → platform sync, or say "Player X drafted"
Your turn  → "Coach, who's my pick?"

    ┌──────────────────────────────────────────┐
    │  TAKE: BREECE HALL                       │
    │  Confidence 88%                          │
    │                                          │
    │  Last back in tier 2 — next RB is a full │
    │  tier down and 6 of 11 picks before your │
    │  next turn are RB-needy.                 │
    │                                          │
    │  If gone → 2. Puka Nacua  3. Kyle Pitts  │
    │  Avoid   → Player D (ankle, Fri report)  │
    │  Verdict → TAKE NOW, do not wait         │
    └──────────────────────────────────────────┘

Follow-ups → "why?" / "what if he's gone?" / "and after that?" / "how long can I wait?"
Mistake    → "Undo last pick." / "Correction: Team 4 took Player A, not Player Z."
Breaking   → 🚨 injury alert mid-draft → affected player re-tiered → recommendation recomputed
```

### 7.2 Morning briefing

"Coach, what's new?" → top news · injuries · depth-chart changes · ADP movers · ranking
movers · sleepers · bust risk · breakouts · weather · upcoming events. **Only what matters** —
an empty section is omitted, never padded.

### 7.3 Player deep-dive & comparison

"Compare A and B" → projection · floor · ceiling · ADP · value · injury risk · role certainty
· schedule · roster fit · a verdict.

---

## 8. Command surface (§43)

Deterministic router; every command has natural-language variants.

| Intent | Says |
| --- | --- |
| `WAKE` | "Coach" |
| `BRIEFING` | "what's new", "latest", "morning briefing", "what happened today" |
| `NEWS` / `INJURIES` | "news", "injuries", "any injuries I need to know about" |
| `SLEEPERS` / `RISKS` | "sleepers", "who's rising", "busts", "who should I avoid" |
| `RANKINGS` / `VALUES` | "rankings", "best value right now" |
| `MY_TEAM` | "show me my roster", "how strong is my team", "weakest position" |
| `DRAFT_MODE` | "draft mode", "start the draft" |
| `MY_PICK` | "who's my pick", "who should I take" |
| `WHY` | "why", "why him" |
| `WHAT_IF` | "what if he's gone", "and after that" |
| `PLAN` | "plan my next three picks", "how many picks until I pick again" |
| `RUN_CHECK` | "what's the positional run", "is it time to take a QB" |
| `WAIT_CHECK` | "should I reach", "how much longer can I wait" |
| `PICK_FLAVOR` | "safest pick", "highest upside", "contrarian pick" |
| `MARK_DRAFTED` / `UNDO` / `CORRECTION` | "Player X drafted", "undo last pick", "correction: …" |
| `COMPARE` / `TRADE` / `START_SIT` | "compare A and B", "evaluate this trade", "start/sit" |
| `HELP` | "help", "what can you do" |

Context carries across turns: pronouns and elliptical follow-ups resolve against the last
recommendation and the live draft state.

---

## 9. Personality (§44)

Knowledgeable · calm · direct · confident without arrogance · honest about uncertainty ·
**terse during drafts**, detailed on request · action-oriented.

It answers *"what should I do?"* first. Supporting numbers come second, and only the ones
that changed the answer.

---

## 10. Data sources & their limits

See `ARCHITECTURE.md` §8 for the full table. What the user needs to know:

- **Free and reliable:** Sleeper (players, live draft sync), RSS news feeds, Yahoo (OAuth).
- **Free but fragile:** ESPN Fantasy (unofficial; cookies expire).
- **Paid, optional:** FantasyPros (rankings/ADP), SportsDataIO, odds, weather.
- **No clean programmatic source:** consensus ADP. **CSV import is the primary ADP path** and
  Draft Mode is designed to be fully effective with CSV data alone.
- **NFL.com Fantasy:** no public API — manual/CSV only. Documented, not faked.

---

## 11. Success criteria (§49)

On 2026-08-30, at a draft party, on a phone:

1. "Coach, draft mode." → board live in under 5 seconds.
2. "Player X was drafted." → board updated, recognized by voice or text, undoable.
3. "Coach, who's my pick?" → **TAKE: <player>** with confidence, 1–3 sentence reason, two
   alternatives, who to avoid, and reach-or-wait — in under a second, **with the wifi off**.
4. The advice reflects the actual roster, actual scoring, actual draft position, actual
   remaining pool, current ADP, and any news ingested before the draft.
5. Nothing it says is invented, and anything stale is labeled stale.

## 12. Milestones to 2026-08-30

| Window | Milestone |
| --- | --- |
| Jul 24–31 | Architecture, schema, deterministic engine, draft state machine, mock-draft simulation |
| Aug 1–8 | Data adapters (Sleeper/CSV/RSS), live connectivity verification, league wizard |
| Aug 9–16 | War Room UI, offline draft pack, voice entry, Coach router |
| Aug 17–23 | News intelligence, trends, alerts, morning briefing |
| Aug 24–29 | **Full dress rehearsal:** mock draft end-to-end on the phone, airplane-mode test, tuning |
| **Aug 30** | **Draft.** |
