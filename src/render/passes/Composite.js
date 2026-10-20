import * as THREE from 'three';
import { FullScreenPass } from './FullScreenPass.js';

/**
 * Final image assembly: radial speed blur, chromatic aberration, bloom add,
 * ACES tone map, grade, vignette, grain and the transition fade — all in one
 * pass so the HDR buffer is only read once.
 *
 * The scene is rendered with tone mapping OFF into a half-float target; doing
 * the tone map here instead means bloom is gathered from genuine HDR values
 * and a 40x-over-white thruster blooms like one, instead of clipping to white
 * before it ever reaches the bright pass.
 */

const COMPOSITE_FS = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uTime;

uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uChroma;
uniform float uSpeed;        // 0..1 driving radial blur + CA scaling
uniform float uGrain;
uniform float uFade;         // 1 = fully black, for screen transitions
uniform float uSaturation;
uniform vec3  uTint;
uniform vec3  uFlashColour;
uniform float uFlashAmount;
uniform int uDebug;   // 0 off, 1 raw scene, 2 bloom only, 3 exposure clip

varying vec2 vUv;

#ifndef SPEED_TAPS
#define SPEED_TAPS 6
#endif

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Narkowicz's ACES fit. Not the full RRT/ODT, but it holds highlights together
// at the sort of intensities thrusters and boost pads reach.
vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Mode 6 draws the transfer curve itself: top half linear, bottom half the
  // tone map, both over a 0..1 horizontal ramp.
  if (uDebug == 6) {
    vec3 v = vec3(vUv.x);
    fragColor = vec4(linearToSRGB(vUv.y > 0.5 ? v : acesFilm(v)), 1.0);
    return;
  }

  // Modes 1-3 inspect the inputs; 4+ tap points further down the chain.
  if (uDebug > 0 && uDebug < 4) {
    vec3 raw = uDebug == 2 ? texture(tBloom, vUv).rgb : texture(tScene, vUv).rgb;
    if (uDebug == 3) raw = step(vec3(1.0), raw);   // white wherever the HDR buffer is over 1
    fragColor = vec4(linearToSRGB(max(raw, vec3(0.0))), 1.0);
    return;
  }

  vec2 centred = vUv - 0.5;
  float r2 = dot(centred, centred);

  // Both effects scale with r^2 so the middle of the screen — where the player
  // is actually reading the track — stays clean at any speed.
  float blurAmount = uSpeed * r2 * 0.075;
  // Scales with the radial vector itself rather than a normalised one. Using
  // normalize() here puts a sign flip through the middle of the screen, which
  // shows up as a hard vertical seam the moment the offset is big enough to
  // sample a different colour. Peaks at about one pixel in the corners.
  float chromaAmount = uChroma * (0.0013 + uSpeed * 0.0055);

  vec3 scene = vec3(0.0);
  float weightSum = 0.0;
  for (int i = 0; i < SPEED_TAPS; i++) {
    float t = float(i) / float(SPEED_TAPS - 1);
    float w = 1.0 - t * 0.65;
    vec2 offset = centred * blurAmount * t;
    vec2 uv = vUv - offset;

    // Per-channel radial offset: the aberration rides along the blur vector so
    // the two effects reinforce rather than fight each other.
    vec2 ca = centred * chromaAmount;
    scene.r += texture(tScene, uv + ca).r * w;
    scene.g += texture(tScene, uv).g * w;
    scene.b += texture(tScene, uv - ca).b * w;
    weightSum += w;
  }
  scene /= weightSum;

  if (uDebug == 4) { fragColor = vec4(linearToSRGB(max(scene, vec3(0.0))), 1.0); return; }

  vec3 bloom = texture(tBloom, vUv).rgb;
  vec3 colour = scene + bloom * uBloomStrength;

  colour *= uExposure;
  colour = mix(colour, uFlashColour * max(colour, vec3(0.35)), uFlashAmount);
  colour = acesFilm(colour);
  if (uDebug == 5) { fragColor = vec4(linearToSRGB(colour), 1.0); return; }

  float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  colour = mix(vec3(luma), colour, uSaturation);
  colour *= uTint;

  float vig = smoothstep(0.95, 0.22, r2 * (2.0 - uSpeed * 0.45));
  colour *= mix(1.0, vig, uVignette);

  if (uGrain > 0.0) {
    // Grain in sRGB-ish space and scaled down in highlights: film grain is most
    // visible in the mid-tones, and uniform noise looks like sensor noise.
    float n = hash12(vUv * uResolution + fract(uTime) * 1371.0) - 0.5;
    colour += n * uGrain * (1.0 - luma * 0.75) * smoothstep(0.0, 0.18, luma);
  }

  colour = linearToSRGB(max(colour, vec3(0.0)));
  colour *= (1.0 - uFade);

  fragColor = vec4(colour, 1.0);
}
`;

export class Composite {
  constructor() {
    this.pass = new FullScreenPass({
      fragmentShader: COMPOSITE_FS,
      defines: { SPEED_TAPS: '6' },
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uExposure: { value: 1.0 },
        uBloomStrength: { value: 0.55 },
        uVignette: { value: 0.85 },
        uChroma: { value: 1.0 },
        uSpeed: { value: 0 },
        uGrain: { value: 0.012 },
        uFade: { value: 0 },
        uSaturation: { value: 1.04 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uFlashColour: { value: new THREE.Color(1, 0.3, 0.25) },
        uFlashAmount: { value: 0 },
        uDebug: { value: 0 },
      },
    });
  }

  get uniforms() {
    return this.pass.uniforms;
  }

  setSize(width, height) {
    this.pass.uniforms.uResolution.value.set(width, height);
  }

  setQuality(taps) {
    const value = String(Math.max(2, taps));
    if (this.pass.material.defines.SPEED_TAPS === value) return;
    this.pass.material.defines.SPEED_TAPS = value;
    this.pass.material.needsUpdate = true;
  }

  render(renderer, target = null) {
    this.pass.render(renderer, target);
  }

  dispose() {
    this.pass.dispose();
  }
}
