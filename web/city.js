import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLayout } from './layout.js';

const C = { paper: '#f4f3ee', land: '#efeee7', lot: '#e1e6d8', wall: '#a9b99c', building: '#a8b9a4', violet: '#8460c4', heat: '#d49b65' };
const hash = str => [...str].reduce((v, c) => (v * 31 + c.charCodeAt(0)) >>> 0, 7);
const height = lines => lines ? Math.min(13, .35 + Math.sqrt(lines) * .205) : .025;
export class City {
  constructor(element, data, callbacks) {
    this.element = element; this.data = data; this.callbacks = callbacks; this.mode = 'city'; this.selected = null; this.snapshot = data.snapshots.length - 1;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(C.paper);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1;
    element.append(this.renderer.domElement);
    this.camera = new THREE.OrthographicCamera(-60, 60, 45, -45, .1, 700);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .07;
    this.controls.maxPolarAngle = Math.PI / 2.12; this.controls.minPolarAngle = .12; this.controls.minZoom = .4; this.controls.maxZoom = 16;
    this.controls.screenSpacePanning = true; this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.scene.add(new THREE.AmbientLight(0xffffff, .65));
    this.sun = new THREE.DirectionalLight(0xfff6e3, 2.8); this.sun.position.set(-50, 85, 40); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); Object.assign(this.sun.shadow.camera, { left: -100, right: 100, top: 100, bottom: -100, near: 1, far: 250 });
    this.sun.shadow.normalBias = .12; this.sun.shadow.bias = -.0002; this.scene.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0xf1f3ff, 0x889377, .9));
    this.lots = new Map(); this.positions = new Map(); this.fileIndex = new Map(data.files.map((f, i) => [f.path, i])); this.labels = [];
    this.targetHeights = new Float32Array(data.files.length); this.currentHeights = new Float32Array(data.files.length); this.targetColors = [];
    this.firstSeen = new Map();
    data.snapshots.forEach((snapshot, index) => { for (const path of Object.keys(snapshot.files)) if (!this.firstSeen.has(path)) this.firstSeen.set(path, index); });
    const footprint = new THREE.Shape(); footprint.moveTo(-.36, -.36); footprint.lineTo(.36, -.36); footprint.lineTo(.36, .36); footprint.lineTo(-.36, .36); footprint.closePath();
    this.box = new THREE.ExtrudeGeometry(footprint, { depth: .92, bevelEnabled: true, bevelSize: .035, bevelThickness: .04, bevelSegments: 2, steps: 1 });
    this.box.rotateX(-Math.PI / 2); this.box.translate(0, .04, 0);
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .74, metalness: 0 });
    this.buildings = new THREE.InstancedMesh(this.box, this.material, data.files.length); this.buildings.castShadow = true; this.buildings.receiveShadow = true; this.buildings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.buildings); this.object = new THREE.Object3D();
    this.roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(.69, .035, .69), this.materialFor('#e9ecde'), data.files.length);
    this.roofs.castShadow = false; this.roofs.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(this.roofs);
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
      if (hit?.instanceId !== undefined) { const file = this.data.files[hit.instanceId]; callbacks.select(file.district); callbacks.selectFile?.(file.path); }
      else { const lot = this.raycaster.intersectObjects([...this.lots.values()].map(l => l.mesh))[0]; if (lot) callbacks.select(lot.object.userData.district); }
    });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(element);
    this.overview(true); this.setSnapshot(this.snapshot, true); this.resize();
    this.lastTime = performance.now(); this.frame = this.frame.bind(this); this.frameId = requestAnimationFrame(this.frame);
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
    const wallMat = this.materialFor(C.wall), curbMat = this.materialFor('#c4ceba'), gateMat = this.materialFor('#d8dec9');
    const wall = (a, b, h, material, group) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mesh = this.block(length, h, .24, (a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2, material, group);
      mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); return mesh;
    };
    for (const lot of this.lots.values()) {
      lot.firstSeen = Math.min(...lot.files.map(f => this.firstSeen.get(f.path) ?? Infinity));
      const shape = new THREE.Shape();
      lot.hull.forEach((p, i) => i ? shape.lineTo(p[0], -p[1]) : shape.moveTo(p[0], -p[1])); shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: .25, bevelEnabled: true, bevelSize: .12, bevelThickness: .06, bevelSegments: 2, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      lot.baseColor = new THREE.Color(C.lot).multiplyScalar(.97 + (hash(lot.id) % 7) / 100);
      lot.mesh = new THREE.Mesh(geometry, this.materialFor(lot.baseColor)); lot.mesh.position.y = -.25; lot.mesh.receiveShadow = true; lot.mesh.userData.district = lot.id; this.scene.add(lot.mesh);
      lot.wallGroup = new THREE.Group(); this.scene.add(lot.wallGroup);
      for (let i = 0; i < lot.hull.length; i++) {
        const a = lot.hull[i], b = lot.hull[(i + 1) % lot.hull.length];
        if (lot.walled && i === lot.gateSegment) {
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const lerp = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const gap = Math.min(1.2, length * .38), ga = lerp(.5 - gap / length), gb = lerp(.5 + gap / length);
          wall(a, ga, 1.05, wallMat, lot.wallGroup); wall(gb, b, 1.05, wallMat, lot.wallGroup);
          for (const p of [ga, gb]) this.block(.4, 1.95, .4, p[0], .975, p[1], gateMat, lot.wallGroup);
          const lintel = wall(ga, gb, .3, gateMat, lot.wallGroup); lintel.position.y = 1.95;
          // A pale threshold makes the public route readable from the overview.
          const threshold = this.block(gap * 2, .04, 1.8, (ga[0] + gb[0]) / 2, .025, (ga[1] + gb[1]) / 2, gateMat, lot.wallGroup);
          threshold.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
        } else wall(a, b, lot.walled ? 1.05 : .06, lot.walled ? wallMat : curbMat, lot.wallGroup);
      }
      if (lot.walled || lot.files.length > 20) this.addLabel(lot);
    }
  }
  addLabel(lot) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#485a45'; ctx.font = '500 29px -apple-system, sans-serif'; ctx.textAlign = 'center';
    const name = lot.id.split('/').pop().replaceAll('_', ' '); ctx.fillText(name, 256, 43, 490);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const darkCanvas = document.createElement('canvas'); darkCanvas.width = 512; darkCanvas.height = 80;
    const darkInk = darkCanvas.getContext('2d'); darkInk.fillStyle = '#bac8b0'; darkInk.font = ctx.font; darkInk.textAlign = 'center'; darkInk.fillText(name, 256, 43, 490);
    const darkTexture = new THREE.CanvasTexture(darkCanvas); darkTexture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, opacity: .85 }));
    sprite.position.set(lot.x, .8, lot.z + lot.d / 2 + 1.2); sprite.scale.set(Math.min(10, lot.w + 2), 1.56, 1); sprite.userData.district = lot.id;
    const active = document.createElement('canvas'); active.width = 512; active.height = 120;
    const ink = active.getContext('2d'); ink.font = '500 30px -apple-system, sans-serif';
    const labelWidth = Math.min(490, ink.measureText(name).width + 70), left = (512 - labelWidth) / 2;
    ink.fillStyle = '#263b33'; ink.beginPath(); ink.roundRect(left, 20, labelWidth, 64, 14); ink.fill();
    ink.beginPath(); ink.moveTo(248, 84); ink.lineTo(256, 96); ink.lineTo(264, 84); ink.fill();
    ink.fillStyle = '#fbfbf3'; ink.textAlign = 'center'; ink.fillText(name, 256, 62, 440);
    const selectedTexture = new THREE.CanvasTexture(active); selectedTexture.colorSpace = THREE.SRGBColorSpace;
    sprite.userData.restPosition = sprite.position.clone(); sprite.userData.restScale = sprite.scale.clone();
    sprite.userData.texture = texture; sprite.userData.darkTexture = darkTexture; sprite.userData.selectedTexture = selectedTexture;
    sprite.userData.textWidth = Math.min(490, ctx.measureText(name).width); sprite.userData.pillWidth = labelWidth;
    this.scene.add(sprite); this.labels.push(sprite);
  }
  resize() {
    const { width, height: h } = this.element.getBoundingClientRect(); if (!width || !h) return; this.renderer.setSize(width, h, false);
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
    const { target, zoom } = this.overviewFraming();
    const position = target.clone().add(new THREE.Vector3(this.span * .85, this.span * .95, this.span * 1.05));
    if (immediate) { this.controls.target.copy(target); this.camera.position.copy(position); this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.controls.update(); }
    else this.flight = { target, position, zoom };
  }
  overviewFraming() {
    const walled = [...this.lots.values()].filter(l => l.walled), core = walled.length ? walled : [...this.lots.values()];
    if (!core.length) return { target: new THREE.Vector3(), zoom: 1.27 };
    const minX = Math.min(...core.map(l => l.x - l.r)), maxX = Math.max(...core.map(l => l.x + l.r));
    const minZ = Math.min(...core.map(l => l.z - l.r)), maxZ = Math.max(...core.map(l => l.z + l.r));
    return { target: new THREE.Vector3((minX + maxX) / 2, 1, (minZ + maxZ) / 2), zoom: Math.min(5, this.span / Math.max(maxX - minX, maxZ - minZ, 1) * .88) };
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
      this.targetHeights[i] = active ? height(live.lines) : this.snapshot >= this.firstSeen.get(f.path) ? .025 : 0;
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
    for (const lot of this.lots.values()) {
      lot.mesh.visible = this.snapshot >= lot.firstSeen; lot.wallGroup.visible = lot.mesh.visible;
      lot.mesh.material.color.copy(this.dark ? new THREE.Color('#384b3e') : lot.baseColor);
      if (lot.id === this.selected) lot.mesh.material.color.lerp(new THREE.Color(this.dark ? '#73628f' : '#d8cdeb'), .33);
    }
    this.makeArcs(snapshot); this.makeActivity(snapshot);
    for (const label of this.labels) {
      const selected = label.userData.district === this.selected, lot = this.lots.get(label.userData.district);
      label.material.opacity = selected ? 1 : .65;
      label.material.map = selected ? label.userData.selectedTexture : this.dark ? label.userData.darkTexture : label.userData.texture;
      label.position.copy(label.userData.restPosition); label.scale.copy(label.userData.restScale);
      if (selected) {
        const roof = Math.max(1, ...lot.files.map(f => height(snapshot.files[f.path]?.lines || 0)));
        label.position.set(lot.x, roof + 2.5, lot.z); label.scale.set(12, 2.81, 1);
      }
    }
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
      const opacity = this.mode === 'activity' ? .09 : bundle.detailed ? .65 : this.mode === 'shortcuts' ? .6 : .27;
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
      this.object.position.copy(this.positions.get(this.data.files[i].path)); const visible = this.currentHeights[i] > .002 ? 1 : 0; this.object.scale.set(visible, this.currentHeights[i], visible); this.object.updateMatrix(); this.buildings.setMatrixAt(i, this.object.matrix);
      this.object.position.y += this.currentHeights[i] + .005; this.object.scale.setScalar(this.currentHeights[i] > .04 ? 1 : 0); this.object.updateMatrix(); this.roofs.setMatrixAt(i, this.object.matrix);
    }
    this.buildings.instanceMatrix.needsUpdate = true; this.roofs.instanceMatrix.needsUpdate = true;
  }
  updateLabels() {
    const width = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    if (!h || !width) return;
    const unit = (this.camera.top - this.camera.bottom) / this.camera.zoom / h, occupied = [];
    // Keep type readable as the camera moves, and hide colliding minor labels.
    const labels = [...this.labels].sort((a, b) => Number(b.userData.district === this.selected) - Number(a.userData.district === this.selected) || Number(this.lots.get(b.userData.district).walled) - Number(this.lots.get(a.userData.district).walled));
    for (const label of labels) {
      const selected = label.userData.district === this.selected, lot = this.lots.get(label.userData.district);
      label.visible = this.snapshot >= lot.firstSeen;
      if (!label.visible) continue;
      const pixels = selected ? 56 : 28, ratio = selected ? 512 / 120 : 512 / 80;
      label.scale.set(pixels * unit * ratio, pixels * unit, 1);
      const point = label.position.clone().project(this.camera), x = (point.x + 1) * width / 2, y = (1 - point.y) * h / 2;
      const textWidth = (selected ? label.userData.pillWidth : label.userData.textWidth) / 512 * pixels * ratio;
      const box = { left: x - textWidth / 2 - 8, right: x + textWidth / 2 + 8, top: y - pixels / 2, bottom: y + pixels / 2 };
      if (point.z < -1 || point.z > 1 || (!selected && occupied.some(b => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top))) label.visible = false;
      if (label.visible) occupied.push(box);
    }
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
    for (const lot of this.lots.values()) for (const m of lot.wallGroup.children) m.material.color.set(dark ? '#71836c' : C.wall);
    this.roofs.material.color.set(dark ? '#b0c0a9' : '#e9ecde');
    this.sun.intensity = dark ? 1.7 : 2.8; this.setSnapshot(this.snapshot);
  }
  capture() { this.updateLabels(); this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
  captureCanvas() { this.updateLabels(); this.renderer.render(this.scene, this.camera); return this.renderer.domElement; }
  setCinematic(progress, districtId) {
    if (!this.cinematic) this.cinematic = { position: this.camera.position.clone(), target: this.controls.target.clone(), zoom: this.camera.zoom };
    this.controls.enabled = false; this.flight = null;
    const p = THREE.MathUtils.clamp(progress, 0, 1), framing = this.overviewFraming(), lot = this.lots.get(districtId);
    const target = lot ? new THREE.Vector3(lot.x, 1, lot.z) : framing.target;
    const zoom = lot ? Math.min(9, this.span / Math.max(lot.w, lot.d) * .42) : framing.zoom * (.92 + p * .1);
    const angle = .57 + p * .46, distance = this.span * 1.35;
    this.controls.target.copy(target);
    this.camera.position.set(target.x + Math.sin(angle) * distance, target.y + this.span * (.91 - p * .05), target.z + Math.cos(angle) * distance);
    this.camera.zoom = zoom; this.camera.lookAt(target); this.camera.updateProjectionMatrix();
  }
  clearCinematic() {
    if (!this.cinematic) return;
    this.camera.position.copy(this.cinematic.position); this.controls.target.copy(this.cinematic.target); this.camera.zoom = this.cinematic.zoom;
    this.camera.updateProjectionMatrix(); this.cinematic = null; this.controls.enabled = true; this.controls.update();
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frameId); this.resizeObserver.disconnect(); this.controls.dispose();
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.scene.traverse(object => { if (object.geometry) geometries.add(object.geometry); for (const material of [object.material].flat().filter(Boolean)) { materials.add(material); if (material.map) textures.add(material.map); } });
    for (const label of this.labels) { textures.add(label.userData.texture); textures.add(label.userData.darkTexture); textures.add(label.userData.selectedTexture); }
    for (const item of [...geometries, ...materials, ...textures]) item.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
  frame(now) {
    if (this.disposed) return;
    const dt = Math.min(.05, (now - this.lastTime) / 1000); this.lastTime = now;
    if (this.flight) { this.controls.target.lerp(this.flight.target, .065); this.camera.position.lerp(this.flight.position, .065); this.camera.zoom += (this.flight.zoom - this.camera.zoom) * .065; this.camera.updateProjectionMatrix(); if (this.controls.target.distanceTo(this.flight.target) < .03 && Math.abs(this.camera.zoom - this.flight.zoom) < .005) this.flight = null; }
    this.updateBuildings(1 - Math.exp(-dt * 9));
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const { curve, dot, offset } of this.curves || []) dot.position.copy(curve.getPoint((now / 9000 + offset) % 1));
      for (const { mesh, points, offset } of this.walkers || []) { const t = (now / 1700 + offset) % points.length, i = Math.floor(t); mesh.position.copy(points[i]).lerp(points[(i + 1) % points.length], t - i); mesh.position.y = .27; }
    }
    if (!this.cinematic) this.controls.update(); this.updateLabels(); this.renderer.render(this.scene, this.camera); this.callbacks.frame?.(now); this.frameId = requestAnimationFrame(this.frame);
  }
}
