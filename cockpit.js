import * as THREE from 'three';

// Live cockpit displays: each Bridge_*Screen mesh gets a canvas quad on the face that points at the pilot.
// The radar redraws at 10 Hz, the text screens once a second (staggered), so the Quest uploads ~1 texture per frame at most.

const PX_PER_M = 1000; // ~600 px across the console screens
const KIND_COLOR = { gas: '#ffb070', ice: '#bfe8ff', ocean: '#4fb8ff', desert: '#e0b070', lava: '#ff6040', iron: '#c0a890', dead: '#a8a8a8' };

// largest triangle group facing the viewer -> a frame (u = viewer's right, v = up) and its extents
export function screenFace(mesh, viewer) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index, N = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  const groups = new Map();
  for (let k = 0; k < N; k += 3) {
    const at = i => (idx ? idx.getX(i) : i);
    a.fromBufferAttribute(pos, at(k)).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, at(k + 1)).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, at(k + 2)).applyMatrix4(mesh.matrixWorld);
    n.crossVectors(e.subVectors(b, a), c.clone().sub(a));
    const area = n.length() / 2; if (area < 1e-6) continue; n.normalize();
    const key = n.toArray().map(x => Math.round(x * 20)).join();
    if (!groups.has(key)) groups.set(key, { n: n.clone(), area: 0, pts: [] });
    const g = groups.get(key); g.area += area; g.pts.push(a.clone(), b.clone(), c.clone());
  }
  let best = null, bestScore = 0;
  for (const g of groups.values()) {
    const centre = g.pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(g.pts.length);
    const score = g.area * g.n.dot(viewer.clone().sub(centre).normalize());
    if (score > bestScore) { bestScore = score; best = { ...g, centre }; }
  }
  if (!best) return null;
  const nn = best.n, up = Math.abs(nn.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  up.addScaledVector(nn, -up.dot(nn)).normalize();
  const right = new THREE.Vector3().crossVectors(up, nn);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of best.pts) {
    const d = p.clone().sub(best.centre), u = d.dot(right), v = d.dot(up);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const centre = best.centre.clone().addScaledVector(right, (u0 + u1) / 2).addScaledVector(up, (v0 + v1) / 2);
  return { centre, right, up, n: nn, w: u1 - u0, h: v1 - v0 };
}

