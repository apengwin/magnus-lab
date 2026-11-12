// Orbit camera with preset views and a ball-follow mode. z is up.
import { v3, perspective, lookAt, mul, invert } from './math.js';

const DEG = Math.PI / 180;

function fromEye(eye, target) {
  const d = v3.sub(eye, target);
  const dist = v3.len(d);
  return { target, dist, yaw: Math.atan2(d[1], d[0]), pitch: Math.asin(d[2] / dist) };
}

export const VIEWS = {
  broadcast: { label: '3/4 View', key: '1', ...fromEye([7.5, -6.5, 3.2], [0, 7.0, 1.0]) },
  catcher:   { label: 'Catcher', key: '2', ...fromEye([0, -2.6, 1.15], [0, 9, 1.25]) },
  batter:    { label: 'Batter (RHB)', key: '3', ...fromEye([-0.85, 0.35, 1.62], [-0.05, 17, 1.6]) },
  side:      { label: 'Side (1B)', key: '4', ...fromEye([16.5, 7.8, 1.7], [0, 7.8, 1.45]) },
  pitcher:   { label: 'Behind Mound', key: '5', ...fromEye([0.6, 22.5, 2.4], [0, 3, 0.9]) },
  top:       { label: 'Overhead', key: '6', target: [0, 8.5, 0], dist: 26, yaw: -90 * DEG, pitch: 89 * DEG },
  follow:    { label: 'Follow Ball', key: '7', follow: true, dist: 15, yaw: -32 * DEG, pitch: 10 * DEG }, // dist in ball radii
};

export class Camera {
  constructor() {
    const v = VIEWS.broadcast;
    this.cur = { target: v.target.slice(), dist: v.dist, yaw: v.yaw, pitch: v.pitch };
    this.des = { ...this.cur, target: v.target.slice() };
    this.followDes = 0; this.followCur = 0;
    this.followDistR = VIEWS.follow.dist; // in display radii
    this.view = 'broadcast';
    this.fov = 40 * DEG;
  }

  setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    this.view = name;
    // take the shortest yaw path
    const wrap = (a, ref) => a + Math.round((ref - a) / (2 * Math.PI)) * 2 * Math.PI;
    if (v.follow) {
      this.followDes = 1;
      this.followDistR = v.dist;
      this.des.yaw = wrap(v.yaw, this.cur.yaw);
      this.des.pitch = v.pitch;
    } else {
      this.followDes = 0;
      this.des.target = v.target.slice();
      this.des.dist = v.dist;
      this.des.yaw = wrap(v.yaw, this.cur.yaw);
      this.des.pitch = v.pitch;
    }
  }

  get following() { return this.followDes > 0.5; }

  rotate(dx, dy) {
    this.des.yaw -= dx * 0.006;
    this.des.pitch = Math.max(this.following ? -1.5 : -0.25, Math.min(1.55, this.des.pitch + dy * 0.006));
    this.view = this.following ? 'follow' : 'custom';
  }
  zoom(factor) {
    if (this.following) this.followDistR = Math.max(3, Math.min(400, this.followDistR * factor));
    else this.des.dist = Math.max(0.5, Math.min(160, this.des.dist * factor));
  }
  pan(dx, dy) {
    if (this.following) return;
    const { yaw, pitch } = this.cur;
    const right = [-Math.sin(yaw), Math.cos(yaw), 0];
    const up = [-Math.cos(yaw) * Math.sin(pitch), -Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch)];
    const k = this.des.dist * 0.0016;
    this.des.target = v3.add(this.des.target, v3.add(v3.scale(right, -dx * k), v3.scale(up, dy * k)));
    this.view = 'custom';
  }

  update(dt, ballPos, ballR) {
    const k = 1 - Math.exp(-dt * 7);
    const c = this.cur, d = this.des;
    c.yaw += (d.yaw - c.yaw) * k;
    c.pitch += (d.pitch - c.pitch) * k;
    if (this.following) d.dist = this.followDistR * ballR;
    c.dist += (d.dist - c.dist) * k;
    c.target = v3.lerp(c.target, d.target, k);
    // follow blend ramps linearly so the target never lags a 40 m/s ball
    const step = dt / 0.6;
    this.followCur = this.followDes > this.followCur ? Math.min(this.followDes, this.followCur + step) : Math.max(this.followDes, this.followCur - step);
    const e = this.followCur * this.followCur * (3 - 2 * this.followCur);
    this.target = v3.lerp(c.target, ballPos, e);
    if (this.followCur >= 1) d.target = ballPos.slice(), c.target = ballPos.slice();
  }

  matrices(aspect) {
    const { yaw, pitch, dist } = this.cur;
    const off = [Math.cos(pitch) * Math.cos(yaw) * dist, Math.cos(pitch) * Math.sin(yaw) * dist, Math.sin(pitch) * dist];
    const eye = v3.add(this.target, off);
    const near = Math.max(0.004, Math.min(0.5, dist * 0.04));
    const proj = perspective(this.fov, aspect, near, 700);
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const viewProj = mul(proj, view);
    return { viewProj, invViewProj: invert(viewProj), eye };
  }
}
