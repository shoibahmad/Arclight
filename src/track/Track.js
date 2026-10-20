import * as THREE from 'three';
import { TrackPath, TrackSample } from './TrackPath.js';
import { TrackMesh, PROFILE } from './TrackMesh.js';
import { buildLayout, levelLayout } from './TrackLayout.js';
import { getTheme } from '../data/themes.js';
import { MeshBuilder } from '../assets/MeshBuilder.js';
import { emissiveMaterial, panelMaterial } from '../assets/Materials.js';
import { clamp } from '../core/MathUtil.js';

/**
 * A loaded circuit: centreline, geometry, timing lines and the starting grid.
 *
 * This is the object everything else in a race talks to. Physics asks it where
 * the road is, the AI asks it where the corners are, the race director asks it
 * which sector a craft is in, and the HUD asks it for the minimap outline.
 */

/** Sectors per lap. Three is the convention and it is what the splits show. */
const SECTOR_COUNT = 3;

export class Track {
  /**
   * @param {object} data a module from src/data/tracks
   */
  constructor(data) {
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.laps = data.laps ?? 3;
    this.theme = getTheme(data.theme);

    const { nodes, report } = buildLayout(data.segments, {
      start: data.layout?.start,
      heading: data.layout?.heading,
      width: data.layout?.width,
    });
    levelLayout(nodes);

    this.layoutReport = report;
    this.path = new TrackPath(nodes, { spacing: 2 });

    /** Distances along the lap at which each sector begins. */
    this.sectorStarts = [];
    for (let i = 0; i < SECTOR_COUNT; i++) {
      this.sectorStarts.push((this.path.length * i) / SECTOR_COUNT);
    }

    this.group = new THREE.Group();
    this.group.name = `track:${this.id}`;

    this.mesh = new TrackMesh(this.path, this.theme);
    this.group.add(this.mesh.group);

    // Scratch sample must exist before anything calls frameAt/halfWidthAt.
    this._scratch = new TrackSample();
    this.decorations = [];
    this._buildStartLine();
    this._buildGantry();
    this._buildDistanceMarkers();

    this.bounds = this.path.computeBounds();
  }

  get length() {
    return this.path.length;
  }

