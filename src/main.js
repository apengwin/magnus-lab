import { Renderer } from './renderer.js';
import { Camera, VIEWS } from './camera.js';
import {
  PITCHES, computePitch, sampleAt, airDensity,
  FT, IN, MPH, BALL_R, BALL_MASS, BALL_AREA, G, PLATE_FRONT_Y, ZONE,
} from './physics.js';
import { SEAM_AXIS } from './geometry.js';
import { v3, axisAngle3, mul3, rotBetween, mat3to4, project } from './math.js';

const $ = (s) => document.querySelector(s);
const MG = BALL_MASS * G;

// ------------------------------------------------------------------ state
const params = {
  type: 'ff', hand: 'R',
  mph: 95, rpm: 2350, tilt: 0.75, eff: 96, seam: '4',
  relH: 6.0, relSide: 2.0, ext: 6.5,
  targetX: -0.1, targetZ: 3.0,
  altitude: 0, tempF: 70, humidity: 50,
};
const display = {
  magnus: true, drag: true, gravity: true, velocity: false, spinAxis: true, comb: true,
  ghost: true, pressure: true, flow: true, flowPaused: true, shadow: true, labels: true,
  ballScale: 3, arrowScale: 1,
};
const play = { t: 0, playing: true, dir: 1, rate: 0.1, loop: true, hold: 0 };
const SPEEDS = [1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];

let pitch = null;
let pitchDirty = true;

function applyPreset(key) {
  const p = PITCHES[key];
  const L = params.hand === 'L';
  Object.assign(params, {
    type: key, mph: p.mph, rpm: p.rpm, eff: p.eff, seam: p.seam,
    tilt: L ? mirrorTilt(p.tilt) : p.tilt,
    relH: p.relH, relSide: p.relSide, ext: p.ext,
    targetX: L ? -p.target[0] : p.target[0], targetZ: p.target[1],
  });
}
const mirrorTilt = (h) => ((12 - h) % 12 + 12) % 12 || 12;

function recompute() {
  pitch = computePitch(params);
  pitchDirty = false;
  // spin orientation: map the body-frame seam axis onto the spin axis
  const W = v3.len(pitch.omega);
  pitch.spinAxis = W > 1e-6 ? v3.scale(pitch.omega, 1 / W) : [0, 0, 1];
  pitch.R0 = mul3(rotBetween(SEAM_AXIS[params.seam], pitch.spinAxis), axisAngle3(SEAM_AXIS[params.seam], 0.6));
  play.t = Math.min(play.t, pitch.main.duration);
  uploadLines();
  updateFinalReadouts();
}

// ------------------------------------------------------------------ renderer setup
const canvas = $('#gfx');
const renderer = new Renderer();
const camera = new Camera();

function trajToVec4(sim, zOverride) {
  const a = new Float32Array(sim.n * 4);
  for (let i = 0; i < sim.n; i++) {
    a[i * 4] = sim.pos[i * 3];
    a[i * 4 + 1] = sim.pos[i * 3 + 1];
    a[i * 4 + 2] = zOverride ?? sim.pos[i * 3 + 2];
    a[i * 4 + 3] = i * sim.dt;
  }
  return a;
}

function uploadLines() {
  if (!renderer.device) return;
  renderer.line('traj', 4096).setPoints(trajToVec4(pitch.main));
  renderer.line('trajShadow', 4096).setPoints(trajToVec4(pitch.main, 0.012));
  renderer.line('ghost', 4096).setPoints(trajToVec4(pitch.ghost));
  // target ring
  const ring = new Float32Array(65 * 4);
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ring.set([pitch.target[0] + Math.cos(a) * 0.06, PLATE_FRONT_Y + 0.002, pitch.target[2] + Math.sin(a) * 0.06, 0], i * 4);
  }
  renderer.line('target', 128).setPoints(ring);
}

function uploadStatic() {
  const y = PLATE_FRONT_Y, hw = ZONE.halfWidth, b = ZONE.bottom, t = ZONE.top;
  renderer.line('zone', 16).setPoints(new Float32Array([
    -hw, y, b, 0, hw, y, b, 0, hw, y, t, 0, -hw, y, t, 0, -hw, y, b, 0,
  ]));
  renderer.line('zone').setStyle({ color: [1, 1, 1, 0.9], width: 1.6 });
  // zone depth over the plate (back edges)
  renderer.line('zoneDepth', 16).setPoints(new Float32Array([
    -hw, y, t, 0, -hw, hw, t, 0, 0, 0, t, 0, hw, hw, t, 0, hw, y, t, 0,
  ]));
  renderer.line('zoneDepth').setStyle({ color: [1, 1, 1, 0.35], width: 1.2 });
}

// ------------------------------------------------------------------ UI construction
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

