/**
 * Run every assertion suite: `node test/run-suites.mjs`.
 *
 * Same contract as the other plugins in this deployment: everything not
 * declared as "not a suite" must pass. A skip list kept in a shell history is a
 * skip list that silently grows.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Files here that are not assertion suites, and why. */
const NOT_SUITES = new Map([
  ['run-suites.mjs', 'this file'],
  ['live.mjs', 'drives a real deployment; needs a running host'],
]);

const files = readdirSync(here)
  .filter((name) => name.endsWith('.mjs'))
  .filter((name) => !NOT_SUITES.has(name))
  .sort();

let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.log(`FAIL ${name} (exit ${result.status})`);
    failed++;
  }
}

const skipped = [...NOT_SUITES.entries()].filter(([name]) => files.includes(name) || true);
console.log('');
for (const [name, reason] of skipped) console.log(`not run here (${reason}): ${name}`);
console.log(`${files.length - failed}/${files.length} suites passed`);
if (failed > 0) process.exit(1);
