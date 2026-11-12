// Pitch flight physics: gravity + drag + Magnus, integrated with RK4.
//
// World frame (meters):
//   origin = back tip of home plate, +y = toward the pitcher, +z = up,
//   +x = catcher's right (first-base side).
// So the ball travels mostly in -y. A right-handed pitcher releases from -x.

export const FT = 0.3048;
export const IN = 0.0254;
export const MPH = 0.44704;

export const BALL_MASS = 0.145;            // kg
export const BALL_R = 0.0367;              // m (9.125" circumference)
export const BALL_AREA = Math.PI * BALL_R * BALL_R;
export const G = 9.80665;

export const PLATE_FRONT_Y = 17 * IN;      // front edge of plate (where location is measured)
export const RUBBER_Y = 60.5 * FT;
export const ZONE = { halfWidth: 8.5 * IN, bottom: 1.5 * FT, top: 3.5 * FT };

const SIM_DT = 0.0005;     // integration step (s)
const REC_EVERY = 2;       // record every N steps -> 1 ms samples
const END_Y = -0.6;        // stop a bit behind the plate (catcher's mitt)

// Presets are written for a right-handed pitcher.
//   tilt   = spin direction, clock hours in the PITCHER'S view (12 = pure backspin,
//            3 = ball pushed toward pitcher's right / arm side for a RHP)
//   eff    = spin efficiency (% of spin that is transverse / "active")
//   target = [x, z] in feet at the front of the plate (catcher's view, +x = 1B side)
export const PITCHES = {
  ff: { name: '4-Seam Fastball', mph: 95, rpm: 2350, tilt: 0.75, eff: 96, seam: '4', target: [-0.1, 3.0], relH: 6.0, relSide: 2.0, ext: 6.5 },
  si: { name: 'Sinker',          mph: 93, rpm: 2200, tilt: 2.25, eff: 90, seam: '2', target: [-0.4, 2.0], relH: 5.8, relSide: 2.1, ext: 6.4 },
  fc: { name: 'Cutter',          mph: 89, rpm: 2400, tilt: 11.0, eff: 40, seam: '4', target: [0.4, 2.4], relH: 5.9, relSide: 2.0, ext: 6.3 },
  sl: { name: 'Slider',          mph: 85, rpm: 2450, tilt: 9.5,  eff: 35, seam: '4', target: [0.6, 1.9], relH: 5.9, relSide: 2.0, ext: 6.2 },
  st: { name: 'Sweeper',         mph: 82, rpm: 2650, tilt: 9.0,  eff: 78, seam: '4', target: [0.7, 2.2], relH: 5.8, relSide: 2.2, ext: 6.2 },
  cu: { name: 'Curveball',       mph: 79, rpm: 2600, tilt: 7.0,  eff: 75, seam: '4', target: [0.2, 1.7], relH: 6.1, relSide: 1.9, ext: 6.1 },
  ch: { name: 'Changeup',        mph: 86, rpm: 1800, tilt: 2.0, eff: 88, seam: '2', target: [-0.4, 1.8], relH: 5.9, relSide: 2.0, ext: 6.4 },
  fs: { name: 'Splitter',        mph: 86, rpm: 1200, tilt: 1.75, eff: 60, seam: '2', target: [-0.2, 1.6], relH: 6.0, relSide: 1.9, ext: 6.3 },
  gy: { name: 'Gyro Slider',     mph: 87, rpm: 2500, tilt: 9.0,  eff: 8,  seam: '4', target: [0.3, 2.0], relH: 5.9, relSide: 2.0, ext: 6.3 },
  kn: { name: 'Knuckleball',     mph: 75, rpm: 60,   tilt: 12.0, eff: 50, seam: '2', target: [0.0, 2.3], relH: 6.0, relSide: 1.8, ext: 6.0 },
};

// --- small vector helpers (plain arrays) ---
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? scl(a, 1 / l) : [0, 0, 0]; };

/** Moist-air density (kg/m^3) from altitude (ft), temperature (F), relative humidity (%). */
export function airDensity(altFt, tempF, rhPct) {
  const h = altFt * FT;
  const P = 101325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
  const T = (tempF - 32) * 5 / 9 + 273.15;
  const Tc = T - 273.15;
  const es = 610.78 * Math.pow(10, 7.5 * Tc / (Tc + 237.3));
  const pv = (rhPct / 100) * es;
  return (P - pv) / (287.058 * T) + pv / (461.495 * T);
}