const controls = {};
function slider(parent, key, label, min, max, step, fmt, obj = params, after) {
  const val = el('span', { class: 'val' });
  const input = el('input', { type: 'range', min, max, step });
  input.value = obj[key];
  const update = () => { val.textContent = fmt(obj[key]); };
  input.addEventListener('input', () => {
    obj[key] = parseFloat(input.value);
    update();
    if (obj === params) pitchDirty = true;
    after?.();
  });
  parent.append(el('label', { class: 'slider' }, el('div', { class: 'row' }, el('span', {}, label), val), input));
  controls[key] = { set: () => { input.value = obj[key]; update(); } };
  update();
}
function toggle(parent, key, label, swatch) {
  const input = el('input', { type: 'checkbox' });
  input.checked = display[key];
  input.addEventListener('change', () => { display[key] = input.checked; });
  const kids = [input];
  if (swatch) kids.push(el('i', { class: 'sw', style: `background:${swatch}` }));
  kids.push(el('span', {}, label));
  parent.append(el('label', { class: 'toggle' }, ...kids));
  controls['d_' + key] = { set: () => { input.checked = display[key]; } };
}
function segmented(parent, options, get, set) {
  const wrap = el('div', { class: 'seg' });
  const btns = options.map(([v, label]) => {
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', () => { set(v); refresh(); });
    wrap.append(b);
    return [v, b];
  });
  const refresh = () => btns.forEach(([v, b]) => b.classList.toggle('on', get() === v));
  refresh();
  parent.append(wrap);
  return refresh;
}
function section(title, open = true) {
  const body = el('div', { class: 'body' });
  const d = el('details', { class: 'sect' }, el('summary', {}, title), body);
  d.open = open;
  $('#controls').append(d);
  return body;
}

const fmtTilt = (h) => {
  let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  hh = hh % 12 || 12;
  return `${hh}:${String(mm).padStart(2, '0')}`;
};

let refreshers = [];
function syncUI() {
  for (const c of Object.values(controls)) c.set();
  refreshers.forEach((r) => r());
  drawDial();
}

