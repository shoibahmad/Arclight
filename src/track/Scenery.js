import * as THREE from 'three';
import { Noise, worley2 } from '../assets/Noise.js';
import { MeshBuilder } from '../assets/MeshBuilder.js';
import { terrainMaterial, panelMaterial, emissiveMaterial, hullMaterial } from '../assets/Materials.js';
import { TrackSample } from './TrackPath.js';
import { PROFILE } from './TrackMesh.js';
import { clamp, clamp01, lerp, makeRng, smoothstep } from '../core/MathUtil.js';

/**
 * The world around the circuit: terrain, support structure and scenery.
 *
 * Terrain is a heightfield that knows where the track is. Each vertex is
 * projected onto the centreline, and the ground is pushed down into a gorge
 * near the road and released into natural hills further out. Without that the
 * circuit either floats in a void or buries itself in a hillside halfway
 * round, and on a track like Calder Shelf — which climbs sixty metres — there
 * is no single ground plane that works at all.
 *
 * Scenery is instanced. A canyon wants several hundred rocks and a city wants
 * a hundred towers; at one draw call each that is a frame's budget gone, and
 * at one draw call total it is free.
 */

/** How far beyond the track bounds the terrain extends. */
const TERRAIN_MARGIN = 900;
/** Heightfield resolution. 160 is ~25k vertices, which builds in well under a second. */
const TERRAIN_RESOLUTION = 160;
/** Lateral distance over which the ground blends from gorge to natural. */
const GORGE_INNER = 26;
const GORGE_OUTER = 190;

export class Scenery {
  /**
   * @param {import('./Track.js').Track} track
   */
  constructor(track) {
    this.track = track;
    this.theme = track.theme;
    this.group = new THREE.Group();
    this.group.name = 'scenery';
    this.disposables = [];

    const seed = hashString(track.id);
    this.rng = makeRng(seed);
    this.noise = new Noise(seed);

    this._buildTerrain();
    this._buildSupports();
    this._buildDecor();
  }

  /** Terrain height at a world position, ignoring the track. */
  _naturalHeight(x, z) {
    const n = this.noise;
    const theme = this.theme.decor;
    const broad = n.fbm(x * 0.00055, z * 0.00055, 4) * 0.5 + 0.5;
    const medium = n.fbm(x * 0.0022, z * 0.0022, 4) * 0.5 + 0.5;

    if (theme === 'city') {
      // Flat and built-up: the interest is in the towers, not the ground.
      return broad * 14 - 6 + medium * 3;
    }
    if (theme === 'glacier') {
      // Broad snowfields cut by fracture lines.
      const cells = worley2(x * 0.0019, z * 0.0019, 11);
      return broad * 58 - 14 + smoothstep(0.0, 0.25, cells) * 22 + medium * 6;
    }
    // Canyon: ridged mesas.
    const ridges = n.ridged(x * 0.0012, z * 0.0012, 5);
    return ridges * 120 - 26 + medium * 14 + broad * 30;
  }

  _buildTerrain() {
    const track = this.track;
    const bounds = track.bounds;
    const minX = bounds.min.x - TERRAIN_MARGIN;
    const maxX = bounds.max.x + TERRAIN_MARGIN;
    const minZ = bounds.min.z - TERRAIN_MARGIN;
    const maxZ = bounds.max.z + TERRAIN_MARGIN;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;

    const res = TERRAIN_RESOLUTION;
    const geometry = new THREE.PlaneGeometry(spanX, spanZ, res, res);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(minX + spanX / 2, 0, minZ + spanZ / 2);

    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const probe = new THREE.Vector3();
    let hint = -1;

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      probe.set(x, 0, z);

      // The projection only needs to be approximate here, and walking from
      // the previous vertex's result keeps it to a local search.
      const hit = track.path.project(probe, hint, 40);
      hint = hit.index;

      const sample = track.frameAt(hit.distance, _sample);
      const lateral = Math.abs(hit.lateral);
      // 1 right beside the road, 0 well away from it.
      const nearness = 1 - smoothstep(GORGE_INNER, GORGE_OUTER, lateral);

      const natural = this._naturalHeight(x, z);
      // Floor of the gorge: below the deck, deeper where the track is high.
      const gorge = sample.position.y - PROFILE.deckDepth - 9;
      const height = lerp(natural, gorge, nearness * nearness);

      position.setY(i, height);
      // Tile in world units so the texture does not stretch. Kept coarse:
      // at a grazing angle a finer tiling aliases into speckle that the
      // chromatic aberration then smears into colour fringing.
      uv.setXY(i, x / 88, z / 88);
    }

