import * as THREE from 'three';

/**
 * Accumulates vertices and triangles, then emits a BufferGeometry.
 *
 * Everything with geometry in this game is generated at runtime, so rather
 * than fighting three's primitive classes into shape and merging the results,
 * the builders write vertices directly. Vertex indices are returned from
 * `vertex()` and wired up by hand, which is what makes the track cross-section
 * code read as a cross-section rather than as matrix bookkeeping.
 */
export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  get isEmpty() {
    return this.indices.length === 0;
  }

  /** @returns {number} the index of the vertex just added */
  vertex(px, py, pz, nx, ny, nz, u, v) {
    this.positions.push(px, py, pz);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  /** Convenience overload taking three.js vectors. */
  vertexV(position, normal, u, v) {
    return this.vertex(position.x, position.y, position.z, normal.x, normal.y, normal.z, u, v);
  }

  triangle(a, b, c) {
    this.indices.push(a, b, c);
  }

  /** Quad in counter-clockwise order a-b-c-d. */
  quad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
  }

  /**
   * Stitch two rows of equal length into a strip of quads.
   * Used for every lengthwise surface on the track.
   */
  strip(rowA, rowB) {
    const n = Math.min(rowA.length, rowB.length);
    for (let i = 0; i < n - 1; i++) {
      this.quad(rowA[i], rowA[i + 1], rowB[i + 1], rowB[i]);
    }
  }

  /** Append an existing geometry, transformed. Used for scattering props. */
  append(geometry, matrix) {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const base = this.vertexCount;

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const p = new THREE.Vector3();
    const nvec = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      if (nor) nvec.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      else nvec.set(0, 1, 0);
      this.vertex(p.x, p.y, p.z, nvec.x, nvec.y, nvec.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }

    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    }
  }

  build({ computeTangents = false, name = '' } = {}) {
    const geometry = new THREE.BufferGeometry();
    geometry.name = name;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(
      this.vertexCount > 65535
        ? new THREE.Uint32BufferAttribute(this.indices, 1)
        : new THREE.Uint16BufferAttribute(this.indices, 1)
    );
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    // Only worth it where a normal map meets non-trivial UVs; three otherwise
    // derives tangents per-pixel from screen-space derivatives, which is fine.
    if (computeTangents) geometry.computeTangents();
    return geometry;
  }
}

/** Box with outward normals and per-face UVs, in local space. */
export function boxGeometry(width, height, depth, uvScale = 1) {
  const g = new THREE.BoxGeometry(width, height, depth);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
  }
  uv.needsUpdate = true;
  return g;
}
