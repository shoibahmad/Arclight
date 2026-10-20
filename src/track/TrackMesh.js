import * as THREE from 'three';
import { MeshBuilder } from '../assets/MeshBuilder.js';
import { roadMaterial, kerbMaterial, panelMaterial, emissiveMaterial } from '../assets/Materials.js';

/**
 * Builds the visible circuit from a TrackPath.
 *
 * The cross-section is one continuous polyline, walked from the bottom of the
 * left barrier's outer face, up and over it, down across the road, and back up
 * and over the right barrier. Walking it in a single consistent direction
 * means every surface normal falls out of `cross(tangent, sectionDirection)`
 * with no per-surface sign juggling — the part of a generator like this that
 * otherwise ends up with one face lit from the wrong side.
 *
 * Geometry is emitted in chunks of a couple of hundred metres. A single mesh
 * can never be frustum culled, so one mesh per circuit would mean the GPU
 * transforming the entire track every frame, including the half behind the
 * camera.
 */

export const PROFILE = {
  kerbWidth: 1.7,
  kerbHeight: 0.26,
  wallHeight: 3.3,
  /** How far the top of the barrier leans away from the track. */
  wallLean: 0.55,
  wallThickness: 0.55,
  /** Depth of the structural deck below the running surface. */
  deckDepth: 1.6,
  trimInset: 0.08,
  trimWidth: 0.2,
  edgeLineInset: 0.22,
  edgeLineWidth: 0.26,
};

const CHUNK_METRES = 220;

/** Texture repeat lengths along the track, in metres. */
const V_SCALE = { road: 20, kerb: 4, wall: 12 };

/**
 * A column in the cross-section.
 * `group` names the strip *leaving* this point toward the next one.
 */
class ProfilePoint {
  constructor() {
    this.lateral = 0;
    this.height = 0;
    this.group = null;
    this.uRoad = 0;
    this.uKerb = 0;
    this.uWall = 0;
  }

  set(lateral, height, group) {
    this.lateral = lateral;
    this.height = height;
    this.group = group;
    return this;
  }
}

/**
 * Cross-section for a given road width, in traversal order.
 *
 * Not ordered by lateral position — the barriers lean outward, so the outer
 * faces run back against the sweep. The array is reused between samples; a
 * circuit has well over a thousand of them and there is no reason to allocate
 * a fresh profile for each.
 */
function buildProfile(width, roadColumns, scratch) {
  const hw = width / 2;
  const { kerbWidth, kerbHeight, wallHeight, wallLean, wallThickness, deckDepth } = PROFILE;
  const outer = hw + kerbWidth;
  const wallTop = kerbHeight + wallHeight;

  const total = 9 + roadColumns;
  while (scratch.length < total) scratch.push(new ProfilePoint());
  const p = scratch;
  let i = 0;

  p[i++].set(-(outer + wallThickness), -deckDepth, 'wall');
  p[i++].set(-(outer + wallThickness + wallLean), wallTop, 'wall');
  p[i++].set(-(outer + wallLean), wallTop, 'wall');
  p[i++].set(-outer, kerbHeight, 'kerb');
  p[i++].set(-hw, 0, 'road');
  for (let c = 1; c < roadColumns; c++) {
    p[i++].set(-hw + width * (c / roadColumns), 0, 'road');
  }
  p[i++].set(hw, 0, 'kerb');
  p[i++].set(outer, kerbHeight, 'wall');
  p[i++].set(outer + wallLean, wallTop, 'wall');
  p[i++].set(outer + wallThickness + wallLean, wallTop, 'wall');
  p[i++].set(outer + wallThickness, -deckDepth, null);

  const count = i;
  const leftRoadEdge = 4;
  const rightRoadEdge = 4 + roadColumns;

  // Road UVs track real lateral position so the panel grid stays square
  // regardless of how wide this part of the circuit is.
  for (let k = leftRoadEdge; k <= rightRoadEdge; k++) p[k].uRoad = (p[k].lateral + hw) / 10;

  // Each kerb runs 0 at the road edge to 1 at the barrier foot.
  p[leftRoadEdge].uKerb = 0;
  p[3].uKerb = 1;
  p[rightRoadEdge].uKerb = 0;
  p[rightRoadEdge + 1].uKerb = 1;

  // Barrier UVs follow arc length up and over the section, so the panelling
  // does not stretch where the wall leans.
  let arc = 0;
  p[0].uWall = 0;
  for (let k = 1; k < count; k++) {
    arc += Math.hypot(p[k].lateral - p[k - 1].lateral, p[k].height - p[k - 1].height);
    p[k].uWall = arc / 6;
  }
  // Restart the sweep on the right barrier so both sides read identically.
  let rightArc = 0;
  for (let k = rightRoadEdge + 1; k < count; k++) {
    if (k > rightRoadEdge + 1) {
      rightArc += Math.hypot(p[k].lateral - p[k - 1].lateral, p[k].height - p[k - 1].height);
    }
    p[k].uWall = rightArc / 6;
  }

  return count;
}

