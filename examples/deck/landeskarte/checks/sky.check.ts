// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Static checks for the sky and atmosphere shader strings: no GPU, so this proves what a string
// check can (twin signatures, shared constants, uniform parity) and the CPU helper `skyColorFor`.

import assert from 'node:assert/strict';
import {ATMOSPHERE_GLSL_CONSTANTS, ATMOSPHERE_WGSL_CONSTANTS} from '../geo/atmosphere';
import {skyColorFor} from '../layers/sky-layer';
import {SKY_GLSL_FRAGMENT} from '../layers/sky.glsl';
import {SKY_WGSL} from '../layers/sky.wgsl';
import {ATMO_GLSL} from '../terrain/atmo.glsl';
import {ATMO_WGSL} from '../terrain/atmo.wgsl';

// Function name -> parameter count, parsed from each language's declarations.
function wgslFunctions(source: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of source.matchAll(/\bfn (lk_\w+)\(([^)]*)\)/g)) {
    found.set(match[1], match[2].trim() ? match[2].split(',').length : 0);
  }
  return found;
}

function glslFunctions(source: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of source.matchAll(/^(?:float|vec3) (lk_\w+)\(([^)]*)\)/gm)) {
    found.set(match[1], match[2].trim() ? match[2].split(',').length : 0);
  }
  return found;
}

const wgsl = wgslFunctions(ATMO_WGSL);
const glsl = glslFunctions(ATMO_GLSL);
assert.deepEqual([...wgsl].sort(), [...glsl].sort(), 'WGSL and GLSL function sets differ');
assert.equal(wgsl.get('lk_atmosphere'), 8);
assert.equal(wgsl.get('lk_grade'), 8);
console.log(`PASS ${wgsl.size} lk_ functions, same names and arities in WGSL and GLSL`);

assert.ok(ATMO_WGSL.includes(ATMOSPHERE_WGSL_CONSTANTS), 'WGSL constants not embedded');
assert.ok(ATMO_GLSL.includes(ATMOSPHERE_GLSL_CONSTANTS), 'GLSL constants not embedded');
assert.ok(SKY_WGSL.includes(ATMO_WGSL) && SKY_GLSL_FRAGMENT.includes(ATMO_GLSL));
console.log('PASS atmosphere constants embedded once, sky shaders embed the atmosphere snippets');

// Every skyDome field either shader reads must be a declared uniform (names are shared).
const declared = [
  'sunDirection',
  'sunColor',
  'skyColor',
  'cameraForward',
  'cameraRight',
  'cameraUp',
  'paperColor',
  'panoramaMix',
  'tanHalfVfov',
  'aspect',
  'eyeHeight',
  'strength'
];
for (const source of [SKY_WGSL, SKY_GLSL_FRAGMENT]) {
  const used = new Set([...source.matchAll(/skyDome\.(\w+)/g)].map(match => match[1]));
  for (const name of used) assert.ok(declared.includes(name), `undeclared uniform ${name}`);
  assert.ok(used.size >= 10, `only ${used.size} uniforms used`);
}
console.log('PASS both sky shaders read only declared skyDome uniforms');

let previousBlue = -1;
for (const elevation of [-30, -18, -10, -6, -3, 0, 3, 6, 15, 30, 60]) {
  const color = skyColorFor(elevation);
  assert.ok(color.every(value => value >= 0 && value <= 1));
  const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  assert.ok(luminance >= previousBlue - 1e-9, `skyColorFor not monotone at ${elevation}`);
  previousBlue = luminance;
}
const noon = skyColorFor(45);
assert.ok(noon[2] > noon[0], 'noon sky is blue');
console.log(
  `PASS skyColorFor monotone in luminance, noon = ${noon.map(v => v.toFixed(2)).join(', ')}`
);
