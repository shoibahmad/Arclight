/**
 * Track preview.
 *
 * Builds a circuit and flies a camera along it. No physics, no craft — this
 * exists purely to look at the generated geometry and lighting, and to catch
 * things like an inverted barrier face or a kerb UV that stretches through a
 * corner, which are invisible in a unit test.
 *
 * Query params:
 *   ?track=meridian     which circuit to build
 *   ?at=0.35            normalised distance around the lap (static shot)
 *   ?fly=1              fly the lap instead of holding position
 *   ?view=chase|orbit|top
 */

import * as THREE from 'three';
import { Viewport } from '../../src/render/Viewport.js';
import { Environment } from '../../src/render/Environment.js';
import { Settings } from '../../src/core/Settings.js';
import { Track } from '../../src/track/Track.js';
import { loadTrack, TRACK_IDS } from '../../src/data/tracks/index.js';
import { TrackSample } from '../../src/track/TrackPath.js';

const params = new URLSearchParams(location.search);
const trackId = TRACK_IDS.includes(params.get('track')) ? params.get('track') : TRACK_IDS[0];
const startAt = Number(params.get('at')) || 0;
const fly = params.get('fly') === '1';
const view = params.get('view') || 'chase';

const readout = document.getElementById('readout');
const canvas = document.getElementById('viewport');

const settings = new Settings();
const viewport = new Viewport(canvas, settings);
const scene = new THREE.Scene();

const buildStart = performance.now();
const track = new Track(loadTrack(trackId));
const buildMs = performance.now() - buildStart;
scene.add(track.group);

const environment = new Environment(scene, track.theme, settings);
environment.applyGrade(viewport);
track.setStartLights(2);

const camera = new THREE.PerspectiveCamera(74, viewport.aspect, 0.4, 6000);
const sample = new TrackSample();
const lookSample = new TrackSample();

let distance = startAt * track.length;
let last = performance.now();
let frame = 0;

function placeCamera() {
  track.frameAt(distance, sample);

  if (view === 'top') {
    const size = new THREE.Vector3();
    track.bounds.getSize(size);
    const span = Math.max(size.x, size.z);
    camera.position.set(
      track.bounds.min.x + size.x / 2,
      track.bounds.min.y + span * 0.95,
      track.bounds.min.z + size.z / 2 + 1
    );
    camera.lookAt(track.bounds.min.x + size.x / 2, 0, track.bounds.min.z + size.z / 2);
    return;
  }

  if (view === 'orbit') {
    const a = frame * 0.004;
    camera.position
      .copy(sample.position)
      .addScaledVector(sample.right, Math.sin(a) * 55)
      .addScaledVector(sample.tangent, Math.cos(a) * 55)
      .addScaledVector(sample.normal, 22);
    camera.lookAt(sample.position);
    return;
  }

  // Chase: sit where a craft would, looking down the road.
  camera.position
    .copy(sample.position)
    .addScaledVector(sample.tangent, -11)
    .addScaledVector(sample.normal, 4.2);
  track.frameAt(distance + 34, lookSample);
  camera.lookAt(lookSample.position.clone().addScaledVector(lookSample.normal, 1.5));
  camera.up.copy(sample.normal);
}

function tick(now) {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;

  if (fly) distance = track.path.wrap(distance + 120 * dt);

  placeCamera();
  camera.aspect = viewport.aspect;
  camera.updateProjectionMatrix();

  viewport.resize();
  viewport.setSpeedSignal(fly ? 0.55 : 0.1);
  environment.update(camera.position, camera, frame * 0.016);
  viewport.render(scene, camera, dt);

  frame++;
  if (frame % 10 === 1) {
    readout.textContent =
      `${track.name}  (${track.theme.name})\n` +
      `length     ${track.length.toFixed(0)} m, ${track.laps} laps\n` +
      `at         ${distance.toFixed(0)} m  (sector ${track.sectorFor(distance) + 1})\n` +
      `width      ${sample.width.toFixed(1)} m, bank ${sample.bank.toFixed(1)}deg\n` +
      `build      ${buildMs.toFixed(0)} ms\n` +
      `draws      ${viewport.sceneStats?.calls ?? 0}\n` +
      `triangles  ${(viewport.sceneStats?.triangles ?? 0).toLocaleString()}\n` +
      `buffer     ${viewport.width}x${viewport.height}`;
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

window.preview = { track, viewport, environment, scene, camera, seek: (d) => { distance = d; } };
window.addEventListener('error', (e) => {
  readout.textContent = `ERROR ${e.message}\n${e.filename}:${e.lineno}`;
});
