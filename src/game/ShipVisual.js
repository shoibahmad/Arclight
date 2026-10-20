import * as THREE from 'three';
import { MeshBuilder } from '../assets/MeshBuilder.js';
import { hullMaterial, emissiveMaterial, glowMaterial } from '../assets/Materials.js';
import { clamp, clamp01, damp, lerp } from '../core/MathUtil.js';

/**
 * The craft you actually see: hull, canopy, thrusters, air brakes and trail.
 *
 * The hull is lofted — a sequence of cross-sections swept along the length
 * and stitched together. That is the only approach that gives a shape with a
 * continuous silhouette while still being a few hundred lines of code, and it
 * makes the whole family of craft one set of numbers rather than one model
 * each.
 *
 * Nothing here touches physics. Ship.js owns the simulation and this reads
 * from it, which means the visual lean, thruster flare and brake flaps can be
 * as exaggerated as they need to be without affecting how the craft drives.
 */

/**
 * Hull cross-section, normalised.
 *
 * A hard chine at mid-height (the +/-1.0, 0.0 pair) rather than a rounded
 * tube. That edge is what gives the craft a readable silhouette against a
 * bright sky, and it is where the accent lighting runs.
 */
const SECTION = [
  [0.0, 1.0],
  [0.55, 0.62],
  [1.0, 0.0],
  [0.72, -0.64],
  [0.22, -1.0],
  [-0.22, -1.0],
  [-0.72, -0.64],
  [-1.0, 0.0],
  [-0.55, 0.62],
];

/**
 * Stations along the hull: [z, halfWidth, halfHeight, verticalOffset].
 * Deliberately low and wide — about 2.2m across and 0.8m tall over 6m of
 * length. A taller hull reads as a boat from the chase camera.
 */
const STATIONS = [
  [-3.2, 0.10, 0.05, 0.02],
  [-2.5, 0.40, 0.17, 0.0],
  [-1.5, 0.78, 0.30, -0.02],
  [-0.4, 1.02, 0.38, -0.03],
  [0.7, 1.08, 0.40, -0.02],
  [1.8, 0.98, 0.34, 0.0],
  [2.8, 0.76, 0.26, 0.02],
];

const HULL_SCALE = 1.04;

/** Interpolate the hull's half-width and vertical offset at a given z. */
function stationAt(z) {
  if (z <= STATIONS[0][0]) return STATIONS[0];
  const last = STATIONS[STATIONS.length - 1];
  if (z >= last[0]) return last;
  for (let i = 1; i < STATIONS.length; i++) {
    const a = STATIONS[i - 1];
    const b = STATIONS[i];
    if (z <= b[0]) {
      const t = (z - a[0]) / (b[0] - a[0]);
      return [z, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
    }
  }
  return last;
}

function loftHull(builder, stations, section, scale) {
  const rows = [];
  for (const [z, halfWidth, halfHeight, offsetY] of stations) {
    const row = [];
    for (let i = 0; i < section.length; i++) {
      const [sx, sy] = section[i];
      const x = sx * halfWidth * scale;
      const y = sy * halfHeight * scale + offsetY * scale;
      row.push({ x, y, z: z * scale, u: i / section.length });
    }
    rows.push(row);
  }

  // Stitch consecutive stations, computing normals from the surrounding quad
  // rather than per-face, so the hull shades as one smooth body.
  const indices = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const indexRow = [];
    for (let i = 0; i < row.length; i++) {
      const p = row[i];
      const prevRow = rows[Math.max(0, r - 1)][i];
      const nextRow = rows[Math.min(rows.length - 1, r + 1)][i];
      const left = row[(i - 1 + row.length) % row.length];
      const right = row[(i + 1) % row.length];

      const along = new THREE.Vector3(
        nextRow.x - prevRow.x,
        nextRow.y - prevRow.y,
        nextRow.z - prevRow.z
      );
      const around = new THREE.Vector3(right.x - left.x, right.y - left.y, right.z - left.z);
      const normal = new THREE.Vector3().crossVectors(around, along).normalize();
      if (normal.lengthSq() < 0.5) normal.set(p.x, p.y, 0).normalize();

      indexRow.push(builder.vertex(p.x, p.y, p.z, normal.x, normal.y, normal.z, p.u, r / rows.length));
    }
    indices.push(indexRow);
  }

  for (let r = 0; r < indices.length - 1; r++) {
    const a = indices[r];
    const b = indices[r + 1];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      builder.quad(a[i], a[j], b[j], b[i]);
    }
  }

  // Cap the tail so the hull is closed.
  const tail = indices[indices.length - 1];
  const centre = builder.vertex(0, STATIONS[STATIONS.length - 1][3] * scale, STATIONS[STATIONS.length - 1][0] * scale, 0, 0, 1, 0.5, 1);
  for (let i = 0; i < tail.length; i++) {
    builder.triangle(tail[i], centre, tail[(i + 1) % tail.length]);
  }
  return indices;
}