  /** Corner names in track order, for the HUD and the track-select screen. */
  get cornerNames() {
    const seen = new Set();
    const out = [];
    for (const node of this.path.nodes) {
      if (node.isCorner && node.name && !seen.has(node.name)) {
        seen.add(node.name);
        out.push(node.name);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- queries

  /**
   * Where a world position sits on the circuit.
   * @param {THREE.Vector3} position
   * @param {number} hintIndex sample index from the previous tick
   */
  locate(position, hintIndex = -1) {
    return this.path.project(position, hintIndex);
  }

  /** Interpolated road frame at a distance. Writes into `out`. */
  frameAt(distance, out = this._scratch) {
    return this.path.sampleAt(distance, out);
  }

  /** Half the road width at a distance, excluding kerbs. */
  halfWidthAt(distance) {
    return this.path.sampleAt(distance, this._scratch).width / 2;
  }

  /**
   * How far beyond the road edge a lateral offset is.
   * Negative while on the road, 0 on the kerb, positive once into the barrier.
   */
  overrunAt(distance, lateral) {
    const hw = this.halfWidthAt(distance);
    const magnitude = Math.abs(lateral);
    return magnitude - (hw + PROFILE.kerbWidth);
  }

  sectorFor(distance) {
    const d = this.path.wrap(distance);
    for (let i = SECTOR_COUNT - 1; i >= 0; i--) {
      if (d >= this.sectorStarts[i]) return i;
    }
    return 0;
  }

  /**
   * Starting grid, two columns, staggered.
   * Slot 0 is pole. Positions sit behind the line so the first crossing is a
   * genuine lap start rather than an instant lap 1 completion.
   */
  gridSlot(index, total = 8) {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const distance = this.path.wrap(-18 - row * 13 - column * 5);
    const sample = this.path.sampleAt(distance, this._scratch);
    const lateral = (column === 0 ? -1 : 1) * sample.width * 0.19;

    const position = new THREE.Vector3()
      .copy(sample.position)
      .addScaledVector(sample.right, lateral)
      .addScaledVector(sample.normal, 1.4);

    return {
      position,
      tangent: sample.tangent.clone(),
      normal: sample.normal.clone(),
      right: sample.right.clone(),
      distance,
      lateral,
    };
  }

  // -------------------------------------------------------- construction

  /** Start/finish: a bright bar across the road plus a dark run-up stripe. */
  _buildStartLine() {
    const builder = new MeshBuilder();
    const sample = this.path.sampleAt(0, new TrackSample());
    const hw = sample.width / 2;
    const point = new THREE.Vector3();

    const push = (lateral, forward) => {
      point
        .copy(sample.position)
        .addScaledVector(sample.right, lateral)
        .addScaledVector(sample.tangent, forward)
        .addScaledVector(sample.normal, 0.02);
      return builder.vertexV(point, sample.normal, (lateral + hw) / (hw * 2), forward > 0 ? 1 : 0);
    };

    const a = push(-hw, -0.9);
    const b = push(hw, -0.9);
    const c = push(hw, 0.9);
    const d = push(-hw, 0.9);
    builder.quad(a, b, c, d);

    const mesh = new THREE.Mesh(
      builder.build({ name: 'start-line' }),
      emissiveMaterial(0xffffff, 2.4, { side: THREE.DoubleSide })
    );
    mesh.name = 'start-line';
    this.group.add(mesh);
    this.decorations.push(mesh);
  }

  /** Gantry over the start line: two pylons and a beam carrying the lights. */
  _buildGantry() {
    const sample = this.path.sampleAt(0, new TrackSample());
    const hw = sample.width / 2;
    const span = hw + PROFILE.kerbWidth + 1.2;
    const height = 9.5;

    const structure = panelMaterial(this.theme, { name: 'gantry' });
    const group = new THREE.Group();
    group.name = 'gantry';

    const makeLeg = (side) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, height, 1.1), structure);
      leg.position
        .copy(sample.position)
        .addScaledVector(sample.right, side * span)
        .addScaledVector(sample.normal, height / 2);
      leg.castShadow = true;
      return leg;
    };
    group.add(makeLeg(-1), makeLeg(1));

    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.1, 1.5, 1.6), structure);
    beam.position
      .copy(sample.position)
      .addScaledVector(sample.normal, height - 0.4);
    beam.castShadow = true;
    group.add(beam);

    // Orient the whole gantry to the track frame.
    const basis = new THREE.Matrix4().makeBasis(sample.right, sample.normal, sample.tangent);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);
    for (const child of group.children) {
      child.quaternion.copy(quaternion);
      child.updateMatrix();
    }

    // Start lights: five lamps that the race director drives during the
    // countdown, so the grid sequence reads without looking at the HUD.
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      // Each lamp owns its material so they can be lit one at a time, and it
      // is an unlit emissive so an extinguished lamp reads as genuinely dark
      // rather than picking up ambient from the sky.
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.52, 16, 12),
        emissiveMaterial(0x1a0d10, 1)
      );
      lamp.position
        .copy(sample.position)
        .addScaledVector(sample.right, (i - 2) * 2.1)
        .addScaledVector(sample.normal, height - 1.5);
      group.add(lamp);
      this.startLights.push(lamp);
    }

    this.group.add(group);
    this.decorations.push(group);
  }

  /** Set the five gantry lamps. `lit` is how many are on, -1 for all green. */
  setStartLights(lit) {
    if (!this.startLights) return;
    for (let i = 0; i < this.startLights.length; i++) {
      const on = lit < 0 ? true : i < lit;
      const material = this.startLights[i].material;
      material.color.setHex(lit < 0 ? 0x24ff92 : on ? 0xff2a2a : 0x1a0d10);
      material.color.multiplyScalar(on ? 6 : 1);
    }
  }

  /**
   * Braking boards on the barrier approaching each corner.
   *
   * Placed by detecting where curvature crosses into "this is a corner"
   * territory, rather than on a fixed distance grid, so a long sweeper gets
   * one set of boards at its entry instead of a board every hundred metres
   * all the way around it. Cheap geometry, but it is most of what makes an
   * unfamiliar circuit learnable at speed.
   */
  _buildDistanceMarkers() {
    const CORNER_THRESHOLD = 0.0055; // roughly a 180m radius
    const MIN_SEPARATION = 170; // metres; closer than this is the same corner
    const entries = [];
    let inCorner = false;

    for (let i = 0; i < this.path.count; i++) {
      const sample = this.path.sampleByIndex(i);
      const k = Math.abs(sample.curvature);
      if (!inCorner && k > CORNER_THRESHOLD) {
        inCorner = true;
        // Sampled curvature is noisy enough that a long sweeper can dip back
        // under the threshold mid-corner; require real separation as well as
        // hysteresis before calling something a new corner.
        const previous = entries.length ? entries[entries.length - 1] : -Infinity;
        if (sample.distance - previous >= MIN_SEPARATION) entries.push(sample.distance);
      } else if (inCorner && k < CORNER_THRESHOLD * 0.55) {
        inCorner = false;
      }
    }
    // The first and last can also be the same corner, across the start line.
    if (entries.length > 1 && this.path.length - entries[entries.length - 1] + entries[0] < MIN_SEPARATION) {
      entries.pop();
    }
    if (entries.length === 0) return;

    const builder = new MeshBuilder();
    const point = new THREE.Vector3();
    const facing = new THREE.Vector3();
    const wallTop = PROFILE.kerbHeight + PROFILE.wallHeight;

    for (const entry of entries) {
      for (let board = 0; board < 3; board++) {
        const at = this.path.wrap(entry - 150 + board * 50);
        const s = this.path.sampleAt(at, this._scratch);
        // Wider board the closer it is to the corner, so the sequence reads
        // as a countdown in peripheral vision.
        const halfLength = 0.8 + board * 0.35;

        for (const side of [-1, 1]) {
          const lateral = side * (s.width / 2 + PROFILE.kerbWidth + 0.05);
          facing.copy(s.right).multiplyScalar(-side);
          const corners = [
            [-halfLength, 0],
            [halfLength, 0],
            [halfLength, 0.75],
            [-halfLength, 0.75],
          ].map(([along, up]) => {
            point
              .copy(s.position)
              .addScaledVector(s.tangent, along)
              .addScaledVector(s.right, lateral)
              .addScaledVector(s.normal, wallTop - 1.3 + up);
            return builder.vertexV(point, facing, 0, 0);
          });
          builder.quad(corners[0], corners[1], corners[2], corners[3]);
        }
      }
    }

    if (builder.isEmpty) return;
    const mesh = new THREE.Mesh(
      builder.build({ name: 'markers' }),
      emissiveMaterial(this.theme.accentWarm, 1.5, { side: THREE.DoubleSide })
    );
    mesh.name = 'distance-markers';
    this.group.add(mesh);
    this.decorations.push(mesh);
    this.cornerEntries = entries;
  }

  /**
   * Centreline polyline in XZ, normalised to a unit box.
   * The HUD minimap draws this with canvas 2D rather than a second 3D pass.
   */
  minimapOutline(sampleEvery = 8) {
    const box = this.bounds;
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = 1 / Math.max(size.x, size.z, 1);
    const points = [];
    for (let i = 0; i < this.path.count; i += sampleEvery) {
      const p = this.path.sampleByIndex(i).position;
      points.push(
        (p.x - box.min.x) * scale - (size.x * scale) / 2,
        (p.z - box.min.z) * scale - (size.z * scale) / 2
      );
    }
    return { points, aspect: size.x / Math.max(size.z, 1) };
  }

  /** Normalised XZ position of a distance along the lap, matching the outline. */
  minimapPoint(distance, out = { x: 0, y: 0 }) {
    const box = this.bounds;
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = 1 / Math.max(size.x, size.z, 1);
    const p = this.path.sampleAt(distance, this._scratch).position;
    out.x = (p.x - box.min.x) * scale - (size.x * scale) / 2;
    out.y = (p.z - box.min.z) * scale - (size.z * scale) / 2;
    return out;
  }

  dispose() {
    this.mesh.dispose();
    for (const item of this.decorations) {
      item.traverse?.((child) => {
        child.geometry?.dispose();
        child.material?.dispose?.();
      });
      item.geometry?.dispose?.();
      item.material?.dispose?.();
    }
    this.decorations.length = 0;
    this.group.clear();
  }
}

export { SECTOR_COUNT, clamp };