function buildUI() {
  // --- pitch
  const sp = section('Pitch');
  const grid = el('div', { class: 'pitch-grid' });
  const pitchBtns = Object.entries(PITCHES).map(([k, p]) => {
    const b = el('button', { type: 'button', title: p.name }, p.name);
    b.addEventListener('click', () => { applyPreset(k); pitchDirty = true; syncUI(); restart(); });
    grid.append(b);
    return [k, b];
  });
  refreshers.push(() => pitchBtns.forEach(([k, b]) => b.classList.toggle('on', params.type === k)));
  sp.append(grid);
  sp.append(el('div', { class: 'sub' }, 'Pitcher'));
  refreshers.push(segmented(sp, [['R', 'Right-handed'], ['L', 'Left-handed']], () => params.hand, (v) => {
    if (v === params.hand) return;
    params.hand = v;
    params.tilt = mirrorTilt(params.tilt);
    params.targetX = -params.targetX;
    pitchDirty = true; syncUI();
  }));

  // --- spin
  const ss = section('Spin');
  slider(ss, 'rpm', 'Spin rate', 0, 3600, 10, (v) => `${v.toFixed(0)} rpm`, params, markCustom);
  const dialWrap = el('div', { class: 'dial-wrap' });
  dialWrap.innerHTML = `<svg id="dial" viewBox="-60 -60 120 120" width="132" height="132"></svg>
    <div class="dial-text"><div class="dial-time" id="dialTime"></div>
    <div class="hint">Spin direction<br>(pitcher's view)<br>Drag the dial. The hand points where Magnus pushes the ball.</div></div>`;
  ss.append(dialWrap);
  slider(ss, 'tilt', 'Spin direction', 0.25, 12, 0.25, fmtTilt, params, () => { drawDial(); markCustom(); });
  slider(ss, 'eff', 'Spin efficiency (active spin)', 0, 100, 1, (v) => `${v.toFixed(0)}%`, params, markCustom);
  ss.append(el('div', { class: 'sub' }, 'Seam orientation (visual only)'));
  refreshers.push(segmented(ss, [['4', '4-seam'], ['2', '2-seam']], () => params.seam, (v) => { params.seam = v; pitchDirty = true; }));

  // --- velocity & release
  const sv = section('Velocity & Release');
  slider(sv, 'mph', 'Release velocity', 40, 105, 0.5, (v) => `${v.toFixed(1)} mph`, params, markCustom);
  slider(sv, 'relH', 'Release height', 3.5, 7.5, 0.05, (v) => `${v.toFixed(2)} ft`);
  slider(sv, 'relSide', 'Release side (arm side)', -1, 4, 0.05, (v) => `${v.toFixed(2)} ft`);
  slider(sv, 'ext', 'Extension', 4.5, 8, 0.05, (v) => `${v.toFixed(2)} ft`);

  // --- location
  const sl = section('Target Location');
  sl.append(el('div', { class: 'hint' }, 'Catcher’s view. Click or drag on the plate view (bottom right) to aim. The release angle is solved so the spinning pitch lands on target.'));
  slider(sl, 'targetX', 'Horizontal (+ = 1B side)', -2.5, 2.5, 0.02, (v) => `${(v * 12).toFixed(1)} in`, params, drawPlate);
  slider(sl, 'targetZ', 'Height above ground', 0.3, 5, 0.02, (v) => `${v.toFixed(2)} ft`, params, drawPlate);

  // --- environment
  const se = section('Environment', false);
  slider(se, 'altitude', 'Altitude', -200, 8000, 10, (v) => `${v.toFixed(0)} ft`);
  const envBtns = el('div', { class: 'chips' });
  [['Sea level', 0], ['Atlanta', 1050], ['Coors Field', 5200], ['Mexico City', 7350]].forEach(([n, a]) => {
    envBtns.append(el('button', { type: 'button', onclick: () => { params.altitude = a; pitchDirty = true; syncUI(); } }, n));
  });
  se.append(envBtns);
  slider(se, 'tempF', 'Temperature', 30, 110, 1, (v) => `${v.toFixed(0)} °F`);
  slider(se, 'humidity', 'Relative humidity', 0, 100, 1, (v) => `${v.toFixed(0)}%`);
  se.append(el('div', { class: 'readline' }, 'Air density: ', el('b', { id: 'rho' })));

  // --- display
  const sd = section('Display');
  const tg = el('div', { class: 'toggles' });
  toggle(tg, 'magnus', 'Magnus force', 'var(--magnus)');
  toggle(tg, 'drag', 'Drag force', 'var(--drag)');
  toggle(tg, 'gravity', 'Gravity', 'var(--gravity)');
  toggle(tg, 'velocity', 'Velocity', 'var(--velocity)');
  toggle(tg, 'spinAxis', 'Spin axis', '#e8e8ee');
  toggle(tg, 'comb', 'Force trail', 'var(--magnus)');
  toggle(tg, 'ghost', 'No-spin ghost', '#cfe0ff');
  toggle(tg, 'pressure', 'Surface pressure');
  toggle(tg, 'flow', 'Airflow particles');
  toggle(tg, 'flowPaused', 'Animate air when paused');
  toggle(tg, 'labels', 'Labels');
  toggle(tg, 'shadow', 'Ground trace');
  sd.append(tg);
  slider(sd, 'ballScale', 'Ball size (visual)', 1, 8, 0.1, (v) => `${v.toFixed(1)}×`, display);
  slider(sd, 'arrowScale', 'Arrow length', 0.3, 3, 0.05, (v) => `${v.toFixed(2)}×`, display);

  // --- explainer
  const sx = section('What am I looking at?', false);
  sx.innerHTML = `
    <p>A spinning ball drags a thin layer of air around with it. On the side where the surface moves <em>with</em> the oncoming air, the flow speeds up and stays attached longer, so pressure drops (<span class="lo">blue</span>). On the side moving <em>against</em> the air, the flow slows and separates early, so pressure rises (<span class="hi">red</span>).</p>
    <p>That pressure imbalance is the <b class="mag">Magnus force</b>. It always points along <code>&omega; &times; v</code>, perpendicular to both the spin axis and the direction of travel. The wake gets kicked the opposite way (Newton's 3rd law), which you can see in the airflow particles.</p>
    <p>Only <b>transverse</b> spin makes Magnus force. Gyro (bullet) spin about the direction of travel does not, which is why a gyro slider barely moves. <b>Spin efficiency</b> sets the transverse share.</p>
    <p>The dashed <b>ghost</b> leaves the hand at the same speed and angle with no Magnus force. The gap between the two at the plate is the spin-induced movement (Statcast's <i>induced vertical break</i> and <i>horizontal break</i>).</p>
    <p class="fine">Model: RK4 integration with gravity, drag (C<sub>D</sub> = 0.301 + 0.029&middot;rpm/1000) and lift C<sub>L</sub>(S) with spin factor S = r&omega;/v. Surface pressure and airflow are qualitative (potential flow + boundary-layer drag + shifted separation). Seam-shifted wake effects are not modeled.</p>`;

  // --- playback
  $('#btnRestart').onclick = () => restart();
  $('#btnBack').onclick = () => stepTime(-1);
  $('#btnFwd').onclick = () => stepTime(1);
  $('#btnRev').onclick = () => {
    if (play.playing && play.dir < 0) { play.playing = false; }
    else { if (play.t <= 0) play.t = pitch.main.duration; play.dir = -1; play.playing = true; }
    refreshPlay();
  };
  $('#btnPlay').onclick = () => togglePlay();
  $('#btnLoop').onclick = () => { play.loop = !play.loop; refreshPlay(); };
  const speeds = $('#speeds');
  SPEEDS.forEach((s) => {
    const b = el('button', { type: 'button', 'data-s': s }, `${s}×`);
    b.onclick = () => { play.rate = s; refreshPlay(); };
    speeds.append(b);
  });
  const tl = $('#timeline');
  tl.addEventListener('input', () => {
    play.playing = false;
    play.t = (parseFloat(tl.value) / 1000) * pitch.main.duration;
    refreshPlay();
  });

  // --- camera
  const cams = $('#cams');
  Object.entries(VIEWS).forEach(([k, v]) => {
    const b = el('button', { type: 'button', 'data-v': k, title: `${v.label} (${v.key})` }, v.label);
    b.onclick = () => { camera.setView(k); refreshCams(); };
    cams.append(b);
  });

  $('#menuBtn').onclick = () => document.body.classList.toggle('panel-open');
}

