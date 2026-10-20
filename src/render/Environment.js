import * as THREE from 'three';
import { Sky } from './Sky.js';

/**
 * The light rig and atmosphere for a loaded track.
 *
 * The one non-obvious job here is the shadow camera. A circuit is a couple of
 * kilometres long but the player only ever sees ~150 metres of it, so the
 * directional light's orthographic frustum is kept small and snapped to follow
 * the craft. Snapping to texel-sized increments is what stops the shadow edges
 * crawling as the camera moves — without it, a 90-metre frustum over a 2048 map
 * shimmers visibly on every straight.
 */

const SHADOW_EXTENT = 95;
const SHADOW_DISTANCE = 220;

export class Environment {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../data/themes.js').THEMES[string]} theme
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(scene, theme, settings) {
    this.scene = scene;
    this.theme = theme;
    this.settings = settings;

    this.sky = new Sky();
    this.sky.applyTheme(theme);
    scene.add(this.sky.mesh);

    scene.fog = new THREE.FogExp2(new THREE.Color(theme.fog.colour), theme.fog.density);

    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(theme.ambient.sky),
      new THREE.Color(theme.ambient.ground),
      theme.ambient.intensity
    );
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(new THREE.Color(theme.sun.colour), theme.sun.intensity);
    this.sun.castShadow = settings.preset.shadows;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    this.configureShadow();
    scene.add(this.sun);

    // Bounce: a dim light from the opposite side keeps the shadowed flank of a
    // craft from going to pure black without lifting the whole scene.
    this.fill = new THREE.DirectionalLight(new THREE.Color(theme.ambient.sky), 0.28);
    this.fill.position.copy(theme.sunDirection).multiplyScalar(-60);
    this.fill.position.y = Math.abs(this.fill.position.y) * 0.4 + 20;
    scene.add(this.fill);

    this.shadowTexel = 1;
    this.envMap = null;
    this._pmrem = null;
  }

  /**
   * Pre-filter the sky into an environment map.
   *
   * Without this every metal in the scene renders almost black. A metallic
   * surface has no diffuse response at all — everything you see on it is
   * reflected environment — so a PBR material at metalness 0.8 with nothing
   * to reflect is, correctly and uselessly, a black object. One 256px cube
   * capture of the sky dome at track load fixes the craft, the barriers and
   * the road in a single stroke, and costs nothing per frame.
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  buildEnvironmentMap(renderer) {
    if (this.envMap) return this.envMap;
    try {
      this._pmrem = new THREE.PMREMGenerator(renderer);

      // Capture the sky alone, from the origin. The dome is a unit sphere
      // parked on the camera during play, so it has to be recentred first.
      const previous = this.sky.mesh.position.clone();
      this.sky.mesh.position.set(0, 0, 0);
      this.sky.mesh.updateMatrix();
      this.sky.mesh.matrixWorldNeedsUpdate = true;

      const skyScene = new THREE.Scene();
      skyScene.add(this.sky.mesh);
      const target = this._pmrem.fromScene(skyScene, 0, 0.05, 10);
      this.envMap = target.texture;

      // Put the dome back where it belongs.
      skyScene.remove(this.sky.mesh);
      this.scene.add(this.sky.mesh);
      this.sky.mesh.position.copy(previous);
      this.sky.mesh.updateMatrix();

      this.scene.environment = this.envMap;
      // Slightly under 1: the generated sky is bright, and a full-strength
      // ambient reflection washes out the directional key light.
      this.scene.environmentIntensity = 0.65;
    } catch (err) {
      console.warn('[environment] could not build an environment map', err);
    }
    return this.envMap;
  }

  configureShadow() {
    const preset = this.settings.preset;
    const size = preset.shadowMapSize;
    const shadow = this.sun.shadow;

    shadow.mapSize.set(size, size);
    shadow.camera.left = -SHADOW_EXTENT;
    shadow.camera.right = SHADOW_EXTENT;
    shadow.camera.top = SHADOW_EXTENT;
    shadow.camera.bottom = -SHADOW_EXTENT;
    shadow.camera.near = 1;
    shadow.camera.far = SHADOW_DISTANCE * 2;
    // Normal bias handles the sloped, banked track surface far better than a
    // constant depth bias, which either peter-pans the craft or leaves acne.
    shadow.bias = -0.0004;
    shadow.normalBias = 0.9;
    shadow.radius = size >= 2048 ? 2.2 : 1.4;
    shadow.camera.updateProjectionMatrix();

    this.shadowTexel = (SHADOW_EXTENT * 2) / size;
    this.sun.castShadow = preset.shadows;
  }

  applyGrade(viewport) {
    viewport.setGrade(this.theme.grade);
  }

  /**
   * @param {THREE.Vector3} focus  where the shadow frustum should centre
   * @param {THREE.Camera} camera
   * @param {number} elapsed
   */
  update(focus, camera, elapsed) {
    this.sky.update(camera, elapsed);

    const dir = this.theme.sunDirection;

    // Snap the focus point to shadow-map texels before placing the light.
    const texel = this.shadowTexel;
    const sx = Math.round(focus.x / texel) * texel;
    const sy = Math.round(focus.y / texel) * texel;
    const sz = Math.round(focus.z / texel) * texel;

    this.sunTarget.position.set(sx, sy, sz);
    this.sunTarget.updateMatrixWorld();

    this.sun.position.set(
      sx + dir.x * SHADOW_DISTANCE,
      sy + dir.y * SHADOW_DISTANCE,
      sz + dir.z * SHADOW_DISTANCE
    );
    this.sun.updateMatrixWorld();
  }

  dispose() {
    this.scene.environment = null;
    this.envMap?.dispose?.();
    this._pmrem?.dispose?.();
    this.scene.remove(this.sky.mesh, this.hemi, this.sun, this.fill, this.sunTarget);
    this.sky.dispose();
    this.sun.dispose?.();
    this.scene.fog = null;
  }
}
