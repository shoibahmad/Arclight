/** Entry point for `node --import ./tools/test/register.mjs`. */
import { register } from 'node:module';
register('./resolve-three.mjs', import.meta.url);