function markCustom() {
  // keep the pitch-type highlight but note values were changed
  pitchDirty = true;
}

function refreshCams() {
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('on', b.dataset.v === camera.view));
}

function refreshPlay() {
  $('#btnPlay').innerHTML = play.playing && play.dir > 0 ? ICON.pause : ICON.play;
  $('#btnRev').innerHTML = play.playing && play.dir < 0 ? ICON.pause : ICON.rev;
  $('#btnLoop').classList.toggle('on', play.loop);
  document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', parseFloat(b.dataset.s) === play.rate));
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  rev: '<svg viewBox="0 0 24 24"><path d="M17 4.5v15L5 12z"/></svg>',
};

function restart() { play.t = 0; play.dir = 1; play.playing = true; play.hold = 0; refreshPlay(); }
function togglePlay() {
  if (play.playing && play.dir > 0) play.playing = false;
  else {
    if (play.t >= pitch.main.duration - 1e-6) play.t = 0;
    play.dir = 1; play.playing = true;
  }
  refreshPlay();
}
function stepTime(sign) {
  play.playing = false;
  play.t = Math.max(0, Math.min(pitch.main.duration, play.t + sign * 0.004));
  refreshPlay();
}

// ------------------------------------------------------------------ spin dial (SVG)
function drawDial() {
  const svg = $('#dial');
  if (!svg) return;
  const th = (params.tilt % 12) / 12 * Math.PI * 2;
  let s = `<circle r="54" class="dial-face"/>`;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2, big = i % 4 === 0;
    const r0 = big ? 45 : 49;
    s += `<line x1="${Math.sin(a) * r0}" y1="${-Math.cos(a) * r0}" x2="${Math.sin(a) * 53}" y2="${-Math.cos(a) * 53}" class="${big ? 'tick big' : 'tick'}"/>`;
  }
  [[12, 0], [3, 1], [6, 2], [9, 3]].forEach(([n, k]) => {
    const a = k * Math.PI / 2;
    s += `<text x="${Math.sin(a) * 36}" y="${-Math.cos(a) * 36 + 4}" class="num">${n}</text>`;
  });
  s += `<text x="0" y="-18" class="lbl">backspin</text><text x="0" y="24" class="lbl">topspin</text>`;
  const hx = Math.sin(th) * 40, hy = -Math.cos(th) * 40;
  s += `<line x1="0" y1="0" x2="${hx}" y2="${hy}" class="hand"/><circle cx="${hx}" cy="${hy}" r="5" class="hand-tip"/><circle r="4" class="hub"/>`;
  svg.innerHTML = s;
  $('#dialTime').textContent = fmtTilt(params.tilt);
}
function bindDial() {
  const svg = $('#dial');
  const setFrom = (e) => {
    const r = svg.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    let a = Math.atan2(x, -y);
    if (a <= 0) a += Math.PI * 2;
    params.tilt = Math.round((a / (Math.PI * 2)) * 12 * 4) / 4 || 12;
    pitchDirty = true;
    controls.tilt.set();
    drawDial();
  };
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); setFrom(e); });
  svg.addEventListener('pointermove', (e) => { if (svg.hasPointerCapture(e.pointerId)) setFrom(e); });
}