    position.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = terrainMaterial(this.theme, { normalScale: 0.5 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    this.group.add(mesh);
    this.disposables.push(geometry);
    this.terrain = mesh;
  }

  /**
   * Pylons holding the deck up wherever it stands clear of the ground.
   * Instanced, because a 4km circuit wants sixty of them.
   */
  _buildSupports() {
    const track = this.track;
    const spacing = 58;
    const count = Math.floor(track.length / spacing);
    const transforms = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const distance = i * spacing;
      const sample = track.frameAt(distance, _sample);
      const deckBottom = sample.position.y - PROFILE.deckDepth;
      const ground = this._naturalHeight(sample.position.x, sample.position.z);
      // Near the road the ground has been pushed into the gorge.
      const gorgeFloor = sample.position.y - PROFILE.deckDepth - 9;
      const height = deckBottom - gorgeFloor;
      if (height < 2) continue;

      for (const side of [-1, 1]) {
        position
          .copy(sample.position)
          .addScaledVector(sample.right, side * (sample.width / 2 + PROFILE.kerbWidth * 0.5))
          .addScaledVector(sample.normal, -PROFILE.deckDepth);
        position.y -= height / 2;

        scale.set(1, height, 1);
        quaternion.setFromUnitVectors(up, sample.normal);
        matrix.compose(position, quaternion, scale);
        transforms.push(matrix.clone());
      }
      void ground;
    }

    if (transforms.length === 0) return;
    const geometry = new THREE.BoxGeometry(1.5, 1, 1.5);
    const mesh = new THREE.InstancedMesh(geometry, panelMaterial(this.theme), transforms.length);
    transforms.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'supports';
    this.group.add(mesh);
    this.disposables.push(geometry);
  }

  _buildDecor() {
    switch (this.theme.decor) {
      case 'city':
        this._buildCity();
        break;
      case 'glacier':
        this._buildGlacier();
        break;
      default:
        this._buildCanyon();
    }
  }

  /**
   * Scatter positions in a ring around the circuit.
   * Candidates too close to the road are rejected outright rather than pushed
   * away, because pushing them produces a visible wall of props following the
   * track at a constant offset.
   */
  _scatter(count, { minLateral, maxLateral, density = 1 }) {
    const track = this.track;
    const wanted = Math.round(count * density);
    const results = [];
    const probe = new THREE.Vector3();

    for (let i = 0; i < wanted * 3 && results.length < wanted; i++) {
      const distance = this.rng() * track.length;
      const side = this.rng() < 0.5 ? -1 : 1;
      const lateral = side * lerp(minLateral, maxLateral, Math.pow(this.rng(), 0.7));

      const sample = track.frameAt(distance, _sample);
      probe
        .copy(sample.position)
        .addScaledVector(sample.right, lateral);

      // Reject anything that landed near another part of the circuit.
      const hit = track.path.project(probe, -1);
      if (Math.abs(hit.lateral) < minLateral * 0.85) continue;

      probe.y = this._naturalHeight(probe.x, probe.z);
      results.push({ position: probe.clone(), distance, lateral, rng: this.rng() });
    }
    return results;
  }

