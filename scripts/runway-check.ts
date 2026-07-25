import { readFileSync } from 'node:fs';
import { BAY_ISLANDS } from '../src/lib/leagues/bay-islands';
import { playersFromPack } from '../src/lib/pack-from-static';
import { buildRunway } from '../src/lib/engine/runway';
import type { PlayerPack } from '../src/lib/static-data';

const pack = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as PlayerPack;
const { players } = playersFromPack(pack, BAY_ISLANDS);
const r = buildRunway(players, BAY_ISLANDS);
console.log('TIER DEADLINES (by which pick the tier is typically gone)\n');
for (const t of r.tiers.slice(0, 18)) {
  console.log(
    `  R${String(t.deadlineRound).padStart(2)}  pick ${String(Math.round(t.lastAdp)).padStart(3)}  ` +
    `${t.position}${t.tier}  ${String(t.count).padStart(2)} left  ` +
    `${t.headliner.padEnd(22)} ${t.players.slice(0,4).map(p=>p.name.split(' ').slice(-1)[0]).join(', ')}`
  );
}
