/**
 * A very small 2D canvas, for running the texture generators under Node.
 *
 * Only the handful of operations Textures.js actually uses are implemented:
 * solid rectangles, filled circles, and direct ImageData access. That is
 * enough to build every surface in the game headlessly, which means the track
 * generator and the smoke test can run without a browser or a GPU.
 *
 * This is test scaffolding. Nothing in src/ imports it, and in the browser the
 * real OffscreenCanvas is used instead.
 */

function parseColour(style) {
  if (typeof style !== 'string') return [255, 0, 255, 1];
  const hex = style.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = style.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((v) => parseFloat(v.trim()));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0, parts.length > 3 ? parts[3] : 1];
  }
  return [255, 0, 255, 1];
}

class ImageDataShim {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data || new Uint8ClampedArray(width * height * 4);
  }
}

class Context2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this._path = [];
  }

  createImageData(width, height) {
    return new ImageDataShim(width, height);
  }

  getImageData(x, y, width, height) {
    const out = new ImageDataShim(width, height);
    const src = this.canvas._pixels;
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * this.canvas.width + x) * 4;
      out.data.set(src.subarray(from, from + width * 4), row * width * 4);
    }
    return out;
  }

  putImageData(image, x, y) {
    const dst = this.canvas._pixels;
    for (let row = 0; row < image.height; row++) {
      const to = ((y + row) * this.canvas.width + x) * 4;
      dst.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), to);
    }
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a] = parseColour(this.fillStyle);
    const px = this.canvas._pixels;
    const W = this.canvas.width;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + w));
    const y1 = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * W + xx) * 4;
        px[i] = px[i] * (1 - a) + r * a;
        px[i + 1] = px[i + 1] * (1 - a) + g * a;
        px[i + 2] = px[i + 2] * (1 - a) + b * a;
        px[i + 3] = 255;
      }
    }
  }

  beginPath() {
    this._path = [];
  }

  arc(x, y, radius) {
    this._path.push({ x, y, radius });
  }

  fill() {
    const [r, g, b, a] = parseColour(this.fillStyle);
    const px = this.canvas._pixels;
    const W = this.canvas.width;
    const H = this.canvas.height;
    for (const circle of this._path) {
      const rad = Math.max(circle.radius, 0.5);
      const x0 = Math.max(0, Math.floor(circle.x - rad));
      const x1 = Math.min(W, Math.ceil(circle.x + rad));
      const y0 = Math.max(0, Math.floor(circle.y - rad));
      const y1 = Math.min(H, Math.ceil(circle.y + rad));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          if (Math.hypot(xx - circle.x, yy - circle.y) > rad) continue;
          const i = (yy * W + xx) * 4;
          px[i] = px[i] * (1 - a) + r * a;
          px[i + 1] = px[i + 1] * (1 - a) + g * a;
          px[i + 2] = px[i + 2] * (1 - a) + b * a;
          px[i + 3] = 255;
        }
      }
    }
    this._path = [];
  }
}

export class OffscreenCanvasShim {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._pixels = new Uint8ClampedArray(width * height * 4);
    this._context = new Context2D(this);
  }

  getContext(type) {
    if (type !== '2d') return null;
    return this._context;
  }
}

/** Install the shim globally if the host has no canvas of its own. */
export function installCanvasShim() {
  if (typeof globalThis.OffscreenCanvas === 'undefined') {
    globalThis.OffscreenCanvas = OffscreenCanvasShim;
  }
  // three checks for these when deciding how to upload a texture.
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = ImageDataShim;
}
