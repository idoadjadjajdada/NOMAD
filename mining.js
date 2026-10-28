import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RESOURCES, COMPOSITION, depositsNear, makeInventory } from './resources.js';
import { screenFace } from './cockpit.js';
import { mulberry32 } from './universe.js';

// Field gear: resource deposits around the landed ship; a backpack you pull round from over your shoulder, holding a
// mining tool, a scanner and a specimen rack; the suit's kg inventory, unloaded into the ship's hold in the cargo bay.
const SUIT_KG = 40, HOLD_KG = 2000;      // placeholders until upgrades exist
const RANGE = 6;                         // metres
const RINGS = 4;                         // deposit cells each side of the ship: ~30 deposits within ~180 m
// a held tool in the glove holder's frame (-Z pointing, +Y thumb side, origin at the controller grip): the grip sits in
// the fist, a little palm-ward and forward of the controller's grip point. x mirrors for the left hand. Tune in VR.
const TOOL_POS = new THREE.Vector3(-0.03, -0.005, -0.035);
const SCAN_RANGE = 30;

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);

const paint = (g, c) => { // flat vertex colour on a non-indexed part
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g;
};
const rock = (r, s, sx = 1, sy = 0.65) => { // a lumpy boulder: a jittered icosahedron
  const g = new THREE.IcosahedronGeometry(s, 0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * sx * (0.8 + r() * 0.4), p.getY(i) * sy * (0.8 + r() * 0.4), p.getZ(i) * (0.8 + r() * 0.4));
  return g.toNonIndexed();
};
const crystal = (r, h, w) => { // a pentagonal prism with a point
  const g = mergeGeometries([new THREE.CylinderGeometry(w, w * 1.15, h, 5, 1).translate(0, h / 2, 0).toNonIndexed(),
    new THREE.ConeGeometry(w, w * 2.2, 5, 1).translate(0, h + w * 1.1, 0).toNonIndexed()]);
  return g.rotateZ((0.15 + r() * 0.5) * (r() < 0.5 ? -1 : 1)).rotateY(r() * 6.283);
};
// one look per resource, ~1 m at scale 1. Vertex colours carry the look; the shared material glows by colour squared,
// so dark rock barely glows and veins, ice and crystals catch the eye.
const LOOK = {
  Iron:      { rock: 0x5a2f1e, vein: 0xd06a3a, boulders: [3, 5], veins: 5 },  // rusty boulders, hot metal veins
  Ice:       { rock: 0x9cc8e8, vein: 0xe8f6ff, boulders: [2, 4], slabs: true }, // pale blue slabs
  Silicate:  { rock: 0x8a7a5e, vein: 0xf0e6c8, boulders: [3, 5], shards: 3, layered: true }, // banded rock, quartz glints
  Carbon:    { rock: 0x1c1b1d, vein: 0x4a4a55, boulders: [4, 6], glassy: true },  // black glassy lumps
  RareMetal: { rock: 0x4a4038, vein: 0xf0c040, boulders: [2, 4], veins: 6 },  // dull rock, gold veins
  Exotic:    { rock: 0x2a2030, vein: 0xc060ff, boulders: [2, 3], shards: 6 },  // the one that's still crystals
};
function depositGeometry(seed, type) {
  const r = mulberry32(seed), L = LOOK[type], parts = [], rockC = new THREE.Color(L.rock), veinC = new THREE.Color(L.vein);
  const nb = L.boulders[0] + Math.floor(r() * (L.boulders[1] - L.boulders[0] + 1));
  for (let i = 0; i < nb; i++) {
    const a = r() * 6.283, d = i === 0 ? 0 : 0.2 + r() * 0.35, s = i === 0 ? 0.42 : 0.16 + r() * 0.2;
    const g = L.slabs ? rock(r, s, 1.3, 0.35).rotateZ(0.3 + r() * 0.6) : rock(r, s, 1, L.glassy ? 0.8 : 0.65);
    g.rotateY(r() * 6.283).translate(Math.cos(a) * d, s * (L.slabs ? 0.5 : 0.3), Math.sin(a) * d);
    if (L.layered) { // light and dark bands by height
      const p = g.attributes.position, c = new Float32Array(p.count * 3);
      for (let k = 0; k < p.count; k++) rockC.clone().multiplyScalar(Math.sin(p.getY(k) * 40) > 0 ? 1.15 : 0.75).toArray(c, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.deleteAttribute('uv'); parts.push(g);
    } else parts.push(paint(g, rockC.clone().multiplyScalar(0.8 + r() * 0.4).toArray()));
  }
  for (let i = 0; i < (L.veins || 0); i++) { // flat veins pressed into the boulders
    const a = r() * 6.283, d = r() * 0.3, h = 0.1 + r() * 0.35;
    parts.push(paint(new THREE.BoxGeometry(0.03, 0.02, 0.18 + r() * 0.2).toNonIndexed().rotateX(r() * 1.2).rotateY(r() * 6.283).translate(Math.cos(a) * d, h, Math.sin(a) * d), veinC.toArray()));
  }
  for (let i = 0; i < (L.shards || 0); i++) {
    const a = r() * 6.283, d = i === 0 ? 0 : 0.1 + r() * 0.3;
    parts.push(paint(crystal(r, i === 0 && type === 'Exotic' ? 0.8 : 0.15 + r() * 0.35, 0.04 + r() * 0.06).translate(Math.cos(a) * d, 0.1, Math.sin(a) * d), veinC.clone().multiplyScalar(type === 'Exotic' ? 1.6 : 1).toArray()));
  }
  const g = mergeGeometries(parts); parts.forEach(p => p.dispose());
  g.computeVertexNormals();
  return g;
}

export function createMining({ scene, retro, nearLit, keepCrisp, say, beep, buzz, research }) { // nearLit: the gloves' helmet-lamp fix
  const inv = makeInventory(SUIT_KG), store = makeInventory(HOLD_KG);
  const stats = { rate: 3, drain: 1.25, scan: 15 }; // kg/s of deposit, battery %/s (80 s a charge), metres the miner reads; upgrades raise them
  const depositMat = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.1, flatShading: true });
  depositMat.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vColor.rgb * vColor.rgb * 2.0;'); };
  depositMat.customProgramCacheKey = () => 'deposit'; // squared: veins and ice glow, dark rock barely does
  retro(depositMat);
  const left = new Map();                // deposit id -> kg left (saved)
  let deposits = [], loose = [];         // deposits; specimens lying on the ground or in a hand
  let spawnedFor = null, full = false;
  const cells = { miner: 100, scanner: 100 }; // tool batteries, %; they charge only while the pack sits on its dock aboard

  // ---- gear: two tools and the pack, loaded once ----
  const tools = {}, pack = { root: null, open: false, hand: null, docked: false, slots: {}, rack: [], samples: [] };
  const screenOn = (root, name, W, H) => { // a canvas on the tool's rear screen, built while the model sits at the origin
    const mesh = root.getObjectByName(name), f = mesh && screenFace(mesh, new THREE.Vector3(0, 0.3, 0.35)); if (!f) return null;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(f.w * 0.94, f.h * 0.92), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    quad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.right, f.up, f.n)); quad.position.copy(f.centre).addScaledVector(f.n, 0.0008);
    keepCrisp(quad.material); root.add(quad);
    return { canvas, g: canvas.getContext('2d'), tex, next: 0 };
  };
  new GLTFLoader().load('tools.glb', g => {
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o => { if (o.isMesh) { o.frustumCulled = false; [].concat(o.material).forEach(m => { nearLit(m); retro(m); }); } });
    for (const [id, name, scr, emit] of [['miner', 'Tool_Miner', 'Tool_Screen', 'Tool_Emitter'], ['scanner', 'Tool_Scanner', 'Scanner_Screen', 'Scanner_Emitter']]) {
      const root = g.scene.getObjectByName(name); if (!root) continue;
      const t = { id, root, hand: null, emitter: root.getObjectByName(emit), screen: screenOn(root, scr, 320, 240), lens: null };
      root.traverse(o => { if (o.isMesh && o.material.name === 'ToolLens') t.lens = o.material = o.material.clone(); });
      tools[id] = t;
    }
    pack.root = g.scene.getObjectByName('Pack');
    if (pack.root) {
      pack.slots = { miner: pack.root.getObjectByName('Pack_SlotMiner'), scanner: pack.root.getObjectByName('Pack_SlotScanner') };
      pack.rack = [0, 1, 2, 3].map(k => pack.root.getObjectByName('Pack_Sample' + k));
      for (const t of Object.values(tools)) stow(t);
      fillRack(); pack.root.removeFromParent();
    }
  });
  function specimenMesh(type) {
    const m = new THREE.Mesh(specimenGeo, new THREE.MeshStandardMaterial({ color: RESOURCES[type].color, emissive: RESOURCES[type].color, emissiveIntensity: 0.5, flatShading: true, roughness: 0.3 }));
    retro(m.material); return m;
  }
  function fillRack() { // a mesh in each rack slot that has a sample but no mesh yet (after a load)
    pack.samples.forEach((type, k) => { const r = pack.rack[k]; if (r && !r.children.length) { const m = specimenMesh(type); r.add(m); m.position.set(0, 0.03, 0); } });
  }
  function stow(t) { // into its cradle in the pack
    if (t.hand) t.hand = null;
    const slot = pack.slots[t.id]; if (!slot) return;
    slot.add(t.root); t.root.position.set(0, 0, 0); t.root.quaternion.identity();
  }
  function draw(t, h) {
    t.hand = h; h.glove.add(t.root); t.root.quaternion.identity();
    t.root.position.copy(TOOL_POS); if (h.glove.userData.side === 'left') t.root.position.x *= -1;
    say(t.id === 'miner' ? `MINING TOOL  //  ${Math.round(cells.miner)}%` : `SCANNER  //  ${Math.round(cells.scanner)}%`); beep(880); buzz(h, 0.7, 50);
  }
  const heldBy = h => Object.values(tools).find(t => t.hand === h) || null;
  const specimenGeo = new THREE.OctahedronGeometry(0.035, 0).scale(0.7, 1.4, 0.7);

  // ---- beam, scan cone, sparks ----
  const addMat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
  const beam = new THREE.Group();
  beam.add(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1, 6, 1, true).translate(0, 0.5, 0), addMat(0xe8fbff, 0.9)),
    new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.01, 1, 8, 1, true).translate(0, 0.5, 0), addMat(0x3fd0ff, 0.35)));
  beam.visible = false; scene.add(beam);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1, 16, 1, true).translate(0, -0.5, 0).rotateX(Math.PI), addMat(0x5ee08a, 0.12));
  cone.visible = false; scene.add(cone);
  const SPARKS = 60, sparkGeo = new THREE.BufferGeometry(), sparkVel = Array.from({ length: SPARKS }, () => new THREE.Vector3()), sparkLife = new Float32Array(SPARKS);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3).fill(-9999), 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: 0xffc070, size: 3, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sparks.frustumCulled = false; scene.add(sparks);
  let sparkNext = 0;

  function clear() { for (const x of deposits) { scene.remove(x.mesh); x.mesh.geometry.dispose(); } deposits = []; spawnedFor = null; for (const s of loose) if (!s.hand) s.mesh.removeFromParent(); loose = loose.filter(s => s.hand); }
  // place deposits on the ground around the ship, in the view frame (static while landed)
  function spawn(craft, body, ground) {
    clear();
    const R = body.radius, cam = new THREE.Vector3().fromArray(craft.cam);
    for (const d of depositsNear(body, craft.dir.toArray(), RINGS)) {
      const key = `${body.id}|${d.id}`, mass = left.has(key) ? left.get(key) : d.mass; // deposit ids repeat on every body
      if (mass <= 0.01) continue; // mined out
      const dir = new THREE.Vector3().fromArray(d.dir), up = dir.clone().applyQuaternion(craft.q);
      if (body.kind === 'ocean' && ground(dir) < 0.5) continue; // nothing on the sea floor
      const mesh = new THREE.Mesh(depositGeometry(d.shape, d.type), depositMat);
      mesh.position.copy(dir).multiplyScalar(R + ground(dir)).sub(cam).applyQuaternion(craft.q);
      if (Math.hypot(mesh.position.x, mesh.position.z) < 16) { mesh.geometry.dispose(); continue; } // not under the ship
      mesh.quaternion.setFromUnitVectors(Y, up);
      const x = { d, key, mesh, mass, up, s: 1, centre: new THREE.Vector3() };
      resize(x); scene.add(mesh); deposits.push(x);
    }
    spawnedFor = craft.dir.clone();
  }
  function resize(x) { // size follows what's left; sink the base a little so it grows out of the ground
    x.s = Math.max(0.35, Math.cbrt(x.mass / 25)); // 30 kg ~1.1 m across, 140 kg ~1.9 m
    x.mesh.scale.setScalar(x.s);
    x.mesh.position.addScaledVector(x.up, x.mesh.userData.sunk || 0); // undo the last sink first
    x.mesh.userData.sunk = 0.12 * x.s; x.mesh.position.addScaledVector(x.up, -x.mesh.userData.sunk);
    x.centre.copy(x.mesh.position).addScaledVector(x.up, 0.3 * x.s);
  }
  function aimed(origin, dir, range) { // nearest deposit the ray passes through, as { x, t }
    let best = null;
    for (const x of deposits) {
      _v.copy(x.centre).sub(origin); const t = _v.dot(dir); if (t < 0 || t > range) continue;
      const r = 0.6 * x.s; if (_v.lengthSq() - t * t > r * r) continue;
      if (!best || t < best.t) best = { x, t };
    }
    return best;
  }
  function spark(p, n) {
    const pos = sparkGeo.attributes.position;
    for (let k = 0; k < n; k++) {
      const i = sparkNext; sparkNext = (sparkNext + 1) % SPARKS;
      sparkLife[i] = 0.25 + Math.random() * 0.3; pos.setXYZ(i, p.x, p.y, p.z);
      sparkVel[i].set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(3);
    }
  }
  const groundHit = (ctx, range) => { for (let t = 0.3; t < range; t += 0.3) if (ctx.heightAboveGround(_v.copy(_e).addScaledVector(_d, t)) < 0) return t; return null; };

  // ---- the tool screens ----
  const scr = { bg: '#020a0b', ink: '#2bd9c4', dim: '#3d8a80', text: '#bff5ee', amber: '#ffb347', warn: '#ff5a4a', ok: '#5ee08a' };
  function paintMiner(t, info) {
    const g = t.screen.g; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = scr.bg; g.fillRect(0, 0, 320, 240);
    g.strokeStyle = scr.ink; g.lineWidth = 3; g.strokeRect(3, 3, 314, 234); g.textBaseline = 'middle';
    g.font = 'bold 28px monospace'; g.fillStyle = scr.ink; g.fillText('MINER', 14, 30);
    g.textAlign = 'right'; g.fillStyle = info.mode === 'FULL' || info.mode === 'EMPTY' ? scr.warn : info.mode === 'MINING' ? scr.amber : scr.ok; g.fillText(info.mode, 306, 30); g.textAlign = 'left';
    const bar = (y, f, col, label) => { g.font = 'bold 22px monospace'; g.fillStyle = scr.dim; g.fillText(label, 14, y); g.fillStyle = '#10262a'; g.fillRect(110, y - 11, 196, 22); g.fillStyle = col; g.fillRect(110, y - 11, 196 * Math.max(0, Math.min(1, f)), 22); };
    bar(78, cells.miner / 100, cells.miner < 20 ? scr.warn : scr.ok, 'CELL'); bar(114, inv.total() / inv.capacity, scr.amber, 'CARGO');
    g.font = 'bold 20px monospace'; g.fillStyle = scr.text; g.fillText(`${inv.total().toFixed(1)} / ${inv.capacity} KG`, 110, 146);
    if (info.target) { const x = info.target; g.fillStyle = scr.amber; g.fillText(RESOURCES[x.d.type].label, 14, 186); g.fillStyle = scr.text; g.fillText(`${Math.round(x.mass)} KG  ${Math.round(x.d.purity * 100)}%`, 14, 214); }
    else { g.fillStyle = scr.dim; g.fillText('AIM AT A DEPOSIT', 14, 200); }
    t.screen.tex.needsUpdate = true;
  }
  function paintScanner(t, info) {
    const g = t.screen.g; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = scr.bg; g.fillRect(0, 0, 320, 240);
    g.strokeStyle = scr.ok; g.lineWidth = 3; g.strokeRect(3, 3, 314, 234); g.textBaseline = 'middle';
    g.font = 'bold 24px monospace'; g.fillStyle = scr.ok; g.fillText('SPECTROMETER', 14, 28);
    g.textAlign = 'right'; g.fillStyle = cells.scanner < 20 ? scr.warn : scr.dim; g.fillText(`${Math.round(cells.scanner)}%`, 306, 28); g.textAlign = 'left';
    const b = info.body, x = info.target;
    g.font = 'bold 18px monospace';
    if (x) {
      g.fillStyle = scr.amber; g.fillText(RESOURCES[x.d.type].label, 14, 60);
      g.fillStyle = scr.text; g.fillText(`${Math.round(x.mass)} KG  PURITY ${Math.round(x.d.purity * 100)}%  ${info.dist.toFixed(0)} M`, 14, 84);
      COMPOSITION[x.d.type].slice(0, 4).forEach(([el, pc], i) => { const y = 112 + i * 24; g.fillStyle = scr.dim; g.fillText(el, 14, y); g.fillStyle = '#10262a'; g.fillRect(110, y - 8, 196, 16); g.fillStyle = scr.ok; g.fillRect(110, y - 8, 196 * pc / 100, 16); });
      g.fillStyle = info.catalogued ? scr.ok : scr.amber;
      g.fillText(info.catalogued ? 'CATALOGUED' : `HOLD TO CATALOGUE ${Math.round(info.hold * 100)}%`, 14, 222);
    } else if (info.scanning) {
      g.fillStyle = scr.amber; g.fillText(info.dist ? `GROUND  ${info.dist.toFixed(1)} M` : 'NO RETURN', 14, 60);
      g.fillStyle = scr.text; g.fillText(`REGOLITH  ${b.kind.toUpperCase()}`, 14, 90);
      g.fillText(`GRAVITY   ${(b.gravity / 9.81).toFixed(2)} G`, 14, 116); g.fillText(`SURFACE   ${b.temperature.surface} K`, 14, 142);
      g.fillText(`AIR       ${b.atmosphere.pressure < 0.001 ? 'VACUUM' : b.atmosphere.pressure.toFixed(3) + ' BAR'}`, 14, 168);
      g.fillText(`LIFE      ${b.life === 'none' ? 'NO SIGNS' : 'TRACE ORGANICS?'}`, 14, 194);
    } else { g.fillStyle = scr.dim; g.fillText('HOLD THE TRIGGER TO SCAN', 14, 110); g.fillText(`RESEARCH  ${research.points} RP`, 14, 140); }
    t.screen.tex.needsUpdate = true;
  }
  let scanHold = 0, scanId = null;

  return {
    inv, store, stats, research, cells, get docked() { return pack.docked; }, get deposits() { return deposits; }, get specimens() { return pack.samples; },
    get holder() { return tools.miner?.hand || null; },
    holding: h => !!h && (!!heldBy(h) || pack.hand === h || loose.some(s => s.hand === h)),
    // over the shoulder: pull the pack round in front of you while that hand keeps squeezing
    shoulder(h) { if (!pack.root || pack.open) return false; if (pack.docked) { say('PACK IS ON ITS DOCK  //  SUIT ROOM'); return false; } pack.open = true; pack.hand = h; scene.add(pack.root); beep(520); buzz(h, 0.6, 40); return true; },
    // a squeeze anywhere else: a tool from its cradle, a tool back into it, or a specimen off the ground. True if used.
    squeeze(h, at) {
      const held = heldBy(h);
      if (pack.docked && !held && pack.root.parent && pack.root.position.distanceTo(at) < 0.35) { // off the dock, held open in front of you
        pack.docked = false; pack.open = true; pack.hand = h; beep(520); buzz(h, 0.6, 40); say('PACK UNDOCKED'); return true;
      }
      if (pack.open && pack.hand !== h) {
        for (const t of Object.values(tools)) {
          const slot = pack.slots[t.id]; if (!slot) continue;
          if (slot.getWorldPosition(_v).distanceTo(at) > 0.14) continue;
          if (held === t) { stow(t); say(`${t.id === 'miner' ? 'MINING TOOL' : 'SCANNER'} STOWED`); beep(440); return true; }
          if (!held && !t.hand) { draw(t, h); return true; }
        }
      }
      if (held) return false;
      const s = loose.find(s => !s.hand && s.mesh.getWorldPosition(_v).distanceTo(at) < 0.16);
      if (s) { s.hand = h; h.glove.add(s.mesh); s.mesh.position.set(-0.03, 0, -0.06); buzz(h, 0.5, 30); say(`SPECIMEN: ${RESOURCES[s.type].label}`); return true; }
      return false;
    },
    release(h, ctx) { // the grip let go
      if (pack.hand === h) {
        pack.open = false; pack.hand = null;
        if (ctx.dock && pack.root.position.distanceTo(ctx.dock.pos) < 0.45) { // onto the dock: the connector seats and the tools in it charge
          pack.docked = true; pack.root.position.copy(ctx.dock.pos); pack.root.lookAt(_v.copy(ctx.dock.pos).add(ctx.dock.face));
          say('PACK DOCKED  //  CHARGING'); beep(880); buzz(h, 0.8, 80);
        } else { pack.root.removeFromParent(); beep(400); }
      }
      const s = loose.find(s => s.hand === h); if (!s) return;
      s.hand = null; s.mesh.getWorldPosition(_v);
      const k = pack.samples.length;
      if (pack.open && k < 4 && pack.rack[k] && pack.rack[k].getWorldPosition(_e).distanceTo(_v) < 0.2) { // into the rack
        pack.rack[k].add(s.mesh); s.mesh.position.set(0, 0.03, 0); pack.samples.push(s.type); loose = loose.filter(y => y !== s);
        say(`SPECIMEN STORED  ${pack.samples.length}/4`); beep(990); return;
      }
      scene.attach(s.mesh); s.mesh.position.y -= Math.max(0, ctx.heightAboveGround(s.mesh.position)) - 0.03; // drop it
    },
    save: () => ({ suit: { ...inv.items }, hold: { ...store.items }, cells: { ...cells }, docked: pack.docked, specimens: [...pack.samples], left: Object.fromEntries(left) }),
    restore(d) { // before the first landing, so deposits spawn with what's left; upgrades re-apply capacity and stats after this
      Object.assign(inv.items, d.suit); Object.assign(store.items, d.hold);
      Object.assign(cells, d.cells); pack.docked = !!d.docked; pack.samples.push(...(d.specimens || []).slice(0, 4)); fillRack();
      for (const [id, kg] of Object.entries(d.left || {})) if (id.includes('|')) left.set(id, kg); // pre-b28 keys had no body
    },
    takeSpecimens() { const n = pack.samples.length; pack.samples.length = 0; for (const r of pack.rack) r?.clear(); return n; },
    // every frame. ctx: { craft, body, ground, place, landed, trigs: {left, right}, heightAboveGround, cargoAt, head, headQuat, dt }
    update(ctx) {
      const { craft, place, landed, dt } = ctx;
      if (landed && (!spawnedFor || spawnedFor.distanceTo(craft.dir) > 1e-9)) spawn(craft, ctx.body, ctx.ground);
      if (!landed && spawnedFor) clear();
      for (const x of deposits) x.mesh.visible = place === 'outside' && x.mesh.position.distanceTo(ctx.head) < 150; // ~25 draws, not 45
      for (const s of loose) if (!s.hand) s.mesh.visible = place === 'outside';
      if (place === 'inside') {
        if (ctx.cargoAt && inv.total() > 0 && Math.hypot(ctx.head.x - ctx.cargoAt.x, ctx.head.z - ctx.cargoAt.z) < 1.8) {
          const kg = inv.moveTo(store); say(`STORED ${kg.toFixed(1)} KG  //  HOLD ${store.total().toFixed(0)} KG`); beep(660); full = false;
        }
      }
      if (pack.docked && pack.root) {
        if (!pack.root.parent && ctx.dock) { scene.add(pack.root); pack.root.position.copy(ctx.dock.pos); pack.root.lookAt(_v.copy(ctx.dock.pos).add(ctx.dock.face)); } // after a load
        if (pack.root.parent) pack.root.visible = place === 'inside'; // it stays aboard when you go out
        for (const t of Object.values(tools)) if (!t.hand) cells[t.id] = Math.min(100, cells[t.id] + 2 * dt); // 50 s from empty
      }
      if (pack.open) { // hangs in front of your chest, open toward you
        _v.set(0, 0, -1).applyQuaternion(ctx.headQuat); _v.y = 0; _v.normalize();
        pack.root.position.copy(ctx.head).addScaledVector(_v, 0.42); pack.root.position.y -= 0.22;
        pack.root.lookAt(ctx.head.x, pack.root.position.y, ctx.head.z);
      }
      for (const t of Object.values(tools)) if (t.hand && t.root.parent !== t.hand.glove) t.hand.glove.add(t.root); // gloves get rebuilt on reconnect
      // sparks fall and fade
      const pos = sparkGeo.attributes.position;
      for (let i = 0; i < SPARKS; i++) {
        if (sparkLife[i] <= 0) continue;
        sparkLife[i] -= dt; sparkVel[i].y -= 4 * dt;
        if (sparkLife[i] <= 0) pos.setXYZ(i, 0, -9999, 0);
        else pos.setXYZ(i, pos.getX(i) + sparkVel[i].x * dt, pos.getY(i) + sparkVel[i].y * dt, pos.getZ(i) + sparkVel[i].z * dt);
      }
      pos.needsUpdate = true;
      beam.visible = cone.visible = false;
      const trigOf = t => (t.hand ? ctx.trigs[t.hand.glove.userData.side] || 0 : 0);
      // --- scanner ---
      const sc = tools.scanner;
      if (sc?.hand) {
        sc.emitter.getWorldPosition(_e); _d.set(0, 0, -1).applyQuaternion(sc.hand.glove.getWorldQuaternion(_q));
        const scanning = trigOf(sc) > 0.1 && place === 'outside' && cells.scanner > 0 && ctx.powered, range = stats.scan > 15 ? 60 : SCAN_RANGE;
        const hit = scanning ? aimed(_e, _d, range) : null, gt = scanning && !hit && landed ? groundHit(ctx, range) : null;
        if (scanning) {
          cells.scanner = Math.max(0, cells.scanner - 0.4 * dt); // about 4 minutes of scanning a charge
          const L = hit ? hit.t : gt || range;
          cone.visible = true; cone.position.copy(_e); cone.quaternion.setFromUnitVectors(Y, _d); cone.scale.set(L / 4, L, L / 4);
          if (sc.lens) sc.lens.emissiveIntensity = 3 + Math.random();
        } else if (sc.lens) sc.lens.emissiveIntensity = 1;
        if (hit && hit.x.d.id === scanId) scanHold += dt; else { scanHold = 0; scanId = hit?.x.d.id ?? null; }
        const type = hit?.x.d.type, catalogued = !!(type && research.field[type]);
        if (hit && !catalogued && scanHold > 1.5) { research.field[type] = true; research.points += 5; say(`CATALOGUED ${RESOURCES[type].label}  +5 RP`); beep(1200); buzz(sc.hand, 0.6, 60); }
        if ((sc.screen.next -= dt) <= 0) { sc.screen.next = 0.2; paintScanner(sc, { body: ctx.body, target: hit?.x, dist: hit ? hit.t : gt, scanning, hold: Math.min(1, scanHold / 1.5), catalogued }); }
      }
      // --- mining tool ---
      const t = tools.miner;
      if (!t?.hand) { if (t?.lens) t.lens.emissiveIntensity = 1; return; }
      t.emitter.getWorldPosition(_e); _d.set(0, 0, -1).applyQuaternion(t.hand.glove.getWorldQuaternion(_q));
      const firing = trigOf(t) > 0.1 && cells.miner > 0 && ctx.powered && place === 'outside';
      if (t.lens) t.lens.emissiveIntensity = firing ? 4 + Math.random() * 2 : 1;
      const hit = aimed(_e, _d, firing ? RANGE : stats.scan);
      const show = mode => { if ((t.screen.next -= dt) <= 0) { t.screen.next = 0.2; paintMiner(t, { mode, target: hit?.x }); } };
      if (!firing) { show(cells.miner <= 0 || !ctx.powered ? 'EMPTY' : inv.free() <= 0 ? 'FULL' : 'READY'); return; }
      // the beam stops at a deposit, the ground, or its range
      const L = hit ? hit.t : (landed && groundHit(ctx, RANGE)) || RANGE;
      beam.visible = true; beam.position.copy(_e); beam.quaternion.setFromUnitVectors(Y, _d);
      beam.scale.set(0.7 + Math.random() * 0.6, L, 0.7 + Math.random() * 0.6);
      cells.miner = Math.max(0, cells.miner - stats.drain * dt);
      if (cells.miner === 0) say('TOOL BATTERY EMPTY  //  DOCK THE PACK ABOARD');
      if (L < RANGE) spark(_v.copy(_e).addScaledVector(_d, L), hit ? 2 : 1);
      if (!hit) { show('MINING'); return; }
      const x = hit.x, kg = Math.min(x.mass, stats.rate * dt), got = inv.add(x.d.type, kg * x.d.purity);
      if (got <= 0) { if (!full) { say(`SUIT CARGO FULL  //  ${inv.capacity} KG`); beep(220); full = true; } show('FULL'); return; }
      full = false; x.mass -= kg; left.set(x.key, x.mass);
      if (Math.random() < 0.3) buzz(t.hand, 0.25, 15);
      show('MINING');
      if (x.mass <= 0.01) { // gone: it leaves one specimen for the pack
        scene.remove(x.mesh); x.mesh.geometry.dispose(); deposits = deposits.filter(y => y !== x);
        const m = specimenMesh(x.d.type); m.position.copy(x.centre); m.position.y -= Math.max(0, ctx.heightAboveGround(m.position)) - 0.04; scene.add(m);
        loose.push({ type: x.d.type, mesh: m, hand: null });
        say(`${RESOURCES[x.d.type].label} DEPLETED  //  SPECIMEN LEFT`); beep(990);
      } else resize(x);
    },
  };
}
