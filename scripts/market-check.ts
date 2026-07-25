import { readFileSync } from 'node:fs';
import { BAY_ISLANDS } from '../src/lib/leagues/bay-islands';
import { playersFromPack } from '../src/lib/pack-from-static';
import { analyzeMarket } from '../src/lib/engine/market';
import type { PlayerPack } from '../src/lib/static-data';

const pack = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as PlayerPack;
const { players } = playersFromPack(pack, BAY_ISLANDS);
const m = analyzeMarket(players, BAY_ISLANDS);

console.log(`analyzed ${m.analyzed}, excluded ${m.excluded}\n`);
console.log('POSITIONAL EDGE (rounds, + = underpriced for you):');
for (const p of m.byPosition) {
  console.log(`  ${p.position.padEnd(4)} ${p.medianRoundsOfEdge >= 0 ? '+' : ''}${p.medianRoundsOfEdge.toFixed(1)}  (n=${p.sampleSize})  ${p.verdict.slice(0, 90)}`);
}
console.log('\nTARGETS:');
for (const t of m.targets.slice(0, 10)) {
  console.log(`  +${String(t.edge).padStart(3)}  ${t.player.name.padEnd(22)} ${t.player.position} ADP ${String(t.player.adp?.toFixed(1)).padStart(6)} → value rank ${t.valueRank}`);
}
console.log('\nFADES:');
for (const f of m.fades.slice(0, 10)) {
  console.log(`  ${String(f.edge).padStart(4)}  ${f.player.name.padEnd(22)} ${f.player.position} ADP ${String(f.player.adp?.toFixed(1)).padStart(6)} → value rank ${f.valueRank}`);
}
