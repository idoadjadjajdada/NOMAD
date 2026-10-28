import * as THREE from 'three';
import { screenFace } from './cockpit.js';
import { RESOURCES, COMPOSITION, itemInfo, RECIPES, WARP_PARTS, FUEL, firstAffordable, abundance } from './resources.js';
import { positionAt, generateSystem, starsNear } from './universe.js';

// Touch screens around the ship (the bridge computer, the airlock keypads, the lab and engineering stations) plus the
// star-map orrery. A fingertip within 2 cm of a screen presses whatever button is drawn under it.
const C = { bg: '#020a0b', ink: '#2bd9c4', dim: '#3d8a80', text: '#bff5ee', amber: '#ffb347', warn: '#ff5a4a', key: '#0b1a1c', on: '#12403b', ok: '#5ee08a' };
const KIND = { gas: '#ffb070', ice: '#bfe8ff', ocean: '#4fb8ff', desert: '#e0b070', lava: '#ff6040', iron: '#c0a890', dead: '#a8a8a8' };
const clock = t => { const s = Math.floor(t); return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// built at the upgrade terminal from the hold, then made by the fabricator. Costs are placeholders.
export const UPGRADES = [
  { id: 'cargo', name: 'CARGO RACK MK2', desc: 'SUIT CARGO 40 > 60 KG', cost: { Iron: 25, Silicate: 10 }, rp: 0, secs: 8, apply: g => { g.mining.inv.capacity = 60; } },
  { id: 'cell', name: 'EXTENDED CELL', desc: 'TOOL BATTERY +50%', cost: { Carbon: 12, Iron: 8 }, rp: 15, secs: 10, apply: g => { g.mining.stats.drain /= 1.5; } },
  { id: 'scan', name: 'DEEP SCANNER', desc: 'SCAN RANGE 15 > 40 M', cost: { Silicate: 12, Carbon: 6 }, rp: 15, secs: 10, apply: g => { g.mining.stats.scan = 40; } },
  { id: 'emitter', name: 'FOCUSED EMITTER', desc: 'MINING SPEED x1.6', cost: { Iron: 20, RareMetal: 6 }, rp: 30, secs: 14, apply: g => { g.mining.stats.rate *= 1.6; } },
  { id: 'array', page: 'SHIP', name: 'ORBITAL ARRAY', desc: 'SURVEY SCANS, ALL SCANS 2X FASTER', cost: { Plate: 6, Wafer: 4 }, rp: 20, secs: 12, apply: g => { g.scanSpeed = 2; } },
  ...WARP_PARTS.map(p => ({ ...p, page: 'WARP', warp: true, apply: () => {} })), // installing is the whole effect: four of them bring the drive online
];

// drawing helpers: every screen is laid out 170 units tall; buttons register hit boxes as they're drawn
function begin(s) {
  const g = s.g, k = s.canvas.height / 170; s.k = k; s.W = s.canvas.width / k; s.buttons = [];
  g.setTransform(k, 0, 0, k, 0, 0); g.fillStyle = C.bg; g.fillRect(0, 0, s.W, 170);
  g.strokeStyle = C.ink; g.globalAlpha = 0.5; g.lineWidth = 1; g.strokeRect(1.5, 1.5, s.W - 3, 167); g.globalAlpha = 1;
  g.textBaseline = 'middle'; g.textAlign = 'left'; return g;
}
const font = (g, px, bold = true) => { g.font = `${bold ? 'bold ' : ''}${px}px monospace`; };
function button(s, id, x, y, w, h, label, { on = false, off = false, col = C.ink } = {}) {
  const g = s.g, hot = s.pressed === id;
  g.fillStyle = hot ? col : on ? C.on : C.key; g.fillRect(x, y, w, h);
  g.strokeStyle = off ? C.dim : col; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = hot ? C.bg : off ? C.dim : C.text; g.textAlign = 'center'; g.fillText(label, x + w / 2, y + h / 2 + 0.5); g.textAlign = 'left';
  if (!off) s.buttons.push({ id, x, y, w, h });
}
const bar = (g, x, y, w, h, f, col) => { g.fillStyle = '#10262a'; g.fillRect(x, y, w, h); g.fillStyle = col; g.fillRect(x, y, w * Math.max(0, Math.min(1, f)), h); };

// ---------- the bridge computer ----------
function drawComputer(s, G) {
  const g = begin(s), W = s.W, tab = s.tab || 'STATUS', blink = Math.floor(G.t * 2) % 2;
  font(g, 9); g.fillStyle = C.amber; g.fillText(`NOMAD-OS 4.1  //  ${G.system.name.toUpperCase()}`, 8, 10);
  g.textAlign = 'right'; g.fillText(clock(G.simTime), W - 8, 10); g.textAlign = 'left';
  g.fillStyle = C.dim; g.fillRect(6, 18, W - 12, 0.6);
  font(g, 8.5);
  const row = (i, k, v, col = C.text) => { const y = 28 + i * 13; g.fillStyle = C.dim; g.fillText(k, 10, y); g.fillStyle = col; g.fillText(v, 104, y); };
  let lines = 0;
  if (tab === 'STATUS') {
    const c = G.craft, alt = c ? Math.max(0, c.alt - c.minAlt) : 0;
    row(0, 'FUEL', `SHIP ${Math.round(G.power.fuel)}%   WARP ${Math.round(G.power.warp)}%`, G.power.fuel < 25 ? C.amber : C.text); row(1, 'LIFE SUPPORT', 'NOMINAL  O2 20.9%');
    row(2, 'AIRLOCK', `${G.airlock.state.toUpperCase()}  ${G.airlock.kPa.toFixed(0)} KPA`, G.airlock.state === 'idle' ? C.text : C.amber);
    row(3, 'FLIGHT', c ? `${c.mode}  ${alt < 1e4 ? alt.toFixed(0) + ' M' : (alt / 1e3).toFixed(0) + ' KM'}` : 'PARKED');
    row(4, 'HOLD', `${G.mining.store.total().toFixed(0)} KG   SUIT ${G.mining.inv.total().toFixed(1)} KG`);
    row(5, 'RESEARCH', `${G.research.points} RP   ${Object.keys(G.research.done).length} SAMPLES TYPED`);
    const parts = warpParts(G);
    row(6, 'WARP DRIVE', parts === 4 ? (G.nav.lock ? `LOCKED  ${G.nav.lock.name.toUpperCase()}` : 'ONLINE  //  NO TARGET') : `OFFLINE  ${parts}/4 PARTS${blink ? '  SEE WARP' : ''}`, parts === 4 ? C.ok : C.warn);
    row(7, 'FABRICATOR', G.job ? `${G.job.u.name} ${Math.floor(100 * G.job.t / G.job.u.secs)}%` : 'READY'); lines = 8;
  } else if (tab === 'CARGO') {
    const items = Object.entries(G.mining.store.items);
    if (!items.length) { g.fillStyle = C.dim; g.fillText('HOLD EMPTY. MINE, THEN UNLOAD IN THE CARGO BAY.', 10, 28); lines = 1; }
    items.slice(0, 8).forEach(([t, kg], i) => { row(i, itemInfo(t).label, `${kg.toFixed(1)} KG`); bar(g, 190, 24 + i * 13, W - 200, 7, kg / 100, '#' + itemInfo(t).color.toString(16).padStart(6, '0')); });
    lines = Math.max(lines, Math.min(7, items.length));
  } else if (tab === 'LOG') {
    font(g, 8, false);
    G.log.slice(-8).forEach(([t, m], i) => { g.fillStyle = C.dim; g.fillText(clock(t), 10, 28 + i * 13); g.fillStyle = C.text; g.fillText(m.slice(0, 40), 70, 28 + i * 13); });
    lines = Math.min(8, G.log.length);
  } else if (tab === 'SCAN') { drawScan(s, G, g, W); lines = null;
  } else if (tab === 'WARP' && warpParts(G) === 4) { drawNav(s, G, g, W); lines = null;
  } else if (tab === 'WARP') {
    WARP_PARTS.forEach((p, i) => {
      const u = UPGRADES.find(x => x.id === p.id), done = G.built[p.id], making = G.job?.u === u;
      row(i, p.name, done ? 'INSTALLED' : making ? `FABRICATING ${Math.floor(100 * G.job.t / u.secs)}%` : G.research.points < p.rp ? `NEEDS ${p.rp} RP` : 'MISSING  //  UPGRADE TERMINAL',
        done ? C.ok : making ? C.amber : C.warn);
    });
    row(4, 'WARP FUEL', `${Math.round(G.power.warp)}%   (POWER PANEL)`, G.power.warp > 0 ? C.text : C.amber);
    const on = warpParts(G) === 4;
    row(5, 'DRIVE', on ? (G.power.warp >= 10 ? 'ONLINE  //  AWAITING NAV LOCK' : 'ONLINE  //  NO WARP FUEL') : 'OFFLINE', on ? C.ok : C.warn);
    font(g, 7, false); g.fillStyle = C.dim; g.fillText('REFINE ORE IN ENGINEERING, BUILD PARTS AT THE TERMINAL.', 10, 28 + 6 * 13); lines = 7;
  } else if (tab === 'SYSTEMS') {
    button(s, 'lights', 10, 24, 130, 18, `CABIN LIGHTS  ${G.cabinLights() ? 'ON' : 'OFF'}`, { on: G.cabinLights() });
    button(s, 'cam', 150, 24, W - 160, 18, `LANDING CAM  ${G.landCam() ? 'ON' : 'OFF'}`, { on: G.landCam() });
    button(s, 'land', 10, 50, 86, 18, 'AUTO LAND', { col: C.amber }); button(s, 'takeoff', 102, 50, 86, 18, 'TAKEOFF', { col: C.amber });
    button(s, 'hold', 194, 50, W - 204, 18, 'HOLD', { col: C.amber });
    font(g, 8, false); g.fillStyle = C.dim; g.fillText('THE STICK AND THROTTLE ON THE ARMRESTS FLY THE SHIP.', 10, 82);
    button(s, 'save', 10, 92, 130, 18, 'SAVE GAME', { col: C.ok }); font(g, 8, false); g.fillStyle = C.dim; g.fillText('AUTOSAVE: 60 S + AIRLOCK', 150, 104); lines = 7;
  }
  if (lines !== null) { font(g, 8.5); g.fillStyle = C.ink; g.fillText(`> ${tab.toLowerCase()}${blink ? '_' : ''}`, 10, 30 + lines * 13); }
  TABS.forEach((t, i) => { font(g, 8); button(s, 'tab:' + t, 6 + i * (W - 12) / TABS.length, 148, (W - 12) / TABS.length - 4, 16, t, { on: tab === t }); });
}
const TABS = ['STATUS', 'CARGO', 'WARP', 'LOG', 'SYSTEMS']; // shortcut: SCAN is hidden until main.js wires G.scans/survey/siteInfo/setCourse (orbital scanning WIP)
const warpParts = G => WARP_PARTS.filter(p => G.built[p.id]).length;
// the warp radar (drive online): nearby stars to scale, touch one to select it, LOCK its coordinates, ENGAGE from orbit
const STAR_COL = { M: '#ff8a5c', K: '#ffb877', G: '#fff1d6', F: '#f4f6ff', A: '#cfe0ff', B: '#9fc0ff' };
const sysCache = new Map();
const sysOf = (seed, index) => { const k = `${seed}:${index}`; if (!sysCache.has(k)) sysCache.set(k, generateSystem(seed, index)); return sysCache.get(k); };
function contacts(G) { // what the radar can see; never empty, so there's always somewhere to go
  const r = G.radarRange(), near = starsNear(G.seed, G.systemIndex, r);
  return near.length ? near : starsNear(G.seed, G.systemIndex, r * 3).slice(0, 1);
}
function drawNav(s, G, g, W) {
  const stars = contacts(G), range = Math.max(G.radarRange(), stars.at(-1).dist), cx = 64, cy = 84, R = 56, k = R / range;
  g.strokeStyle = C.dim; g.lineWidth = 0.6;
  for (const f of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, R * f, 0, Math.PI * 2); g.stroke(); }
  g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  font(g, 6, false); g.fillStyle = C.dim; g.fillText(`${range.toFixed(0)} LY`, cx + 2, cy - R + 5);
  g.fillStyle = C.amber; g.beginPath(); g.arc(cx, cy, 2.5, 0, Math.PI * 2); g.fill();
  for (const st of stars) {
    const x = cx + st.rel[0] * k, y = cy - st.rel[1] * k, sys = sysOf(G.seed, st.index), id = String(st.index);
    g.fillStyle = STAR_COL[sys.star.cls] || C.text; g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
    if (G.nav.visited.includes(id)) { g.strokeStyle = C.dim; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.stroke(); }
    if (String(G.nav.sel?.index) === id) { g.strokeStyle = C.amber; g.lineWidth = 1; g.strokeRect(x - 6, y - 6, 12, 12); g.lineWidth = 0.6; }
    if (String(G.nav.lock?.index) === id) { g.strokeStyle = C.warn; g.beginPath(); g.moveTo(x - 9, y); g.lineTo(x + 9, y); g.moveTo(x, y - 9); g.lineTo(x, y + 9); g.stroke(); }
    s.buttons.push({ id: 'star:' + id, x: x - 8, y: y - 8, w: 16, h: 16 });
  }
  const x0 = 130, sel = G.nav.sel; font(g, 8.5);
  if (!sel) { g.fillStyle = C.dim; font(g, 7.5, false); g.fillText(`${stars.length} CONTACT${stars.length > 1 ? 'S' : ''}. TOUCH A STAR.`, x0, 30); }
  else {
    const sys = sysOf(G.seed, sel.index), cost = G.warpCost(sel.dist), locked = String(G.nav.lock?.index) === String(sel.index);
    g.fillStyle = C.amber; g.fillText(sys.name.toUpperCase(), x0, 28);
    font(g, 7.5, false); g.fillStyle = C.text;
    g.fillText(`${sys.star.cls}-TYPE STAR  ${sel.dist.toFixed(1)} LY`, x0, 42);
    g.fillText(`${sys.bodies.filter(b => !b.parent).length} PLANETS`, x0, 54);
    g.fillStyle = G.nav.visited.includes(String(sel.index)) ? C.ok : C.dim; g.fillText(G.nav.visited.includes(String(sel.index)) ? 'VISITED' : 'UNCHARTED', x0, 66);
    g.fillStyle = G.power.warp >= cost ? C.text : C.warn; g.fillText(`WARP FUEL ${cost}% (HAVE ${Math.round(G.power.warp)}%)`, x0, 78);
    font(g, 8); button(s, 'lock', x0, 88, 52, 16, locked ? 'UNLOCK' : 'LOCK', { on: locked, col: C.amber });
    button(s, 'engage', x0 + 56, 88, W - x0 - 62, 16, 'ENGAGE', { off: !locked, col: C.warn });
  }
  font(g, 6.5, false); g.fillStyle = C.dim; g.fillText('DRIVE ONLINE. ENGAGE FROM ORBIT.', x0, 120); g.fillText('RANGE GROWS WITH RESEARCH.', x0, 130);
}
// orbital scans (HANDOFF 3.2): BASIC for any body, DEEP for the one below, SURVEY (orbital array) finds the best deposit near
// the ground track. Each level pays research once per body. Timers run in tickStations; the survey itself is G.survey().
const SCAN = [null, { name: 'BASIC SCAN', secs: 6, rp: 5 }, { name: 'DEEP SCAN', secs: 15, rp: 10 }, { name: 'SURVEY', secs: 20, rp: 10 }];
const GEOLOGY = { dead: 'CRATERED REGOLITH', iron: 'METALLIC CRUST', ice: 'ICE CRUST, FRACTURES', desert: 'DUNES AND MESAS', ocean: 'OCEANS AND SHORES', lava: 'ACTIVE VOLCANISM', gas: 'NO SOLID SURFACE' };
const shortName = (b, G) => b.name.slice(G.system.name.length + 1).toUpperCase() || b.name.toUpperCase();
function nextScan(G, b) { // the scan this body can take next, or why not
  const lv = G.scans[b.id] || 0, below = b === G.startBody;
  if (G.craft?.mode === 'LANDED') return { why: 'TAKE OFF TO SCAN' };
  if (lv === 0) return { level: 1 };
  if (!below) return { why: lv === 1 ? 'DEEP SCAN: ORBIT IT FIRST' : 'DONE' };
  if (lv === 1) return { level: 2 };
  if (!G.built.array) return { why: 'SURVEY NEEDS ORBITAL ARRAY' };
  return { level: 3 }; // and again: a survey from a new spot can find a better site
}
function drawScan(s, G, g, W) {
  const bodies = G.system.bodies, here = G.startBody, sel = bodies.find(b => b.id === s.scanSel) || here, lv = G.scans[sel.id] || 0;
  s.scanTop = Math.max(0, Math.min(bodies.length - 8, s.scanTop ?? Math.max(0, bodies.indexOf(here) - 2)));
  bodies.slice(s.scanTop, s.scanTop + 8).forEach((b, i) => {
    const y = 22 + i * 13, l = G.scans[b.id] || 0;
    if (b === sel) { g.fillStyle = C.on; g.fillRect(6, y - 1, 100, 12); }
    font(g, 7, b === here); g.fillStyle = b === here ? C.amber : C.text; g.fillText((b.parent ? '  ' : '') + shortName(b, G) + (b === here ? ' (BELOW)' : ''), 9, y + 5);
    for (let k = 0; k < 3; k++) { g.fillStyle = k < l ? C.ok : '#16302e'; g.fillRect(90 + k * 5, y + 3, 4, 4); }
    s.buttons.push({ id: 'body:' + b.id, x: 6, y: y - 1, w: 100, h: 12 });
  });
  font(g, 8); button(s, 'up', 6, 128, 48, 14, 'UP', { off: s.scanTop === 0 }); button(s, 'down', 58, 128, 48, 14, 'DOWN', { off: s.scanTop >= bodies.length - 8 });
  const x0 = 112, line = (i, k, v, col = C.text) => { const y = 38 + i * 10; font(g, 6.5, false); g.fillStyle = C.dim; g.fillText(k, x0, y); g.fillStyle = col; g.fillText(v, x0 + 40, y); };
  font(g, 8.5); g.fillStyle = C.amber; g.fillText(sel.name.toUpperCase(), x0, 26);
  const ab = abundance(sel), air = sel.atmosphere.pressure == null ? `DEEP ${sel.atmosphere.composition}` : sel.atmosphere.pressure < 0.001 ? 'VACUUM' : `${sel.atmosphere.pressure < 0.1 ? sel.atmosphere.pressure.toFixed(3) : sel.atmosphere.pressure.toFixed(2)} BAR ${sel.atmosphere.composition}`;
  if (!lv) line(0, 'STATUS', 'UNSCANNED', C.dim);
  else {
    line(0, 'TYPE', sel.kind.toUpperCase()); line(1, 'GRAVITY', `${(sel.gravity / 9.81).toFixed(2)} G`); line(2, 'SURFACE', `${sel.temperature.surface} K`);
    line(3, 'AIR', air);
    line(4, 'ORES', !ab.length ? 'NONE' : lv < 2 ? ab.slice(0, 3).map(([t, v]) => `${t.toUpperCase()}${v > 0.35 ? '+' : ''}`).join(' ') : ab.slice(0, 3).map(([t, v]) => `${t.slice(0, 4).toUpperCase()} ${Math.round(v * 100)}%`).join(' '));
  }
  if (lv >= 2) {
    line(5, 'GEOLOGY', GEOLOGY[sel.kind] || '-');
    line(6, 'BIO', sel.life !== 'none' ? 'POSSIBLE SIGNS: CONFIRM ON SURFACE' : 'NONE DETECTED', sel.life !== 'none' ? C.ok : C.dim);
  }
  const site = sel === here && G.site && G.siteInfo();
  if (site) line(7, 'SITE', `${G.site.type.toUpperCase()} ${site.dist < 1000 ? site.dist.toFixed(0) + ' M' : (site.dist / 1000).toFixed(1) + ' KM'} ${site.bearing}`, C.amber);
  const j = G.scanJob;
  if (j) { font(g, 7.5); g.fillStyle = C.amber; g.fillText(`${SCAN[j.level].name}  ${Math.floor(100 * j.t / j.dur)}%`, x0, 122); bar(g, x0, 128, W - x0 - 8, 8, j.t / j.dur, C.amber); return; }
  const n = nextScan(G, sel);
  font(g, 8);
  if (site && sel === here) {
    button(s, 'scan', x0, 126, (W - x0 - 12) / 2, 16, n.level ? 'RE-SURVEY' : n.why, { off: !n.level, col: C.amber });
    button(s, 'course', x0 + (W - x0 - 4) / 2, 126, (W - x0 - 12) / 2, 16, G.craft?.target ? 'ON COURSE' : 'SET COURSE', { on: !!G.craft?.target, col: C.ok });
  } else button(s, 'scan', x0, 126, W - x0 - 8, 16, n.level ? SCAN[n.level].name : n.why, { off: !n.level, col: C.amber });
}
function startScan(G, b) {
  const n = nextScan(G, b); if (!n.level || G.scanJob) return;
  G.scanJob = { id: b.id, level: n.level, t: 0, dur: SCAN[n.level].secs / (G.scanSpeed || 1) }; G.say(`${SCAN[n.level].name}  //  ${b.name.toUpperCase()}`); G.beep(700);
}
function pressComputer(s, id, G) {
  if (id.startsWith('body:')) { s.scanSel = id.slice(5); return; }
  if (id === 'up' || id === 'down') { s.scanTop = (s.scanTop || 0) + (id === 'up' ? -4 : 4); return; }
  if (id === 'scan') { startScan(G, G.system.bodies.find(b => b.id === s.scanSel) || G.startBody); return; }
  if (id === 'course') { G.setCourse(); return; }
  if (id.startsWith('star:')) { G.nav.sel = contacts(G).find(st => String(st.index) === id.slice(5)) || null; if (G.nav.sel) G.nav.sel.name = sysOf(G.seed, G.nav.sel.index).name; return; }
  if (id === 'lock') {
    const same = String(G.nav.lock?.index) === String(G.nav.sel?.index);
    G.nav.lock = same ? null : G.nav.sel; G.say(same ? 'WARP LOCK RELEASED' : `COORDINATES LOCKED  //  ${G.nav.sel.name.toUpperCase()}`); return;
  }
  if (id === 'engage') { G.engage(); return; }
  if (id.startsWith('tab:')) s.tab = id.slice(4);
  else if (id === 'save') G.save(); else if (id === 'lights') G.toggleLights(); else if (id === 'cam') G.toggleLandCam();
  else G.craftCommand(id);
}

