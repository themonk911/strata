import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY, forceRadial } from 'd3-force';
import { polygonHull } from 'd3-polygon';

// Two deterministic force layouts: files within neighborhoods, then neighborhoods
// within the city. Only the view uses the full file set; historical metrics don't.
export function createLayout(data) {
  const modules = new Map(data.snapshots.flatMap(s => s.districts).map(d => [d.id, d]));
  const files = [...data.files].sort((a, b) => a.path.localeCompare(b.path));
  const fileMap = new Map(files.map(f => [f.path, f]));
  const groups = new Map();
  for (const f of files) { if (!groups.has(f.district)) groups.set(f.district, []); groups.get(f.district).push(f); }
  const latest = data.snapshots.at(-1);
  // Inferred Swift relationships influence placement, never shortcut arcs.
  const imports = [...latest.imports, ...(latest.inferredReferences || [])];
  const lots = [...groups].sort(([a], [b]) => Number(Boolean(modules.get(b)?.walled)) - Number(Boolean(modules.get(a)?.walled)) || a.localeCompare(b)).map(([id, members], index) => {
    const walled = Boolean(modules.get(id)?.walled);
    const nodes = members.map(f => ({ id: f.path, gate: f.gate }));
    const own = new Set(members.map(f => f.path));
    const links = imports.filter(e => own.has(e.source) && own.has(e.target)).map(e => ({ source: e.source, target: e.target }));
    const gateY = Math.sqrt(nodes.length) * .4;
    forceSimulation(nodes).stop()
      .force('links', forceLink(links).id(n => n.id).distance(1.5).strength(.15))
      .force('charge', forceManyBody().strength(-.18).distanceMax(9))
      .force('collision', forceCollide(.64).strength(1).iterations(3))
      .force('x', forceX(0).strength(n => n.gate ? .22 : .075))
      .force('y', forceY(n => walled && n.gate ? gateY : 0).strength(n => n.gate ? .25 : .075))
      .tick(180);
    const r = Math.max(2.3, ...nodes.map(n => Math.hypot(n.x, n.y) + 1.5));
    const angle = index * 2.399963; const distance = walled ? 6 + Math.sqrt(index) * 3 : 25 + Math.sqrt(index) * 3;
    return { id, files: members, nodes, r, w: r * 2, d: r * 2, walled, x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  });
  const cross = new Map();
  for (const edge of imports) {
    const a = fileMap.get(edge.source)?.district, b = fileMap.get(edge.target)?.district;
    if (!a || !b || a === b) continue;
    const [source, target] = [a, b].sort(); const key = source + '>' + target;
    if (!cross.has(key)) cross.set(key, { source, target, count: 0 }); cross.get(key).count++;
  }
  const coreRadius = Math.sqrt(lots.filter(l => l.walled).reduce((area, l) => area + (l.r + 1.2) ** 2, 0)) * .95;
  forceSimulation(lots).stop()
    .force('links', forceLink([...cross.values()]).id(n => n.id).distance(e => e.source.r + e.target.r + 4).strength(e => Math.min(.18, .012 * Math.sqrt(e.count))))
    .force('charge', forceManyBody().strength(n => -n.r * .4).distanceMax(70))
    .force('collision', forceCollide(n => n.r + 1.2).strength(1).iterations(5))
    .force('ring', forceRadial(n => n.walled ? 0 : coreRadius + n.r + 4).strength(n => n.walled ? .04 : .055))
    .force('x', forceX(0).strength(n => n.walled ? .1 : .012))
    .force('y', forceY(0).strength(n => n.walled ? .1 : .012)).tick(420);
  // Final geometric separation makes the static layout independent of residual
  // simulation velocity, even for dense graphs.
  for (let pass = 0; pass < 35; pass++) for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const a = lots[i], b = lots[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || .001, min = a.r + b.r + 1.8;
    if (d < min) { const push = (min - d) * .5; a.x -= dx / d * push; a.y -= dy / d * push; b.x += dx / d * push; b.y += dy / d * push; }
  }
  const positions = new Map();
  for (const lot of lots) {
    lot.z = lot.y;
    const angle = Math.atan2(-lot.z, -lot.x) - Math.PI / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const points = [];
    for (const n of lot.nodes) {
      const x = lot.x + n.x * c - n.y * s, z = lot.z + n.x * s + n.y * c;
      positions.set(n.id, { x, z });
      for (let i = 0; i < 8; i++) points.push([x + Math.cos(i * Math.PI / 4) * 1.25, z + Math.sin(i * Math.PI / 4) * 1.25]);
    }
    lot.hull = polygonHull(points);
    // The gate faces the city center, and public files gravitate toward it.
    lot.gateSegment = lot.hull.reduce((best, p, i) => {
      const q = lot.hull[(i + 1) % lot.hull.length]; const distance = Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      return distance < best.distance && Math.hypot(p[0] - q[0], p[1] - q[1]) > 1.8 ? { index: i, distance } : best;
    }, { index: 0, distance: Infinity }).index;
  }
  const w = Math.max(...lots.map(l => Math.abs(l.x) + l.r)) * 2 + 3;
  const d = Math.max(...lots.map(l => Math.abs(l.z) + l.r)) * 2 + 3;
  return { lots, positions, bounds: { w, d }, span: Math.max(w, d) };
}
