# Magnus Lab

A WebGPU visualization of how spin bends a baseball pitch. It has no dependencies and no build step.

```sh
npm start          # or: node serve.mjs
# open http://localhost:5173
```

You need a browser with WebGPU: Chrome or Edge 113+, Safari 26+, or Firefox 141+ on Windows.

## What it shows

- **Flight path** of the pitch (gold) next to a **no-spin ghost** (dashed). The ghost leaves the hand at the same speed and angle but has no Magnus force, so the gap between the two is the spin-induced movement.
- **Force arrows** on the ball:
  - Magnus (gold): the push from the pressure difference across the spinning ball.
  - Drag (red)
  - Gravity (purple)
  - Optional: velocity and spin axis.
  - A trail of small Magnus arrows marks the force history along the path.
- **Surface pressure** on the ball. Red is high pressure (front stagnation and the side that turns into the air). Blue is low pressure (the side whose surface moves with the air, plus the wake).
- **Airflow particles** (GPU compute) streaming past the ball in its own frame, colored by pressure. The wake is deflected opposite to the Magnus force.
- **Catcher's view** inset: the pitch's path, the break arrow from the ghost to the actual pitch, and the target. Click or drag in it to aim.

## Controls

| | |
|---|---|
| Pitch presets | 4-seam, sinker, cutter, slider, sweeper, curve, changeup, splitter, gyro slider, knuckleball |
| Handedness | Mirrors the release side, spin direction, and target |
| Spin | Rate, direction (clock dial, pitcher's view), efficiency (active spin %), seam orientation |
| Release | Velocity, height, side, extension |
| Environment | Altitude (try Coors Field), temperature, humidity → air density |
| Playback | Play, pause, reverse, frame step, scrub, loop, speeds from 1× down to 0.01× |
| Camera | 3/4, catcher, batter, side, behind mound, overhead, follow-ball. Drag to orbit, right-drag or shift-drag to pan, scroll to zoom |

Keyboard: `Space` play/pause · `←/→` step · `R` replay · `L` loop · `[ ]` speed · `1`–`7` cameras

URL parameters, for sharing a specific moment:
`?pitch=cu&hand=L&view=follow&t=0.25&pause=1&rate=0.05&rpm=2800&ball=4`

## Physics

- RK4 integration (0.5 ms steps) of gravity, drag, and Magnus lift.
- C<sub>D</sub> = 0.3008 + 0.0292·(rpm/1000) (Nathan). C<sub>L</sub>(S) is bilinear in the spin factor S = rω/v (Sawicki et al.).
- Only the **transverse** spin component (ω perpendicular to v) produces lift. Gyro spin produces none. The force is along ω × v.
- The release direction is solved iteratively so the spinning pitch hits the chosen target.
- Air density comes from altitude (barometric formula), temperature, and humidity.

The surface pressure and airflow are **qualitative**: potential flow around a sphere, plus a boundary layer dragged by the surface and a spin-shifted separation and wake. They match the direction and relative size of the real effect but are not CFD. Seam-shifted wake effects are not modeled.

## Layout

```
index.html, style.css   UI shell
serve.mjs               zero-dependency static server
src/physics.js          trajectory model, presets, aim solver
src/renderer.js         WebGPU pipelines (render + compute)
src/shaders.js          WGSL: sky, field, ball (seams + pressure), arrows, lines, particles
src/camera.js           orbit / preset / follow camera
src/geometry.js         meshes, seam curve
src/main.js             state, UI, playback, HUD
```
