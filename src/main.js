import { Game } from './core/Game.js';
import { ViewportError } from './render/Viewport.js';

/**
 * Entry point.
 *
 * Boot is deliberately staged with a frame between each step. Generating the
 * procedural textures for a circuit takes a couple of seconds of solid
 * main-thread work, and without yielding the browser never paints the
 * progress bar — the player gets a frozen logo and assumes it has hung.
 */

const canvas = document.getElementById('viewport');
const hudRoot = document.getElementById('hud');
const screenRoot = document.getElementById('screens');
const boot = document.getElementById('boot');
const bootFill = document.getElementById('boot-fill');
const bootStatus = document.getElementById('boot-status');

function setProgress(fraction, label) {
  if (bootFill) bootFill.style.width = `${Math.round(fraction * 100)}%`;
  if (bootStatus && label) bootStatus.textContent = label;
}

function fail(message, detail) {
  boot?.classList.add('is-done');
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal">
       <h1>Arclight cannot start</h1>
       <p>${escapeHtml(message)}</p>
       ${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}
     </div>`
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

async function main() {
  if (!canvas) {
    fail('The page is missing its canvas element.');
    return;
  }

  let game;
  try {
    game = new Game({ canvas, hudRoot, screenRoot });
  } catch (error) {
    if (error instanceof ViewportError) {
      fail(
        error.message,
        'Arclight needs WebGL 2. On a desktop browser this usually means hardware acceleration is switched off in settings.'
      );
    } else {
      fail('Arclight could not initialise.', error?.stack ?? String(error));
    }
    return;
  }

  // Exposed for the automated smoke test and for debugging from the console.
  window.arclight = game;

  try {
    await game.boot(setProgress);
  } catch (error) {
    fail('Arclight failed during startup.', error?.stack ?? String(error));
    return;
  }

  boot?.classList.add('is-done');
  setTimeout(() => boot?.remove(), 800);
}

main();