export class TrackMesh {
  /**
   * @param {import('./TrackPath.js').TrackPath} path
   * @param {object} theme
   */
  constructor(path, theme, { roadColumns = 6 } = {}) {
    this.path = path;
    this.theme = theme;
    this.group = new THREE.Group();
    this.group.name = 'track';

    this.materials = {
      road: roadMaterial(theme),
      kerb: kerbMaterial(theme),
      wall: panelMaterial(theme),
      trim: emissiveMaterial(theme.accent, 7, { side: THREE.DoubleSide }),
      edge: emissiveMaterial(theme.accent, 2.6, { side: THREE.DoubleSide }),
    };

    this.geometries = [];
    this._profileScratch = [];
    this._build(roadColumns);
  }

  _build(roadColumns) {
    const n = this.path.count;
    const samplesPerChunk = Math.max(8, Math.round(CHUNK_METRES / this.path.spacing));
    const chunkCount = Math.max(1, Math.round(n / samplesPerChunk));
    const perChunk = Math.ceil(n / chunkCount);

    for (let c = 0; c < chunkCount; c++) {
      const start = c * perChunk;
      if (start >= n) break;
      // Inclusive end, overlapping the next chunk by one sample so the strips
      // meet exactly. The final chunk wraps onto sample 0 to close the loop.
      const end = Math.min(start + perChunk, n);
      this._buildChunk(start, end, roadColumns, c);
    }
  }

  _buildChunk(startIndex, endIndex, roadColumns, chunkId) {
    const path = this.path;
    const builders = {
      road: new MeshBuilder(),
      kerb: new MeshBuilder(),
      wall: new MeshBuilder(),
      trim: new MeshBuilder(),
      edge: new MeshBuilder(),
    };

    const worldPoint = new THREE.Vector3();
    const sectionDir = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    let previousRows = null;
    let previousTrim = null;

    for (let i = startIndex; i <= endIndex; i++) {
      const sample = path.sampleByIndex(i);
      const count = buildProfile(sample.width, roadColumns, this._profileScratch);
      const profile = this._profileScratch;
      // Distance has to run monotonically through the chunk; sampleByIndex
      // wraps, so the closing sample would otherwise jump back to zero and
      // smear the texture across the whole final strip.
      const distance = i >= path.count ? path.length + sample.distance : sample.distance;

      const rows = { road: [], kerb: [], wall: [], trim: [], edge: [] };

      for (let p = 0; p < count; p++) {
        const point = profile[p];
        const prev = profile[Math.max(0, p - 1)];
        const next = profile[Math.min(count - 1, p + 1)];

        // Smooth the normal across the section using the neighbouring points
        // rather than the single outgoing segment, so the barrier reads as a
        // rounded extrusion instead of a set of hard facets.
        a.copy(sample.right).multiplyScalar(prev.lateral).addScaledVector(sample.normal, prev.height);
        b.copy(sample.right).multiplyScalar(next.lateral).addScaledVector(sample.normal, next.height);
        sectionDir.subVectors(b, a).normalize();
        normal.crossVectors(sample.tangent, sectionDir).normalize();

        worldPoint
          .copy(sample.position)
          .addScaledVector(sample.right, point.lateral)
          .addScaledVector(sample.normal, point.height);

        // A vertex sits on the strip leaving it and the strip arriving at it.
        // Where those use different materials it is emitted into both, with
        // that material's own UV, so neither gets a stretched edge texel.
        for (const g of [point.group, prev.group]) {
          if (!g || !builders[g]) continue;
          if (rows[g].length && rows[g][rows[g].length - 1].profileIndex === p) continue;
          const u = g === 'road' ? point.uRoad : g === 'kerb' ? point.uKerb : point.uWall;
          rows[g].push({
            index: builders[g].vertexV(worldPoint, normal, u, distance / V_SCALE[g]),
            profileIndex: p,
          });
        }
      }

      if (previousRows) {
        for (const key of ['road', 'kerb', 'wall']) {
          stitchRows(builders[key], previousRows[key], rows[key]);
        }
      }
      previousRows = rows;

      previousTrim = this._emitTrim(builders, sample, distance, previousTrim);
    }

    for (const [key, builder] of Object.entries(builders)) {
      if (builder.isEmpty) continue;
      const geometry = builder.build({ name: `track-${key}-${chunkId}` });
      const mesh = new THREE.Mesh(geometry, this.materials[key]);
      mesh.name = `track-${key}-${chunkId}`;
      mesh.castShadow = key === 'wall' || key === 'kerb';
      mesh.receiveShadow = key === 'road' || key === 'kerb' || key === 'wall';
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.geometries.push(geometry);
    }
  }