// ------------------------------------------------------------------ plate view (2D canvas, catcher's view)
const plate = $('#plate');
const pctx = plate.getContext('2d');
const PV = { xMin: -3.4, xMax: 3.4, zMin: 0, zMax: 7.2 };
function plateXY(xm, zm, w, h) {
  const xf = xm / FT, zf = zm / FT;
  return [((xf - PV.xMin) / (PV.xMax - PV.xMin)) * w, h - ((zf - PV.zMin) / (PV.zMax - PV.zMin)) * h];
}
function drawPlate() {
  if (!pitch) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = plate.clientWidth, H = plate.clientHeight;
  if (plate.width !== W * dpr) { plate.width = W * dpr; plate.height = H * dpr; }
  const c = pctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const P = (x, z) => plateXY(x, z, W, H);
  // ground
  const [, gy] = P(0, 0);
  c.fillStyle = 'rgba(160,110,70,0.25)'; c.fillRect(0, gy - 2, W, 2);
  // plate
  const [px0] = P(-ZONE.halfWidth, 0), [px1] = P(ZONE.halfWidth, 0);
  c.fillStyle = '#eee'; c.fillRect(px0, gy - 4, px1 - px0, 4);
  // zone
  const [zx0, zy1] = P(-ZONE.halfWidth, ZONE.top), [zx1, zy0] = P(ZONE.halfWidth, ZONE.bottom);
  c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const x = zx0 + (zx1 - zx0) * i / 3, y = zy1 + (zy0 - zy1) * i / 3;
    c.beginPath(); c.moveTo(x, zy1); c.lineTo(x, zy0); c.moveTo(zx0, y); c.lineTo(zx1, y); c.stroke();
  }
  c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.5; c.strokeRect(zx0, zy1, zx1 - zx0, zy0 - zy1);

  const path = (sim, upto, style, width, dash) => {
    const n = Math.min(sim.n, upto === undefined ? sim.n : Math.floor(upto / sim.dt) + 1);
    if (n < 2) return;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = P(sim.pos[i * 3], sim.pos[i * 3 + 2]);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.setLineDash(dash || []); c.strokeStyle = style; c.lineWidth = width; c.stroke(); c.setLineDash([]);
  };
  if (display.ghost) path(pitch.ghost, undefined, 'rgba(200,220,255,0.55)', 1.5, [4, 4]);
  path(pitch.main, undefined, 'rgba(255,200,60,0.25)', 2);
  path(pitch.main, play.t, '#ffc83c', 2.5);

  // target
  const [tx, ty] = P(pitch.target[0], pitch.target[2]);
  c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1.2;
  c.beginPath(); c.arc(tx, ty, 6, 0, Math.PI * 2); c.moveTo(tx - 10, ty); c.lineTo(tx + 10, ty); c.moveTo(tx, ty - 10); c.lineTo(tx, ty + 10); c.stroke();

  // break arrow ghost crossing -> actual crossing
  const mc = pitch.crossing, gc = pitch.ghostCrossing;
  if (mc && gc && display.ghost) {
    const [gx, gyy] = P(gc.x, gc.z), [mx, my] = P(mc.x, mc.z);
    c.fillStyle = 'rgba(200,220,255,0.9)'; c.beginPath(); c.arc(gx, gyy, 3.5, 0, Math.PI * 2); c.fill();
    arrow2d(c, gx, gyy, mx, my, '#ffc83c');
  }
  // ball now
  const s = sampleAt(pitch.main, play.t);
  const [bx, by] = P(s.pos[0], s.pos[2]);
  // apparent size grows as it approaches the catcher
  const depth = Math.max(0.6, s.pos[1] + 1.2);
  const rr = Math.max(3, Math.min(12, 22 / depth));
  c.fillStyle = '#fff'; c.strokeStyle = '#c0202a'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(bx, by, rr, 0, Math.PI * 2); c.fill(); c.stroke();

  c.fillStyle = 'rgba(255,255,255,0.55)'; c.font = '10px ui-sans-serif, system-ui';
  c.fillText('3B side', 6, 14); c.textAlign = 'right'; c.fillText('1B side', W - 6, 14); c.textAlign = 'left';
}
function arrow2d(c, x0, y0, x1, y1, col) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  if (L < 3) return;
  const ux = dx / L, uy = dy / L, h = Math.min(9, L * 0.5);
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2;
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - ux * h * 0.8, y1 - uy * h * 0.8); c.stroke();
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 - ux * h - uy * h * 0.5, y1 - uy * h + ux * h * 0.5); c.lineTo(x1 - ux * h + uy * h * 0.5, y1 - uy * h - ux * h * 0.5); c.closePath(); c.fill();
}
function bindPlate() {
  const setFrom = (e) => {
    const r = plate.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fz = 1 - (e.clientY - r.top) / r.height;
    params.targetX = Math.max(-2.5, Math.min(2.5, PV.xMin + fx * (PV.xMax - PV.xMin)));
    params.targetZ = Math.max(0.3, Math.min(5, PV.zMin + fz * (PV.zMax - PV.zMin)));
    pitchDirty = true;
    controls.targetX.set(); controls.targetZ.set();
  };
  plate.addEventListener('pointerdown', (e) => { plate.setPointerCapture(e.pointerId); setFrom(e); });
  plate.addEventListener('pointermove', (e) => { if (plate.hasPointerCapture(e.pointerId)) setFrom(e); });
}