// ---------- airlock keypads (both sides of the inner door) ----------
function drawAirlock(s, G) {
  const g = begin(s), W = s.W, a = G.airlock;
  font(g, 11); g.fillStyle = C.amber; g.fillText('AIRLOCK', 8, 12);
  const state = { idle: 'PRESSURIZED', depress: 'DEPRESSURIZING', open: 'VACUUM / OUTER OPEN', repress: 'REPRESSURIZING' }[a.state];
  const col = a.state === 'idle' ? C.ok : C.warn;
  font(g, 26); g.fillStyle = col; g.fillText(a.kPa.toFixed(1), 8, 40); font(g, 9); g.fillText('KPA', 8 + g.measureText(a.kPa.toFixed(1)).width * 26 / 9 + 4, 44);
  bar(g, 8, 56, W - 16, 8, a.kPa / 101.3, col);
  font(g, 8); g.fillStyle = col; g.fillText(state, 8, 74);
  g.fillStyle = a.state === 'idle' ? C.ok : C.dim; g.fillText('INNER', 8, 88); g.fillStyle = a.state === 'open' ? C.ok : C.dim; g.fillText('OUTER', W / 2, 88);
  font(g, 12);
  button(s, 'cycle', 8, 98, W - 16, 30, a.state === 'open' ? 'CLOSE + REPRESS' : 'CYCLE', { off: a.state === 'depress' || a.state === 'repress', col: C.amber });
  font(g, 7, false); g.fillStyle = C.dim; g.fillText(a.state === 'open' ? 'STEP THROUGH THE OUTER DOOR' : 'CYCLE, THEN STEP OUT', 8, 140);
  g.fillText(clock(G.simTime), 8, 156);
}
function pressAirlock(s, id, G) { if (id === 'cycle') G.cycle(); }