/** A swept outboard pod, mirrored to both sides. */
function buildPod(builder, side, scale) {
  const profile = [
    [-1.1, -0.14, 0.13],
    [-0.1, -0.17, 0.24],
    [1.0, -0.15, 0.23],
    [2.1, -0.07, 0.12],
  ];
  const rows = [];
  for (const [z, y, halfHeight] of profile) {
    const row = [];
    const lateral = 1.02 + Math.abs(z) * 0.05;
    for (const [ox, oy] of [
      [0.0, 1.0],
      [0.85, 0.2],
      [0.5, -0.9],
      [-0.5, -0.9],
      [-0.85, 0.2],
    ]) {
      row.push({
        x: (lateral + ox * 0.26) * side * scale,
        y: (y + oy * halfHeight) * scale,
        z: z * scale,
      });
    }
    rows.push(row);
  }

  const indices = rows.map((row, r) =>
    row.map((p, i) => {
      const left = row[(i - 1 + row.length) % row.length];
      const right = row[(i + 1) % row.length];
      const prev = rows[Math.max(0, r - 1)][i];
      const next = rows[Math.min(rows.length - 1, r + 1)][i];
      const around = new THREE.Vector3(right.x - left.x, right.y - left.y, right.z - left.z);
      const along = new THREE.Vector3(next.x - prev.x, next.y - prev.y, next.z - prev.z);
      const normal = new THREE.Vector3().crossVectors(around, along).normalize();
      if (side < 0) normal.negate();
      if (normal.lengthSq() < 0.5) normal.set(side, 0.3, 0).normalize();
      return builder.vertex(p.x, p.y, p.z, normal.x, normal.y, normal.z, i / row.length, r / rows.length);
    })
  );

  for (let r = 0; r < indices.length - 1; r++) {
    const a = indices[r];
    const b = indices[r + 1];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      if (side > 0) builder.quad(a[i], a[j], b[j], b[i]);
      else builder.quad(a[j], a[i], b[i], b[j]);
    }
  }
}

export class ShipVisual {
  /**
   * @param {import('./Ship.js').Ship} ship
   * @param {{trailSegments?: number, isPlayer?: boolean}} options
   */
  constructor(ship, { trailSegments = 40, ghost = false } = {}) {
    this.ship = ship;
    this.ghost = ghost;
    const colours = ship.colours ?? {
      hull: 0xcfd6e0,
      trim: 0x242a35,
      accent: 0x40e0ff,
      thruster: 0x8ff0ff,
    };
    this.colours = colours;

    this.group = new THREE.Group();
    this.group.name = `craft:${ship.shipId}:${ship.uid}`;

    const opacity = ghost ? 0.3 : 1;

    // Hull
    const hullBuilder = new MeshBuilder();
    loftHull(hullBuilder, STATIONS, SECTION, HULL_SCALE);
    buildPod(hullBuilder, 1, HULL_SCALE);
    buildPod(hullBuilder, -1, HULL_SCALE);
    this.hullMesh = new THREE.Mesh(
      hullBuilder.build({ name: 'hull' }),
      hullMaterial(colours.hull, {
        roughness: 0.32,
        metalness: 0.62,
        transparent: ghost,
        opacity,
        depthWrite: !ghost,
      })
    );
    this.hullMesh.castShadow = !ghost;
    this.hullMesh.receiveShadow = !ghost;
    this.group.add(this.hullMesh);

    // Canopy: a smaller loft sitting on the spine.
    const canopyBuilder = new MeshBuilder();
    loftHull(
      canopyBuilder,
      [
        [-1.75, 0.06, 0.03, 0.34],
        [-1.05, 0.30, 0.13, 0.33],
        [-0.15, 0.40, 0.17, 0.32],
        [0.75, 0.30, 0.12, 0.30],
      ],
      SECTION,
      HULL_SCALE
    );
    this.canopy = new THREE.Mesh(
      canopyBuilder.build({ name: 'canopy' }),
      hullMaterial(0x0d1420, {
        roughness: 0.08,
        metalness: 0.4,
        transparent: true,
        opacity: ghost ? 0.25 : 0.86,
      })
    );
    this.canopy.castShadow = !ghost;
    this.group.add(this.canopy);

    // Accent strip along the chine.
    //
    // Sampled from the same station table as the hull, so it tapers with the
    // nose instead of running at a constant width and projecting out in
    // front of the craft — which is exactly what a fixed-width strip did.
    const trimBuilder = new MeshBuilder();
    for (const side of [-1, 1]) {
      const rows = [];
      for (let z = -2.3; z <= 2.75; z += 0.42) {
        const [, halfWidth, halfHeight, offsetY] = stationAt(z);
        const x = side * halfWidth * HULL_SCALE * 1.012;
        const y = offsetY * HULL_SCALE;
        const thickness = halfHeight * HULL_SCALE * 0.22;
        const n = new THREE.Vector3(side, 0.25, 0).normalize();
        rows.push([
          trimBuilder.vertex(x, y + thickness, z * HULL_SCALE, n.x, n.y, n.z, 0, z),
          trimBuilder.vertex(x, y - thickness, z * HULL_SCALE, n.x, n.y, n.z, 1, z),
        ]);
      }
      for (let i = 0; i < rows.length - 1; i++) {
        const [a, b] = rows[i];
        const [c, d] = rows[i + 1];
        if (side > 0) trimBuilder.quad(a, b, d, c);
        else trimBuilder.quad(c, d, b, a);
      }
    }
    this.trim = new THREE.Mesh(
      trimBuilder.build({ name: 'trim' }),
      emissiveMaterial(colours.accent, ghost ? 0.8 : 3.2, {
        side: THREE.DoubleSide,
        transparent: ghost,
        opacity,
      })
    );
    this.group.add(this.trim);

    // Thrusters: cones at the tail with a glow billboard in front of each.
    this.thrusters = [];
    const thrusterMaterial = emissiveMaterial(colours.thruster, ghost ? 1 : 7);
    for (const side of [-0.56, 0.56]) {
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.32, 1.3, 14, 1, true),
        thrusterMaterial
      );
      cone.rotation.x = Math.PI / 2;
      cone.position.set(side * 0.62 * HULL_SCALE, -0.02, 2.95 * HULL_SCALE);
      this.group.add(cone);

