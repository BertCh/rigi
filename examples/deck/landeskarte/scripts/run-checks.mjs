// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Runs every checks/*.check.ts (pure CPU, no browser or GPU) with tsx and prints a summary.
//   node scripts/run-checks.mjs [name…]     e.g. geo sun, or no names for all
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checksDirectory = join(root, 'checks');
const requested = new Set(process.argv.slice(2));

const checks = readdirSync(checksDirectory)
  .filter(file => file.endsWith('.check.ts'))
  .filter(file => requested.size === 0 || requested.has(file.replace(/\.check\.ts$/, '')))
  .sort();

if (checks.length === 0) {
  console.error(`No checks matched in ${checksDirectory}`);
  process.exit(1);
}

const results = [];
for (const file of checks) {
  console.log(`\n=== ${file} ===`);
  const started = performance.now();
  // Inherit stdio: each check prints its own PASS lines with measured numbers.
  const run = spawnSync('npx', ['tsx', join(checksDirectory, file)], {
    cwd: root,
    stdio: 'inherit'
  });
  results.push({
    file,
    ok: run.status === 0,
    seconds: (performance.now() - started) / 1000,
    status: run.error ? run.error.message : `exit ${run.status ?? run.signal}`
  });
}

console.log('\nSummary');
for (const result of results) {
  const label = result.ok ? 'PASS' : 'FAIL';
  console.log(
    `  ${label}  ${result.file.padEnd(28)} ${result.seconds.toFixed(1).padStart(6)} s` +
      (result.ok ? '' : `  (${result.status})`)
  );
}
const failed = results.filter(result => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