// ------------------------------------------------------------------ readouts
function updateFinalReadouts() {
  const p = pitch, mc = p.crossing;
  const hand = params.hand === 'L' ? 1 : -1;     // arm side is -x for RHP
  const hbArm = (p.hb * hand) / IN;
  $('#rho').textContent = `${p.env.rho.toFixed(3)} kg/m³`;
  const rows = [
    ['Plate location', mc ? `${(mc.x / IN).toFixed(1)}″, ${(mc.z / FT).toFixed(2)} ft` : '—'],
    ['Induced vert. break', `${p.ivb >= 0 ? '+' : ''}${(p.ivb / IN).toFixed(1)}″`],
    ['Horizontal break', `${Math.abs(hbArm).toFixed(1)}″ ${Math.abs(hbArm) < 0.05 ? '' : hbArm > 0 ? 'arm side' : 'glove side'}`],
    ['Flight time', mc ? `${mc.t.toFixed(3)} s` : '—'],
    ['Velocity at plate', mc ? `${(mc.v / MPH).toFixed(1)} mph` : '—'],
    ['Active spin', `${p.activeRpm.toFixed(0)} rpm`],
    ['Release angle (v / h)', `${(p.releaseAngle.vert * 180 / Math.PI).toFixed(2)}° / ${(p.releaseAngle.horz * 180 / Math.PI).toFixed(2)}°`],
  ];
  $('#final').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') +
    (p.main.hitGround ? `<div class="warn">Bounces before the plate</div>` : '');
}

function updateLiveReadouts(s) {
  const v = v3.len(s.vel);
  const fm = v3.len(s.fm), fd = v3.len(s.fd);
  const q = 0.5 * pitch.env.rho * BALL_AREA * v * v;
  const vh = v3.scale(s.vel, 1 / v);
  const wt = v3.sub(pitch.omega, v3.scale(vh, v3.dot(pitch.omega, vh)));
  const S = BALL_R * v3.len(wt) / v;
  const toPlate = Math.max(0, s.pos[1] - PLATE_FRONT_Y) / FT;
  const rows = [
    ['Time', `${play.t.toFixed(3)} / ${pitch.main.duration.toFixed(3)} s`],
    ['To plate', `${toPlate.toFixed(1)} ft`],
    ['Speed', `${(v / MPH).toFixed(1)} mph`],
    ['Spin factor S', `${S.toFixed(3)}`],
    ['C<sub>L</sub> / C<sub>D</sub>', `${(fm / q).toFixed(3)} / ${(fd / q).toFixed(3)}`],
    ['<i class="sw" style="background:var(--magnus)"></i>Magnus', `${fm.toFixed(2)} N <small>(${(fm / MG).toFixed(2)} g)</small>`],
    ['<i class="sw" style="background:var(--drag)"></i>Drag', `${fd.toFixed(2)} N <small>(${(fd / MG).toFixed(2)} g)</small>`],
    ['<i class="sw" style="background:var(--gravity)"></i>Gravity', `${MG.toFixed(2)} N <small>(1.00 g)</small>`],
  ];
  $('#live').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('#timeline').value = String(Math.round((play.t / pitch.main.duration) * 1000));
  $('#timeLabel').textContent = `${(play.t * 1000).toFixed(0)} ms`;
}

// ------------------------------------------------------------------ labels
const labelEls = {};
function label(key, text, pos, color, vp) {
  let e = labelEls[key];
  if (!e) { e = labelEls[key] = el('div', { class: 'tag' }); $('#labels').append(e); }
  const p = pos && project(vp.viewProj, pos, vp.w, vp.h);
  if (!p || !display.labels) { e.style.display = 'none'; return; }
  e.style.display = 'block';
  e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
  e.style.setProperty('--c', color);
  if (e._t !== text) { e.textContent = text; e._t = text; }
}

// ------------------------------------------------------------------ input: camera
function bindCamera() {
  const pts = new Map();
  let lastPinch = 0;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey });
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) camera.zoom(lastPinch / d);
      lastPinch = d;
      return;
    }
    if (p.btn === 2 || p.shift) camera.pan(dx, dy);
    else camera.rotate(dx, dy);
    refreshCams();
  });
  const up = (e) => { pts.delete(e.pointerId); lastPinch = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    const tag = e.target.tagName;
    // let focused sliders keep their own arrow-key behaviour
    if (tag === 'INPUT' && e.target.type === 'range' && k.startsWith('Arrow')) return;
    if (k === ' ') { e.preventDefault(); e.target.blur?.(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepTime(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepTime(1); }
    else if (k === 'r' || k === 'R') restart();
    else if (k === 'l' || k === 'L') { play.loop = !play.loop; refreshPlay(); }
    else if (k === '[' || k === ']') {
      const i = SPEEDS.indexOf(play.rate);
      play.rate = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + (k === '[' ? 1 : -1)))];
      refreshPlay();
    } else {
      const v = Object.entries(VIEWS).find(([, v]) => v.key === k);
      if (v) { camera.setView(v[0]); refreshCams(); }
    }
  });
}

// ------------------------------------------------------------------ frame loop
const COL = {
  magnus: [1.0, 0.76, 0.12, 1], drag: [1.0, 0.34, 0.22, 1], gravity: [0.6, 0.5, 1.0, 1],
  velocity: [0.3, 0.84, 1.0, 1], spin: [0.9, 0.9, 0.95, 1],
};
const CSS = { magnus: '#ffc21f', drag: '#ff5638', gravity: '#9980ff', velocity: '#4dd6ff', spin: '#e6e6f0', ghost: '#cfe0ff' };