      const flare = new THREE.Mesh(
        new THREE.PlaneGeometry(2.1, 2.1),
        glowMaterial(colours.thruster, ghost ? 0.6 : 3.4, { opacity })
      );
      flare.position.set(side * 0.62 * HULL_SCALE, -0.02, 3.35 * HULL_SCALE);
      this.group.add(flare);
      this.thrusters.push({ cone, flare, side });
    }

    // Air brake flaps, hinged at the trailing shoulder.
    this.flaps = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Object3D();
      pivot.position.set(side * 1.14 * HULL_SCALE, 0.02, 1.4 * HULL_SCALE);
      const flap = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.46, 1.25),
        hullMaterial(colours.trim, { roughness: 0.5, metalness: 0.6, transparent: ghost, opacity })
      );
      flap.position.set(0, 0, 0.35);
      flap.castShadow = !ghost;
      pivot.add(flap);
      this.group.add(pivot);
      this.flaps.push({ pivot, side });
    }

    // Underside glow: what makes it read as hovering rather than driving.
    this.underglow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, 5.8),
      glowMaterial(colours.accent, ghost ? 0.3 : 1.5, { opacity: ghost ? 0.2 : 0.85 })
    );
    this.underglow.rotation.x = -Math.PI / 2;
    this.underglow.position.y = -0.62 * HULL_SCALE;
    this.group.add(this.underglow);

    // Shield bubble, shown only while the shield is drawing power.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(2.9, 20, 14),
      glowMaterial(colours.accent, 1.1, { opacity: 0, side: THREE.BackSide })
    );
    this.shield.scale.set(1, 0.52, 1.25);
    this.shield.visible = false;
    this.group.add(this.shield);

    this.trail = ghost ? null : new ThrusterTrail(colours.thruster, trailSegments);
    if (this.trail) this.group.parent?.add(this.trail.mesh);

    this._quaternion = new THREE.Quaternion();
    this._thrusterLevel = 0;
    this._flapAngle = [0, 0];
    this._damageFlicker = 0;
  }

  /** The trail lives in world space, so it is added to the scene, not the craft. */
  addTo(scene) {
    scene.add(this.group);
    if (this.trail) scene.add(this.trail.mesh);
  }

  removeFrom(scene) {
    scene.remove(this.group);
    if (this.trail) scene.remove(this.trail.mesh);
  }

  /**
   * @param {number} dt real frame time
   * @param {{throttle:number,airLeft:number,airRight:number}} controls
   */
  update(dt, controls = { throttle: 0, airLeft: 0, airRight: 0 }) {
    const ship = this.ship;
    this.group.position.copy(ship.position);
    ship.getOrientation(this._quaternion);
    this.group.quaternion.copy(this._quaternion);

    // Thruster flare tracks throttle and boost, with a little lag so it
    // pulses rather than snapping between two states.
    const wanted = clamp01(controls.throttle * 0.75 + (ship.boosting ? 0.6 : 0) + ship.speed01 * 0.3);
    this._thrusterLevel = damp(this._thrusterLevel, wanted, 0.0008, dt);
    const flicker = 0.92 + Math.sin(performance.now() * 0.045 + ship.uid) * 0.08;

    for (const { cone, flare } of this.thrusters) {
      const scale = (0.45 + this._thrusterLevel * 0.9) * flicker;
      cone.scale.set(1, scale * 1.5, 1);
      cone.position.z = (2.95 + scale * 0.45) * HULL_SCALE;
      flare.scale.setScalar(0.55 + this._thrusterLevel * 1.15);
      flare.material.opacity = this.ghost ? 0.25 : 0.55 + this._thrusterLevel * 0.45;
    }

    // Air brakes swing out to 55 degrees.
    const targets = [controls.airLeft, controls.airRight];
    for (let i = 0; i < this.flaps.length; i++) {
      this._flapAngle[i] = damp(this._flapAngle[i], targets[i] ?? 0, 0.0002, dt);
      this.flaps[i].pivot.rotation.y = this.flaps[i].side * this._flapAngle[i] * 0.96;
    }

    this.underglow.material.opacity =
      (this.ghost ? 0.2 : 0.55) + clamp01(ship.speed01) * 0.35;

    this.shield.visible = ship.shielding;
    if (ship.shielding) {
      const pulse = 0.16 + Math.sin(performance.now() * 0.009) * 0.05;
      this.shield.material.opacity = pulse;
    }

    // Damage flicker: the hull trim stutters as integrity drops.
    if (ship.integrity01 < 0.35) {
      this._damageFlicker += dt * 22;
      const on = Math.sin(this._damageFlicker) > -0.2 + (1 - ship.integrity01);
      this.trim.visible = on;
    } else {
      this.trim.visible = true;
    }

    if (this.trail) this.trail.update(dt, ship, this._thrusterLevel);
  }

  dispose() {
    this.group.traverse((child) => {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    });
    this.trail?.dispose();
  }
}