  _addInstances(name, geometry, material, placements, build) {
    if (placements.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    const matrix = new THREE.Matrix4();
    placements.forEach((placement, i) => {
      build(matrix, placement, i);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
    this.disposables.push(geometry);
  }

  _buildCanyon() {
    const density = this.track.theme.decorDensity ?? 1;
    const rocks = this._scatter(260, { minLateral: 55, maxLateral: 780, density });
    const geometry = rockGeometry(this.noise, 1);
    const material = terrainMaterial(this.theme, { name: 'rock' });

    this._addInstances('rocks', geometry, material, rocks, (matrix, p) => {
      const size = lerp(5, 34, Math.pow(p.rng, 1.8));
      _position.copy(p.position);
      _position.y -= size * 0.25;
      _quaternion.setFromAxisAngle(_up, p.rng * Math.PI * 2);
      _scale.set(size * lerp(0.7, 1.4, p.rng), size * lerp(0.8, 1.9, 1 - p.rng), size);
      matrix.compose(_position, _quaternion, _scale);
    });

    // A few tall spires further out, for silhouette against the sky.
    const spires = this._scatter(34, { minLateral: 260, maxLateral: 900, density });
    const spireGeometry = new THREE.CylinderGeometry(0.42, 1, 1, 7, 1);
    this._addInstances('spires', spireGeometry, material, spires, (matrix, p) => {
      const height = lerp(60, 190, p.rng);
      _position.copy(p.position);
      _position.y += height * 0.4;
      _quaternion.setFromAxisAngle(_up, p.rng * 7);
      _scale.set(lerp(12, 30, p.rng), height, lerp(12, 30, 1 - p.rng));
      matrix.compose(_position, _quaternion, _scale);
    });
  }

  _buildCity() {
    const density = this.track.theme.decorDensity ?? 1;
    const towers = this._scatter(170, { minLateral: 48, maxLateral: 820, density });
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = panelMaterial(this.theme, { name: 'tower' });

    this._addInstances('towers', geometry, material, towers, (matrix, p) => {
      const height = lerp(30, 230, Math.pow(p.rng, 2.1));
      const footprint = lerp(14, 40, p.rng);
      _position.copy(p.position);
      _position.y += height / 2 - 4;
      _quaternion.setFromAxisAngle(_up, Math.round(p.rng * 4) * (Math.PI / 4));
      _scale.set(footprint, height, footprint * lerp(0.7, 1.3, p.rng));
      matrix.compose(_position, _quaternion, _scale);
    });

    // Window light: emissive slabs on a subset of the towers, so the skyline
    // reads at night without lighting every face.
    const lit = towers.filter((t) => t.rng > 0.45);
    const litGeometry = new THREE.BoxGeometry(1, 1, 1);
    this._addInstances(
      'tower-lights',
      litGeometry,
      emissiveMaterial(this.theme.accentWarm, 0.5),
      lit,
      (matrix, p) => {
        const height = lerp(30, 230, Math.pow(p.rng, 2.1));
        const footprint = lerp(14, 40, p.rng);
        _position.copy(p.position);
        _position.y += height / 2 - 4;
        _quaternion.setFromAxisAngle(_up, Math.round(p.rng * 4) * (Math.PI / 4));
        _scale.set(footprint * 1.01, height * 0.82, footprint * 0.22);
        matrix.compose(_position, _quaternion, _scale);
      }
    );

    // Beacons on the tallest structures.
    const tall = towers.filter((t) => t.rng > 0.88);
    const beaconGeometry = new THREE.SphereGeometry(1, 8, 6);
    this._addInstances(
      'beacons',
      beaconGeometry,
      emissiveMaterial(0xff4d5e, 3),
      tall,
      (matrix, p) => {
        const height = lerp(30, 230, Math.pow(p.rng, 2.1));
        _position.copy(p.position);
        _position.y += height - 2;
        _quaternion.identity();
        _scale.setScalar(2.4);
        matrix.compose(_position, _quaternion, _scale);
      }
    );
  }

  _buildGlacier() {
    const density = this.track.theme.decorDensity ?? 1;
    const material = terrainMaterial(this.theme, { name: 'ice' });

    const seracs = this._scatter(210, { minLateral: 50, maxLateral: 760, density });
    const geometry = iceGeometry();
    this._addInstances('seracs', geometry, material, seracs, (matrix, p) => {
      const height = lerp(9, 62, Math.pow(p.rng, 1.7));
      _position.copy(p.position);
      _position.y += height * 0.36;
      _quaternion.setFromAxisAngle(_up, p.rng * Math.PI * 2);
      _scale.set(lerp(6, 22, p.rng), height, lerp(6, 22, 1 - p.rng));
      matrix.compose(_position, _quaternion, _scale);
    });

    // Low ridges hugging the gorge edge, to give the cutting a lip.
    const ridges = this._scatter(120, { minLateral: 34, maxLateral: 110, density });
    const ridgeGeometry = rockGeometry(this.noise, 2);
    this._addInstances('ice-ridges', ridgeGeometry, material, ridges, (matrix, p) => {
      const size = lerp(6, 18, p.rng);
      _position.copy(p.position);
      _position.y -= size * 0.3;
      _quaternion.setFromAxisAngle(_up, p.rng * 5);
      _scale.set(size * 1.8, size * 0.7, size);
      matrix.compose(_position, _quaternion, _scale);
    });
  }

  dispose() {
    for (const item of this.disposables) item.dispose?.();
    this.disposables.length = 0;
    this.group.traverse((child) => {
      if (child.isInstancedMesh) child.dispose?.();
    });
    this.group.clear();
  }
}

/** A lumpy boulder: an icosahedron with its vertices pushed around by noise. */
function rockGeometry(noise, seed = 1) {
  const geometry = new THREE.IcosahedronGeometry(0.5, 1);
  const position = geometry.getAttribute('position');
  const vector = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    vector.fromBufferAttribute(position, i);
    const n = noise.fbm(vector.x * 2.4 + seed * 11, vector.z * 2.4 + vector.y * 1.7, 3);
    vector.multiplyScalar(1 + n * 0.42);
    // Flatten the base so rocks sit on the ground rather than floating.
    if (vector.y < -0.2) vector.y = lerp(vector.y, -0.34, 0.7);
    position.setXYZ(i, vector.x, vector.y, vector.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** An angular ice block: a tapered prism with an uneven top. */
function iceGeometry() {
  const builder = new MeshBuilder();
  const sides = 6;
  const bottom = [];
  const top = [];

  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const r0 = 0.5 * (0.85 + Math.sin(angle * 3) * 0.15);
    const r1 = 0.26 * (0.7 + Math.cos(angle * 2 + 1) * 0.3);
    const x0 = Math.cos(angle) * r0;
    const z0 = Math.sin(angle) * r0;
    const x1 = Math.cos(angle) * r1 + 0.08;
    const z1 = Math.sin(angle) * r1;
    const nx = Math.cos(angle);
    const nz = Math.sin(angle);
    bottom.push(builder.vertex(x0, -0.5, z0, nx, 0.1, nz, i / sides, 0));
    top.push(builder.vertex(x1, 0.5, z1, nx, 0.35, nz, i / sides, 1));
  }

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    builder.quad(bottom[i], bottom[j], top[j], top[i]);
  }
  const apex = builder.vertex(0.08, 0.56, 0, 0, 1, 0, 0.5, 1);
  for (let i = 0; i < sides; i++) {
    builder.triangle(top[i], top[(i + 1) % sides], apex);
  }

  return builder.build({ name: 'ice' });
}

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const _sample = new TrackSample();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export { rockGeometry, iceGeometry };
