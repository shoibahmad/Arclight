import * as THREE from 'three';
import { Bloom } from './passes/Bloom.js';
import { Composite } from './passes/Composite.js';
import { clamp, damp } from '../core/MathUtil.js';

/**
 * Owns the WebGL renderer, the HDR scene buffer and the post chain.
 *
 * Everything that wants to change how the frame looks goes through here, so
 * there is exactly one place that knows the resolution, the quality preset and
 * the order of the passes.
 */

export class ViewportError extends Error {}

export class Viewport {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false, // MSAA is done on the HDR target instead
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      throw new ViewportError(`WebGL could not be initialised: ${err.message}`);
    }

    if (!renderer.capabilities.isWebGL2) {
      throw new ViewportError('Arclight needs WebGL 2, which this browser does not provide.');
    }

    renderer.autoClear = false;
    // Tone mapping happens in the composite pass, not here — see Composite.js.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);

    this.renderer = renderer;
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    this.bloom = new Bloom({ iterations: 5, threshold: 1.25, knee: 0.5, radius: 1.0 });
    this.composite = new Composite();
    this.bloomStrength = 0.55;
    /** Debug/accessibility multiplier on top of the theme's bloom strength. */
    this.bloomScale = 1;
    /** Bound to tBloom when bloom is switched off, so the sampler is never null. */
    this.blackTexture = makeBlackTexture();

    this.sceneTarget = null;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;

    /** Smoothed 0..1 speed signal driving motion effects. */
    this.speedSignal = 0;
    this.targetSpeedSignal = 0;
    this.fade = 0;
    this.flash = 0;
    this.time = 0;

    this.contextLost = false;
    this._bindContextEvents();
    this.applyQuality();
    this.resize();
  }

  _bindContextEvents() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault the context is gone for good; with it, the
      // browser will restore and we can keep playing.
      e.preventDefault();
      this.contextLost = true;
      console.warn('[viewport] WebGL context lost — pausing rendering');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.applyQuality();
      this.resize(true);
      console.info('[viewport] WebGL context restored');
    });
  }

  get preset() {
    return this.settings.preset;
  }

  applyQuality() {
    const preset = this.preset;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.bloom.iterations = preset.bloomIterations;
    this.composite.uniforms.uGrain.value = preset.grain ? 0.012 : 0;
    this.composite.uniforms.uChroma.value = this.settings.get('chromaticAberration') ? 1 : 0;
    this.composite.setQuality(preset.bloomIterations >= 5 ? 8 : 5);
    this.msaaSamples = preset.shadows ? (preset.shadowMapSize >= 2048 ? 4 : 2) : 0;
    this.resize(true);
  }

  /** Device pixels per CSS pixel, after the preset cap and the user's scale. */
  computePixelRatio() {
    const preset = this.preset;
    const dpr = window.devicePixelRatio || 1;
    return clamp(Math.min(dpr, preset.maxPixelRatio) * this.settings.get('renderScale'), 0.4, 3);
  }

  resize(force = false) {
    const cssWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const ratio = this.computePixelRatio();

    const width = Math.max(2, Math.floor(cssWidth * ratio));
    const height = Math.max(2, Math.floor(cssHeight * ratio));
    if (!force && width === this.width && height === this.height) return false;

    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;

    this.renderer.setPixelRatio(1); // we size the drawing buffer ourselves
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.sceneTarget?.dispose();
    this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.msaaSamples || 0,
    });
    this.sceneTarget.texture.colorSpace = THREE.NoColorSpace;

    this.bloom.setSize(width, height);
    this.composite.setSize(width, height);
    return true;
  }

  get aspect() {
    return this.width / this.height;
  }

  /** 0..1 — how fast the player is going, for blur and aberration. */
  setSpeedSignal(v) {
    this.targetSpeedSignal = clamp(v, 0, 1);
  }

  setFade(v) {
    this.fade = clamp(v, 0, 1);
  }

  /** Punchy one-shot screen flash, e.g. a wall strike. */
  pulse(amount = 0.5, colour = 0xff4a32) {
    this.flash = clamp(Math.max(this.flash, amount), 0, 1);
    this.composite.uniforms.uFlashColour.value.setHex(colour);
  }

  setGrade({ exposure, bloomStrength, saturation, tint, vignette } = {}) {
    const u = this.composite.uniforms;
    if (exposure != null) u.uExposure.value = exposure;
    if (bloomStrength != null) this.bloomStrength = bloomStrength;
    if (saturation != null) u.uSaturation.value = saturation;
    if (vignette != null) u.uVignette.value = vignette;
    if (tint != null) u.uTint.value.set(tint);
  }

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} dt  real frame time, for effect smoothing
   */
  render(scene, camera, dt) {
    if (this.contextLost || !this.sceneTarget) return;

    // Never trust the caller's delta. A single negative or absurd dt here used
    // to poison the decaying effect state for the rest of the session, and the
    // symptom (a bleached, hue-shifted image) looks nothing like the cause.
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;

    this.time += dt;
    this.speedSignal = damp(this.speedSignal, this.targetSpeedSignal, 0.0005, dt);
    this.flash = clamp(this.flash - dt * 2.6, 0, 1);

    const u = this.composite.uniforms;
    u.uTime.value = this.time;
    u.uSpeed.value = this.speedSignal;
    u.uFade.value = this.fade;
    u.uFlashAmount.value = this.flash * 0.55;

    const renderer = this.renderer;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    // Snapshot before the post passes, otherwise every counter reads as the
    // one fullscreen triangle of the composite.
    this.sceneStats = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };

    const bloomTexture = this.preset.bloom
      ? this.bloom.render(renderer, this.sceneTarget.texture, this.width, this.height)
      : null;

    u.tScene.value = this.sceneTarget.texture;
    u.tBloom.value = bloomTexture ?? this.blackTexture;
    u.uBloomStrength.value = bloomTexture ? this.bloomStrength * this.bloomScale : 0;

    this.composite.render(renderer, null);
  }

  get info() {
    return this.renderer.info;
  }

  dispose() {
    this.bloom.dispose();
    this.composite.dispose();
    this.blackTexture.dispose();
    this.sceneTarget?.dispose();
    this.renderer.dispose();
  }
}

/** 1x1 black texture used as a stand-in when a pass is disabled. */
function makeBlackTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}
