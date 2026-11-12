// WGSL shader sources.

const FRAME = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec4f,
  lightDir: vec4f,
  viewport: vec4f,   // w, h, 1/w, 1/h
  misc: vec4f,       // x: real time
};
@group(0) @binding(0) var<uniform> frame: Frame;

const SKY_HORIZON = vec3f(0.80, 0.86, 0.92);
const SKY_ZENITH  = vec3f(0.30, 0.52, 0.86);

fn fogMix(col: vec3f, wp: vec3f) -> vec3f {
  let d = length(wp - frame.camPos.xyz);
  let f = 1.0 - exp(-max(d - 25.0, 0.0) * 0.006);
  return mix(col, SKY_HORIZON, clamp(f, 0.0, 0.85));
}

// Diverging pressure colormap: Cp < 0 (suction) blue, Cp > 0 (compression) red.
fn pressureColor(cp: f32, neutral: vec3f) -> vec3f {
  if (cp >= 0.0) {
    let t = clamp(cp / 1.0, 0.0, 1.0);
    return mix(mix(neutral, vec3f(0.98, 0.55, 0.30), smoothstep(0.0, 0.5, t)), vec3f(0.80, 0.08, 0.10), smoothstep(0.45, 1.0, t));
  }
  let t = clamp(-cp / 1.8, 0.0, 1.0);
  return mix(mix(neutral, vec3f(0.35, 0.70, 0.98), smoothstep(0.0, 0.45, t)), vec3f(0.10, 0.22, 0.78), smoothstep(0.4, 1.0, t));
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1, 0)), u.x), mix(hash21(i + vec2f(0, 1)), hash21(i + vec2f(1, 1)), u.x), u.y);
}
`;

// ---------------------------------------------------------------- sky
export const skyWGSL = FRAME + /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[vi], 1.0, 1.0);
  o.ndc = p[vi];
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let a = frame.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let b = frame.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  let h = clamp(dir.z, 0.0, 1.0);
  var col = mix(SKY_HORIZON, SKY_ZENITH, pow(h, 0.6));
  let sun = max(dot(dir, normalize(frame.lightDir.xyz)), 0.0);
  col += vec3f(1.0, 0.95, 0.8) * (pow(sun, 400.0) * 2.0 + pow(sun, 8.0) * 0.12);
  return vec4f(col, 1.0);
}
`;

