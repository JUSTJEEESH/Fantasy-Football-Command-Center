-- ============================================================================
-- FANTASY COACH — 0001 core schema
-- PostgreSQL 14+ / Supabase compatible.
--
-- Conventions enforced throughout:
--   * every table is keyed by user_id where user-scoped (multi-user ready)
--   * every FACT table carries provenance: source_timestamp + fetched_at,
--     alongside created_at / updated_at. The UI reads these to render staleness.
--   * ADP and rankings are append-only time series, never mutated in place --
--     that is what makes "moved up 18 spots in 72 hours" a query, not a guess.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity & configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 0 = maximum floor/safety, 1 = maximum ceiling/upside
  risk_tolerance      NUMERIC(3,2) NOT NULL DEFAULT 0.50
                        CHECK (risk_tolerance BETWEEN 0 AND 1),
  -- e.g. 'balanced' | 'hero_rb' | 'zero_rb' | 'robust_rb' | 'best_available'
  draft_strategy      TEXT NOT NULL DEFAULT 'balanced',
  -- per-position draft-round biases, e.g. {"QB": {"avoid_before_round": 6}}
  position_biases     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- free-text standing instructions the Coach should honor
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leagues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT 'manual'
                    CHECK (platform IN ('sleeper','espn','yahoo','nfl','manual')),
  platform_league_id TEXT,
  season          INTEGER NOT NULL,
  league_type     TEXT NOT NULL DEFAULT 'redraft'
                    CHECK (league_type IN ('redraft','keeper','dynasty','bestball')),
  team_count      INTEGER NOT NULL CHECK (team_count BETWEEN 2 AND 32),
  draft_type      TEXT NOT NULL DEFAULT 'snake'
                    CHECK (draft_type IN ('snake','linear','auction')),
  draft_slot      INTEGER,          -- the user's own draft position (1-indexed)
  draft_starts_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leagues_user_idx ON leagues(user_id);

-- Scoring and roster rules live in JSONB on purpose: a custom scoring rule must
-- never require a migration. Shape is validated by Zod (src/lib/types/league.ts).
CREATE TABLE IF NOT EXISTS league_settings (
  league_id       UUID PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
  scoring         JSONB NOT NULL,   -- ScoringSettings
  roster_slots    JSONB NOT NULL,   -- {"QB":1,"RB":2,"WR":2,"TE":1,"FLEX":1,...}
  bench_size      INTEGER NOT NULL DEFAULT 6,
  ir_slots        INTEGER NOT NULL DEFAULT 1,
  taxi_slots      INTEGER NOT NULL DEFAULT 0,
  waiver_type     TEXT NOT NULL DEFAULT 'faab'
                    CHECK (waiver_type IN ('faab','rolling','reverse','none')),
  faab_budget     INTEGER NOT NULL DEFAULT 100,
  keeper_rules    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  owner_name        TEXT,
  draft_slot        INTEGER NOT NULL,
  is_user           BOOLEAN NOT NULL DEFAULT false,
  platform_team_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, draft_slot)
);

