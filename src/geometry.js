// Mesh generators. All return Float32Array vertex data for non-indexed triangle lists.
import { FT } from './physics.js';

/** UV sphere, unit radius. Vertex = position (normal == position). */
export function sphere(seg = 64, rings = 40) {
  const out = [];
  const P = (i, j) => {
    const th = (j / rings) * Math.PI, ph = (i / seg) * Math.PI * 2;
    return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
  };
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      out.push(...a, ...d, ...c, ...a, ...c, ...b);
    }
  return new Float32Array(out);
}

/**
 * Arrow template. Vertex = (cos, sin, t, part):
 *  part 0 = shaft (t along shaft), 1 = cone (t along head), 2 = cone back disk (t = radial).
 * The vertex shader turns this into an arrow of any length/thickness.
 */
export function arrowTemplate(seg = 24) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // shaft
    out.push(c0, s0, 0, 0, c1, s1, 0, 0, c1, s1, 1, 0);
    out.push(c0, s0, 0, 0, c1, s1, 1, 0, c0, s0, 1, 0);
    // cone
    out.push(c0, s0, 0, 1, c1, s1, 0, 1, c1, s1, 1, 1);
    out.push(c0, s0, 0, 1, c1, s1, 1, 1, c0, s0, 1, 1);
    // back disk
    out.push(0, 0, 0, 2, c1, s1, 1, 2, c0, s0, 1, 2);
  }
  return new Float32Array(out);
}

// Ground-type meshes: vertex = position(3) + normal(3).
function pushTri(out, a, b, c, na, nb, nc) {
  out.push(...a, ...na, ...b, ...nb, ...c, ...nc);
}

export function groundPlane(size = 400) {
  const s = size / 2, n = [0, 0, 1];
  const out = [];
  // offset center so the field sits inside
  const cx = 0, cy = 40;
  const a = [cx - s, cy - s, 0], b = [cx + s, cy - s, 0], c = [cx + s, cy + s, 0], d = [cx - s, cy + s, 0];
  pushTri(out, a, b, c, n, n, n);
  pushTri(out, a, c, d, n, n, n);
  return out;
}

export const MOUND_CENTER = [0, 59.5 * FT];
const MOUND_R = 9 * FT;

export function moundHeight(r) {
  // 10" plateau around the rubber, sloping down; dips just below grade at the rim.
  const top = 2.5 * FT;
  const u = Math.min(1, Math.max(0, (r - top) / (MOUND_R - top)));
  const s = 1 - u * u * (3 - 2 * u);
  return 10 * 0.0254 * s - 0.01 * u;
}

export function mound(seg = 72, rings = 24) {
  const out = [];
  const h = (r) => moundHeight(r);
  const P = (i, j) => {
    const r = (j / rings) * MOUND_R, a = (i / seg) * Math.PI * 2;
    return [MOUND_CENTER[0] + r * Math.cos(a), MOUND_CENTER[1] + r * Math.sin(a), h(r)];
  };
  const N = (i, j) => {
    const r = (j / rings) * MOUND_R, a = (i / seg) * Math.PI * 2, e = 0.01;
    const dh = (h(r + e) - h(Math.max(0, r - e))) / (2 * e);
    const n = [-dh * Math.cos(a), -dh * Math.sin(a), 1];
    const l = Math.hypot(...n);
    return n.map((x) => x / l);
  };
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      pushTri(out, P(i, j), P(i + 1, j), P(i + 1, j + 1), N(i, j), N(i + 1, j), N(i + 1, j + 1));
      pushTri(out, P(i, j), P(i + 1, j + 1), P(i, j + 1), N(i, j), N(i + 1, j + 1), N(i, j + 1));
    }
  return out;
}

export const WALL = { cx: 0, cy: 52, r: 70, h: 3.2 };

export function wall(seg = 160) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a, z) => [WALL.cx + WALL.r * Math.cos(a), WALL.cy + WALL.r * Math.sin(a), z];
    const n = (a) => [-Math.cos(a), -Math.sin(a), 0];
    pushTri(out, p(a0, 0), p(a1, 0), p(a1, WALL.h), n(a0), n(a1), n(a1));
    pushTri(out, p(a0, 0), p(a1, WALL.h), p(a0, WALL.h), n(a0), n(a1), n(a0));
  }
  return out;
}

/** Baseball seam curve on the unit sphere, sampled. Returns Float32Array of vec4. */
export function seamPoints(n = 96) {
  const a = 0.62, b = 0.38, c = 2 * Math.sqrt(a * b);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out[i * 4] = a * Math.cos(t) + b * Math.cos(3 * t);
    out[i * 4 + 1] = a * Math.sin(t) - b * Math.sin(3 * t);
    out[i * 4 + 2] = c * Math.sin(2 * t);
  }
  return out;
}
// Body-frame spin axes giving 4 vs 2 seam crossings per revolution (found numerically).
export const SEAM_AXIS = { '4': [0, 0, 1], '2': [Math.SQRT1_2, Math.SQRT1_2, 0] };