// ---------------------------------------------------------------- ground / mound / wall
export const groundWGSL = FRAME + /* wgsl */ `
struct GroundU { shadow: vec4f, shadow2: vec4f };   // xy, radius, strength
@group(1) @binding(0) var<uniform> gu: GroundU;

struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.wp = p; o.n = n;
  return o;
}

const FT = 0.3048;
fn sdBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
// Anti-aliased band |d| < w, using the screen-space derivative of d itself
// (stays crisp at grazing angles and fades to average coverage far away).
fn band(d: f32, w: f32) -> f32 {
  let f = max(fwidth(d), 1e-4);
  return clamp((w - abs(d)) / f + 0.5, 0.0, 1.0) * min(1.0, 2.0 * w / f);
}
// Anti-aliased "inside" for a signed distance (negative inside).
fn inside(d: f32) -> f32 {
  let f = max(fwidth(d), 1e-4);
  return clamp(0.5 - d / f, 0.0, 1.0);
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  // NOTE: every derivative (fwidth) is evaluated up front, in uniform control flow.
  let wp = in.wp;
  let pf = wp.xy / FT;                    // feet
  let n2 = vnoise(pf * 0.9) * 0.6 + vnoise(pf * 3.7) * 0.4;
  let uv = vec2f(pf.x + pf.y, pf.y - pf.x) * 0.70710678;   // rotated: 1B line on +u, 3B line on +v
  let r = length(pf);

  // grass with mowing stripes
  let stripe = step(0.5, fract(uv.x / 30.0)) * 0.5 + step(0.5, fract(uv.y / 30.0)) * 0.5;
  var col = mix(vec3f(0.20, 0.42, 0.17), vec3f(0.25, 0.50, 0.20), stripe) * (0.88 + 0.2 * n2);

  // infield skin
  let dirt = vec3f(0.66, 0.47, 0.32) * (0.85 + 0.25 * n2);
  let arcIn = inside(length(pf - vec2f(0.0, 60.5)) - 95.0);
  let outGrass = 1.0 - inside(sdBox(uv - vec2f(45.0, 45.0), vec2f(41.0, 41.0)));
  let fairish = step(-6.0, min(uv.x, uv.y));
  var skin = arcIn * outGrass * fairish;
  skin = max(skin, inside(abs(uv.y) - 3.0) * step(0.0, uv.x) * step(uv.x, 92.0));
  skin = max(skin, inside(abs(uv.x) - 3.0) * step(0.0, uv.y) * step(uv.y, 92.0));
  skin = max(skin, inside(r - 13.0));
  let moundD = length(pf - vec2f(0.0, 59.5));
  skin = max(skin, inside(moundD - 9.0));
  col = mix(col, dirt, skin);
  col = mix(col, vec3f(0.62, 0.40, 0.27) * (0.85 + 0.2 * n2), (1.0 - smoothstep(8.6, 9.0, moundD)) * 0.6);

  // chalk: foul lines, batter's boxes (4' x 6', 6" off the plate), catcher's box
  let outsideHome = step(4.0, r);
  var chalk = band(uv.y, 0.17) * step(0.0, uv.x) * outsideHome;
  chalk = max(chalk, band(uv.x, 0.17) * step(0.0, uv.y) * outsideHome);
  chalk = max(chalk, band(sdBox(pf - vec2f(3.208, 0.85), vec2f(2.0, 3.0)), 0.12));
  chalk = max(chalk, band(sdBox(pf - vec2f(-3.208, 0.85), vec2f(2.0, 3.0)), 0.12));
  chalk = max(chalk, band(sdBox(pf - vec2f(0.0, -6.3), vec2f(1.79, 4.0)), 0.12) * step(pf.y, -2.15));
  col = mix(col, vec3f(0.96, 0.96, 0.93), chalk);

  // home plate (pentagon): back tip at origin, front edge at 17"
  let ax = abs(pf.x);
  let plate = max(max(pf.y - 1.4167, ax - 0.7083), (ax - pf.y) * 0.70710678);
  col = mix(col, vec3f(0.12, 0.12, 0.12), inside(plate - 0.05));
  col = mix(col, vec3f(0.98, 0.98, 0.97), inside(plate));
  // pitching rubber 24" x 6"
  col = mix(col, vec3f(0.98, 0.98, 0.97), inside(sdBox(pf - vec2f(0.0, 60.75), vec2f(1.0, 0.25))));

  // lighting
  let N = normalize(in.n);
  let L = normalize(frame.lightDir.xyz);
  var lit = 0.50 + 0.55 * max(dot(N, L), 0.0);

  // outfield wall
  let wallR = length(wp.xy - vec2f(0.0, 52.0));
  if (wallR > 69.8) {
    col = vec3f(0.10, 0.25, 0.17) * (0.85 + 0.15 * vnoise(vec2f(atan2(wp.y - 52.0, wp.x) * 200.0, wp.z * 4.0)));
    if (wp.z > 3.0) { col = vec3f(0.95, 0.80, 0.15); }
    lit = 0.55 + 0.45 * max(dot(N, L), 0.0);
  }

  // soft contact shadows under the ball and the ghost
  let d1 = length(wp.xy - gu.shadow.xy) / max(gu.shadow.z, 1e-4);
  lit *= 1.0 - gu.shadow.w * exp(-d1 * d1 * 2.0);
  let d2 = length(wp.xy - gu.shadow2.xy) / max(gu.shadow2.z, 1e-4);
  lit *= 1.0 - gu.shadow2.w * exp(-d2 * d2 * 2.0);

  return vec4f(fogMix(col * lit, wp), 1.0);
}
`;

