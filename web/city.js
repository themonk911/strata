import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLayout } from './layout.js';

const C = { paper: '#f4f3ee', land: '#eeeee6', lot: '#e5e8dd', wall: '#c4cdbb', building: '#c5cec1', violet: '#9470ce', heat: '#d99a5e' };
const hash = str => [...str].reduce((v, c) => (v * 31 + c.charCodeAt(0)) >>> 0, 7);
const height = lines => lines ? Math.min(13, .35 + Math.sqrt(lines) * .205) : .025;
export class City {
  constructor(element, data, callbacks) {
    this.element = element; this.data = data; this.callbacks = callbacks; this.mode = 'city'; this.selected = null; this.snapshot = data.snapshots.length - 1;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(C.paper);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    element.append(this.renderer.domElement);
    this.camera = new THREE.OrthographicCamera(-60, 60, 45, -45, .1, 700);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .07;
    this.controls.maxPolarAngle = Math.PI / 2.12; this.controls.minPolarAngle = .12; this.controls.minZoom = .4; this.controls.maxZoom = 16;
    this.controls.screenSpacePanning = true; this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    this.sun = new THREE.DirectionalLight(0xfff6e3, 2.6); this.sun.position.set(-35, 90, 45); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); Object.assign(this.sun.shadow.camera, { left: -100, right: 100, top: 100, bottom: -100, near: 1, far: 250 });
    this.sun.shadow.normalBias = .12; this.sun.shadow.bias = -.0002; this.scene.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0xf1f3ff, 0xb4b49b, .8));
    this.lots = new Map(); this.positions = new Map(); this.fileIndex = new Map(data.files.map((f, i) => [f.path, i])); this.labels = [];
    this.targetHeights = new Float32Array(data.files.length); this.currentHeights = new Float32Array(data.files.length); this.targetColors = [];
    this.box = new THREE.BoxGeometry(.73, 1, .73); this.box.translate(0, .5, 0);
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .94, metalness: 0 });
    this.buildings = new THREE.InstancedMesh(this.box, this.material, data.files.length); this.buildings.castShadow = true; this.buildings.receiveShadow = true; this.buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.buildings); this.object = new THREE.Object3D();
    this.layout();
    this.arcs = new THREE.Group(); this.scene.add(this.arcs); this.rings = new THREE.Group(); this.scene.add(this.rings);
    this.particles = new THREE.Group(); this.scene.add(this.particles);
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.renderer.domElement.addEventListener('pointermove', e => this.hover(e));
    this.renderer.domElement.addEventListener('pointerleave', () => callbacks.hover(null));
    this.renderer.domElement.addEventListener('pointerdown', e => { this.pointerStart = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!this.pointerStart || Math.hypot(e.clientX - this.pointerStart[0], e.clientY - this.pointerStart[1]) > 5) return;
      const hit = this.pick(e);
      if (hit?.instanceId !== undefined) { const file = this.data.files[hit.instanceId]; callbacks.select(file.district); }
      else { const lot = this.raycaster.intersectObjects([...this.lots.values()].map(l => l.mesh))[0]; if (lot) callbacks.select(lot.object.userData.district); }
    });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(element);
    this.overview(true); this.setSnapshot(this.snapshot, true); this.resize();
    this.lastTime = performance.now(); this.frame = this.frame.bind(this); requestAnimationFrame(this.frame);
  }
  materialFor(color) { return new THREE.MeshStandardMaterial({ color, roughness: .95 }); }
  block(w, h, d, x, y, z, material, group = this.scene) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); mesh.castShadow = h > .3; mesh.receiveShadow = true; group.add(mesh); return mesh;
  }
  layout() {
    const layout = createLayout(this.data);
    this.span = layout.span; this.bounds = layout.bounds;
    this.lots = new Map(layout.lots.map(lot => [lot.id, lot]));
    for (const [path, p] of layout.positions) this.positions.set(path, new THREE.Vector3(p.x, .05, p.z));
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(this.span * 3, this.span * 3), this.materialFor(C.paper));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.y = -.22; this.ground.receiveShadow = true; this.scene.add(this.ground);
    const lotMat = this.materialFor(C.lot), wallMat = this.materialFor(C.wall), curbMat = this.materialFor('#cdd6c4');
    const wall = (a, b, h, material, group) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mesh = this.block(length, h, .17, (a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2, material, group);
      mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); return mesh;
    };
    for (const lot of this.lots.values()) {
      const shape = new THREE.Shape();
      lot.hull.forEach((p, i) => i ? shape.lineTo(p[0], -p[1]) : shape.moveTo(p[0], -p[1])); shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: .16, bevelEnabled: true, bevelSize: .05, bevelThickness: .04, bevelSegments: 1, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      lot.mesh = new THREE.Mesh(geometry, lotMat); lot.mesh.position.y = -.15; lot.mesh.receiveShadow = true; lot.mesh.userData.district = lot.id; this.scene.add(lot.mesh);
      lot.wallGroup = new THREE.Group(); this.scene.add(lot.wallGroup);
      for (let i = 0; i < lot.hull.length; i++) {
        const a = lot.hull[i], b = lot.hull[(i + 1) % lot.hull.length];
        if (lot.walled && i === lot.gateSegment) {
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const lerp = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const ga = lerp(.5 - .8 / length), gb = lerp(.5 + .8 / length);
          wall(a, ga, .75, wallMat, lot.wallGroup); wall(gb, b, .75, wallMat, lot.wallGroup);
          for (const p of [ga, gb]) this.block(.28, 1.35, .28, p[0], .675, p[1], wallMat, lot.wallGroup);
          const lintel = wall(ga, gb, .23, wallMat, lot.wallGroup); lintel.position.y = 1.35;
        } else wall(a, b, lot.walled ? .75 : .055, lot.walled ? wallMat : curbMat, lot.wallGroup);
      }
      if (lot.walled || lot.files.length > 20) this.addLabel(lot);
    }
  }
  addLabel(lot) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#687263'; ctx.font = '500 29px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(lot.id.split('/').pop().replaceAll('_', ' '), 256, 43);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, opacity: .85 }));
    sprite.position.set(lot.x, .8, lot.z + lot.d / 2 + 1.2); sprite.scale.set(Math.min(10, lot.w + 2), 1.56, 1); sprite.userData.district = lot.id;
    this.scene.add(sprite); this.labels.push(sprite);
  }
  resize() {
    const { width, height: h } = this.element.getBoundingClientRect(); this.renderer.setSize(width, h, false);
    const aspect = width / h; const frustum = this.span * .62;
    this.camera.left = -frustum * aspect; this.camera.right = frustum * aspect; this.camera.top = frustum; this.camera.bottom = -frustum; this.camera.updateProjectionMatrix();
  }
  reset(immediate = false) {
    const target = new THREE.Vector3(this.span * .055, 0, 0);
    const position = target.clone().add(new THREE.Vector3(this.span * .85, this.span * .95, this.span * 1.05));
    if (immediate) { this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = 1.27; this.camera.updateProjectionMatrix(); this.controls.update(); }
    else this.flight = { target, position, zoom: 1.27 };
  }
  overview(immediate = false) {
    const core = [...this.lots.values()].filter(l => l.walled);
    if (!core.length) return this.reset(immediate);
    const minX = Math.min(...core.map(l => l.x - l.r)), maxX = Math.max(...core.map(l => l.x + l.r));
    const minZ = Math.min(...core.map(l => l.z - l.r)), maxZ = Math.max(...core.map(l => l.z + l.r));
    const target = new THREE.Vector3((minX + maxX) / 2 + 2, 1, (minZ + maxZ) / 2);
    const position = target.clone().add(new THREE.Vector3(this.span * .85, this.span * .95, this.span * 1.05));
    const zoom = Math.min(5, this.span / Math.max(maxX - minX, maxZ - minZ) * .92);
    if (immediate) { this.controls.target.copy(target); this.camera.position.copy(position); this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.controls.update(); }
    else this.flight = { target, position, zoom };
  }
  select(id, focus = false) {
    this.selected = id; this.setSnapshot(this.snapshot);
    if (focus) {
      const lot = this.lots.get(id); if (!lot) return;
      const target = new THREE.Vector3(lot.x, 1, lot.z);
      this.flight = { target, position: target.clone().add(new THREE.Vector3(this.span * .85, this.span * .95, this.span * 1.05)), zoom: Math.min(12, this.span / Math.max(lot.w, lot.d) * .72) };
    }
  }
  setMode(mode) { this.mode = mode; this.setSnapshot(this.snapshot); }
  disposeGroup(group) { for (const child of [...group.children]) { child.geometry?.dispose(); child.material?.dispose(); group.remove(child); } }
  setSnapshot(index, immediate = false) {
    this.snapshot = Math.min(this.data.snapshots.length - 1, Math.max(0, Math.round(index))); const snapshot = this.data.snapshots[this.snapshot];
    this.current = snapshot;
    const touched = new Set(snapshot.shortcuts.flatMap(e => [e.source, e.target]));
    for (let i = 0; i < this.data.files.length; i++) {
      const f = this.data.files[i], live = snapshot.files[f.path]; const active = live && live.lines > 0;
      this.targetHeights[i] = active ? height(live.lines) : .025;
      if (immediate) this.currentHeights[i] = this.targetHeights[i];
      const age = live ? Math.max(0, snapshot.timestamp - (live.changed || 0)) / 86400 : 999;
      const color = new THREE.Color(this.dark ? '#7e9182' : C.building);
      color.multiplyScalar(.91 + (hash(f.path) % 20) / 100);
      if (live?.gate) color.set(this.dark ? '#aac4a5' : '#e0e9d8');
      if (age < 8 && this.mode !== 'shortcuts') color.lerp(new THREE.Color(C.heat), Math.max(0, 1 - age / 8) * (this.mode === 'activity' ? .95 : .58));
      if (this.mode === 'shortcuts' && touched.has(f.path)) color.lerp(new THREE.Color(C.violet), .5);
      if (!active || (this.mode === 'shortcuts' && !touched.has(f.path))) color.lerp(new THREE.Color(this.dark ? '#33453b' : '#eeefe6'), .8);
      if (this.selected && f.district === this.selected) color.multiplyScalar(1.06);
      this.buildings.setColorAt(i, color);
    }
    this.buildings.instanceColor.needsUpdate = true;
    this.makeArcs(snapshot); this.makeActivity(snapshot);
    for (const label of this.labels) label.material.opacity = this.selected && label.userData.district === this.selected ? 1 : .7;
    if (immediate) this.updateBuildings(1);
  }
  makeArcs(snapshot) {
    this.disposeGroup(this.arcs); this.disposeGroup(this.rings); this.curves = [];
    const bundles = new Map();
    for (const edge of snapshot.shortcuts) {
      const a = snapshot.files[edge.source]?.district, b = snapshot.files[edge.target]?.district;
      if (!a || !b || !this.positions.has(edge.source) || !this.positions.has(edge.target)) continue;
      // Selected district earns file-level detail; the rest stay bundled.
      const detailed = this.selected && [a, b].includes(this.selected);
      const key = detailed ? edge.source + '>' + edge.target : [a, b].sort().join('>');
      if (!bundles.has(key)) bundles.set(key, { a, b, edges: [], detailed });
      bundles.get(key).edges.push(edge);
    }
    const all = [...bundles.values()].sort((a, b) => b.edges.length - a.edges.length).slice(0, 150);
    for (const bundle of all) {
      const start = bundle.detailed ? this.positions.get(bundle.edges[0].source).clone() : new THREE.Vector3(this.lots.get(bundle.a).x, 1.5, this.lots.get(bundle.a).z);
      const end = bundle.detailed ? this.positions.get(bundle.edges[0].target).clone() : new THREE.Vector3(this.lots.get(bundle.b).x, 1.5, this.lots.get(bundle.b).z);
      if (bundle.detailed) { start.y = height(snapshot.files[bundle.edges[0].source]?.lines || 0) + .1; end.y = height(snapshot.files[bundle.edges[0].target]?.lines || 0) + .1; }
      const distance = start.distanceTo(end); const middle = start.clone().lerp(end, .5); middle.y = Math.max(start.y, end.y) + Math.min(17, distance * .35 + 3);
      const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
      const radius = bundle.detailed ? .022 : Math.min(.23, .038 * Math.sqrt(bundle.edges.length));
      const opacity = this.mode === 'activity' ? .13 : bundle.detailed ? .57 : .66;
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 5, false), new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity })); this.arcs.add(tube);
      if (this.curves.length < 30 && this.mode !== 'activity') {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.5 + .045, 6, 6), new THREE.MeshBasicMaterial({ color: '#b98dea', transparent: true, opacity: .95 })); this.arcs.add(dot); this.curves.push({ curve, dot, offset: this.curves.length * .17 });
      }
    }
    for (const desire of snapshot.desirePaths) {
      const pos = this.positions.get(desire.target); if (!pos) continue;
      const radius = .56 + Math.min(.55, desire.districts.length * .07);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, .045, 5, 32), new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity: .75 })); ring.rotation.x = Math.PI / 2; ring.position.copy(pos); ring.position.y = .08; this.rings.add(ring);
    }
  }
  makeActivity(snapshot) {
    this.disposeGroup(this.particles); this.walkers = [];
    const prev = this.data.snapshots[Math.max(0, this.snapshot - 1)].timestamp;
    const changes = this.data.changes.filter(c => c.time > prev && c.time <= snapshot.timestamp);
    for (const [i, change] of changes.slice(-60).entries()) {
      const points = change.files.map(p => this.positions.get(p)).filter(Boolean); if (!points.length) continue;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.13, 6, 6), new THREE.MeshBasicMaterial({ color: C.heat, transparent: true, opacity: .95 }));
      this.particles.add(mesh); this.walkers.push({ mesh, points, offset: i * .19 });
    }
    this.particles.visible = this.mode === 'activity';
  }
  updateBuildings(rate) {
    for (let i = 0; i < this.data.files.length; i++) {
      this.currentHeights[i] += (this.targetHeights[i] - this.currentHeights[i]) * rate;
      this.object.position.copy(this.positions.get(this.data.files[i].path)); this.object.scale.set(1, this.currentHeights[i], 1); this.object.updateMatrix(); this.buildings.setMatrixAt(i, this.object.matrix);
    }
    this.buildings.instanceMatrix.needsUpdate = true;
  }
  pick(event) {
    const r = this.element.getBoundingClientRect(); this.pointer.set((event.clientX - r.left) / r.width * 2 - 1, -(event.clientY - r.top) / r.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera); return this.raycaster.intersectObject(this.buildings)[0];
  }
  hover(event) {
    if (event.buttons) return this.callbacks.hover(null);
    const hit = this.pick(event); if (hit?.instanceId === undefined) { this.callbacks.hover(null); this.renderer.domElement.style.cursor = 'grab'; return; }
    const file = this.data.files[hit.instanceId], live = this.current.files[file.path];
    this.callbacks.hover({ ...file, lines: live?.lines || 0, deleted: !live, x: event.clientX, y: event.clientY }); this.renderer.domElement.style.cursor = 'pointer';
  }
  theme(dark) {
    this.dark = dark; this.scene.background.set(dark ? '#202825' : C.paper); this.ground.material.color.set(dark ? '#28392f' : C.land);
    for (const lot of this.lots.values()) { lot.mesh.material.color.set(dark ? '#3c4e3d' : C.lot); for (const m of lot.wallGroup.children) m.material.color.set(dark ? '#71836c' : C.wall); }
    this.sun.intensity = dark ? 1.7 : 2.6; this.setSnapshot(this.snapshot);
  }
  capture() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
  frame(now) {
    const dt = Math.min(.05, (now - this.lastTime) / 1000); this.lastTime = now;
    if (this.flight) { this.controls.target.lerp(this.flight.target, .065); this.camera.position.lerp(this.flight.position, .065); this.camera.zoom += (this.flight.zoom - this.camera.zoom) * .065; this.camera.updateProjectionMatrix(); if (this.controls.target.distanceTo(this.flight.target) < .03 && Math.abs(this.camera.zoom - this.flight.zoom) < .005) this.flight = null; }
    this.updateBuildings(1 - Math.exp(-dt * 9));
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const { curve, dot, offset } of this.curves || []) dot.position.copy(curve.getPoint((now / 9000 + offset) % 1));
      for (const { mesh, points, offset } of this.walkers || []) { const t = (now / 1700 + offset) % points.length, i = Math.floor(t); mesh.position.copy(points[i]).lerp(points[(i + 1) % points.length], t - i); mesh.position.y = .27; }
    }
    this.controls.update(); this.renderer.render(this.scene, this.camera); this.callbacks.frame?.(now); requestAnimationFrame(this.frame);
  }
}