let last = performance.now(), realTime = 0, flowTime = 0, frameNo = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; realTime += dt; frameNo++;

  if (pitchDirty) recompute();
  const T = pitch.main.duration;

  // playback
  if (play.playing) {
    play.t += dt * play.rate * play.dir;
    if (play.dir > 0 && play.t >= T) {
      play.t = T;
      if (play.loop) { play.hold += dt; if (play.hold > 0.9) { play.t = 0; play.hold = 0; } }
      else { play.playing = false; refreshPlay(); }
    } else if (play.dir < 0 && play.t <= 0) {
      play.t = 0;
      if (play.loop) { play.hold += dt; if (play.hold > 0.6) { play.t = T; play.hold = 0; } }
      else { play.playing = false; refreshPlay(); }
    }
  }
  const t = play.t;
  const s = sampleAt(pitch.main, t);
  const g = sampleAt(pitch.ghost, Math.min(t, pitch.ghost.duration));
  const R = BALL_R * display.ballScale;

  camera.update(dt, s.pos, R);
  const aspect = renderer.width / renderer.height;
  const cam = camera.matrices(aspect);

  // ball orientation
  const W = v3.len(pitch.omega);
  const rot3 = mul3(axisAngle3(pitch.spinAxis, W * t), pitch.R0);

  // arrows
  const arrows = [];
  const unit = R * 3.2 * display.arrowScale;   // arrow length for a force equal to the ball's weight
  const rad = R * 0.085;
  const tips = {};
  const addForce = (key, F, on) => {
    const m = v3.len(F);
    if (!on || m < 1e-5) { tips[key] = null; return; }
    const d = v3.scale(F, 1 / m);
    const base = v3.add(s.pos, v3.scale(d, R * 1.03));
    const len = unit * (m / MG);
    arrows.push({ base, dir: d, len, radius: rad, color: COL[key] });
    tips[key] = v3.add(base, v3.scale(d, len + R * 0.25));
  };
  addForce('magnus', s.fm, display.magnus);
  addForce('drag', s.fd, display.drag);
  addForce('gravity', [0, 0, -MG], display.gravity);
  if (display.velocity) {
    const v = v3.len(s.vel), d = v3.scale(s.vel, 1 / v);
    const base = v3.add(s.pos, v3.scale(d, R * 1.03)), len = R * 4.5 * display.arrowScale * (v / 40);
    arrows.push({ base, dir: d, len, radius: rad * 0.8, color: COL.velocity });
    tips.velocity = v3.add(base, v3.scale(d, len + R * 0.25));
  } else tips.velocity = null;
  if (display.spinAxis && W > 1) {
    const a = pitch.spinAxis;
    arrows.push({ base: v3.sub(s.pos, v3.scale(a, R * 1.7)), dir: a, len: R * 3.6, radius: R * 0.035, color: COL.spin });
    tips.spin = v3.add(s.pos, v3.scale(a, R * 2.1));
  } else tips.spin = null;
  if (display.comb) {
    const every = 0.02;
    for (let tc = every; tc <= t - every * 0.5; tc += every) {
      const sc = sampleAt(pitch.main, tc);
      const m = v3.len(sc.fm);
      if (m < 1e-4) continue;
      arrows.push({ base: sc.pos, dir: v3.scale(sc.fm, 1 / m), len: unit * 0.55 * (m / MG), radius: R * 0.045, color: [1.0, 0.76, 0.12, 1] });
    }
  }

  // lines
  const traj = renderer.lines.traj;
  traj.setStyle({ color: [1.0, 0.78, 0.2, 0.95], color2: [1.0, 0.45, 0.15, 1], width: 3.2, cut: t, futureAlpha: 0.25 });
  const gl = renderer.lines.ghost;
  gl.visible = display.ghost;
  gl.setStyle({ color: [0.82, 0.88, 1.0, 0.85], width: 2, cut: t, dash: 45, futureAlpha: 0.35 });
  const sh = renderer.lines.trajShadow;
  sh.visible = display.shadow;
  sh.setStyle({ color: [0.05, 0.05, 0.05, 0.3], width: 2.2, cut: t, futureAlpha: 0.1 });
  renderer.lines.target.setStyle({ color: [1, 1, 1, 0.55], width: 1.4 });

  // flow field (ball frame)
  const v = v3.len(s.vel), vh = v3.scale(s.vel, 1 / v);
  const uhat = v3.scale(vh, -1);
  let e1 = v3.cross(uhat, [0, 0, 1]);
  if (v3.len(e1) < 1e-3) e1 = v3.cross(uhat, [1, 0, 0]);
  e1 = v3.norm(e1);
  const e2 = v3.cross(uhat, e1);
  const fmMag = v3.len(s.fm);
  const CL = fmMag / (0.5 * pitch.env.rho * BALL_AREA * v * v);
  const flowDt = display.flow && (play.playing || display.flowPaused) ? dt * 6.5 : 0;
  flowTime += flowDt;
  // apparent ball radius in CSS px: airflow and labels only make sense up close
  const distCam = v3.len(v3.sub(cam.eye, s.pos));
  const pxR = (R / distCam) * (canvas.clientHeight / 2) / Math.tan(camera.fov / 2);
  const flowAlpha = 0.8 * Math.min(1, Math.max(0, (pxR - 8) / 22));

  const scene = {
    time: realTime,
    cam,
    ball: { pos: s.pos, radius: R, physR: BALL_R, rot: mat3to4(rot3), vel: s.vel, omega: pitch.omega, pressure: display.pressure ? 1 : 0, slip: 1.0 },
    ghost: { pos: g.pos, radius: R, visible: display.ghost, alpha: 0.4 },
    arrows,
    shadows: [
      [s.pos[0], s.pos[1], R * 1.1 + s.pos[2] * 0.12, 0.55 * Math.exp(-s.pos[2] / 3)],
      display.ghost ? [g.pos[0], g.pos[1], R * 1.1 + g.pos[2] * 0.12, 0.2 * Math.exp(-g.pos[2] / 3)] : [0, 0, 1, 0],
    ],
    flow: {
      enabled: display.flow && flowAlpha > 0.01, dt: flowDt, uhat,
      svec: v3.scale(pitch.omega, BALL_R / v), swirl: 1.6,
      fdir: fmMag > 1e-5 ? v3.scale(s.fm, 1 / fmMag) : [0, 0, 0], wake: Math.min(1.1, CL * 3.2),
      e1, e2, time: flowTime, streak: 0.26, width: 1.5 * Math.min(window.devicePixelRatio || 1, 2), alpha: flowAlpha,
    },
    lineOrder: ['trajShadow', 'zoneDepth', 'zone', 'target', 'ghost', 'traj'],
  };
  renderer.render(scene);

  // HUD
  const vp = { viewProj: cam.viewProj, w: canvas.clientWidth, h: canvas.clientHeight };
  const showTags = pxR > 7;
  const fN = (F) => `${v3.len(F).toFixed(2)} N`;
  label('magnus', `Magnus ${fN(s.fm)}`, showTags && tips.magnus, CSS.magnus, vp);
  label('drag', `Drag ${fN(s.fd)}`, showTags && tips.drag, CSS.drag, vp);
  label('gravity', `Gravity ${MG.toFixed(2)} N`, showTags && tips.gravity, CSS.gravity, vp);
  label('velocity', `${(v / MPH).toFixed(1)} mph`, showTags && tips.velocity, CSS.velocity, vp);
  label('ghost', 'no-spin ghost', display.ghost && pxR > 2.5 && v3.len(v3.sub(g.pos, s.pos)) > R * 2.5 && v3.add(g.pos, [0, 0, R * 1.6]), CSS.ghost, vp);
  $('#legend').classList.toggle('show', display.pressure || display.flow);

  if (frameNo % 2 === 0) { updateLiveReadouts(s); drawPlate(); }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ URL params