// ---------------------------------------------------------------- ball
export const ballWGSL = FRAME + /* wgsl */ `
struct BallU {
  model: mat4x4f,     // translate + scale
  rot: mat4x4f,       // body -> world rotation
  vel: vec4f,         // world velocity (m/s), w = speed
  omega: vec4f,       // world angular velocity (rad/s), w = |w|
  params: vec4f,      // x: pressure overlay mix, y: ghost alpha, z: physical radius (m), w: ghost flag
  params2: vec4f,     // x: boundary-layer slip factor
};
struct Seam { p: array<vec4f, 96> };
@group(1) @binding(0) var<uniform> bu: BallU;
@group(1) @binding(1) var<uniform> seam: Seam;

struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f };
@vertex fn vs(@location(0) p: vec3f) -> VOut {
  var o: VOut;
  let w = bu.model * vec4f(p, 1.0);
  o.pos = frame.viewProj * w;
  o.wp = w.xyz;
  o.n = p;
  return o;
}

// distance to seam curve, curve parameter, side of curve
fn seamInfo(nb: vec3f) -> vec3f {
  var best = 1e9; var bp = 0.0; var side = 1.0;
  for (var i = 0u; i < 96u; i++) {
    let a = seam.p[i].xyz;
    let b = seam.p[(i + 1u) % 96u].xyz;
    let ab = b - a;
    let h = clamp(dot(nb - a, ab) / dot(ab, ab), 0.0, 1.0);
    let c = a + ab * h;
    let d = length(nb - c);
    if (d < best) {
      best = d; bp = (f32(i) + h) / 96.0;
      side = sign(dot(cross(ab, c), nb - c));
    }
  }
  return vec3f(best, bp, side);
}

// Qualitative surface pressure coefficient: potential flow over a sphere,
// plus boundary-layer dragging by the spinning surface, plus a separated wake
// whose separation line is shifted by spin (delayed on the side moving with the air).
fn pressureCp(n: vec3f) -> f32 {
  let U = bu.vel.w;
  if (U < 0.1) { return 0.0; }
  let vh = bu.vel.xyz / U;
  let Uair = -bu.vel.xyz;                       // air velocity seen by the ball
  let Ut = Uair - dot(Uair, n) * n;
  let surf = cross(bu.omega.xyz, n) * bu.params.z;   // surface velocity of the ball
  let ueff = 1.5 * Ut + bu.params2.x * surf;
  var cp = 1.0 - dot(ueff, ueff) / (U * U);
  let theta = acos(clamp(dot(n, vh), -1.0, 1.0));   // 0 at the front stagnation point
  let withFlow = dot(surf, -vh) / U;                 // >0 where surface moves with the air
  let thetaSep = radians(102.0) + radians(30.0) * clamp(withFlow * 5.0, -1.0, 1.0);
  let wake = smoothstep(thetaSep - 0.18, thetaSep + 0.25, theta);
  let wakeCp = -0.42 - 0.35 * clamp(withFlow * 4.0, -1.0, 1.0);
  cp = mix(max(cp, -2.2), wakeCp, wake);
  return cp;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.n);
  let V = normalize(frame.camPos.xyz - in.wp);
  let L = normalize(frame.lightDir.xyz);

  if (bu.params.w > 0.5) {
    // ghost (no-spin comparison ball)
    let f = pow(1.0 - max(dot(N, V), 0.0), 2.0);
    return vec4f(vec3f(0.85, 0.92, 1.0), bu.params.y * (0.25 + 0.75 * f));
  }

  let R = mat3x3f(bu.rot[0].xyz, bu.rot[1].xyz, bu.rot[2].xyz);
  let nb = transpose(R) * N;

  var base = vec3f(0.95, 0.93, 0.87) * (0.94 + 0.06 * vnoise(nb.xy * 40.0 + nb.z * 13.0));
  let si = seamInfo(nb);
  let d = si.x;
  let w = 0.08;
  // seam groove
  base *= 1.0 - 0.18 * (1.0 - smoothstep(0.004, 0.018, d));
  var stitch = 0.0;
  if (d < w) {
    let u = si.y * 108.0 + si.z * (d / w) * 0.55;
    let line = abs(fract(u) - 0.5);
    stitch = (1.0 - smoothstep(0.12, 0.2, line)) * (1.0 - smoothstep(w * 0.75, w, d)) * smoothstep(0.006, 0.016, d);
  }
  base = mix(base, vec3f(0.80, 0.07, 0.09), stitch);

  let diff = max(dot(N, L), 0.0);
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 48.0) * 0.22;
  let rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.18;
  var col = base * (0.42 + 0.68 * diff) + spec + rim;

  let pm = bu.params.x;
  if (pm > 0.001) {
    let cp = pressureCp(N);
    var pc = pressureColor(cp, vec3f(0.96, 0.96, 0.94)) * (0.65 + 0.40 * diff) + spec * 0.5;
    pc *= 1.0 - 0.35 * stitch;
    col = mix(col, pc, pm);
  }
  return vec4f(col, 1.0);
}
`;

