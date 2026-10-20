import * as THREE from 'three';
import { noiseTexture, starfield } from '../assets/Textures.js';

/**
 * Procedural sky dome.
 *
 * Drawn first with depth testing off, so the geometry is a unit sphere parked
 * on the camera and its radius is irrelevant — no need to juggle a skybox
 * against the far plane when the track climbs 200 metres.
 *
 * Output is linear HDR and deliberately unclamped: the sun disc runs well above
 * 1.0 so it blooms properly in the post chain rather than clipping to a flat
 * white circle.
 */

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FS = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDirection;
uniform vec3 uSunColour;
uniform float uSunIntensity;
uniform float uSunSize;
uniform float uHaze;
uniform float uCloudiness;
uniform float uStarIntensity;
uniform float uTime;
uniform sampler2D uStars;
uniform sampler2D uNoise;
uniform float uExposure;

varying vec3 vDir;

const float PI = 3.141592653589793;

vec3 sampleStars(vec3 d) {
  // Equirectangular lookup over the upper hemisphere only.
  float u = atan(d.z, d.x) / (2.0 * PI) + 0.5;
  float v = clamp(asin(clamp(d.y, -1.0, 1.0)) / (PI * 0.5), 0.0, 1.0);
  return texture(uStars, vec2(u, v)).rgb;
}

float cloudBand(vec3 d) {
  if (uCloudiness <= 0.001) return 0.0;
  // Project onto a plane well above the camera; this is what gives the layer
  // its perspective stretch toward the horizon.
  float h = max(d.y, 0.03);
  vec2 p = d.xz / h * 0.11;
  p += vec2(uTime * 0.0035, uTime * 0.0012);

  float n = texture(uNoise, p * 0.5).r;
  n += texture(uNoise, p * 1.37 + 0.31).g * 0.5;
  n += texture(uNoise, p * 2.9 - 0.17).r * 0.25;
  n /= 1.75;

  float coverage = smoothstep(0.52 - uCloudiness * 0.3, 0.78, n);
  // Fade the layer out near the zenith and right at the horizon so it reads as
  // a finite deck rather than a wrapped texture.
  return coverage * smoothstep(0.02, 0.16, d.y) * (1.0 - smoothstep(0.22, 0.62, d.y));
}

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;

  // Sky gradient. pow() on the horizon term keeps the band tight instead of
  // smearing the horizon colour halfway up the dome.
  float t = pow(clamp(up, 0.0, 1.0), 0.55);
  vec3 sky = mix(uHorizon, uZenith, t);

  // Below the horizon fades to the ground bounce colour.
  float below = smoothstep(0.0, -0.18, up);
  sky = mix(sky, uGround, below);

  float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);

  // Broad atmospheric scattering around the sun.
  float halo = pow(sunDot, 9.0) * 0.30 + pow(sunDot, 3.0) * 0.045;
  sky += uSunColour * halo * uHaze;

  if (uStarIntensity > 0.001) {
    float fade = smoothstep(-0.05, 0.25, up);
    sky += sampleStars(dir) * uStarIntensity * fade;
  }

  float clouds = cloudBand(dir);
  if (clouds > 0.0) {
    // Light the deck from the sun direction: silver linings on the near edge.
    vec3 lit = mix(uHorizon * 0.8, uSunColour * 1.1, pow(sunDot, 2.5) * 0.7);
    vec3 shadowed = uZenith * 0.7 + uHorizon * 0.12;
    sky = mix(sky, mix(shadowed, lit, 0.45), clouds * 0.7);
  }

  // The disc itself, far brighter than anything else in the scene.
  float disc = 1.0 - smoothstep(uSunSize * 0.85, uSunSize, acos(clamp(sunDot, -1.0, 1.0)));
  sky += uSunColour * disc * uSunIntensity;

  fragColor = vec4(max(sky * uExposure, vec3(0.0)), 1.0);
}
`;

export class Sky {
  constructor() {
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x1b3a6b) },
      uHorizon: { value: new THREE.Color(0xd98a52) },
      uGround: { value: new THREE.Color(0x14161c) },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.3, -0.86) },
      uSunColour: { value: new THREE.Color(0xffd9a0) },
      uSunIntensity: { value: 28 },
      uSunSize: { value: 0.035 },
      uHaze: { value: 1.0 },
      uCloudiness: { value: 0.35 },
      uStarIntensity: { value: 0 },
      uTime: { value: 0 },
      uStars: { value: starfield() },
      uNoise: { value: noiseTexture(128, 23) },
      uExposure: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: `precision highp float;\nout vec4 fragColor;\n${SKY_FS}`.replace(
        /\bvarying\b/g,
        'in'
      ),
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    this.mesh.frustumCulled = false;
    // Drawn before everything else, with depth off: a pure background fill.
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    this.material = material;
  }

  /** @param {object} theme see data/themes.js */
  applyTheme(theme) {
    const sky = theme.sky;
    this.uniforms.uZenith.value.set(sky.zenith);
    this.uniforms.uHorizon.value.set(sky.horizon);
    this.uniforms.uGround.value.set(sky.ground);
    this.uniforms.uSunColour.value.set(sky.sunColour);
    this.uniforms.uSunIntensity.value = sky.sunIntensity;
    this.uniforms.uSunSize.value = sky.sunSize ?? 0.035;
    this.uniforms.uHaze.value = sky.haze ?? 1;
    this.uniforms.uCloudiness.value = sky.cloudiness ?? 0;
    this.uniforms.uStarIntensity.value = sky.stars ?? 0;
    this.uniforms.uSunDirection.value.copy(theme.sunDirection).normalize();
  }

  /** Keep the dome centred on the camera; it has no position of its own. */
  update(camera, elapsed) {
    this.uniforms.uTime.value = elapsed;
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrix();
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
