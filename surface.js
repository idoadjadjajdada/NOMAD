// PlanetSurface: a cube-sphere quadtree of terrain chunks, built in workers and drawn around a floating origin.
// The camera's planet-frame position stays in doubles; each drawn chunk is placed at (chunk centre - camera), so
// nothing near you is ever far from (0,0,0). A parent stays on screen until all four of its children are ready.
import * as THREE from 'three';
import { makeTerrain, faceDir, nodeSize } from './terrain.js';

const VIEW_HALF_ANGLE = 1.22; // 70 degrees: wider than the Quest 3's per-eye field of view, so turning your head never shows a hole

export class PlanetSurface {
  constructor(body, material, { segs = 32, splitK = 1.25, cacheMax = 600, uploadsPerFrame = 4 } = {}) { // splitK, cacheMax: placeholders until Quest numbers
    Object.assign(this, { body, material, segs, splitK, cacheMax, uploadsPerFrame });
    this.R = body.radius;
    this.terrain = makeTerrain(body); // same height field as the workers, for ground queries here
    this.maxLevel = Math.floor(Math.log2(nodeSize(this.R, 0) / segs)); // leaves end up with 1-2 m between vertices
    this.group = new THREE.Group();
    this.nodes = new Map();
    this.roots = [0, 1, 2, 3, 4, 5].map(f => this.node(f, 0, 0, 0));
    this.queue = []; this.inbox = []; this.drawn = []; this.frame = 0; this.meshes = 0;
    this.stats = { drawn: 0, cached: 0, queued: 0, genMs: 0, updateMs: 0, updateMaxMs: 0, level: 0 };
    this.bodyMsg = { kind: body.kind, seed: body.seed, radius: body.radius, life: body.life };
    const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      w.jobs = 0;
      w.onmessage = e => { w.jobs--; this.inbox.push(e.data); this.feed(w); }; // keep workers busy between frames too
      return w;
    });
    this._maxT = 0; this._sumT = 0; this._frames = 0; this._statT = performance.now();
  }

  node(face, level, ix, iy) {
    const du = 2 / (1 << level), key = `${face}/${level}/${ix}/${iy}`;
    const n = { face, level, ix, iy, key, kids: null, mesh: null, pending: false, used: 0, dist: 0,
      size: nodeSize(this.R, level), dir: faceDir(face, -1 + (ix + 0.5) * du, -1 + (iy + 0.5) * du),
      center: null, minH: this.terrain.min, maxH: this.terrain.max };
    this.nodes.set(key, n);
    return n;
  }

  ground(dir) { return this.terrain.height(dir.x, dir.y, dir.z); }

  // cam: camera position in the planet frame (metres, doubles). viewQ: planet frame -> view frame. fwd: view direction, planet frame.
  update(cam, viewQ, fwd) {
    const t0 = performance.now();
    this.frame++;
    Object.assign(this, { cam, viewQ, fwd });
    this.receive();
    const camR = Math.hypot(cam[0], cam[1], cam[2]);
    this.rMin = this.R + this.terrain.min;
    this.horizon = Math.sqrt(Math.max(0, camR * camR - this.rMin * this.rMin)); // over the lowest possible ground
    const prev = this.drawn;
    this.drawn = []; this.deepest = 0;
    for (const r of this.roots) this.visit(r);
    for (const m of prev) if (m.userData.frame !== this.frame) m.visible = false;
    this.dispatch();
    if (this.frame % 30 === 0 && this.meshes > this.cacheMax) this.evict();
    const dt = performance.now() - t0;
    this._sumT += dt; this._frames++; this._maxT = Math.max(this._maxT, dt);
    if (t0 - this._statT > 1000) {
      Object.assign(this.stats, { updateMs: +(this._sumT / this._frames).toFixed(2), updateMaxMs: +this._maxT.toFixed(2) });
      this._sumT = this._maxT = this._frames = 0; this._statT = t0;
    }
    Object.assign(this.stats, { drawn: this.drawn.length, cached: this.meshes, queued: this.queue.length, level: this.deepest });
  }

  visit(n) {
    n.used = this.frame;
    if (!n.mesh) { this.want(n); return; }
    const c = n.center, cam = this.cam;
    const dx = c[0] - cam[0], dy = c[1] - cam[1], dz = c[2] - cam[2], dist = Math.hypot(dx, dy, dz);
    const bound = n.size * 0.75 + (n.maxH - n.minH);
    const rTop = this.R + n.maxH; // can any of it peek over the horizon?
    if (dist - bound > this.horizon + Math.sqrt(Math.max(0, rTop * rTop - this.rMin * this.rMin))) return;
    if (n.level < this.maxLevel && dist - (n.maxH - n.minH) < this.splitK * n.size) { // about 3*pi*K^2 chunks per level
      n.kids ||= [0, 1, 2, 3].map(k => this.node(n.face, n.level + 1, n.ix * 2 + (k & 1), n.iy * 2 + (k >> 1)));
      if (n.kids.every(k => k.mesh)) { for (const k of n.kids) this.visit(k); return; }
      for (const k of n.kids) { k.used = this.frame; if (!k.mesh) this.want(k); }
    }
    if (dist > bound && Math.acos((dx * this.fwd[0] + dy * this.fwd[1] + dz * this.fwd[2]) / dist) - Math.asin(bound / dist) > VIEW_HALF_ANGLE) return;
    const m = n.mesh;
    m.visible = true; m.userData.frame = this.frame;
    m.position.set(dx, dy, dz).applyQuaternion(this.viewQ);
    m.quaternion.copy(this.viewQ);
    this.drawn.push(m);
    this.deepest = Math.max(this.deepest, n.level);
  }

  want(n) {
    if (n.pending) return;
    n.pending = true;
    const R = this.R, cam = this.cam;
    n.dist = Math.hypot(n.dir[0] * R - cam[0], n.dir[1] * R - cam[1], n.dir[2] * R - cam[2]);
    this.queue.push(n);
  }

  dispatch() { // drop requests nobody asked for this frame, then coarse and close first
    this.queue = this.queue.filter(n => n.used === this.frame || (n.pending = false));
    this.queue.sort((a, b) => a.level - b.level || a.dist - b.dist);
    for (const w of this.workers) this.feed(w);
  }

  feed(w) {
    while (w.jobs < 2 && this.queue.length) {
      const n = this.queue.shift();
      w.jobs++;
      w.postMessage({ key: n.key, body: this.bodyMsg, face: n.face, level: n.level, ix: n.ix, iy: n.iy, segs: this.segs, maxLevel: this.maxLevel });
    }
  }

  receive() { // a few uploads per frame so a burst of finished chunks can't stall a frame
    for (let k = 0; k < this.uploadsPerFrame && this.inbox.length; k++) {
      const r = this.inbox.shift(), n = this.nodes.get(r.key);
      n.pending = false;
      if (n.mesh) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
      g.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
      if (r.glow) g.setAttribute('glow', new THREE.BufferAttribute(r.glow, 1));
      g.setIndex(new THREE.BufferAttribute(r.index, 1));
      const m = new THREE.Mesh(g, this.material);
      m.frustumCulled = false; // the shader pulls far chunks in, so three's far-plane test would wrongly drop them
      m.visible = false;
      this.group.add(m);
      Object.assign(n, { mesh: m, center: r.center, minH: r.minH, maxH: r.maxH });
      this.meshes++;
      this.stats.genMs = +(this.stats.genMs * 0.9 + r.ms * 0.1).toFixed(2);
    }
  }

  evict() { // least recently used first; roots stay
    // shortcut: node objects are never pruned (a few hundred bytes each); prune empty subtrees if long walks grow memory
    const old = [...this.nodes.values()].filter(n => n.mesh && n.level > 0 && n.used < this.frame - 60).sort((a, b) => a.used - b.used);
    for (const n of old.slice(0, this.meshes - Math.floor(this.cacheMax * 0.9))) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null; n.center = null; this.meshes--;
    }
  }

  statsText() {
    const s = this.stats;
    return `terrain: ${s.drawn} drawn / ${s.cached} cached / ${s.queued} queued  L${s.level}/${this.maxLevel}  gen ${s.genMs} ms  update avg ${s.updateMs} max ${s.updateMaxMs} ms`;
  }
}