// ---------------------------------------------------------------- arrows
export const arrowWGSL = FRAME + /* wgsl */ `
struct Arrow { base: vec4f, dir: vec4f, color: vec4f };   // base.w = length, dir.w = shaft radius
@group(1) @binding(0) var<storage, read> arrows: array<Arrow>;

struct VOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) col: vec4f, @location(2) wp: vec3f };
@vertex fn vs(@location(0) a: vec4f, @builtin(instance_index) ii: u32) -> VOut {
  let ar = arrows[ii];
  let d = normalize(ar.dir.xyz);
  let Lh = ar.base.w;
  let r = ar.dir.w;
  let hl = min(Lh * 0.45, r * 6.0);
  let rh = r * 2.6;
  var up = vec3f(0.0, 0.0, 1.0);
  if (abs(d.z) > 0.95) { up = vec3f(1.0, 0.0, 0.0); }
  let t1 = normalize(cross(up, d));
  let t2 = cross(d, t1);
  var lp: vec3f; var ln: vec3f;
  if (a.w < 0.5) {
    lp = vec3f(a.x * r, a.y * r, a.z * (Lh - hl)); ln = vec3f(a.x, a.y, 0.0);
  } else if (a.w < 1.5) {
    let k = 1.0 - a.z;
    lp = vec3f(a.x * rh * k, a.y * rh * k, Lh - hl + a.z * hl);
    ln = normalize(vec3f(a.x * hl, a.y * hl, rh));
  } else {
    lp = vec3f(a.x * rh * a.z, a.y * rh * a.z, Lh - hl); ln = vec3f(0.0, 0.0, -1.0);
  }
  let wp = ar.base.xyz + t1 * lp.x + t2 * lp.y + d * lp.z;
  var o: VOut;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  o.n = t1 * ln.x + t2 * ln.y + d * ln.z;
  o.col = ar.color;
  o.wp = wp;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.n);
  let L = normalize(frame.lightDir.xyz);
  let V = normalize(frame.camPos.xyz - in.wp);
  let diff = max(dot(N, L), 0.0);
  let spec = pow(max(dot(N, normalize(L + V)), 0.0), 32.0) * 0.35;
  let col = in.col.rgb * (0.55 + 0.6 * diff) + spec;
  return vec4f(col, 1.0);
}
`;

// ---------------------------------------------------------------- screen-space lines
const LINE_EXPAND = /* wgsl */ `
// Expand segment a->b (world) into a screen-space quad of width px. Returns clip pos.
fn expandSegment(a: vec3f, b: vec3f, vi: u32, widthPx: f32) -> vec4f {
  var ca = frame.viewProj * vec4f(a, 1.0);
  var cb = frame.viewProj * vec4f(b, 1.0);
  let eps = 0.0005;
  if (ca.w < eps && cb.w < eps) { return vec4f(0.0, 0.0, -2.0, 1.0); }
  if (ca.w < eps) { ca = mix(ca, cb, (eps - ca.w) / (cb.w - ca.w)); }
  if (cb.w < eps) { cb = mix(cb, ca, (eps - cb.w) / (ca.w - cb.w)); }
  let sa = ca.xy / ca.w; let sb = cb.xy / cb.w;
  var dir = (sb - sa) * frame.viewport.xy;
  let l = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / l, l > 1e-5);
  let nrm = vec2f(-dir.y, dir.x);
  var corner = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(0, 1), vec2f(0, 1), vec2f(1, -1), vec2f(1, 1));
  let c = corner[vi];
  var clip = select(ca, cb, c.x > 0.5);
  let hw = widthPx * 0.5;
  let off = (nrm * c.y + dir * (c.x * 2.0 - 1.0)) * hw * 2.0 * frame.viewport.zw;
  clip = vec4f(clip.xy + off * clip.w, clip.zw);
  return clip;
}
`;

