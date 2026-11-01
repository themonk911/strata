import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout } from '../web/layout.js';
const data = { files: Array.from({length:18}, (_, i) => ({path:`src/m${i % 3}/f${i}.ts`, district:`src/m${i % 3}`, gate:i < 3})), snapshots:[{districts:[0,1,2].map(i=>({id:`src/m${i}`,walled:true})),imports:[]}] };
data.snapshots[0].inferredReferences = [{source: data.files[0].path, target: data.files[1].path, kind:'swift_type_reference', inferred:true}];
test('organic layout is deterministic and places every file', () => {
  const a = createLayout(data), b = createLayout(data);
  assert.equal(a.positions.size, 18);
  assert.deepEqual(a.positions, b.positions);
  for(const p of a.positions.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});
test('district envelopes do not overlap', () => {
  const {lots} = createLayout(data);
  for(let i=0;i<lots.length;i++) for(let j=i+1;j<lots.length;j++) assert.ok(Math.hypot(lots[i].x-lots[j].x,lots[i].z-lots[j].z) >= lots[i].r+lots[j].r+1.7);
});
test('isolated neighborhoods remain compact without overlapping a large neighborhood', () => {
  const districts = Array.from({length:25}, (_, i) => ({id:`module-${i}`, walled:i < 5}));
  const files = districts.flatMap((d, i) => Array.from({length:i === 8 ? 120 : i % 7 + 1}, (_, j) => ({path:`${d.id}/${j}.ts`, district:d.id, gate:j === 0})));
  const {lots, span, positions} = createLayout({files, snapshots:[{districts, imports:[]}]});
  assert.equal(positions.size, files.length);
  const areaRadius = Math.sqrt(lots.reduce((area, l) => area + (l.r + 1.8) ** 2, 0));
  assert.ok(span < areaRadius * 4, 'disconnected lots should stay within a compact city envelope');
  for(let i=0;i<lots.length;i++) for(let j=i+1;j<lots.length;j++) assert.ok(Math.hypot(lots[i].x-lots[j].x,lots[i].z-lots[j].z) >= lots[i].r+lots[j].r+1.7);
});