const fmtDist = d => d >= 1.496e9 ? `${(d / 1.496e11).toFixed(d < 1.496e10 ? 3 : 2)}AU` : d >= 1e9 ? `${(d / 1e9).toFixed(1)}Gm` : d >= 1e6 ? `${(d / 1e6).toFixed(1)}Mm` : d >= 1e4 ? `${(d / 1e3).toFixed(0)}km` : `${d.toFixed(0)}m`;
const fmtClock = t => { const s = Math.floor(t); return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const shortName = (b, sys) => b.name.startsWith(sys.name) ? b.name.slice(sys.name.length).trim() || b.name : b.name;

function frame(g, W, H, col, title, right) {
  g.fillStyle = '#020a0b'; g.fillRect(0, 0, W, H);
  g.strokeStyle = col; g.globalAlpha = 0.6; g.lineWidth = 2; g.strokeRect(3, 3, W - 6, H - 6); g.globalAlpha = 1;
  g.font = 'bold 15px monospace'; g.textBaseline = 'middle'; g.fillStyle = col; g.textAlign = 'left';
  g.fillText(title, 12, 16);
  if (right) { g.textAlign = 'right'; g.fillText(right, W - 12, 16); g.textAlign = 'left'; }
  g.globalAlpha = 0.35; g.fillRect(10, 27, W - 20, 1); g.globalAlpha = 1;
}

function drawRadar(g, W, H, I) {
  const col = '#2bd9c4';
  frame(g, W, H, col, 'RADAR // SYSTEM', I.lock ? `WARP LOCK  ${I.lock}` : 'LOG RANGE');
  const cx = H * 0.5 + 6, cy = H * 0.5 + 12, R = H * 0.5 - 22, LO = 6, HI = 12.5;
  const rOf = d => R * Math.min(1, Math.max(0, (Math.log10(d) - LO) / (HI - LO)));
  g.strokeStyle = col; g.lineWidth = 1; g.font = '10px monospace';
  for (const dec of [7, 8, 9, 10, 11, 12]) {
    const r = rOf(10 ** dec); g.globalAlpha = dec % 2 ? 0.18 : 0.35;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    if (dec % 2 === 0) { g.globalAlpha = 0.55; g.fillStyle = col; g.fillText(fmtDist(10 ** dec), cx + 3, cy - r + 7); }
  }
  g.globalAlpha = 0.25; g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  const sweep = (I.t * 1.3) % (Math.PI * 2); // 0 = nose (up), clockwise
  for (let k = 0; k < 18; k++) {
    const a0 = sweep - (k + 1) * 0.05, a1 = sweep - k * 0.05;
    g.globalAlpha = 0.22 * (1 - k / 18); g.fillStyle = col;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2); g.closePath(); g.fill();
  }
  g.globalAlpha = 1;
  const contacts = [];
  const blip = (rel, color, size, label) => {
    const d = rel.length(), th = Math.atan2(rel.x, -rel.z), r = rOf(d);
    const age = (((sweep - th) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
    const x = cx + r * Math.sin(th), y = cy - r * Math.cos(th);
    g.globalAlpha = 1 - age * 0.75; g.fillStyle = color; g.fillRect(x - size / 2, y - size / 2, size, size);
    if (label) { g.font = '10px monospace'; g.fillText(label, x + size, y - size); }
    g.globalAlpha = 1;
    return { d, th };
  };
  const sun = blip(I.sunRel, '#fff2a0', 7, 'STAR');
  for (const b of I.system.bodies) {
    const rel = I.relOf(b); if (b === I.startBody) continue;
    const c = blip(rel, KIND_COLOR[b.kind] || col, b.kind === 'gas' ? 6 : 4, b.parent ? null : shortName(b, I.system));
    contacts.push({ b, ...c });
  }
  g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx + 4, cy + 4); g.lineTo(cx - 4, cy + 4); g.closePath(); g.fill(); // you
  // contact list
  contacts.sort((p, q) => p.d - q.d);
  const x0 = cx + R + 16; g.font = 'bold 11px monospace'; g.fillStyle = col; g.fillText('CONTACTS', x0, 42);
  g.font = '11px monospace';
  g.fillStyle = '#ffffff'; g.fillText(`BELOW  ${shortName(I.startBody, I.system)}`, x0, 58);
  contacts.slice(0, 7).forEach((c, i) => {
    g.fillStyle = KIND_COLOR[c.b.kind] || col;
    const brg = String(Math.round(((c.th * 180 / Math.PI) + 360) % 360)).padStart(3, '0');
    g.fillText(`${brg}  ${shortName(c.b, I.system).padEnd(7).slice(0, 7)} ${fmtDist(c.d)}`, x0, 74 + i * 14);
  });
  g.fillStyle = '#ff8a3d'; g.fillText('LONG RANGE: OFFLINE', x0, H - 16);
  void sun;
}

function drawNav(g, W, H, I) {
  const col = '#2bd9c4';
  frame(g, W, H, col, `NAV // ${I.system.name.toUpperCase()}`, `${I.system.star.cls}-STAR`);
  g.font = 'bold 11px monospace'; g.fillStyle = '#3d8a80';
  const cols = [14, 104, 170, 238, 300];
  ['BODY', 'TYPE', 'DIST', 'GRAV', 'TEMP'].forEach((h, i) => g.fillText(h, cols[i], 40));
  const list = I.system.bodies.map(b => ({ b, d: I.relOf(b).length() })).sort((p, q) => (p.b === I.startBody ? -1 : q.b === I.startBody ? 1 : p.d - q.d));
  g.font = '12px monospace';
  const rowH = 15, max = Math.floor((H - 80) / rowH);
  list.slice(0, max).forEach(({ b, d }, i) => {
    const y = 56 + i * rowH, sel = b === I.startBody;
    if (sel) { g.fillStyle = '#0f3a36'; g.fillRect(8, y - 7, W - 16, rowH - 1); }
    g.fillStyle = sel ? '#ffffff' : KIND_COLOR[b.kind] || col;
    g.fillText(`${sel ? '>' : ' '}${shortName(b, I.system).slice(0, 9)}`, cols[0], y);
    g.fillText(b.kind.toUpperCase(), cols[1], y);
    g.fillText(sel ? fmtDist(Math.max(0, I.alt)) : fmtDist(d), cols[2], y);
    g.fillText(`${(b.gravity / 9.81).toFixed(2)}g`, cols[3], y);
    g.fillText(`${b.temperature.surface}K`, cols[4], y);
  });
  g.fillStyle = '#ffb347'; g.font = 'bold 11px monospace';
  g.fillText(`TARGET ${shortName(I.startBody, I.system).toUpperCase()}  //  ${I.startBody.kind === 'gas' ? 'NO SURFACE' : 'LANDING OK'}`, 14, H - 16);
}

function drawDash(g, W, H, I) {
  const col = '#2bd9c4';
  g.fillStyle = '#020a0b'; g.fillRect(0, 0, W, H);
  g.strokeStyle = col; g.globalAlpha = 0.6; g.lineWidth = 2; g.strokeRect(3, 3, W - 6, H - 6); g.globalAlpha = 1;
  g.textBaseline = 'middle';
  const cells = [['MODE', I.mode], ['ALT', fmtDist(Math.max(0, I.alt))], ['V/S', `${I.vs >= 0 ? '+' : ''}${I.vs.toFixed(1)}m/s`], ['GND', `${I.gs.toFixed(1)}m/s`], ['FUEL', `${Math.round(I.fuel)}%`]];
  const cw = W * 0.115;
  cells.forEach(([k, v], i) => {
    const x = 14 + i * cw;
    g.font = 'bold 12px monospace'; g.fillStyle = '#3d8a80'; g.fillText(k, x, 22);
    g.font = 'bold 22px monospace'; g.fillStyle = k === 'MODE' || (k === 'FUEL' && I.fuel < 25) ? '#ffb347' : '#bff5ee'; g.fillText(v, x, H - 30);
  });
  const legend = [['1', 'AUTO LAND'], ['2', 'TAKEOFF'], ['3', 'HOLD']];
  const lx = 14 + 5 * cw + 10, lw = (W - lx - 14) / 3;
  legend.forEach(([n, l], i) => {
    const x = lx + i * lw, hot = I.mode === ['DESCENT', 'ASCENT', 'HOLD'][i];
    g.fillStyle = hot ? '#ffb347' : '#0d1c1e'; g.fillRect(x, 12, lw - 10, H - 24);
    g.strokeStyle = '#ffb347'; g.lineWidth = 1; g.strokeRect(x + 0.5, 12.5, lw - 11, H - 25);
    g.fillStyle = hot ? '#020a0b' : '#ffb347'; g.font = 'bold 13px monospace'; g.fillText(`[${n}] ${l}`, x + 8, H / 2);
  });
}

function drawComms(g, W, H, I) {
  const col = '#2bd9c4';
  frame(g, W, H, col, 'COMMS', 'RX ONLY');
  for (let k = 0; k < 500; k++) { g.fillStyle = `rgba(43,217,196,${Math.random() * 0.25})`; g.fillRect(10 + Math.random() * (W - 20), 34 + Math.random() * (H - 80), 2, 2); }
  const f = 1420.405 + Math.sin(I.t * 0.3) * 12;
  g.font = 'bold 18px monospace'; g.fillStyle = col; g.fillText(`SCAN ${f.toFixed(3)} MHz`, 14, H * 0.5);
  g.font = 'bold 14px monospace'; g.fillStyle = Math.floor(I.t) % 2 ? '#ff8a3d' : '#7a3a10'; g.fillText('NO SIGNAL', 14, H - 20);
}

function drawSchematic(g, W, H, I) {
  const col = '#2bd9c4';
  frame(g, W, H, col, 'SHIP // DECKS', I.place === 'inside' ? 'ABOARD' : 'EVA');
  // top-down hull: blender y -11..12 maps to x; rooms from the interior layout
  const x0 = 20, x1 = W - 20, yc = H * 0.58, sc = (x1 - x0) / 23.5, X = y => x0 + (y + 11.5) * sc, hw = 2.05 * sc;
  const rooms = [['ENG', -11, -7.5], ['CARGO', -7.5, -4], ['SUIT', -4, -1.5], ['LAB', -1.5, 2.5], ['HAB', 2.5, 7], ['BRIDGE', 7, 12]];
  const py = I.player ? -I.player.z : null;
  g.lineWidth = 1; g.font = '10px monospace';
  for (const [n, a, b] of rooms) {
    const here = py !== null && py >= a && py < b;
    g.fillStyle = here ? '#0f3a36' : '#06161a'; g.fillRect(X(a), yc - hw, X(b) - X(a), hw * 2);
    g.strokeStyle = col; g.strokeRect(X(a) + 0.5, yc - hw + 0.5, X(b) - X(a) - 1, hw * 2 - 1);
    g.fillStyle = here ? '#ffffff' : col; g.fillText(n, X(a) + 4, yc);
  }
  g.fillStyle = '#ffb347'; g.fillRect(X(-3.69), yc - hw - 12, X(-1.81) - X(-3.69), 12); // airlock
  g.fillStyle = '#020a0b'; g.fillText('LOCK', X(-3.6), yc - hw - 6);
  if (py !== null) { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(X(py), yc + (I.player.x / 2.05) * hw, 3, 0, Math.PI * 2); g.fill(); }
}

const SCREENS = {
  Bridge_Screen0: { draw: drawRadar, hz: 6 },
  Bridge_Screen2: { draw: drawNav, hz: 1 },
  Bridge_DashScreen: { draw: drawDash, hz: 2, hud: true }, // a see-through combiner over the windscreen
  'Bridge_SideScreen-1': { draw: drawComms, hz: 4, ppm: 560 },
  Bridge_SideScreen1: { draw: drawSchematic, hz: 1, ppm: 560 },
};

// root: the loaded interior (at the origin, unrotated). viewer: pilot eye in world space. Returns the quad materials
// (so the caller can keep them out of the retro shader) and an update(dt, info) to call every frame while aboard.
export function makeCockpitScreens(root, viewer) {
  const live = [];
  for (const [name, def] of Object.entries(SCREENS)) {
    const mesh = root.getObjectByName(name); if (!mesh?.isMesh) continue;
    const f = screenFace(mesh, viewer); if (!f) continue;
    const canvas = document.createElement('canvas');
    const ppm = def.ppm ?? PX_PER_M; // lower density = bigger text on the far screens
    canvas.width = Math.max(128, Math.round(f.w * ppm)); canvas.height = Math.max(64, Math.round(f.h * ppm));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = tex.magFilter = THREE.LinearFilter;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(f.w * 0.97, f.h * 0.95), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    quad.name = `${name}_live`;
    if (def.hud) { Object.assign(quad.material, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }); mesh.visible = false; } // black = clear
    quad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.right, f.up, f.n));
    quad.position.copy(f.centre).addScaledVector(f.n, 0.002);
    root.add(quad);
    live.push({ name, def, canvas, g: canvas.getContext('2d'), tex, quad, feed: null, next: live.length * 0.17 });
  }
  let t = 0;
  return {
    materials: live.map(s => s.quad.material),
    update(dt, info) {
      t += dt;
      let drawn = 0;
      for (const s of live) {
        if (s.feed || t < s.next || drawn >= 2) continue; // at most two uploads per frame
        s.next = t + 1 / s.def.hz; drawn++;
        s.def.draw(s.g, s.canvas.width, s.canvas.height, { ...info, t });
        s.tex.needsUpdate = true;
      }
    },
    setFeed(name, tex) { // show a render target (the landing camera) instead of the screen's own canvas
      const s = live.find(l => l.name === name); if (!s) return;
      s.feed = tex; s.quad.material.map = tex || s.tex; s.quad.material.needsUpdate = true;
    },
  }; // the quads live under root, so disposeShip frees them with the rest of the interior
}
