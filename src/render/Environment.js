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
    this.scene.remove(this.sky.mesh, this.hemi, this.sun, this.fill, this.sunTarget);
    this.sky.dispose();
    this.sun.dispose?.();
    this.scene.fog = null;
  }
}