// ---------- lab: the sample analyzer ----------
function drawAnalyzer(s, G) {
  const g = begin(s), W = s.W, a = G.analysis;
  font(g, 10); g.fillStyle = C.ink; g.fillText('SAMPLE ANALYZER', 8, 11);
  g.textAlign = 'right'; g.fillStyle = C.amber; g.fillText(`${G.research.points} RP`, W - 8, 11); g.textAlign = 'left';
  if (a.job) {
    font(g, 9); g.fillStyle = C.text; g.fillText(`ANALYZING ${RESOURCES[a.job.type].label}...`, 8, 34);
    bar(g, 8, 44, W - 16, 10, a.job.t / 4, C.ink); return;
  }
  const items = Object.entries(G.mining.store.items).filter(([t, kg]) => kg >= 1 && RESOURCES[t]); // refined goods aren't samples
  font(g, 8);
  if (!items.length) { g.fillStyle = C.dim; g.fillText('NO SAMPLES IN THE HOLD (1 KG EACH)', 8, 32); }
  items.slice(0, 4).forEach(([t], i) => button(s, 'an:' + t, 8, 22 + i * 19, 96, 15, RESOURCES[t].label, { on: !!G.research.done[t] }));
  const n = G.mining.specimens.length;
  if (n) button(s, 'specimens', 8, 104, 96, 15, `SPECIMENS x${n}`, { col: C.amber });
  if (a.last) { // the last result
    const x = 112; font(g, 8); g.fillStyle = C.amber; g.fillText(RESOURCES[a.last.type].label, x, 28);
    font(g, 8, false);
    (COMPOSITION[a.last.type] || []).forEach(([el, pc], i) => { g.fillStyle = C.text; g.fillText(el, x, 42 + i * 11); bar(g, x + 44, 38 + i * 11, W - x - 52, 6, pc / 100, C.ink); });
    font(g, 8); g.fillStyle = a.last.rp ? C.ok : C.dim; g.fillText(a.last.rp ? `NEW MATERIAL  +${a.last.rp} RP` : 'ALREADY CATALOGUED', x, 104);
  }
  font(g, 7, false); g.fillStyle = C.dim; g.fillText('TOUCH A SAMPLE TO ANALYZE IT. EACH NEW MATERIAL IS WORTH RESEARCH.', 8, 160);
}
function pressAnalyzer(s, id, G) {
  if (id === 'specimens') { const n = G.mining.takeSpecimens(); G.research.points += n * 8; G.say(`${n} SPECIMENS ANALYZED  +${n * 8} RP`); G.beep(1100); return; }
  if (!id.startsWith('an:') || G.analysis.job) return;
  const type = id.slice(3);
  if (!G.mining.store.take({ [type]: 1 })) return;
  G.analysis.job = { type, t: 0 }; G.beep(700);
}

