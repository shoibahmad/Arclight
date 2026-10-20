/**
 * Render sandbox.
 *
 * Boots the viewport, a theme and a handful of reference objects, with nothing
 * from the gameplay layer in the way. Used to tune the post chain and the
 * procedural materials — and to give the headless screenshot test something
 * deterministic to compare against.
 *
 * Query params:
 *   ?theme=ridge|nocturne|hollow
 *   ?frames=N   render N frames then stop (the screenshot harness uses this)
 */

import * as THREE from 'three';
import { Viewport } from '../../src/render/Viewport.js';
import { Environment } from '../../src/render/Environment.js';
import { Settings } from '../../src/core/Settings.js';
import { getTheme, THEME_IDS } from '../../src/data/themes.js';
import { roadSurface, panelSurface, terrainSurface, kerbSurface } from '../../src/assets/Textures.js';

const params = new URLSearchParams(location.search);
const themeId = THEME_IDS.includes(params.get('theme')) ? params.get('theme') : 'ridge';
const frameLimit = Number(params.get('frames')) || Infinity;
/** ?nopost=1 bypasses the whole post chain — scene straight to the canvas. */
const noPost = params.get('nopost') === '1';

const readout = document.getElementById('readout');
const canvas = document.getElementById('viewport');

const settings = new Settings();
const viewport = new Viewport(canvas, settings);
const scene = new THREE.Scene();
const theme = getTheme(themeId);
const environment = new Environment(scene, theme, settings);
environment.applyGrade(viewport);

const camera = new THREE.PerspectiveCamera(70, viewport.aspect, 0.3, 4000);

function standardMaterial(surface, repeat, extra = {}) {
  for (const tex of Object.values(surface)) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    tex.needsUpdate = true;
  }
  const mat = new THREE.MeshStandardMaterial({
    map: surface.map,
    normalMap: surface.normalMap,
    roughnessMap: surface.ormMap,
    metalnessMap: surface.ormMap,
    aoMap: surface.ormMap,
    roughness: 1,
    metalness: 1,
    ...extra,
  });
  mat.aoMap.channel = 0;
  return mat;
}

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000, 1, 1),
  standardMaterial(terrainSurface({ ...theme.surfaces.terrain }), [320, 320])
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// A strip of "road" with kerbs, as a stand-in for real track geometry.
const road = new THREE.Mesh(
  new THREE.PlaneGeometry(22, 240, 1, 1),
  standardMaterial(roadSurface({ ...theme.surfaces.road }), [1, 10])
);
road.rotation.x = -Math.PI / 2;
road.position.y = 0.05;
road.receiveShadow = true;
scene.add(road);

const kerbMat = standardMaterial(kerbSurface({ ...theme.surfaces.kerb }), [1, 40]);
for (const side of [-1, 1]) {
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.28, 240), kerbMat);
  kerb.position.set(side * 11.5, 0.14, 0);
  kerb.castShadow = kerb.receiveShadow = true;
  scene.add(kerb);
}

// Barrier pylons, to read the panel material and the shadowing.
const panelMat = standardMaterial(panelSurface({ ...theme.surfaces.panel }), [1, 1]);
for (let i = -5; i <= 5; i++) {
  for (const side of [-1, 1]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(1.1, 3.4, 1.1), panelMat);
    pylon.position.set(side * 14.5, 1.7, i * 20);
    pylon.castShadow = pylon.receiveShadow = true;
    scene.add(pylon);
  }
}

// Emissive trim — the thing the bloom chain has to handle gracefully.
const trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent).multiplyScalar(9) });
for (const side of [-1, 1]) {
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 240), trimMat);
  trim.position.set(side * 12.6, 0.5, 0);
  scene.add(trim);
}

// Reference spheres: roughness sweep across the frame.
for (let i = 0; i < 6; i++) {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 32, 24),
    new THREE.MeshStandardMaterial({
      color: 0xb9c4d2,
      roughness: i / 5,
      metalness: i < 3 ? 1 : 0.1,
    })
  );
  ball.position.set(-7.5 + i * 3, 1.5, -26);
  ball.castShadow = ball.receiveShadow = true;
  scene.add(ball);
}

/**
 * Reference path: three's own tone mapping straight to the canvas. Used to
 * tell "the scene is lit wrong" apart from "the post chain is wrong".
 */
function renderDirect() {
  const r = viewport.renderer;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1;
  r.setRenderTarget(null);
  r.clear(true, true, false);
  r.render(scene, camera);
  viewport.sceneStats = { calls: r.info.render.calls, triangles: r.info.render.triangles };
}

let frame = 0;
let last = performance.now();
let running = true;

function tick(now) {
  if (!running) return;
  // The first rAF timestamp can predate module init, because generating the
  // procedural textures blocks for a few seconds before `last` is sampled.
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;

  const t = frame * 0.004;
  camera.position.set(Math.sin(t) * 9, 3.4 + Math.sin(t * 0.7) * 1.2, 22 + Math.cos(t) * 6);
  camera.lookAt(0, 1.6, -26);
  camera.aspect = viewport.aspect;
  camera.updateProjectionMatrix();

  viewport.resize();
  viewport.setSpeedSignal(0.45);
  environment.update(camera.position, camera, frame * 0.016);
  if (noPost) renderDirect();
  else viewport.render(scene, camera, dt);

  frame++;
  readout.textContent =
    `theme     ${theme.name}\n` +
    `frame     ${frame}\n` +
    `buffer    ${viewport.width}x${viewport.height} @${viewport.pixelRatio.toFixed(2)}\n` +
    `draws     ${viewport.info.render.calls}\n` +
    `triangles ${viewport.info.render.triangles.toLocaleString()}\n` +
    `programs  ${viewport.renderer.info.programs?.length ?? 0}`;

  if (frame >= frameLimit) {
    running = false;
    document.title = 'sandbox-ready';
    return;
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// Exposed so the capture harness can poke individual post-chain uniforms and
// re-render a single frame while bisecting a visual regression.
window.sandbox = {
  THREE,
  viewport,
  environment,
  scene,
  camera,
  theme,
  set(name, value) {
    const u = viewport.composite.uniforms[name];
    if (!u) return `no uniform ${name}`;
    if (u.value && typeof u.value.set === 'function') u.value.set(value);
    else u.value = value;
    return true;
  },
  sky(name, value) {
    const u = environment.sky.uniforms[name];
    if (!u) return `no sky uniform ${name}`;
    if (u.value && typeof u.value.set === 'function') u.value.set(value);
    else u.value = value;
    return true;
  },
  frame(speed = 0.45) {
    viewport.setSpeedSignal(speed);
    viewport.speedSignal = speed;
    environment.update(camera.position, camera, 1.2);
    viewport.render(scene, camera, 1 / 60);
    return true;
  },
  stop() {
    running = false;
  },
  /** Read the linear HDR scene buffer at a normalised screen position. */
  probe(nx, ny) {
    const rt = viewport.sceneTarget;
    const x = Math.floor(nx * (rt.width - 1));
    const y = Math.floor((1 - ny) * (rt.height - 1)); // GL origin is bottom-left
    const raw = new Uint16Array(4);
    viewport.renderer.readRenderTargetPixels(rt, x, y, 1, 1, raw);
    return Array.from(raw, (v) => +THREE.DataUtils.fromHalfFloat(v).toFixed(4));
  },
};

window.addEventListener('error', (e) => {
  readout.textContent = `ERROR: ${e.message}\n${e.filename}:${e.lineno}`;
  document.title = 'sandbox-error';
});
