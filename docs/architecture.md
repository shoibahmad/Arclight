# Architecture

How the pieces fit together, and why they are arranged this way.

---

## The shape of a frame

```
Loop (core/Loop.js)
 ├─ fixed step, 1/120s, up to 5 catch-up steps
 │   └─ Game.step()
 │       ├─ Input.update()          sample keyboard + gamepad once
 │       ├─ AIDriver.update()  ×7   produce a controls object each
 │       ├─ Ship.update()     ×8    physics, in the track's local frame
 │       ├─ Race._resolveContacts() craft-to-craft separation
 │       └─ RaceDirector.update()   laps, sectors, standings
 │
 └─ once per rendered frame
     └─ Game.render()
         ├─ Race.present()          visuals, trails, camera, effects
         ├─ Viewport.render()       scene → HDR target → bloom → composite
         ├─ Hud.update()            DOM, only where values changed
         └─ AudioEngine.update()    engine voices, music intensity
```

The split between `step` and `present` is load-bearing. Everything that
affects where a craft ends up lives in `step` and runs at exactly 1/120s;
everything cosmetic lives in `present` and runs at whatever rate the display
manages. Vehicle handling is extremely sensitive to step size — tune grip at
60Hz and the same craft understeers on a 144Hz monitor — so the simulation
never sees a variable delta.

`Loop` caps catch-up at five steps and discards the backlog beyond that. A
GC pause or a shader compile should cost one stutter, not a spiral of
ever-longer frames.

---

## Layers

The dependency direction is strictly downward. Nothing in `core/` or
`track/` imports from `game/` or `ui/`.

```
  ui/          HUD, screens              ─┐
  audio/       synthesis                  ├─ read the simulation, never write it
  render/      viewport, post, sky       ─┘
  game/        ships, AI, race rules      ← the simulation
  track/       geometry, arcline          ← the world
  assets/      noise, textures, meshes    ← how the world is built
  core/        loop, input, storage, math ← no game knowledge at all
  data/        plain objects, no logic
```

`RaceDirector` is deliberately free of three.js, the DOM and audio. It is
handed a track and a list of craft and emits events. That is what makes the
rules testable in Node, and it means the HUD, the audio engine and the
championship screen all read the same standings rather than each deriving
their own idea of who is winning.

---

## The track is a coordinate system

`TrackPath` is the most important class in the project. It takes control
nodes and produces a centreline **resampled to uniform arc length**, then
offers two operations:

- `sampleAt(distance)` — the road frame (position, tangent, normal, right,
  width, bank, curvature) at *d* metres around the lap
- `project(worldPos, hint)` — where a world position sits, as
  `{distance, lateral, height}`

Everything downstream works in those terms. Physics, the AI's corner
lookahead, the minimap, texture tiling, scenery placement and the arcline are
all expressed as "metres around the lap" and "metres right of centre", never
as world coordinates or spline parameter.

Spline parameter is specifically avoided: a Catmull-Rom's `t` advances at
wildly different rates through tight and open corners, so anything paced by
it comes out uneven.

`project` takes the caller's previous sample index as a hint and does a
windowed local search, falling back to a full coarse-to-fine scan when the
hint turns out to be stale. That is what makes it affordable to call once per
craft per physics step.

### Frames

Surface normals are carried forward by parallel transport rather than derived
from world up, so a steep climb or a hard camber change cannot flip the road
over. The residual twist where the loop meets itself is distributed evenly
around the lap, so there is no kink at the start line.

`right = normal × tangent`. The other order gives *left*, which is an easy
mistake to make and silently mirrors the grid, the minimap, and every
overtaking decision the AI makes. There is a unit test pinning it down.

---

## Circuits are authored, not generated

A circuit is a sequence of corners:

```js
{ straight: 480, name: 'Main straight', width: 24 },
{ turn: 80, radius: 150, bank: 10, rise: 6, name: 'Copperline' },
```

`TrackLayout.buildLayout()` walks that into control nodes. A hand-written
loop never closes, so it is squared up in two steps:

1. **Heading.** Every corner is scaled by one common factor so the total
   turning is exactly 360°.
2. **Position.** With corner angles fixed, each segment's displacement is
   linear in one number — a straight in its length, an arc in its radius
   (chord = 2R·sin θ/2 along a fixed heading). Closing the loop is therefore
   a two-equation least-squares problem over all of them, and the
   minimum-norm solution spreads the correction in proportion to how much
   each segment points along the gap.

Straights are weighted far above radii, so a circuit gets stretched rather
than reshaped. All six circuits close to 0.00 m.

`tools/layout-report.mjs` is the authoring feedback loop — length, closure
residual, how hard the builder had to bend things, tightest radius, steepest
grade. Two of the six circuits were redesigned because it said so.

---