// ---------- lab: upgrades, made by the fabricator ----------
function drawUpgrades(s, G) {
  const g = begin(s), W = s.W;
  const page = s.page || 'GEAR';
  font(g, 9); g.fillStyle = C.amber; g.fillText(`${G.research.points} RP`, 8, 11);
  font(g, 8); ['GEAR', 'SHIP', 'WARP'].forEach((p, i) => button(s, 'page:' + p, W - 122 + i * 40, 3, 36, 14, p, { on: page === p }));
  UPGRADES.filter(u => (u.page || 'GEAR') === page).forEach((u, i) => {
    const y = 22 + i * 34, built = G.built[u.id], lockedRp = G.research.points < u.rp, afford = G.mining.store.has(u.cost);
    font(g, 8.5); g.fillStyle = built ? C.ok : C.text; g.fillText(u.name, 8, y + 5);
    font(g, 7, false); g.fillStyle = C.dim; g.fillText(u.desc, 8, y + 15);
    const cost = Object.entries(u.cost).map(([t, kg]) => `${kg} ${t.toUpperCase()}`).join(' + ') + (u.rp ? `  ${u.rp} RP` : '');
    g.fillStyle = afford && !lockedRp ? C.amber : C.dim; g.fillText(cost, 8, y + 25);
    font(g, 8);
    button(s, 'up:' + u.id, W - 66, y + 2, 58, 18, built ? 'BUILT' : G.job?.u === u ? 'MAKING' : lockedRp ? 'LOCKED' : 'BUILD',
      { off: built || !!G.job || lockedRp || !afford, col: C.amber });
  });
}
function pressUpgrades(s, id, G) {
  if (id.startsWith('page:')) { s.page = id.slice(5); return; }
  const u = UPGRADES.find(x => 'up:' + x.id === id);
  if (!u || G.built[u.id] || G.job || G.research.points < u.rp || !G.mining.store.take(u.cost)) return;
  G.job = { u, t: 0 }; G.say(`FABRICATING ${u.name}`); G.beep(900);
}
function drawFabricator(s, G) {
  const g = begin(s), W = s.W, j = G.job;
  font(g, 12); g.fillStyle = C.amber; g.fillText('FABRICATOR', 10, 16);
  if (!j) { font(g, 10); g.fillStyle = C.dim; g.fillText('READY', 10, 60); font(g, 8, false); g.fillText('ORDER AN UPGRADE AT THE TERMINAL', 10, 80); return; }
  font(g, 10); g.fillStyle = C.text; g.fillText(j.u.name, 10, 52);
  bar(g, 10, 66, W - 20, 14, j.t / j.u.secs, C.amber);
  font(g, 9, false); g.fillStyle = C.amber; g.fillText(`${Math.floor(100 * j.t / j.u.secs)}%  ${Math.ceil(j.u.secs - j.t)} S`, 10, 96);
  for (let k = 0; k < 6; k++) { g.fillStyle = Math.floor(G.t * 6 + k) % 6 === 0 ? C.amber : '#3a2208'; g.fillRect(10 + k * 16, 120, 12, 6); }
}

