// WebGPU renderer: sky, field, ball (seams + pressure), arrows, lines, airflow particles.
import { skyWGSL, groundWGSL, ballWGSL, arrowWGSL, lineWGSL, flowComputeWGSL, flowRenderWGSL } from './shaders.js';
import { sphere, arrowTemplate, groundPlane, mound, wall, seamPoints } from './geometry.js';

const SAMPLES = 4;
const DEPTH = 'depth32float';
export const PARTICLE_COUNT = 10240;
const MAX_ARROWS = 128;

class Line {
  constructor(r, capacity) {
    const d = r.device;
    this.capacity = capacity;
    this.count = 0;
    this.pts = d.createBuffer({ size: capacity * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.ubo = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = d.createBindGroup({
      layout: r.lineBGL,
      entries: [{ binding: 0, resource: { buffer: this.ubo } }, { binding: 1, resource: { buffer: this.pts } }],
    });
    this.u = new Float32Array(12);
    this.device = d;
    this.visible = true;
  }
  setPoints(f32vec4) {
    const n = Math.min(this.capacity, f32vec4.length / 4);
    this.device.queue.writeBuffer(this.pts, 0, f32vec4.buffer, f32vec4.byteOffset, n * 16);
    this.count = n;
  }
  setStyle({ color = [1, 1, 1, 1], width = 2, cut = 1e9, dash = 0, futureAlpha = 1, color2 = [0, 0, 0, 0] }) {
    this.u.set(color, 0);
    this.u.set([width, cut, dash, futureAlpha], 4);
    this.u.set(color2, 8);
    this.device.queue.writeBuffer(this.ubo, 0, this.u);
  }
}

export class Renderer {
  async init(canvas) {
    if (!navigator.gpu) throw new Error('This browser does not support WebGPU.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available.');
    const device = await adapter.requestDevice();
    device.lost.then((info) => console.error('WebGPU device lost:', info.message));
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    const U = GPUBufferUsage;
    const S = GPUShaderStage;
    const buf = (size, usage) => device.createBuffer({ size, usage });
    const vbuf = (data) => {
      const b = device.createBuffer({ size: data.byteLength, usage: U.VERTEX | U.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };

    // ---- bind group layouts
    this.frameBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} }] });
    this.groundBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.FRAGMENT, buffer: {} }] });
    this.ballBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        { binding: 1, visibility: S.FRAGMENT, buffer: {} },
      ],
    });
    this.arrowBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } }] });
    this.lineBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.flowRBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        { binding: 1, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.flowCBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.COMPUTE, buffer: {} },
        { binding: 1, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    // ---- buffers
    this.frameUBO = buf(192, U.UNIFORM | U.COPY_DST);
    this.frameBG = device.createBindGroup({ layout: this.frameBGL, entries: [{ binding: 0, resource: { buffer: this.frameUBO } }] });
    this.groundUBO = buf(32, U.UNIFORM | U.COPY_DST);
    this.groundBG = device.createBindGroup({ layout: this.groundBGL, entries: [{ binding: 0, resource: { buffer: this.groundUBO } }] });

    const seamBuf = buf(96 * 16, U.UNIFORM | U.COPY_DST);
    device.queue.writeBuffer(seamBuf, 0, seamPoints(96));
    this.ballUBO = buf(192, U.UNIFORM | U.COPY_DST);
    this.ghostUBO = buf(192, U.UNIFORM | U.COPY_DST);
    const ballBG = (ubo) => device.createBindGroup({
      layout: this.ballBGL,
      entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: { buffer: seamBuf } }],
    });
    this.ballBG = ballBG(this.ballUBO);
    this.ghostBG = ballBG(this.ghostUBO);

    this.arrowSB = buf(MAX_ARROWS * 48, U.STORAGE | U.COPY_DST);
    this.arrowBG = device.createBindGroup({ layout: this.arrowBGL, entries: [{ binding: 0, resource: { buffer: this.arrowSB } }] });
    this.arrowCount = 0;

    this.flowUBO = buf(112, U.UNIFORM | U.COPY_DST);
    this.particles = buf(PARTICLE_COUNT * 32, U.STORAGE | U.COPY_DST);
    device.queue.writeBuffer(this.particles, 0, initialParticles(PARTICLE_COUNT));
    this.flowCBG = device.createBindGroup({
      layout: this.flowCBGL,
      entries: [{ binding: 0, resource: { buffer: this.flowUBO } }, { binding: 1, resource: { buffer: this.particles } }],
    });
    this.flowRBG = device.createBindGroup({
      layout: this.flowRBGL,
      entries: [{ binding: 0, resource: { buffer: this.flowUBO } }, { binding: 1, resource: { buffer: this.particles } }],
    });

    // ---- meshes
    const sph = sphere(72, 48);
    this.sphereVB = vbuf(sph); this.sphereCount = sph.length / 3;
    const arr = arrowTemplate(24);
    this.arrowVB = vbuf(arr); this.arrowVerts = arr.length / 4;
    const groundData = new Float32Array([...groundPlane(420), ...mound(), ...wall()]);
    this.groundVB = vbuf(groundData); this.groundCount = groundData.length / 6;

    // ---- pipelines
    const mod = (code, label) => {
      const m = device.createShaderModule({ code, label });
      m.getCompilationInfo?.().then((info) => {
        for (const msg of info.messages) if (msg.type === 'error') console.error(`[${label}] ${msg.lineNum}:${msg.linePos} ${msg.message}`);
      });
      return m;
    };
    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const make = ({ code, label, layouts, buffers = [], transparent = false, depthCompare = 'less', depthWrite = true, cull = 'none' }) => {
      const m = mod(code, label);
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module: m, entryPoint: 'vs', buffers },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format, blend: transparent ? blend : undefined }] },
        primitive: { topology: 'triangle-list', cullMode: cull },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite && !transparent, depthCompare },
        multisample: { count: SAMPLES },
      });
    };
    const posNorm = [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }];

    this.skyPipe = make({ code: skyWGSL, label: 'sky', layouts: [this.frameBGL], depthCompare: 'always', depthWrite: false });
    this.groundPipe = make({ code: groundWGSL, label: 'ground', layouts: [this.frameBGL, this.groundBGL], buffers: posNorm });
    const sphBuf = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }];
    this.ballPipe = make({ code: ballWGSL, label: 'ball', layouts: [this.frameBGL, this.ballBGL], buffers: sphBuf, cull: 'back' });
    this.ghostPipe = make({ code: ballWGSL, label: 'ghost', layouts: [this.frameBGL, this.ballBGL], buffers: sphBuf, transparent: true, cull: 'back' });
    this.arrowPipe = make({
      code: arrowWGSL, label: 'arrow', layouts: [this.frameBGL, this.arrowBGL],
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    });
    this.linePipe = make({ code: lineWGSL, label: 'line', layouts: [this.frameBGL, this.lineBGL], transparent: true });
    this.flowPipe = make({ code: flowRenderWGSL, label: 'flow', layouts: [this.frameBGL, this.flowRBGL], transparent: true });
    const cm = mod(flowComputeWGSL, 'flow-compute');
    this.flowCompute = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.flowCBGL] }),
      compute: { module: cm, entryPoint: 'cs' },
    });

    this.lines = {};
    this.frameData = new Float32Array(48);
    this.ballData = new Float32Array(48);
    this.ghostData = new Float32Array(48);
    this.flowData = new Float32Array(28);
    this.frameCounter = 0;
    this.resize();
  }

  line(name, capacity = 1024) {
    if (!this.lines[name]) this.lines[name] = new Line(this, capacity);
    return this.lines[name];
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this.msaa?.destroy(); this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /**
   * scene = { cam:{viewProj,invViewProj,eye}, ball:{pos,radius,physR,rot(mat4),vel,omega,pressure},
   *           ghost:{pos,radius,visible}, arrows:[{base,dir,len,radius,color}], shadows:[[x,y,r,s],[..]],
   *           flow:{enabled,dt,uhat,svec,swirl,fdir,wake,e1,e2,time,streak,width,alpha}, lineOrder:[names] }
   */
  render(scene) {
    const d = this.device, q = d.queue;
    this.resize();
    const fd = this.frameData;
    fd.set(scene.cam.viewProj, 0);
    fd.set(scene.cam.invViewProj, 16);
    fd.set([...scene.cam.eye, 1], 32);
    fd.set([0.45, -0.35, 0.82, 0], 36);
    fd.set([this.width, this.height, 1 / this.width, 1 / this.height], 40);
    fd.set([scene.time, 0, 0, 0], 44);
    q.writeBuffer(this.frameUBO, 0, fd);

    const [s1, s2] = scene.shadows;
    q.writeBuffer(this.groundUBO, 0, new Float32Array([...s1, ...s2]));

    const writeBall = (data, ubo, b, ghost) => {
      const r = b.radius;
      data.set([r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, b.pos[0], b.pos[1], b.pos[2], 1], 0);
      data.set(b.rot || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
      const sp = Math.hypot(...(b.vel || [0, 0, 0]));
      data.set([...(b.vel || [0, 0, 0]), sp], 32);
      const om = b.omega || [0, 0, 0];
      data.set([...om, Math.hypot(...om)], 36);
      data.set([b.pressure || 0, b.alpha ?? 0.5, b.physR || 0.0367, ghost ? 1 : 0], 40);
      data.set([b.slip ?? 1.0, 0, 0, 0], 44);
      q.writeBuffer(ubo, 0, data);
    };
    writeBall(this.ballData, this.ballUBO, scene.ball, false);
    if (scene.ghost.visible) writeBall(this.ghostData, this.ghostUBO, scene.ghost, true);

    // arrows
    const arrows = scene.arrows.slice(0, MAX_ARROWS);
    if (arrows.length) {
      const a = new Float32Array(arrows.length * 12);
      arrows.forEach((ar, i) => {
        a.set([...ar.base, ar.len, ...ar.dir, ar.radius, ...ar.color], i * 12);
      });
      q.writeBuffer(this.arrowSB, 0, a);
    }
    this.arrowCount = arrows.length;

    // flow
    const fl = scene.flow;
    if (fl.enabled) {
      const f = this.flowData;
      f.set([...fl.uhat, fl.dt], 0);
      f.set([...fl.svec, fl.swirl], 4);
      f.set([...fl.fdir, fl.wake], 8);
      f.set([...fl.e1, fl.time], 12);
      f.set([...fl.e2, this.frameCounter++], 16);
      f.set([...scene.ball.pos, scene.ball.radius], 20);
      f.set([fl.streak, fl.width, fl.alpha, PARTICLE_COUNT], 24);
      q.writeBuffer(this.flowUBO, 0, f);
    }

    const enc = d.createCommandEncoder();
    if (fl.enabled && fl.dt > 0) {
      const cp = enc.beginComputePass();
      cp.setPipeline(this.flowCompute);
      cp.setBindGroup(0, this.flowCBG);
      cp.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
      cp.end();
    }

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaa.createView(), resolveTarget: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.8, g: 0.86, b: 0.92, a: 1 }, loadOp: 'clear', storeOp: 'discard',
      }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.frameBG);

    pass.setPipeline(this.skyPipe);
    pass.draw(3);

    pass.setPipeline(this.groundPipe);
    pass.setBindGroup(1, this.groundBG);
    pass.setVertexBuffer(0, this.groundVB);
    pass.draw(this.groundCount);

    pass.setPipeline(this.ballPipe);
    pass.setBindGroup(1, this.ballBG);
    pass.setVertexBuffer(0, this.sphereVB);
    pass.draw(this.sphereCount);

    if (this.arrowCount) {
      pass.setPipeline(this.arrowPipe);
      pass.setBindGroup(1, this.arrowBG);
      pass.setVertexBuffer(0, this.arrowVB);
      pass.draw(this.arrowVerts, this.arrowCount);
    }

    // transparent
    pass.setPipeline(this.linePipe);
    for (const name of scene.lineOrder) {
      const l = this.lines[name];
      if (!l || !l.visible || l.count < 2) continue;
      pass.setBindGroup(1, l.bind);
      pass.draw(6, l.count - 1);
    }

    if (scene.ghost.visible) {
      pass.setPipeline(this.ghostPipe);
      pass.setBindGroup(1, this.ghostBG);
      pass.setVertexBuffer(0, this.sphereVB);
      pass.draw(this.sphereCount);
    }

    if (fl.enabled) {
      pass.setPipeline(this.flowPipe);
      pass.setBindGroup(1, this.flowRBG);
      pass.draw(6, PARTICLE_COUNT);
    }

    pass.end();
    q.submit([enc.finish()]);
  }
}

function initialParticles(n) {
  const a = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    // spread through the domain along -y (default free-stream); recycled quickly anyway
    const s = -7.5 + Math.random() * 22;
    const r = Math.sqrt(Math.random()) * 3.6, t = Math.random() * Math.PI * 2;
    let x = r * Math.cos(t), y = -s, z = r * Math.sin(t);
    const l = Math.hypot(x, y, z);
    if (l < 1.05) { x *= 1.05 / l; y *= 1.05 / l; z *= 1.05 / l; }
    a.set([x, y, z, 2 + Math.random() * 4, 0, -1, 0, 14 + Math.random() * 14], i * 8);
  }
  return a;
}