-- ---------------------------------------------------------------------------
-- Players & facts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS players (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable cross-source identity. External ids kept in a JSONB map so a new
  -- source never requires a column: {"sleeper":"4034","espn":"3139477"}
  external_ids      JSONB NOT NULL DEFAULT '{}'::jsonb,
  full_name         TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  -- normalized for fuzzy matching across sources ("aj brown" -> "ajbrown")
  search_key        TEXT NOT NULL,
  position          TEXT NOT NULL CHECK (position IN ('QB','RB','WR','TE','K','DST')),
  nfl_team          TEXT,                 -- 'PHI'; NULL = free agent
  previous_team     TEXT,
  jersey_number     INTEGER,
  age               INTEGER,
  birth_date        DATE,
  height_inches     INTEGER,
  weight_lbs        INTEGER,
  college           TEXT,
  draft_year        INTEGER,
  draft_round       INTEGER,
  draft_pick        INTEGER,
  years_exp         INTEGER,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|inactive|ir|pup|suspended|retired
  bye_week          INTEGER,
  contract_status   TEXT,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_search_key_idx ON players(search_key);
CREATE INDEX IF NOT EXISTS players_position_idx   ON players(position);
CREATE INDEX IF NOT EXISTS players_team_idx       ON players(nfl_team);
CREATE INDEX IF NOT EXISTS players_external_idx   ON players USING GIN (external_ids);

-- Team-level context that materially moves a player's projection.
CREATE TABLE IF NOT EXISTS nfl_teams (
  abbr              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  head_coach        TEXT,
  offensive_coordinator TEXT,
  starting_qb_player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  bye_week          INTEGER,
  pace_rank         INTEGER,
  pass_rate_oe      NUMERIC(5,2),
  ol_rank           INTEGER,
  implied_total     NUMERIC(5,2),
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  nfl_team      TEXT NOT NULL,
  season        INTEGER NOT NULL,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_teams_player_idx ON player_teams(player_id, season);

CREATE TABLE IF NOT EXISTS depth_charts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  nfl_team          TEXT NOT NULL,
  position          TEXT NOT NULL,
  depth_order       INTEGER NOT NULL,        -- 1 = starter
  role              TEXT,                    -- 'bellcow' | 'committee' | 'slot' | 'RZ back'
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS depth_charts_player_idx ON depth_charts(player_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS player_stats (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season            INTEGER NOT NULL,
  week              INTEGER,                 -- NULL = season aggregate
  -- raw box score
  pass_att          NUMERIC(7,2) DEFAULT 0,
  pass_cmp          NUMERIC(7,2) DEFAULT 0,
  pass_yds          NUMERIC(7,2) DEFAULT 0,
  pass_td           NUMERIC(7,2) DEFAULT 0,
  pass_int          NUMERIC(7,2) DEFAULT 0,
  rush_att          NUMERIC(7,2) DEFAULT 0,
  rush_yds          NUMERIC(7,2) DEFAULT 0,
  rush_td           NUMERIC(7,2) DEFAULT 0,
  targets           NUMERIC(7,2) DEFAULT 0,
  receptions        NUMERIC(7,2) DEFAULT 0,
  rec_yds           NUMERIC(7,2) DEFAULT 0,
  rec_td            NUMERIC(7,2) DEFAULT 0,
  fumbles_lost      NUMERIC(7,2) DEFAULT 0,
  two_pt            NUMERIC(7,2) DEFAULT 0,
  -- usage / opportunity (the signal that actually predicts next year)
  snap_pct          NUMERIC(5,2),
  route_pct         NUMERIC(5,2),
  target_share      NUMERIC(5,2),
  air_yards         NUMERIC(7,2),
  yprr              NUMERIC(5,2),
  carry_share       NUMERIC(5,2),
  rz_touches        NUMERIC(7,2),
  goal_line_touches NUMERIC(7,2),
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, season, week, source)
);
CREATE INDEX IF NOT EXISTS player_stats_player_idx ON player_stats(player_id, season, week);

CREATE TABLE IF NOT EXISTS player_projections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season            INTEGER NOT NULL,
  week              INTEGER,                 -- NULL = full season
  -- Stat-line projection. Points are NOT stored: they are derived from the
  -- league's scoring settings at read time, so one projection serves every
  -- league format. See src/lib/engine/scoring.ts.
  stat_line         JSONB NOT NULL,
  floor_stat_line   JSONB,
  ceiling_stat_line JSONB,
  games_projected   NUMERIC(4,1),
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, season, week, source)
);
CREATE INDEX IF NOT EXISTS player_projections_lookup_idx
  ON player_projections(season, week, source);