// ---------- engineering: power ----------
// fuel refining at the power panel (FUEL in resources.js): the first option the hold can pay
const costText = c => Object.entries(c).map(([t, kg]) => `${t.toUpperCase()} ${kg}`).join(' + ') + ' KG';
const shipCost = G => firstAffordable(FUEL.ship, G.mining.store), warpCost = G => firstAffordable(FUEL.warp, G.mining.store);
function drawPower(s, G) {
  const g = begin(s), W = s.W, p = G.power;
  font(g, 10); g.fillStyle = C.ink; g.fillText('POWER & FUEL', 8, 11);
  const gauge = (y, k, f, col) => { font(g, 8); g.fillStyle = C.dim; g.fillText(k, 8, y); bar(g, 76, y - 4, W - 124, 8, f / 100, col); g.fillStyle = C.text; g.fillText(`${Math.round(f)}%`, W - 42, y); };
  gauge(28, 'SHIP FUEL', p.fuel, p.fuel < 25 ? C.warn : C.ink);
  font(g, 8); button(s, 'fuel', 8, 36, W - 16, 16, `REFINE ${costText(shipCost(G))}  >  +${FUEL.shipGain}%`, { off: p.fuel >= 100 || !G.mining.store.has(shipCost(G)), col: C.amber });
  gauge(66, 'WARP FUEL', p.warp, C.amber);
  font(g, 8); button(s, 'warp', 8, 74, W - 16, 16, `SYNTHESIZE ${costText(warpCost(G))}  >  +${FUEL.warpGain}%`, { off: p.warp >= 100 || !G.mining.store.has(warpCost(G)), col: C.amber });
  gauge(104, p.charging ? 'SUIT  CHG' : 'SUIT', p.suit, p.suit < 20 ? C.warn : C.ok);
  const docked = G.mining.docked, cellsLow = Object.values(G.mining.cells).some(c => c < 100);
  const loads = [['LIFE SUPPORT', 18], ['LIGHTS', G.cabinLights() ? 6 : 1], ['COMPUTERS', 9], ['FABRICATOR', G.job ? 22 : 1], ['ANALYZER', G.analysis.job ? 12 : 1],
    ['TOOL DOCK', docked && cellsLow ? 8 : 0], ['SUIT CUFF', p.charging ? 10 : 0], ['REFINERY', G.refine ? 20 : 1]];
  const total = loads.reduce((a, [, w]) => a + w, 0);
  font(g, 7, false); g.fillStyle = C.dim; g.fillText(loads.filter(([, w]) => w > 2).map(([k, w]) => `${k} ${w}`).join('  '), 8, 124);
  font(g, 8); g.fillStyle = C.amber; g.fillText(`REACTOR ${total} / 120 KW   ${Math.round(100 * total / 120)}%`, 8, 138);
  bar(g, 8, 148, W - 16, 8, total / 120, C.amber);
}
function pressPower(s, id, G) {
  const p = G.power;
  if (id === 'fuel' && p.fuel < 100 && G.mining.store.take(shipCost(G))) { p.fuel = Math.min(100, p.fuel + FUEL.shipGain); G.say(`FUEL REFINED  //  SHIP ${Math.round(p.fuel)}%`); G.beep(1100); }
  if (id === 'warp' && p.warp < 100 && G.mining.store.take(warpCost(G))) { p.warp = Math.min(100, p.warp + FUEL.warpGain); G.say(`WARP FUEL  //  ${Math.round(p.warp)}%`); G.beep(1200); }
}