/** Lift coefficient vs spin factor S = r*w/v (bilinear fit, Sawicki et al.). */
export function liftCoeff(S) {
  return S < 0.1 ? 1.5 * S : 0.09 + 0.6 * S;
}

/** Drag coefficient (A. Nathan's trajectory-calculator fit, rpm-dependent). */
export function dragCoeff(rpm) {
  return 0.3008 + 0.0292 * (rpm / 1000);
}

/**
 * Spin vector (rad/s, world) for a given release velocity.
 * tiltHours: clock direction of the Magnus push in the pitcher's view.
 */
export function spinVector(v0, rpm, tiltHours, effPct, hand) {
  const vh = norm(v0);
  const up = norm(sub([0, 0, 1], scl(vh, vh[2])));
  const right = cross(vh, up);                     // pitcher's right
  const th = (tiltHours % 12) / 12 * 2 * Math.PI;  // clockwise from 12
  const m = add(scl(up, Math.cos(th)), scl(right, Math.sin(th)));
  const wt = cross(vh, m);                         // transverse spin axis: w x v points along m
  const wg = scl(vh, hand === 'L' ? -1 : 1);       // gyro (bullet) component, no Magnus force
  const e = Math.min(1, Math.max(0, effPct / 100));
  const W = rpm * 2 * Math.PI / 60;
  return add(scl(wt, W * e), scl(wg, W * Math.sqrt(1 - e * e)));
}

/** Aerodynamic + gravity accelerations at a state. Returns {acc, fm, fd, S, CL}. */
function forces(vel, omega, env, useMagnus) {
  const v = len(vel);
  const vh = scl(vel, 1 / v);
  const k = 0.5 * env.rho * BALL_AREA;              // force per (C * v^2)
  const fd = scl(vh, -k * env.cd * v * v);
  let fm = [0, 0, 0], S = 0, CL = 0;
  if (useMagnus) {
    const wt = sub(omega, scl(vh, dot(omega, vh)));  // only transverse spin makes lift
    const wtl = len(wt);
    if (wtl > 1e-6) {
      S = BALL_R * wtl / v;
      CL = liftCoeff(S);
      fm = scl(norm(cross(wt, vh)), k * CL * v * v);
    }
  }
  const acc = [
    (fd[0] + fm[0]) / BALL_MASS,
    (fd[1] + fm[1]) / BALL_MASS,
    (fd[2] + fm[2]) / BALL_MASS - G,
  ];
  return { acc, fm, fd, S, CL };
}

/**
 * Integrate one flight. Returns recorded samples (Float32Arrays, 3 comps each)
 * and the plate crossing.
 */
export function simulate(rel, v0, omega, env, { useMagnus = true, stopAtGround = true, record = true } = {}) {
  let p = rel.slice(), v = v0.slice(), t = 0;
  const cap = 4000;
  const pos = record ? new Float32Array(cap * 3) : null;
  const vel = record ? new Float32Array(cap * 3) : null;
  const fmA = record ? new Float32Array(cap * 3) : null;
  const fdA = record ? new Float32Array(cap * 3) : null;
  let n = 0, crossing = null, step = 0, hitGround = false;

  const rec = () => {
    if (!record || n >= cap) return;
    const f = forces(v, omega, env, useMagnus);
    pos.set(p, n * 3); vel.set(v, n * 3); fmA.set(f.fm, n * 3); fdA.set(f.fd, n * 3);
    n++;
  };
  rec();

  const deriv = (pp, vv) => forces(vv, omega, env, useMagnus).acc;
  while (t < 3) {
    // RK4
    const a1 = deriv(p, v);
    const p2 = add(p, scl(v, SIM_DT / 2)), v2 = add(v, scl(a1, SIM_DT / 2));
    const a2 = deriv(p2, v2);
    const p3 = add(p, scl(v2, SIM_DT / 2)), v3 = add(v, scl(a2, SIM_DT / 2));
    const a3 = deriv(p3, v3);
    const p4 = add(p, scl(v3, SIM_DT)), v4 = add(v, scl(a3, SIM_DT));
    const a4 = deriv(p4, v4);
    const np = add(p, scl(add(add(v, scl(v2, 2)), add(scl(v3, 2), v4)), SIM_DT / 6));
    const nv = add(v, scl(add(add(a1, scl(a2, 2)), add(scl(a3, 2), a4)), SIM_DT / 6));

    if (!crossing && p[1] >= PLATE_FRONT_Y && np[1] < PLATE_FRONT_Y) {
      const f = (p[1] - PLATE_FRONT_Y) / (p[1] - np[1]);
      crossing = {
        x: p[0] + (np[0] - p[0]) * f,
        z: p[2] + (np[2] - p[2]) * f,
        t: t + SIM_DT * f,
        v: len(v) + (len(nv) - len(v)) * f,
      };
    }
    p = np; v = nv; t += SIM_DT; step++;
    if (step % REC_EVERY === 0) rec();
    if (p[1] < END_Y) break;
    if (stopAtGround && p[2] < BALL_R) { hitGround = true; if (step % REC_EVERY !== 0) rec(); break; }
  }
  return { dt: SIM_DT * REC_EVERY, n, pos, vel, fm: fmA, fd: fdA, crossing, hitGround, duration: (n - 1) * SIM_DT * REC_EVERY };
}

