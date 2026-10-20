import * as THREE from 'three';

/**
 * Fullscreen shader pass.
 *
 * Draws a single oversized triangle rather than a quad: one triangle covers the
 * viewport with no diagonal seam, so the GPU never rasterises the two-triangle
 * edge twice and derivatives stay continuous across the middle of the screen.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

let sharedGeometry = null;

function triangleGeometry() {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  sharedGeometry = g;
  return g;
}

export class FullScreenPass {
  constructor({ fragmentShader, uniforms = {}, defines = {}, blending = THREE.NoBlending }) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: upgradeVertex(VERTEX),
      fragmentShader: upgradeFragment(fragmentShader),
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      blending,
      transparent: blending !== THREE.NoBlending,
    });

    this.mesh = new THREE.Mesh(triangleGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.Camera();
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** @param {THREE.WebGLRenderer} renderer */
  render(renderer, target = null, clear = true) {
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    if (clear) renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.material.dispose();
  }
}

/**
 * RawShaderMaterial gets none of three's boilerplate, so the GLSL3 preamble and
 * the two attributes every pass uses are injected here instead of being copied
 * into the top of a dozen shader strings.
 */
function upgradeVertex(src) {
  return `in vec3 position;\nin vec2 uv;\n${src.replace('varying', 'out')}`;
}

function upgradeFragment(src) {
  return `precision highp float;\nprecision highp int;\nout vec4 fragColor;\n${src.replace(
    /\bvarying\b/g,
    'in'
  )}`;
}