// ---------- engineering: the refinery (RECIPES in resources.js) turns hold ore into refined goods ----------
function drawRefinery(s, G) {
  const g = begin(s), W = s.W, j = G.refine, store = G.mining.store;
  font(g, 10); g.fillStyle = C.amber; g.fillText('REFINERY', 8, 11);
  font(g, 8); g.textAlign = 'right';
  if (j) { g.fillStyle = C.amber; g.fillText(`${itemInfo(j.id).label}  ${Math.floor(100 * j.t / RECIPES[j.id].secs)}%`, W - 8, 11); }
  else { g.fillStyle = C.dim; g.fillText('IDLE', W - 8, 11); }
  g.textAlign = 'left';
  if (j) bar(g, 8, 18, W - 16, 3, j.t / RECIPES[j.id].secs, C.amber);
  Object.entries(RECIPES).forEach(([id, r], i) => {
    const y = 26 + i * 28, cost = firstAffordable(r.in, store), ok = store.has(cost);
    font(g, 8.5); g.fillStyle = C.text; g.fillText(itemInfo(id).label, 8, y + 4); const lw = g.measureText(itemInfo(id).label).width;
    font(g, 7, false); g.fillStyle = C.dim; g.fillText(`HOLD ${(store.items[id] || 0).toFixed(0)}`, 16 + lw, y + 4);
    g.fillStyle = ok ? C.amber : C.dim; g.fillText(`${Object.entries(cost).map(([t, kg]) => `${t.toUpperCase()} ${kg}`).join(' + ')}  >  ${r.out} KG`, 8, y + 15);
    font(g, 8); button(s, 'ref:' + id, W - 66, y - 2, 58, 18, j?.id === id ? 'RUNNING' : 'REFINE', { off: !!j || !ok, col: C.amber });
  });
}
function pressRefinery(s, id, G) {
  const rid = id.slice(4), r = RECIPES[rid];
  if (!r || G.refine || !G.mining.store.take(firstAffordable(r.in, G.mining.store))) return;
  G.refine = { id: rid, t: 0 }; G.say(`REFINING ${itemInfo(rid).label}`); G.beep(800);
}