export const lineWGSL = FRAME + LINE_EXPAND + /* wgsl */ `
struct LineU { color: vec4f, params: vec4f, color2: vec4f };
// params: x = width px, y = time cut, z = dash frequency (per second of t), w = alpha for t > cut
@group(1) @binding(0) var<uniform> lu: LineU;
@group(1) @binding(1) var<storage, read> pts: array<vec4f>;

struct VOut { @builtin(position) pos: vec4f, @location(0) t: f32, @location(1) side: f32, @location(2) u: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let a = pts[ii]; let b = pts[ii + 1u];
  var o: VOut;
  o.pos = expandSegment(a.xyz, b.xyz, vi, lu.params.x);
  var corner = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(0, 1), vec2f(0, 1), vec2f(1, -1), vec2f(1, 1));
  let c = corner[vi];
  o.t = mix(a.w, b.w, c.x);
  o.side = c.y;
  o.u = c.x;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  var a = lu.color.a;
  var col = lu.color.rgb;
  if (in.t > lu.params.y) { a *= lu.params.w; }
  else if (lu.color2.a > 0.0) {
    // gradient along traveled part
    col = mix(lu.color2.rgb, lu.color.rgb, clamp(in.t / max(lu.params.y, 1e-3), 0.0, 1.0));
  }
  if (lu.params.z > 0.0 && fract(in.t * lu.params.z) > 0.55) { discard; }
  a *= 1.0 - smoothstep(0.55, 1.0, abs(in.side));
  return vec4f(col, a);
}
`;

// ---------------------------------------------------------------- airflow particles
const FLOW = /* wgsl */ `
struct Flow {
  uhat: vec4f,    // xyz: free-stream air direction (ball frame), w: dt
  svec: vec4f,    // xyz: spin parameter vector  w*R/U, w: swirl gain
  fdir: vec4f,    // xyz: Magnus force direction, w: wake deflection strength
  e1: vec4f,      // lateral basis, w: time
  e2: vec4f,      // lateral basis, w: frame counter
  ball: vec4f,    // world position, w: display radius
  rp: vec4f,      // x: streak length, y: width px, z: alpha, w: count
};
struct Particle { pos: vec4f, vel: vec4f };   // pos.w = age, vel.w = life

fn turb(x: vec3f, t: f32) -> vec3f {
  return vec3f(
    sin(x.y * 2.1 + t * 3.1 + cos(x.z * 1.7)),
    sin(x.z * 2.3 - t * 2.7 + cos(x.x * 1.9)),
    sin(x.x * 1.9 + t * 2.3 + cos(x.y * 2.2)));
}

// Where the separated wake is (0..1). The wake centerline bends opposite the Magnus force.
fn wakeMask(x: vec3f) -> f32 {
  let U = fl.uhat.xyz;
  let s = dot(x, U);
  let bend = -fl.fdir.xyz * fl.fdir.w * 0.35 * max(s, 0.0);
  let lat = x - s * U - bend;
  let wr = 1.0 + 0.12 * max(s, 0.0);
  return smoothstep(0.0, 1.2, s) * exp(-dot(lat, lat) / (wr * wr * 1.4)) * exp(-max(s, 0.0) / 14.0);
}

// Velocity field in units of free-stream speed, lengths in ball radii.
fn flowVel(x: vec3f) -> vec3f {
  let U = fl.uhat.xyz;
  let r2 = max(dot(x, x), 1.0);
  let r = sqrt(r2);
  let r3 = r2 * r;
  let xh = x / r;
  // potential flow around a sphere (uniform stream + doublet)
  var u = U + 0.5 * (U - 3.0 * dot(U, xh) * xh) / r3;
  // air dragged around by the spinning surface
  u += cross(fl.svec.xyz, x) / r3 * fl.svec.w;
  // wake: deflected opposite to the Magnus force (Newton's 3rd law), turbulent
  let wake = wakeMask(x);
  u += -fl.fdir.xyz * fl.fdir.w * wake;
  u -= U * 0.45 * wake;                                 // velocity deficit in the wake
  u += turb(x * 1.3, fl.e1.w) * 0.28 * wake;
  return u;
}
`;

