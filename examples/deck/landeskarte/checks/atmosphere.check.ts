// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import assert from 'node:assert/strict';
import {
  applyAtmosphere,
  ATMOSPHERE_GLSL_CONSTANTS,
  ATMOSPHERE_WGSL_CONSTANTS,
  atmPath,
  BETA_M0,
  BETA_R0,
  cornetteShanks,
  H_M,
  H_R,
  MIE_G,
  rayleighPhase,
  transmittance
} from '../geo/atmosphere';

/** Midpoint-rule integral of exp(-h(s) / H) over the ray, an independent formulation. */
function numericPath(h0: number, h1: number, L: number, H: number, steps = 10000): number {
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const h = h0 + ((h1 - h0) * (i + 0.5)) / steps;
    sum += Math.exp(-h / H);
  }
  return (sum * L) / steps;
}

// 1. atmPath against numeric integration (tolerance 1e-4 relative), including the level-ray branch.
const rays: [number, number, number][] = [
  [1919, 558, 20000],
  [558, 1919, 20000],
  [1919, 3970, 60000],
  [558, 558, 30000],
  [1919, 1919.5, 40000],
  [0, 9000, 100000],
  [1200, 400, 500]
];
let worstPath = 0;
for (const [h0, h1, L] of rays) {
  for (const H of [H_R, H_M]) {
    const closed = atmPath(h0, h1, L, H);
    const numeric = numericPath(h0, h1, L, H);
    const relative = Math.abs(closed - numeric) / numeric;
    worstPath = Math.max(worstPath, relative);
    assert.ok(relative < 1e-4, `atmPath ${h0}->${h1} L=${L} H=${H}: ${relative}`);
  }
}
console.log(`PASS atmPath vs 1e4-step integral: worst relative ${worstPath.toExponential(2)}`);

// 2. The small-x branch meets the closed form without a jump at |x| = 1e-3.
{
  const H = H_R;
  const below = atmPath(0, 0.999e-3 * H, 1000, H);
  const above = atmPath(0, 1.001e-3 * H, 1000, H);
  const jump = Math.abs(above - below) / below;
  assert.ok(jump < 1e-5, `branch jump ${jump}`);
  const exactBelow = (1 - Math.exp(-0.999e-3)) / 0.999e-3;
  assert.ok(Math.abs(below - 1000 * exactBelow) / below < 1e-6);
  console.log(
    `PASS small-x branch continuity: relative step across threshold ${jump.toExponential(2)}`
  );
}

// 3. Transmittance: strength 0 is transparent, monotone in distance, blue dies first, bounds.
{
  const clear = transmittance(1919, 558, 20000, 0);
  assert.deepEqual(clear, [1, 1, 1]);
  const near = transmittance(1919, 1900, 1000, 1);
  const far = transmittance(1919, 1500, 40000, 1);
  for (let c = 0; c < 3; c++) {
    assert.ok(far[c] < near[c] && near[c] <= 1 && far[c] > 0);
  }
  assert.ok(far[0] > far[1] && far[1] > far[2], 'red transmits best, blue worst');
  const double = transmittance(1919, 1500, 40000, 2);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(double[c] - far[c] ** 2) < 1e-12, 'strength is an optical-depth multiplier');
  }
  // Horizontal ray at 1900 m, 40 km, checked by hand from the definition.
  const level = transmittance(1900, 1900, 40000, 1);
  const dR = Math.exp(-1900 / H_R) * 40000;
  const dM = Math.exp(-1900 / H_M) * 40000;
  const expected = Math.exp(-(BETA_R0[2] * dR + BETA_M0 * dM));
  assert.ok(Math.abs(level[2] - expected) < 1e-12);
  console.log(
    `PASS transmittance: 40 km level at 1900 m T=[${level.map(v => v.toFixed(3)).join(', ')}], ` +
      `sea-level 40 km T=[${transmittance(0, 0, 40000, 1)
        .map(v => v.toFixed(3))
        .join(', ')}]`
  );
}

// 4. applyAtmosphere: T = 1 keeps the colour, T = 0 gives airlight, in between is a convex mix.
{
  const c: [number, number, number] = [0.2, 0.5, 0.1];
  const a: [number, number, number] = [0.7, 0.8, 0.9];
  assert.deepEqual(applyAtmosphere(c, a, [1, 1, 1]), c);
  assert.deepEqual(applyAtmosphere(c, a, [0, 0, 0]), a);
  const mixed = applyAtmosphere(c, a, [0.5, 0.25, 0.75]);
  assert.ok(Math.abs(mixed[0] - 0.45) < 1e-12 && Math.abs(mixed[1] - 0.725) < 1e-12);
  console.log('PASS applyAtmosphere endpoints and mix');
}

// 5. Phase functions integrate to 1 over the sphere: 2 pi * integral of p(cos) d(cos) over [-1, 1].
{
  const steps = 200000;
  let mie = 0;
  let rayleigh = 0;
  for (let i = 0; i < steps; i++) {
    const cosT = -1 + (2 * (i + 0.5)) / steps;
    mie += cornetteShanks(cosT, MIE_G);
    rayleigh += rayleighPhase(cosT);
  }
  mie *= (2 * Math.PI * 2) / steps;
  rayleigh *= (2 * Math.PI * 2) / steps;
  assert.ok(Math.abs(mie - 1) < 1e-6, `Cornette-Shanks norm ${mie}`);
  assert.ok(Math.abs(rayleigh - 1) < 1e-6, `Rayleigh norm ${rayleigh}`);
  assert.ok(cornetteShanks(1) > 50 * cornetteShanks(-1), 'strongly forward peaked');
  console.log(
    `PASS phase normalisation: Cornette-Shanks ${mie.toFixed(5)}, Rayleigh ${rayleigh.toFixed(7)}, ` +
      `forward/back ${(cornetteShanks(1) / cornetteShanks(-1)).toFixed(0)}`
  );
}

// 6. Generated shader strings carry the TS numbers and are valid-looking float literals.
{
  const literal = /^(\d+\.\d+)(e-?\d+)?$/;
  for (const text of [ATMOSPHERE_WGSL_CONSTANTS, ATMOSPHERE_GLSL_CONSTANTS]) {
    const numbers = text.match(/(?<![\w.])\d+\.\d+(?:e-?\d+)?/g) ?? [];
    assert.ok(numbers.length >= 7);
    for (const n of numbers) {
      assert.ok(literal.test(n), `bad float literal ${n}`);
    }
    // Round-trip: the parsed numbers are exactly the TS constants.
    const parsed = numbers.map(Number);
    assert.deepEqual(parsed, [...BETA_R0, BETA_M0, H_R, H_M, MIE_G]);
  }
  assert.match(ATMOSPHERE_WGSL_CONSTANTS, /const LK_BETA_R0: vec3<f32> = vec3<f32>\(/);
  assert.match(ATMOSPHERE_GLSL_CONSTANTS, /const vec3 LK_BETA_R0 = vec3\(/);
  assert.ok(!/LK_BETA_R0\d/.test(ATMOSPHERE_GLSL_CONSTANTS));
  console.log('PASS generated WGSL/GLSL constants round-trip to the TS numbers');
}