// ---------- suit room: the pack dock and the suit charger cuff ----------
function drawDock(s, G) {
  const g = begin(s), W = s.W, c = G.mining.cells;
  font(g, 12); g.fillStyle = C.ink; g.fillText('PACK DOCK', 8, 16);
  if (!G.mining.docked) { font(g, 9, false); g.fillStyle = C.dim; g.fillText('HANG THE PACK HERE TO', 8, 60); g.fillText('CHARGE THE TOOLS IN IT', 8, 76); }
  [['MINER', c.miner], ['SCANNER', c.scanner]].forEach(([k, v], i) => {
    const y = 100 + i * 30; font(g, 10); g.fillStyle = C.dim; g.fillText(k, 8, y);
    bar(g, 84, y - 6, W - 140, 12, v / 100, v < 20 ? C.warn : C.ok); g.fillStyle = C.text; g.fillText(`${Math.round(v)}%`, W - 48, y);
  });
  if (G.mining.docked) { font(g, 10); g.fillStyle = Object.values(c).every(v => v >= 100) ? C.ok : C.amber; g.fillText(Object.values(c).every(v => v >= 100) ? 'CHARGED' : 'CHARGING', 8, 44); }
}
function drawCharger(s, G) {
  const g = begin(s), W = s.W, p = G.power;
  font(g, 12); g.fillStyle = C.ink; g.fillText('SUIT CHARGER', 8, 16);
  font(g, 40); g.fillStyle = p.suit < 20 ? C.warn : C.text; g.fillText(`${Math.round(p.suit)}%`, 8, 66);
  bar(g, 8, 96, W - 16, 14, p.suit / 100, p.charging ? C.amber : C.ok);
  font(g, 10, !p.charging); g.fillStyle = p.charging ? C.amber : C.dim; g.fillText(p.charging ? (p.suit >= 100 ? 'CHARGED' : 'CHARGING...') : 'ARM IN THE CUFF BELOW', 8, 132);
}

// ---------- hab: the galley ----------
function drawGalley(s, G) {
  const g = begin(s), W = s.W, d = G.galley;
  font(g, 10); g.fillStyle = C.amber; g.fillText('NUTRIENTS', 8, 12);
  font(g, 8, false); g.fillStyle = C.dim; g.fillText(`RATIONS SERVED ${d.served}`, 8, 28);
  if (d.t > 0) { font(g, 9); g.fillStyle = C.text; g.fillText(d.t > 1 ? 'DISPENSING...' : 'ENJOY.', 8, 60); bar(g, 8, 74, W - 16, 8, 1 - Math.max(0, d.t - 1) / 3, C.amber); }
  font(g, 11); button(s, 'dispense', 8, 110, W - 16, 34, 'DISPENSE', { off: d.t > 0, col: C.amber });
}
function pressGalley(s, id, G) { if (id === 'dispense' && G.galley.t <= 0) { G.galley.t = 4; G.galley.served++; G.beep(520); } }

const DEFS = {
  Bridge_Screen1: { draw: drawComputer, hz: 4, press: pressComputer, viewer: 'pilot' },
  Airlock_Panel: { draw: drawAirlock, hz: 6, press: pressAirlock, ppm: 1600 },
  Airlock_PanelIn: { draw: drawAirlock, hz: 6, press: pressAirlock, ppm: 1600, viewer: 'chamber' },
  Analyzer_Screen: { draw: drawAnalyzer, hz: 3, press: pressAnalyzer },
  UpgradeTerminal_Screen: { draw: drawUpgrades, hz: 2, press: pressUpgrades },
  Fabricator_Window: { draw: drawFabricator, hz: 4 },
  PowerPanel_Screen: { draw: drawPower, hz: 2, press: pressPower, viewer: 'aft' },
  PackDock_Screen: { draw: drawDock, hz: 3, ppm: 1600 },
  Refinery_Screen: { draw: drawRefinery, hz: 3, press: pressRefinery, ppm: 1400 },
  SuitCharger_Screen: { draw: drawCharger, hz: 4, ppm: 1600 },
  Galley_DispenserScreen: { draw: drawGalley, hz: 4, press: pressGalley, ppm: 1600 },
};

