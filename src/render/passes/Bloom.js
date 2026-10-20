import * as THREE from 'three';
import { FullScreenPass } from './FullScreenPass.js';

/**
 * Mip-chain bloom (downsample with a 13-tap filter, upsample with a 9-tap tent).
 *
 * This is the Call of Duty: Advanced Warfare approach rather than a stack of
 * separable gaussians. It is cheaper for the same reach, and — more importantly
 * for a racing game — it is stable under motion: a gaussian pyramid shimmers
 * badly when bright track edges sweep past the camera at 300kph, whereas the
 * Karis-weighted first downsample kills the firefly pixels that cause it.
 */

const DOWNSAMPLE_FS = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;        // texel size of the SOURCE texture
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;

vec3 fetch(vec2 uv) {
  vec3 c = texture(tSource, uv).rgb;
  // A single NaN anywhere in the chain propagates to the whole screen.
  return mix(c, vec3(0.0), vec3(isnan(c.r) || isnan(c.g) || isnan(c.b)));
}

#ifdef PREFILTER
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 prefilter(vec3 c) {
  // A sky sun disc is the brightest thing in the game by an order of magnitude.
  // Left unclamped it survives every downsample and reappears as a flat wash
  // over the whole screen, so it is capped before it enters the chain.
  c = min(c, vec3(8.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * max(soft, br - uThreshold) / max(br, 1e-4);
}

// Karis average: weight each 2x2 group by inverse luma before averaging, so one
// very bright pixel cannot dominate the block and flicker between frames.
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = 1.0 / (1.0 + luma(a));
  float wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
#endif

void main() {
  vec2 t = uTexel;

  vec3 a = fetch(vUv + vec2(-2.0, 2.0) * t);
  vec3 b = fetch(vUv + vec2( 0.0, 2.0) * t);
  vec3 c = fetch(vUv + vec2( 2.0, 2.0) * t);
  vec3 d = fetch(vUv + vec2(-2.0, 0.0) * t);
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + vec2( 2.0, 0.0) * t);
  vec3 g = fetch(vUv + vec2(-2.0,-2.0) * t);
  vec3 h = fetch(vUv + vec2( 0.0,-2.0) * t);
  vec3 i = fetch(vUv + vec2( 2.0,-2.0) * t);
  vec3 j = fetch(vUv + vec2(-1.0, 1.0) * t);
  vec3 k = fetch(vUv + vec2( 1.0, 1.0) * t);
  vec3 l = fetch(vUv + vec2(-1.0,-1.0) * t);
  vec3 m = fetch(vUv + vec2( 1.0,-1.0) * t);

#ifdef PREFILTER
  vec3 inner  = karis(j, k, l, m);
  vec3 tl     = karis(a, b, d, e);
  vec3 tr     = karis(b, c, e, f);
  vec3 bl     = karis(d, e, g, h);
  vec3 br     = karis(e, f, h, i);
  vec3 colour = inner * 0.5 + (tl + tr + bl + br) * 0.125;
  fragColor = vec4(prefilter(colour), 1.0);
#else
  vec3 colour = e * 0.125;
  colour += (a + c + g + i) * 0.03125;
  colour += (b + d + f + h) * 0.0625;
  colour += (j + k + l + m) * 0.125;
  fragColor = vec4(colour, 1.0);
#endif
}
`;

const UPSAMPLE_FS = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;       // texel size of the SOURCE (smaller) texture
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;

  vec3 sum = texture(tSource, vUv + vec2(-t.x,  t.y)).rgb;
  sum += texture(tSource, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
  sum += texture(tSource, vUv + vec2( t.x,  t.y)).rgb;
  sum += texture(tSource, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  sum += texture(tSource, vUv).rgb * 4.0;
  sum += texture(tSource, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  sum += texture(tSource, vUv + vec2(-t.x, -t.y)).rgb;
  sum += texture(tSource, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
  sum += texture(tSource, vUv + vec2( t.x, -t.y)).rgb;

  fragColor = vec4(sum * (1.0 / 16.0), 1.0);
}
`;

function makeTarget(width, height) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

export class Bloom {
  constructor({ iterations = 5, threshold = 1.0, knee = 0.6, radius = 1.0 } = {}) {
    this.iterations = iterations;
    this.threshold = threshold;
    this.knee = knee;
    this.radius = radius;

    /** @type {THREE.WebGLRenderTarget[]} progressively halved, mips[0] is half-res */
    this.mips = [];

    this.prefilterPass = new FullScreenPass({
      fragmentShader: DOWNSAMPLE_FS,
      defines: { PREFILTER: '' },
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: threshold },
        uKnee: { value: knee },
      },
    });

    this.downPass = new FullScreenPass({
      fragmentShader: DOWNSAMPLE_FS,
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 0 },
        uKnee: { value: 0 },
      },
    });

    this.upPass = new FullScreenPass({
      fragmentShader: UPSAMPLE_FS,
      blending: THREE.AdditiveBlending,
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: radius },
      },
    });
  }

  setSize(width, height) {
    this.dispose(false);
    this.mips = [];

    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (let i = 0; i < this.iterations; i++) {
      this.mips.push(makeTarget(w, h));
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      // Below ~8px a mip contributes nothing but a uniform wash.
      if (w < 8 || h < 8) break;
    }
  }

  setIterations(n) {
    if (n === this.iterations) return;
    this.iterations = n;
    // Caller re-runs setSize; the chain is rebuilt there.
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} sourceTexture  scene colour, linear HDR
   * @returns {THREE.Texture} the bloom result, at half resolution
   */
  render(renderer, sourceTexture, sourceWidth, sourceHeight) {
    if (this.mips.length === 0) return null;

    this.prefilterPass.uniforms.tSource.value = sourceTexture;
    this.prefilterPass.uniforms.uTexel.value.set(1 / sourceWidth, 1 / sourceHeight);
    this.prefilterPass.uniforms.uThreshold.value = this.threshold;
    this.prefilterPass.uniforms.uKnee.value = this.knee;
    this.prefilterPass.render(renderer, this.mips[0]);

    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      this.downPass.uniforms.tSource.value = src.texture;
      this.downPass.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.downPass.render(renderer, this.mips[i]);
    }

    this.upPass.uniforms.uRadius.value = this.radius;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      this.upPass.uniforms.tSource.value = src.texture;
      this.upPass.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      // Additive, and deliberately no clear: each level accumulates into the
      // one below it, which is what gives the chain its wide soft falloff.
      this.upPass.render(renderer, this.mips[i - 1], false);
    }

    return this.mips[0].texture;
  }

  dispose(disposeMaterials = true) {
    for (const rt of this.mips) rt.dispose();
    this.mips = [];
    if (disposeMaterials) {
      this.prefilterPass.dispose();
      this.downPass.dispose();
      this.upPass.dispose();
    }
  }
}