## Physics without a collision mesh

`Ship` is a point mass with an orientation, held to the road by a hover
spring, positioned in the track's local frame. There is no rigid body and no
collision geometry.

That is the whole architecture. A general rigid body on three kilometres of
banked ribbon spends its life tunnelling through barriers and catching edges
at 130 m/s. A craft that asks the track where the road *is* can never leave
it by accident: the barrier check is `|lateral| > width/2 + kerb`, which is
exact at any speed and any step size.

Three deliberate departures from realism, each one something a player can
feel:

- **Grip grows with speed.** The craft plants itself the harder it is driven,
  and lifting mid-corner is punished.
- **Yaw authority shrinks with speed.** High-speed corrections are gentle;
  hairpins are sharp.
- **Air brakes rotate *and* scrub.** They cost speed and cell, so using one
  is a decision rather than a free turn.

Drag is not a tuned constant — it is derived per craft as
`thrust / topSpeed²`, so the quoted top speed *is* the terminal velocity and
boost raises it by the correct `sqrt((thrust + boost) / thrust)`. Changing a
stat never requires re-chasing the drag number.

Lateral grip is applied as a limited impulse rather than a force, which is
stable at any step size and gives a clean break into a slide.

---

## Rendering

The scene is rendered with **tone mapping off** into a half-float target, and
ACES is applied later in the composite. That ordering is what makes bloom
work: the bright pass gathers genuine HDR values, so a thruster forty times
over white blooms like one instead of clipping to white before it is ever
sampled.

```
scene ──► HDR target (half-float, MSAA)
            ├─► bright pass ─► downsample ×5 ─► upsample ×5  (mip-chain bloom)
            └─────────────────────────────┬───► composite
                                          │     radial speed blur
                                          │     chromatic aberration
                                          │     + bloom
                                          │     ACES tone map
                                          │     grade, vignette, grain, fade
                                          └───► canvas
```

Bloom is the Call of Duty: Advanced Warfare mip chain rather than a stack of
gaussians — cheaper for the same reach, and stable under motion, which
matters when bright track edges sweep past at 300 kph. The Karis-weighted
first downsample is what kills the firefly pixels that otherwise shimmer.

The post chain is hand-written rather than using three's `examples/jsm`
addons, so the only vendored code is three core.

### Environment map

The sky dome is pre-filtered into an environment map once per track load.
Without it every metal in the scene renders almost black — a metallic surface
has no diffuse response, so a PBR material at metalness 0.8 with nothing to
reflect is correctly and uselessly black. One 256 px cube capture fixes the
craft, the barriers and the road at zero per-frame cost.

---

## Assets are code

Nothing is loaded from disk. `src/assets/` generates:

- **Textures** from simplex and Worley noise plus canvas drawing. Normal maps
  are derived by Sobel over the height field; ambient occlusion, roughness
  and metalness are packed into one ORM texture, which is the layout three's
  `MeshStandardMaterial` already expects.
- **Geometry** through `MeshBuilder`, which accumulates vertices and
  triangles directly. Craft hulls are lofted from cross-sections; the track
  is one continuous profile swept along the centreline; rocks are
  noise-displaced icosahedra.

Texture *data* is cached and shared. Where a surface needs different tiling,
the texture is cloned — a three `Texture` clone shares its `source`, so the
image is still uploaded once, but repeat and offset become independent.
Mutating the cached texture instead would silently re-tile every other
surface using it.

---

## Performance notes

- Track geometry is emitted in 220 m chunks. A single mesh per circuit can
  never be frustum culled, so the GPU would transform the whole track every
  frame including the half behind the camera.
- Scenery is instanced — one draw call for several hundred rocks.
- Trails and the arcline ribbon are ring buffers written into fixed geometry.
  Reallocating them per frame across eight craft is exactly the kind of
  steady allocation that becomes a GC stutter a minute into a race.
- The HUD only touches the DOM when a value has actually changed, and the
  position tower reorders with CSS `order` rather than by moving nodes.
- Engine voices are allocated only for the player and the three nearest
  rivals.

---

## Testing

`npm test` runs the pure-logic suites in Node. The bare `three` specifier is
mapped to the vendored build by an ESM resolver hook in `tools/test/`, and a
small canvas shim lets the texture generators run headlessly — so a full
circuit, textures and all, can be built and asserted on without a browser.

`npm run test:smoke` drives the real game in headless Chrome through the
DevTools protocol (`tools/browser.mjs`, dependency-free — Node 22 ships a
global `WebSocket`), runs a race to classification, and fails on any console
error or non-finite state.

Several real bugs were caught this way rather than by inspection, including a
chromatic aberration term that put a sign flip through the middle of the
screen, and a negative frame delta that poisoned the impact-flash state and
bleached every subsequent frame.
