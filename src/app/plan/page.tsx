'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { loadPack, type DraftPack } from '@/lib/draft-pack';
import { analyzeMarket, type MarketAnalysis, type MarketEdge } from '@/lib/engine/market';
import { relativeTime } from '@/lib/static-data';
import type { PlayerCard, Position } from '@/lib/types';

/**
 * The cheat sheet.
 *
 * Everything else in this app answers "who do I take right now". This page
 * answers "what am I doing" — the plan you want in your head before the room
 * gets loud, and the one page worth glancing at between picks.
 *
 * It leads with the strategy, because the strategy is where the edge is. A
 * league that requires no tight end is drafting against a market that prices
 * every tight end as though it did, and that is worth more than any single
 * player opinion this app could offer.
 */
export default function PlanPage() {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPack(loadPack());
    setHydrated(true);
  }, []);

  const market = useMemo<MarketAnalysis | null>(() => {
    if (!pack || pack.players.length === 0) return null;
    return analyzeMarket(pack.players, pack.league);
  }, [pack]);

  if (!hydrated) return <SkeletonPlan />;

  if (!pack || pack.players.length === 0) {
    return (
      <div className="space-y-4">
        <Header subtitle="Your draft plan, before the room gets loud." />
        <div className="card border-[var(--warn)]/40">
          <h2 className="font-semibold text-[var(--warn)]">No board yet</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            The plan is built from your own board, so there is nothing to plan with
            until you have one.
          </p>
          <Link href="/settings" className="btn-primary mt-3 inline-flex items-center">
            Build my board
          </Link>
        </div>
      </div>
    );
  }

  const league = pack.league;

  return (
    <div className="space-y-4">
      <Header
        subtitle={`${league.name} · ${league.teamCount} teams · ${totalRounds(pack)} rounds`}
      />

      <p className="text-xs text-[var(--muted)]">
        Built from data fetched {relativeTime(pack.dataFetchedAt)}. Everything below is
        an inference from ESPN projections re-scored in your rules — good reasoning on
        imperfect numbers, not prophecy.
      </p>

      <RulesEdge pack={pack} />

      {market && market.byPosition.length > 0 && (
        <section className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Where the market is wrong about your league</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              ADP is set by people playing a different game. Positive means a position is
              cheaper than it is worth to you.
            </p>
          </div>

          {market.byPosition.map((verdict) => (
            <div key={verdict.position} className="rounded-lg bg-[var(--surface-2)] p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{verdict.position}</span>
                <span
                  className={`text-sm font-bold tabular-nums ${
                    verdict.medianRoundsOfEdge >= 0.5
                      ? 'text-[var(--accent)]'
                      : verdict.medianRoundsOfEdge <= -0.5
                        ? 'text-[var(--danger)]'
                        : 'text-[var(--muted)]'
                  }`}
                >
                  {verdict.medianRoundsOfEdge >= 0 ? '+' : ''}
                  {verdict.medianRoundsOfEdge.toFixed(1)} rounds
                </span>
              </div>
              <p className="mt-1 text-sm leading-snug text-[var(--muted)]">
                {verdict.verdict}
              </p>
            </div>
          ))}
        </section>
      )}

      {market && market.targets.length > 0 && (
        <EdgeList
          title="Targets"
          blurb="Worth more in your scoring than where they go. These are the picks that win a draft quietly."
          edges={market.targets}
          tone="good"
        />
      )}

      {market && market.fades.length > 0 && (
        <EdgeList
          title="Let someone else take them"
          blurb="Priced for a league you are not in. Taking one of these at ADP is paying full price for a part you cannot use."
          edges={market.fades}
          tone="bad"
        />
      )}

      <ByeStacks pack={pack} />

      {market && (
        <section className="card space-y-2">
          <h2 className="text-sm font-semibold">What this is built on</h2>
          <ul className="space-y-1 text-xs text-[var(--muted)]">
            {market.notes.map((note, i) => (
              <li key={i}>· {note}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Header({ subtitle }: { subtitle: string }) {
  return (
    <header className="pt-2">
      <h1 className="text-2xl font-bold">Draft plan</h1>
      <p className="text-sm text-[var(--muted)]">{subtitle}</p>
    </header>
  );
}

/**
 * The league's own rules, translated into what they mean for drafting.
 *
 * These are FACTS — they come straight from the league configuration, not from
 * any model — so they are stated plainly and separately from anything inferred.
 */
function RulesEdge({ pack }: { pack: DraftPack }) {
  const league = pack.league;
  const scoring = league.scoring.perStat;
  const facts: string[] = [];

  const passTd = scoring.pass_td ?? 4;
  if (passTd > 4) {
    facts.push(
      `Passing touchdowns are worth ${passTd}, not the standard 4. Every quarterback is worth more here than his ADP assumes.`,
    );
  }
  const passYds = scoring.pass_yds ?? 0.04;
  if (passYds > 0.04) {
    facts.push(
      `A passing yard is worth 1/${Math.round(1 / passYds)}, not 1/25 — another few dozen points a season for a starting quarterback.`,
    );
  }
  if ((scoring.rush_100_bonus ?? 0) > 0) {
    facts.push(
      `${scoring.rush_100_bonus} bonus points for a 100-yard rushing game, which rewards the backs who get volume rather than the ones who get lucky.`,
    );
  }
  if ((league.rosterSlots.TE ?? 0) === 0) {
    facts.push(
      'You are never required to start a tight end. The other eleven teams are drafting as though they are.',
    );
  }
  if ((scoring.receptions ?? 0) >= 1) {
    facts.push(`Full PPR — ${scoring.receptions} per catch, so target volume is points.`);
  }

  if (facts.length === 0) return null;

  return (
    <section className="card space-y-2">
      <h2 className="text-sm font-semibold">Your rules, and what they mean</h2>
      <ul className="space-y-1.5">
        {facts.map((fact, i) => (
          <li key={i} className="claim-FACT text-[15px] leading-snug">
            {fact}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EdgeList({
  title,
  blurb,
  edges,
  tone,
}: {
  title: string;
  blurb: string;
  edges: MarketEdge[];
  tone: 'good' | 'bad';
}) {
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">{blurb}</p>
      </div>

      <ul className="space-y-1.5">
        {edges.map((edge) => (
          <li
            key={edge.player.id}
            className="flex items-baseline gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2"
          >
            <span
              className={`w-14 shrink-0 text-sm font-bold tabular-nums ${
                tone === 'good' ? 'text-[var(--accent)]' : 'text-[var(--danger)]'
              }`}
            >
              {edge.roundsOfEdge >= 0 ? '+' : ''}
              {edge.roundsOfEdge.toFixed(1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {edge.player.name}
                <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">
                  {edge.player.position}
                  {edge.player.team ? ` · ${edge.player.team}` : ''}
                </span>
              </span>
              <span className="block text-xs text-[var(--muted)]">{edge.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Bye weeks worth knowing before you stack three starters onto one.
 *
 * Only counts players good enough to actually start, since a bye clash between
 * two bench players is not a problem worth a line on a cheat sheet.
 */
function ByeStacks({ pack }: { pack: DraftPack }) {
  const startable = pack.players
    .filter((p) => p.adp !== undefined && p.adp <= pack.league.teamCount * 8)
    .filter((p) => p.byeWeek);

  if (startable.length === 0) return null;

  const byWeek = new Map<number, PlayerCard[]>();
  for (const player of startable) {
    const week = player.byeWeek!;
    byWeek.set(week, [...(byWeek.get(week) ?? []), player]);
  }

  const crowded = [...byWeek.entries()]
    .map(([week, players]) => ({ week, players }))
    .sort((a, b) => b.players.length - a.players.length)
    .slice(0, 3);

  return (
    <section className="card space-y-2">
      <h2 className="text-sm font-semibold">Bye weeks to watch</h2>
      <p className="text-xs text-[var(--muted)]">
        The weeks holding the most draftable players. Not a reason to avoid anyone — a
        reason to notice when your third starter shares a week with two others.
      </p>
      <div className="space-y-1.5">
        {crowded.map(({ week, players }) => (
          <div key={week} className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">Week {week}</span>
              <span className="text-xs text-[var(--muted)]">
                {players.length} draftable players
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
              {players
                .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
                .slice(0, 6)
                .map((p) => p.name)
                .join(' · ')}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function totalRounds(pack: DraftPack): number {
  const starters = Object.values(pack.league.rosterSlots).reduce<number>(
    (sum, n) => sum + (n ?? 0),
    0,
  );
  return starters + pack.league.benchSize;
}

function SkeletonPlan() {
  return (
    <div className="space-y-4">
      <Header subtitle="Loading your plan…" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="card h-28 animate-pulse bg-[var(--surface-2)]" />
      ))}
    </div>
  );
}