// timers that run whether or not you're aboard: analysis, fabrication, the galley
export function tickStations(G, dt) {
  const a = G.analysis;
  if (a.job && (a.job.t += dt) >= 4) {
    const type = a.job.type, first = !G.research.done[type], rp = first ? ({ Exotic: 40, RareMetal: 25 }[type] || 15) : 0;
    G.research.done[type] = true; G.research.points += rp; a.last = { type, rp }; a.job = null;
    G.say(rp ? `ANALYSIS: ${RESOURCES[type].label}  +${rp} RP` : `ANALYSIS: ${RESOURCES[type].label}`); G.beep(1100);
  }
  if (G.job && (G.job.t += dt) >= G.job.u.secs) {
    G.job.u.apply(G); G.built[G.job.u.id] = true; G.say(`${G.job.u.name} INSTALLED`); G.beep(1300);
    if (G.job.u.warp && warpParts(G) === 4) G.say('WARP DRIVE RESTORED  //  ALL PARTS INSTALLED');
    G.job = null;
  }
  const sj = G.scanJob;
  if (sj && (sj.t += dt) >= sj.dur) {
    const b = G.system.bodies.find(x => x.id === sj.id), first = (G.scans[sj.id] || 0) < sj.level;
    let rp = first ? SCAN[sj.level].rp : 0;
    if (sj.level === 2 && first && b.life !== 'none') rp += 20; // a possible biosignature is a discovery too
    G.scans[sj.id] = Math.max(G.scans[sj.id] || 0, sj.level); G.research.points += rp; G.scanJob = null;
    if (sj.level === 3) { const site = G.survey(); G.say(site ? `SURVEY: ${site.type.toUpperCase()} ${(site.dist / 1000).toFixed(1)} KM${rp ? `  +${rp} RP` : ''}` : 'SURVEY: NOTHING IN RANGE'); }
    else G.say(`${SCAN[sj.level].name} COMPLETE${rp ? `  +${rp} RP` : ''}${sj.level === 2 && b.life !== 'none' ? '  //  POSSIBLE BIOSIGNATURE' : ''}`);
    G.beep(1100);
  }
  const r = G.refine;
  if (r && (r.t += dt) >= RECIPES[r.id].secs) {
    const kg = G.mining.store.add(r.id, RECIPES[r.id].out);
    G.say(kg > 0 ? `${itemInfo(r.id).label} +${kg.toFixed(0)} KG` : 'HOLD FULL  //  REFINERY OUTPUT LOST'); G.beep(1000); G.refine = null;
  }
  if (G.galley.t > 0) G.galley.t -= dt;
}

// root: the interior (origin, unrotated). G: shared game state and actions (see main.js). Returns update(dt, tips, head).
export function makeStations(root, G, pilotEye) {
  const screens = [];
  for (const [name, def] of Object.entries(DEFS)) {
    const mesh = root.getObjectByName(name); if (!mesh) continue;
    const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const viewer = def.viewer === 'pilot' ? pilotEye : def.viewer === 'chamber' ? new THREE.Vector3(-3.0, 0.3, c.z)
      : def.viewer === 'aft' ? new THREE.Vector3(c.x, 0.3, c.z - 1.5) : new THREE.Vector3(0, 0.35, c.z);
    const f = screenFace(mesh, viewer); if (!f) continue;
    const ppm = def.ppm ?? 1000, canvas = document.createElement('canvas');
    canvas.width = Math.round(f.w * ppm); canvas.height = Math.round(f.h * ppm);
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = tex.magFilter = THREE.LinearFilter;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(f.w * 0.96, f.h * 0.94), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    quad.name = `${name}_live`;
    quad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.right, f.up, f.n));
    quad.position.copy(f.centre).addScaledVector(f.n, 0.002);
    root.add(quad);
    screens.push({ name, def, canvas, g: canvas.getContext('2d'), tex, quad, w: f.w * 0.96, h: f.h * 0.94, next: screens.length * 0.11, buttons: [], pressed: null, latch: false });
  }
  // star map: hide the old holo blob and run a little orrery of this system above the emitter
  const orrery = new THREE.Group(), holo = root.getObjectByName('StarMap_Holo');
  if (holo) {
    holo.getWorldPosition(orrery.position); orrery.position.y += 0.05;
    holo.visible = false; root.traverse(o => { if (o.isMesh && o.material?.name === 'Int_Holo') o.visible = false; }); // merged copies too
    const add = m => { m.material.toneMapped = false; orrery.add(m); return m; };
    add(new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff2c0 })));
    const planets = G.system.bodies.filter(b => !b.parent), aMax = Math.max(...planets.map(b => b.orbit.a)), aMin = Math.min(...planets.map(b => b.orbit.a));
    const rOf = a => 0.05 + 0.17 * Math.log(a / aMin) / Math.log(aMax / aMin || 2);
    const ring = [];
    for (const b of planets) {
      const r = rOf(b.orbit.a);
      for (let k = 0; k < 48; k++) { const a0 = k / 48 * 6.283, a1 = (k + 1) / 48 * 6.283; ring.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r); }
      const p = add(new THREE.Mesh(new THREE.SphereGeometry(b.kind === 'gas' ? 0.014 : 0.009, 8, 6), new THREE.MeshBasicMaterial({ color: KIND[b.kind] || C.ink })));
      p.userData = { b, r };
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x2bd9c4, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending })));
    root.add(orrery);
  }
  const _l = new THREE.Vector3(), pos = [0, 0, 0];
  return {
    screens,
    update(dt, tips, head) {
      G.t += dt;
      // orrery: real orbital phases, sped up a million times
      for (const m of orrery.children) {
        const b = m.userData.b; if (!b) continue;
        positionAt(b, G.simTime * 1e6, G.system.bodies, pos);
        const ang = Math.atan2(pos[2], pos[0]); m.position.set(Math.cos(ang) * m.userData.r, 0, Math.sin(ang) * m.userData.r);
      }
      orrery.rotation.y += dt * 0.05;
      let drawn = 0;
      for (const s of screens) {
        const near = s.quad.getWorldPosition(_l).distanceTo(head);
        // touch: any fingertip within 2 cm of the glass
        if (near < 1.5) {
          let hit = null;
          for (const tip of tips) {
            s.quad.worldToLocal(_l.copy(tip));
            if (Math.abs(_l.x) > s.w / 2 || Math.abs(_l.y) > s.h / 2 || _l.z > 0.02 || _l.z < -0.03) continue;
            const px = (_l.x / s.w + 0.5) * s.W, py = (0.5 - _l.y / s.h) * 170;
            hit = s.buttons.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) || 'glass';
          }
          if (hit && !s.latch) { s.latch = true; if (hit !== 'glass') { s.pressed = hit.id; s.def.press?.(s, hit.id, G); G.beep(980); G.buzz?.(); s.next = 0; } }
          if (!hit) { s.latch = false; s.pressed = null; }
        }
        if (near > 6 || G.t < s.next || drawn >= 2) continue; // far screens don't redraw; at most two uploads a frame
        s.next = G.t + 1 / s.def.hz; drawn++;
        s.def.draw(s, G); s.tex.needsUpdate = true;
      }
    },
  };
}