/**
 * Full pitch: solve release direction so the spinning pitch hits the target,
 * then simulate it plus a "ghost" with identical release but no Magnus force.
 */
export function computePitch(prm) {
  const env = {
    rho: airDensity(prm.altitude, prm.tempF, prm.humidity),
    cd: dragCoeff(prm.rpm),
  };
  const sideSign = prm.hand === 'L' ? 1 : -1;
  const rel = [sideSign * prm.relSide * FT, RUBBER_Y - prm.ext * FT, prm.relH * FT];
  const target = [prm.targetX * FT, PLATE_FRONT_Y, prm.targetZ * FT];
  const speed = prm.mph * MPH;
  const D = rel[1] - target[1];

  // Initial guess: straight line + gravity drop compensation.
  const tGuess = D / (speed * 0.95);
  let a = (target[0] - rel[0]) / D;
  let b = (target[2] - rel[2] + 0.5 * G * tGuess * tGuess) / D;
  let v0, omega;
  for (let it = 0; it < 12; it++) {
    v0 = scl(norm([a, -1, b]), speed);
    omega = spinVector(v0, prm.rpm, prm.tilt, prm.eff, prm.hand);
    const c = simulate(rel, v0, omega, env, { stopAtGround: false, record: false }).crossing;
    if (!c) break;
    const ex = c.x - target[0], ez = c.z - target[2];
    if (Math.abs(ex) < 2e-5 && Math.abs(ez) < 2e-5) break;
    a -= ex / D; b -= ez / D;
  }

  const main = simulate(rel, v0, omega, env, { useMagnus: true });
  const ghost = simulate(rel, v0, omega, env, { useMagnus: false });
  // Crossings ignoring the ground, so break numbers exist even for pitches in the dirt.
  const mc = main.crossing || simulate(rel, v0, omega, env, { stopAtGround: false, record: false }).crossing;
  const gc = ghost.crossing || simulate(rel, v0, omega, env, { useMagnus: false, stopAtGround: false, record: false }).crossing;

  const Wmag = len(omega);
  const vh0 = norm(v0);
  const transverse = len(sub(omega, scl(vh0, dot(omega, vh0))));
  const S0 = BALL_R * transverse / speed;

  return {
    params: { ...prm },
    env, rel, v0, omega, target,
    main, ghost,
    crossing: mc, ghostCrossing: gc,
    ivb: mc && gc ? (mc.z - gc.z) : 0,          // m, + = rise vs no-spin
    hb: mc && gc ? (mc.x - gc.x) : 0,           // m, catcher's view, + = 1B side
    spinRad: Wmag,
    activeRpm: transverse * 60 / (2 * Math.PI),
    S0, CL0: liftCoeff(S0),
    releaseAngle: { vert: Math.atan2(v0[2], -v0[1]), horz: Math.atan2(v0[0], -v0[1]) },
  };
}

/** Linear interpolation of recorded samples at time t. */
export function sampleAt(sim, t) {
  const f = Math.max(0, Math.min(sim.n - 1, t / sim.dt));
  const i = Math.min(sim.n - 2, Math.floor(f));
  const u = Math.max(0, Math.min(1, f - i));
  const lerp3 = (arr) => {
    const a = i * 3, b = (i + 1) * 3;
    return [arr[a] + (arr[b] - arr[a]) * u, arr[a + 1] + (arr[b + 1] - arr[a + 1]) * u, arr[a + 2] + (arr[b + 2] - arr[a + 2]) * u];
  };
  if (sim.n < 2) {
    return { pos: [sim.pos[0], sim.pos[1], sim.pos[2]], vel: [sim.vel[0], sim.vel[1], sim.vel[2]], fm: [0, 0, 0], fd: [0, 0, 0] };
  }
  return { pos: lerp3(sim.pos), vel: lerp3(sim.vel), fm: lerp3(sim.fm), fd: lerp3(sim.fd) };
}