/**
 * A ribbon of past positions behind the thrusters.
 *
 * Written as a ring buffer into a fixed geometry rather than rebuilt each
 * frame: with eight craft on track, reallocating a few hundred vertices per
 * craft per frame is exactly the kind of steady allocation that shows up as a
 * GC stutter a minute into a race.
 */
class ThrusterTrail {
  constructor(colour, segments = 40) {
    this.segments = segments;
    this.width = 0.9;
    this.positions = new Float32Array(segments * 2 * 3);
    this.alphas = new Float32Array(segments * 2);
    this.history = [];
    this.timer = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

    const indices = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: new THREE.Color(colour).multiplyScalar(2.4) } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        uniform vec3 uColour;
        varying float vAlpha;
        out vec4 fragColor;
        void main() {
          fragColor = vec4(uColour * vAlpha, vAlpha);
        }`,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.geometry = geometry;
  }

  update(dt, ship, level) {
    this.timer += dt;
    // Sample at a fixed rate so trail length is a distance, not a frame count.
    const interval = 1 / 60;
    if (this.timer < interval) return;
    this.timer = 0;

    const back = _trailScratch
      .copy(ship.position)
      .addScaledVector(ship.forward, -3.2)
      .addScaledVector(ship.up, 0.05);
    this.history.unshift({
      point: back.clone(),
      right: ship.right.clone(),
      strength: level * clamp01(ship.speed01 * 1.4),
    });
    if (this.history.length > this.segments) this.history.pop();

    const count = this.history.length;
    for (let i = 0; i < count; i++) {
      const entry = this.history[i];
      const fade = (1 - i / this.segments) ** 1.6 * entry.strength;
      const halfWidth = this.width * (0.35 + fade * 0.65);
      const base = i * 6;
      this.positions[base] = entry.point.x - entry.right.x * halfWidth;
      this.positions[base + 1] = entry.point.y - entry.right.y * halfWidth;
      this.positions[base + 2] = entry.point.z - entry.right.z * halfWidth;
      this.positions[base + 3] = entry.point.x + entry.right.x * halfWidth;
      this.positions[base + 4] = entry.point.y + entry.right.y * halfWidth;
      this.positions[base + 5] = entry.point.z + entry.right.z * halfWidth;
      this.alphas[i * 2] = fade;
      this.alphas[i * 2 + 1] = fade;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const _trailScratch = new THREE.Vector3();

export { HULL_SCALE, lerp, clamp };