export const flowComputeWGSL = FLOW + /* wgsl */ `
@group(0) @binding(0) var<uniform> fl: Flow;
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;

fn hash(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn rnd(seed: ptr<function, u32>) -> f32 {
  *seed = hash(*seed);
  return f32(*seed) / 4294967295.0;
}

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(fl.rp.w)) { return; }
  var p = parts[i];
  var seed = i * 9781u + u32(fl.e2.w) * 6271u + 17u;
  let dt = fl.uhat.w;
  let x = p.pos.xyz;
  let k1 = flowVel(x);
  let k2 = flowVel(x + 0.5 * dt * k1);
  var nx = x + dt * k2;
  let r = length(nx);
  if (r < 1.03) { nx = nx / r * 1.03; }
  var age = p.pos.w + dt;
  var life = p.vel.w;
  let U = fl.uhat.xyz;
  let s = dot(nx, U);
  let lat = nx - s * U;
  if (s > 16.0 || s < -9.0 || dot(lat, lat) > 26.0 || age > life) {
    let rr = sqrt(rnd(&seed)) * 3.6;
    let a = rnd(&seed) * 6.2831853;
    nx = U * (-7.5 + rnd(&seed) * 1.5) + fl.e1.xyz * cos(a) * rr + fl.e2.xyz * sin(a) * rr;
    age = 0.0;
    life = 14.0 + rnd(&seed) * 14.0;
  }
  parts[i] = Particle(vec4f(nx, age), vec4f(k2, life));
}
`;

export const flowRenderWGSL = FRAME + LINE_EXPAND + FLOW + /* wgsl */ `
@group(1) @binding(0) var<uniform> fl: Flow;
@group(1) @binding(1) var<storage, read> parts: array<Particle>;

struct VOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) side: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = parts[ii];
  let x = p.pos.xyz;
  let u = p.vel.xyz;
  let sp = length(u);
  let tail = x - u * fl.rp.x;
  let wa = fl.ball.xyz + tail * fl.ball.w;
  let wb = fl.ball.xyz + x * fl.ball.w;
  var o: VOut;
  o.pos = expandSegment(wa, wb, vi, fl.rp.y);
  // Bernoulli: Cp = 1 - (u/U)^2 (qualitative; not valid inside the wake)
  // Bernoulli doesn't hold in the separated wake: there the pressure stays low.
  let cp = mix(1.0 - sp * sp, -0.45, clamp(wakeMask(x) * 1.6, 0.0, 1.0));
  let col = pressureColor(cp, vec3f(0.86, 0.88, 0.92));
  let s = dot(x, fl.uhat.xyz);
  let lat = length(x - s * fl.uhat.xyz);
  var a = fl.rp.z * smoothstep(0.0, 1.5, p.pos.w) * (1.0 - smoothstep(10.0, 15.0, s)) * (1.0 - smoothstep(3.6, 5.0, lat));
  a *= smoothstep(-8.0, -5.5, s);
  // undisturbed free stream stays faint so the interesting air stands out
  a *= 0.14 + 0.86 * smoothstep(0.04, 0.4, abs(cp));
  o.col = vec4f(col, a);
  var corner = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(0, 1), vec2f(0, 1), vec2f(1, -1), vec2f(1, 1));
  o.side = corner[vi].y;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let a = in.col.a * (1.0 - smoothstep(0.3, 1.0, abs(in.side)));
  return vec4f(in.col.rgb, a);
}
`;