-- Append-only time series. One row per (player, source, observation).
CREATE TABLE IF NOT EXISTS player_adp (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season            INTEGER NOT NULL,
  format            TEXT NOT NULL,           -- 'ppr' | 'half' | 'std' | 'superflex' | '2qb'
  adp               NUMERIC(6,2) NOT NULL,
  adp_stdev         NUMERIC(6,2),            -- drives availability simulation
  min_pick          INTEGER,
  max_pick          INTEGER,
  sample_size       INTEGER,
  auction_value     NUMERIC(6,2),
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_adp_series_idx
  ON player_adp(player_id, season, format, fetched_at DESC);
CREATE INDEX IF NOT EXISTS player_adp_latest_idx
  ON player_adp(season, format, source, fetched_at DESC);

CREATE TABLE IF NOT EXISTS player_rankings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season            INTEGER NOT NULL,
  week              INTEGER,
  format            TEXT NOT NULL,
  overall_rank      INTEGER,
  position_rank     INTEGER,
  tier              INTEGER,
  expert_name       TEXT,                    -- NULL = consensus
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_rankings_series_idx
  ON player_rankings(player_id, season, format, fetched_at DESC);

CREATE TABLE IF NOT EXISTS player_injuries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,           -- questionable|doubtful|out|ir|pup|healthy
  designation       TEXT,                    -- DNP | LP | FP
  body_part         TEXT,
  description       TEXT,
  expected_return   DATE,
  games_missed_est  NUMERIC(4,1),
  severity          TEXT,                    -- minor|moderate|severe|season_ending|unknown
  is_current        BOOLEAN NOT NULL DEFAULT true,
  source            TEXT NOT NULL,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_injuries_player_idx
  ON player_injuries(player_id, is_current, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- News intelligence
-- ---------------------------------------------------------------------------

-- The source registry (§4). Ingestion reads this table; disabling a flaky
-- source is a row update, not a deploy.
CREATE TABLE IF NOT EXISTS news_sources (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('rss','api','csv','manual')),
  url                   TEXT,
  parser                TEXT NOT NULL,       -- adapter key in src/lib/sources/
  -- 0..1. Weighs into fantasy impact confidence; official > national > aggregator
  reliability           NUMERIC(3,2) NOT NULL DEFAULT 0.70
                          CHECK (reliability BETWEEN 0 AND 1),
  update_frequency_min  INTEGER NOT NULL DEFAULT 15,
  rate_limit_per_min    INTEGER,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  last_success_at       TIMESTAMPTZ,
  last_error_at         TIMESTAMPTZ,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw item, exactly one row per source article. Never deleted on dedup --
-- original attribution must survive (§5).
CREATE TABLE IF NOT EXISTS news_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  external_id       TEXT,
  url               TEXT,
  title             TEXT NOT NULL,
  summary           TEXT,
  author            TEXT,
  -- sha256 of normalized title+summary; cheap exact-duplicate gate
  fingerprint       TEXT NOT NULL,
  published_at      TIMESTAMPTZ,
  source_timestamp  TIMESTAMPTZ,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS news_items_published_idx ON news_items(published_at DESC);

-- The canonical, deduplicated event that several outlets reported.
CREATE TABLE IF NOT EXISTS news_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  headline          TEXT NOT NULL,
  event_type        TEXT NOT NULL,   -- injury|depth_chart|trade|signing|suspension|
                                     -- practice|usage|coaching|return|holdout|other
  classification    TEXT NOT NULL DEFAULT 'WATCH'
                      CHECK (classification IN
                        ('BREAKING','HIGH_IMPACT','IMPORTANT','WATCH','LOW_IMPACT','NOISE')),
  fantasy_impact    TEXT NOT NULL DEFAULT 'LOW'
                      CHECK (fantasy_impact IN ('CRITICAL','HIGH','MEDIUM','LOW','NONE')),
  impact_score      NUMERIC(6,2),    -- Fantasy Impact Score (§7), 0..100
  team_impact       TEXT CHECK (team_impact IN
                      ('STRONG_POSITIVE','POSITIVE','NEUTRAL','NEGATIVE','STRONG_NEGATIVE')),
  positions_affected TEXT[] NOT NULL DEFAULT '{}',
  nfl_team          TEXT,
  -- 0..1. Derived from source reliability + corroboration count + recency.
  confidence        NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  summary           TEXT,
  event_time        TIMESTAMPTZ,     -- when the thing happened, if known
  first_reported_at TIMESTAMPTZ,
  last_updated_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_events_recent_idx ON news_events(first_reported_at DESC);
CREATE INDEX IF NOT EXISTS news_events_impact_idx ON news_events(impact_score DESC);

CREATE TABLE IF NOT EXISTS news_event_items (
  event_id      UUID NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  news_item_id  UUID NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  similarity    NUMERIC(4,3),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, news_item_id)
);

CREATE TABLE IF NOT EXISTS news_player_links (
  event_id      UUID NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- how this event moves THIS player, which may oppose the team-level direction
  player_impact TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK (player_impact IN
                  ('STRONG_POSITIVE','POSITIVE','NEUTRAL','NEGATIVE','STRONG_NEGATIVE')),
  is_primary    BOOLEAN NOT NULL DEFAULT true,
  confidence    NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, player_id)
);
CREATE INDEX IF NOT EXISTS news_player_links_player_idx ON news_player_links(player_id);

-- ---------------------------------------------------------------------------
-- Draft
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS drafts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  platform_draft_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','paused','complete')),
  rounds            INTEGER NOT NULL,
  current_pick      INTEGER NOT NULL DEFAULT 1,   -- 1-indexed overall pick
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_picks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick  INTEGER NOT NULL,
  round         INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  team_id       UUID REFERENCES teams(id) ON DELETE SET NULL,
  draft_slot    INTEGER NOT NULL,
  player_id     UUID REFERENCES players(id) ON DELETE SET NULL,
  price         NUMERIC(6,2),                  -- auction support
  is_keeper     BOOLEAN NOT NULL DEFAULT false,
  entry_method  TEXT NOT NULL DEFAULT 'manual'
                  CHECK (entry_method IN ('manual','voice','sync','simulated')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, overall_pick)
);
CREATE INDEX IF NOT EXISTS draft_picks_draft_idx ON draft_picks(draft_id, overall_pick);