// e.g. ?pitch=cu&hand=L&view=follow&t=0.2&pause=1&rate=0.05&rpm=2800
function readURL() {
  const q = new URLSearchParams(location.search);
  if (q.get('hand') === 'L') params.hand = 'L';
  if (q.has('pitch') && PITCHES[q.get('pitch')]) applyPreset(q.get('pitch'));
  for (const k of ['mph', 'rpm', 'tilt', 'eff', 'relH', 'relSide', 'ext', 'targetX', 'targetZ', 'altitude', 'tempF', 'humidity']) {
    if (q.has(k) && Number.isFinite(+q.get(k))) params[k] = +q.get(k);
  }
  if (q.has('ball')) display.ballScale = Math.max(1, Math.min(8, +q.get('ball') || 3));
  if (q.has('view') && VIEWS[q.get('view')]) {
    camera.setView(q.get('view'));
    // jump straight there instead of animating
    Object.assign(camera.cur, { ...camera.des, target: camera.des.target.slice() });
    camera.followCur = camera.followDes;
    if (camera.following) camera.cur.dist = camera.des.dist = camera.followDistR * BALL_R * display.ballScale;
  }
  if (q.has('rate') && SPEEDS.includes(+q.get('rate'))) play.rate = +q.get('rate');
  if (q.has('t')) play.t = Math.max(0, +q.get('t') || 0);
  if (q.get('pause') === '1') play.playing = false;
}

// ------------------------------------------------------------------ boot
async function main() {
  buildUI();
  bindDial();
  bindPlate();
  bindCamera();
  readURL();
  syncUI();
  refreshPlay();
  refreshCams();
  try {
    await renderer.init(canvas);
  } catch (err) {
    console.error(err);
    $('#nogpu').classList.add('show');
    $('#nogpuMsg').textContent = err.message;
    return;
  }
  uploadStatic();
  recompute();
  new ResizeObserver(() => { renderer.resize(); drawPlate(); }).observe(canvas);
  requestAnimationFrame(frame);
}
main();
