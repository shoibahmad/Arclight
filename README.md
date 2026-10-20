# ARCLIGHT

An anti-gravity circuit racer built on Three.js. Six circuits, four craft, two
speed classes, three championships, time trial with ghosts.

It runs from a clean clone with **no install step, no build step, and no
network access**. Clone it, start a static server, drive.

```
git clone <this repo>
cd arclight
npm start            # or: python -m http.server 8080
```

Then open `http://localhost:8080`. `npm start` runs `tools/serve.mjs`, a
~90-line static file server that uses nothing but the Node standard library.
There are no dependencies to install — `package.json` has no `dependencies`
and no `devDependencies`.

---

## The hook

A luminous **arcline** is threaded through every circuit — a moving ideal
racing line that is re-derived with a different wander every lap. Riding it
charges your cell.

The cell is the only resource in the game. It pays for boost, for shields, and
for the air brakes that get you through a hairpin without lifting. So every
corner is the same question asked a different way: *can I afford to take the
fast way through this one, given what I spent on the last straight?* Spend
everything on boost down the Mile and you arrive at Dockhead with no shield;
hit the barrier there and the race is over.

It is readable at a glance — you are on the glowing ribbon or you are not —
and it gives the AI something legible to fight you over.

---

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Thrust | `W` / `↑` | Right trigger |
| Brake | `S` / `↓` | Left trigger |
| Steer | `A` `D` / `←` `→` | Left stick |
| Left air brake | `Q` | Left bumper |
| Right air brake | `E` | Right bumper |
| Boost | `Shift` | B / Circle |
| Shield | `Space` | Y / Triangle |
| Look back | `C` | Right stick click |
| Pause | `Esc` | Start |
| Restart (time trial) | `R` | Back |

Every key is rebindable from **Settings → Controls**. A standard-layout
gamepad works with no setup.

The air brakes are the thing worth learning. They rotate the craft *and* scrub
speed, and they draw from the cell — so they are a real decision, not a free
turn.

---

## What is in it

**Six circuits**, each authored as a corner sequence rather than a coordinate
list:

| Circuit | Environment | Length | Character |
| --- | --- | --- | --- |
| Meridian Flats | High desert | 3.3 km | Wide and forgiving; the tutorial circuit |
| Saltflat Run | High desert | 3.8 km | Almost no slow corners |
| Lowtown Spiral | Night city | 2.4 km | Ten corners, nowhere to recharge |
| Harbour Mile | Night city | 4.3 km | The longest straight in the game |
| Vaskr Hollow | Glacier | 3.2 km | Linked sweepers that never settle |
| Calder Shelf | Glacier | 3.3 km | Climbs 57 m and gives it back in two drops |

**Four craft** — Kestrel (balanced), Vireo (grippy, charges fast, no top end),
Mantis (fastest and least forgiving), Oriole (heavy, stubborn, hard to put
out of a race).

**Two speed classes.** Apex is not simply "everything faster": grip rises more
slowly than speed does, so corners that were flat in Sprint need a genuine
lift.

**Three championships**, each unlocking the next along with the circuits and
craft it introduces.

**Time trial** with ghost recording and playback, and a live delta.

Roughly 30–45 minutes to see all six circuits once in Sprint; the Apex class
and the Summit Cup take it well past that.

---

## Running the tests

```
npm test             # unit tests  (Node, no browser)
npm run test:smoke   # end-to-end  (headless Chrome)
```

`npm test` runs the pure-logic suites — track geometry, the arcline, and the
handling model — directly in Node. The bare `three` specifier is mapped to the
vendored build by a 20-line ESM resolver hook in `tools/test/`, and a small
canvas shim lets the procedural texture generators run headlessly too. No
bundler, no `node_modules`.

`npm run test:smoke` boots the real game in headless Chrome over the DevTools
protocol (`tools/browser.mjs`, also dependency-free — Node 22 ships a global
`WebSocket`), drives a full race to classification, and fails on any console
error, any non-finite state, or a field that does not finish.

Other tools:

```
node --import ./tools/test/register.mjs tools/layout-report.mjs   # circuit stats
node --import ./tools/test/register.mjs tools/close-layout.mjs <id>
npm run capture                                                   # screenshots
```

`tools/sandbox/` holds two live pages — a material/post-chain sandbox and a
track flythrough — that load the real engine modules with none of the game on
top. They are how the look was tuned.

---

## Assets

Every asset in this repository is generated from code that is also in this
repository. There are no texture files, no models, and no audio files.

- **Textures** — `src/assets/Textures.js` builds every surface from simplex
  and Worley noise plus canvas drawing, and derives normal maps by Sobel over
  the height field. Albedo and a packed ORM map (ambient occlusion,
  roughness, metalness) per surface.
- **Geometry** — `src/assets/MeshBuilder.js` and the builders on top of it.
  Craft hulls are lofted from cross-sections; the track is swept from a
  profile; rocks are noise-displaced icosahedra.
- **Audio** — `src/audio/AudioEngine.js` synthesises everything through the
  Web Audio API. Engine notes are generated from speed, throttle and boost
  rather than sampled, which is why they track the simulation continuously.
  The score is generative and scheduled 120 ms ahead.
- **Fonts** — system font stacks only.

The only third-party code is Three.js itself, vendored under `vendor/three/`
with its MIT licence. See [NOTICE.md](NOTICE.md).

---

## Layout

```
index.html            import map + boot shell
src/
  core/               loop, input, settings, save profile, math
  render/             viewport, post chain, sky, environment, arcline ribbon
  assets/             procedural noise, textures, materials, mesh builder
  track/              centreline, layout DSL, mesh, arcline, scenery
  game/               ship physics, AI, race rules, camera, visuals
  audio/              synthesis
  ui/                 HUD, screens
  data/               circuits, craft, themes, championships
styles/               three stylesheets
tools/                server, test harness, authoring tools, sandboxes
tests/                unit tests
vendor/three/         Three.js r186 (MIT)
docs/                 architecture and design notes
```

Start with [docs/architecture.md](docs/architecture.md) for how the pieces fit
together, and [docs/design.md](docs/design.md) for why the game is shaped the
way it is.

---

## Requirements

A browser with **WebGL 2** — any current Chrome, Edge, Firefox or Safari.
Node 18+ is needed only for `npm start` and the tests; the game itself is
static files and will run from any web server.

If the frame rate is not where you want it, **Settings → Quality** and
**Render scale** are the two dials that matter. Render scale is the stronger
of the two.

---

## Licence

See [LICENSE](LICENSE).
