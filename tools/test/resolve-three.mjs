/**
 * ESM resolver hook mapping the bare specifier "three" to the vendored build.
 *
 * In the browser this job is done by the import map in index.html. Node has no
 * equivalent, and adding a node_modules copy of three purely so the tests can
 * run would undermine the point of vendoring it. Twenty lines here keeps the
 * project genuinely dependency-free while still letting every pure module in
 * src/ be unit tested.
 */

import { fileURLToPath } from 'node:url';

const THREE_URL = new URL('../../vendor/three/three.module.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return { url: THREE_URL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export const vendorPath = fileURLToPath(THREE_URL);