CREATE TABLE IF NOT EXISTS draft_recommendations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id          UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick      INTEGER NOT NULL,
  recommended_player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  confidence        NUMERIC(3,2) NOT NULL,
  flavors           JSONB NOT NULL,     -- best_overall/fit/value/safe/upside/contrarian
  alternatives      JSONB NOT NULL DEFAULT '[]'::jsonb,
  avoid             JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict           TEXT,               -- TAKE_NOW | CAN_WAIT | REACH
  engine_version    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_recs_idx ON draft_recommendations(draft_id, overall_pick);

-- ---------------------------------------------------------------------------
-- Derived signals, personalization, observability
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS player_trends (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  trend_type        TEXT NOT NULL,   -- adp_rising|adp_falling|rank_rising|rank_falling|
                                     -- workload_up|workload_down|news_positive|news_negative|
                                     -- injury_concern|depth_chart_up|depth_chart_down
  magnitude         NUMERIC(8,2),    -- e.g. spots moved
  window_hours      INTEGER NOT NULL,
  detail            TEXT,
  confidence        NUMERIC(3,2) NOT NULL DEFAULT 0.60,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_trends_player_idx ON player_trends(player_id, computed_at DESC);

-- AI-derived per-player scores. Every row records its inputs and model so any
-- number the Coach says can be traced back (§8: "every AI-derived field").
CREATE TABLE IF NOT EXISTS player_derived (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id             UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season                INTEGER NOT NULL,
  format                TEXT NOT NULL,
  breakout_probability  NUMERIC(4,3),
  bust_probability      NUMERIC(4,3),
  injury_risk           NUMERIC(4,3),
  role_certainty        NUMERIC(4,3),
  ceiling_score         NUMERIC(6,2),
  floor_score           NUMERIC(6,2),
  value_score           NUMERIC(6,2),
  draft_score           NUMERIC(6,2),
  trend_score           NUMERIC(6,2),
  confidence            NUMERIC(3,2),
  inputs                JSONB NOT NULL DEFAULT '{}'::jsonb,
  engine_version        TEXT NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_derived_idx
  ON player_derived(player_id, season, format, computed_at DESC);

CREATE TABLE IF NOT EXISTS watchlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'watch'
                CHECK (kind IN ('watch','target','avoid','favorite')),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, player_id, kind)
);

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    UUID REFERENCES news_events(id) ON DELETE CASCADE,
  player_id   UUID REFERENCES players(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL DEFAULT 'info'
                CHECK (severity IN ('critical','high','info')),
  title       TEXT NOT NULL,
  body        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts(user_id, created_at DESC);

-- §32 audit log: makes "how good was Coach?" answerable after the season.
CREATE TABLE IF NOT EXISTS ai_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  league_id         UUID REFERENCES leagues(id) ON DELETE SET NULL,
  draft_id          UUID REFERENCES drafts(id) ON DELETE SET NULL,
  decision_type     TEXT NOT NULL,   -- draft_pick|start_sit|trade|briefing|answer
  intent            TEXT,
  inputs            JSONB NOT NULL,  -- roster, available pool digest, engine inputs
  output            JSONB NOT NULL,  -- recommendation, alternatives, reasons
  confidence        NUMERIC(3,2),
  model             TEXT,
  prompt_version    TEXT,
  latency_ms        INTEGER,
  used_llm          BOOLEAN NOT NULL DEFAULT false,
  outcome           JSONB,           -- backfilled later: what actually happened
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_decisions_idx ON ai_decisions(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model             TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_time_idx ON ai_usage(created_at DESC);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ok','partial','error')),
  items_fetched     INTEGER NOT NULL DEFAULT 0,
  items_new         INTEGER NOT NULL DEFAULT 0,
  items_deduped     INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ingest_runs_idx ON ingest_runs(source_key, started_at DESC);

CREATE TABLE IF NOT EXISTS system_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level       TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  scope       TEXT NOT NULL,
  message     TEXT NOT NULL,
  context     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_logs_idx ON system_logs(created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','user_preferences','leagues','league_settings','teams','players',
    'news_sources','news_events','drafts'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_touch ON %I; '
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t, t, t, t);
  END LOOP;
END $$;