  /**
   * Emissive strips: one along the inner lip of each barrier cap, one just
   * inside each road edge. These are what the player actually tracks at speed,
   * so they are geometry rather than texture detail — they need to bloom.
   */
  _emitTrim(builders, sample, distance, previous) {
    const hw = sample.width / 2;
    const { kerbWidth, kerbHeight, wallHeight, wallLean, trimInset, trimWidth } = PROFILE;
    const outer = hw + kerbWidth;
    const wallTop = kerbHeight + wallHeight;
    const point = new THREE.Vector3();

    const emit = (builder, lateral, height) => {
      point
        .copy(sample.position)
        .addScaledVector(sample.right, lateral)
        .addScaledVector(sample.normal, height);
      return builder.vertexV(point, sample.normal, 0, distance / 10);
    };

    const capLeft = -(outer + wallLean) - trimInset;
    const capRight = outer + wallLean + trimInset;
    const current = {
      trim: [
        emit(builders.trim, capLeft - trimWidth, wallTop + 0.012),
        emit(builders.trim, capLeft, wallTop + 0.012),
        emit(builders.trim, capRight, wallTop + 0.012),
        emit(builders.trim, capRight + trimWidth, wallTop + 0.012),
      ],
      edge: [
        emit(builders.edge, -hw + PROFILE.edgeLineInset, 0.015),
        emit(builders.edge, -hw + PROFILE.edgeLineInset + PROFILE.edgeLineWidth, 0.015),
        emit(builders.edge, hw - PROFILE.edgeLineInset - PROFILE.edgeLineWidth, 0.015),
        emit(builders.edge, hw - PROFILE.edgeLineInset, 0.015),
      ],
    };

    if (previous) {
      // Two independent two-vertex spans per row (left strip, right strip);
      // pairs 0-1 and 2-3 are stitched separately so the strips are not
      // joined into one ribbon across the width of the road.
      for (const [s, e] of [[0, 1], [2, 3]]) {
        builders.trim.quad(previous.trim[s], previous.trim[e], current.trim[e], current.trim[s]);
        builders.edge.quad(previous.edge[s], previous.edge[e], current.edge[e], current.edge[s]);
      }
    }
    return current;
  }

  dispose() {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    for (const material of Object.values(this.materials)) material.dispose();
    this.group.clear();
  }
}

/**
 * Join two consecutive cross-sections.
 *
 * Only *profile-adjacent* columns are connected. Without that check a strip
 * would happily bridge the gap between, say, the left barrier foot and the
 * right barrier foot — both are in the wall group and adjacent within its row,
 * but they are on opposite sides of the circuit, and the result is a single
 * enormous quad laid flat across the racing surface.
 */
function stitchRows(builder, rowA, rowB) {
  const n = Math.min(rowA.length, rowB.length);
  for (let i = 0; i < n - 1; i++) {
    const a0 = rowA[i];
    const a1 = rowA[i + 1];
    const b0 = rowB[i];
    const b1 = rowB[i + 1];
    if (a1.profileIndex !== a0.profileIndex + 1) continue;
    if (b0.profileIndex !== a0.profileIndex || b1.profileIndex !== a1.profileIndex) continue;
    builder.quad(a0.index, a1.index, b1.index, b0.index);
  }
}
