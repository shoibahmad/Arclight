import * as THREE from 'three';
import { TrackSample } from '../track/TrackPath.js';

/**
 * The visible arcline: a glowing ribbon laid on the road.
 *
 * Rebuilt in place whenever the line moves to a new lap — the vertex buffer is
 * allocated once and the positions are rewritten, because a circuit's worth of
 * ribbon is a few thousand vertices and reallocating that mid-race is a
 * guaranteed hitch at exactly the moment the player crosses the line.
 *
 * The shader does two jobs: it pulses energy along the line so the direction
 * of travel is unmistakable, and it fades the ribbon out beyond the player's
 * useful horizon so the far side of the circuit does not glow through the
 * scenery.
 */

const VERTEX = /* glsl */ `
uniform float uTime;
attribute float aDistance;
attribute float aSide;
varying float vDistance;
varying float vSide;
void main() {
  vDistance = aDistance;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uTime;
uniform float uIntensity;
varying float vDistance;
varying float vSide;
out vec4 fragColor;

void main() {
  // Soft edges across the ribbon.
  float across = 1.0 - abs(vSide);
  float edge = smoothstep(0.0, 0.45, across);

  // Energy running along the line, toward the direction of travel.
  float flow = fract(vDistance * 0.035 - uTime * 0.85);
  float pulse = smoothstep(0.75, 1.0, flow) * 0.9 + 0.35;

  // A slower, wider swell so it breathes rather than strobes.
  float swell = 0.85 + sin(vDistance * 0.006 - uTime * 1.6) * 0.15;

  float alpha = edge * pulse * swell;
  fragColor = vec4(uColour * alpha * uIntensity, alpha);
}
`;

export class ArclineRibbon {
  /**
   * @param {import('../track/Arcline.js').Arcline} arcline
   * @param {number} colour
   */
  constructor(arcline, colour = 0x40e0ff, { width = 1.5, step = 3 } = {}) {
    this.arcline = arcline;
    this.path = arcline.path;
    this.width = width;
    // Sample every few metres rather than every track sample: the line is
    // already heavily smoothed, so the extra vertices buy nothing.
    this.stride = Math.max(1, Math.round(step / this.path.spacing));
    this.count = Math.floor(this.path.count / this.stride) + 1;

    const vertices = this.count * 2;
    this.positions = new Float32Array(vertices * 3);
    const distances = new Float32Array(vertices);
    const sides = new Float32Array(vertices);

    const indices = [];
    for (let i = 0; i < this.count - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    // Close the loop back onto the first pair.
    const last = (this.count - 1) * 2;
    indices.push(last, last + 1, 1, last, 1, 0);

    for (let i = 0; i < this.count; i++) {
      const d = i * this.stride * this.path.spacing;
      distances[i * 2] = d;
      distances[i * 2 + 1] = d;
      sides[i * 2] = -1;
      sides[i * 2 + 1] = 1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aDistance', new THREE.BufferAttribute(distances, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setIndex(indices);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(colour) },
        uTime: { value: 0 },
        uIntensity: { value: 2.6 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'arcline';
    this.mesh.renderOrder = 3;
    // The ribbon follows the whole circuit, so there is nothing to cull it by.
    this.mesh.frustumCulled = false;

    this.builtForLap = -1;
    this.rebuild();
  }

  /** Rewrite the vertex positions for the arcline's current lap. */
  rebuild() {
    const point = _scratch;
    for (let i = 0; i < this.count; i++) {
      const distance = i * this.stride * this.path.spacing;
      const sample = this.path.sampleAt(distance, _sample);
      const lateral = this.arcline.lateralAt(distance);

      point
        .copy(sample.position)
        .addScaledVector(sample.right, lateral)
        .addScaledVector(sample.normal, 0.06);

      const half = this.width / 2;
      const base = i * 6;
      this.positions[base] = point.x - sample.right.x * half;
      this.positions[base + 1] = point.y - sample.right.y * half;
      this.positions[base + 2] = point.z - sample.right.z * half;
      this.positions[base + 3] = point.x + sample.right.x * half;
      this.positions[base + 4] = point.y + sample.right.y * half;
      this.positions[base + 5] = point.z + sample.right.z * half;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.builtForLap = this.arcline.lap;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  update(dt) {
    this.material.uniforms.uTime.value += dt;
    if (this.arcline.lap !== this.builtForLap) this.rebuild();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _scratch = new THREE.Vector3();
const _sample = new TrackSample();
