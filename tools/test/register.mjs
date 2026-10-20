/**
 * Entry point for `node --import ./tools/test/register.mjs`.
 *
 * Installs the "three" resolver hook and a minimal canvas, so modules written
 * for the browser can be exercised from Node without a bundler or a DOM.
 */
import { register } from 'node:module';
import { installCanvasShim } from './canvas-shim.mjs';

register('./resolve-three.mjs', import.meta.url);
installCanvasShim();
