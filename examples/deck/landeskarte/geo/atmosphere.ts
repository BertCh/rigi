// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU mirror of the terrain shader's aerial perspective: single scattering through an
// exponential atmosphere, no ozone and no multiple scattering. It is "physically inspired", not
// physically exact (in particular there is no blue hour). The shader snippets embed the generated
// constant strings at the bottom of this file, so the CPU numbers and the GPU numbers cannot drift.

import type {RGB} from '../types';

/** Sea-level Rayleigh scattering coefficients per metre for R, G, B (about 680, 550, 440 nm). */
export const BETA_R0: RGB = [5.8e-6, 13.5e-6, 33.1e-6];
/** Sea-level Mie extinction per metre. Wavelength independent (large aerosol particles). */
export const BETA_M0 = 21e-6;
/** Rayleigh scale height, metres. */
export const H_R = 8000;
/** Mie scale height, metres: aerosols hug the valley floor. */
export const H_M = 1200;
/** Cornette-Shanks anisotropy of the aerosol phase function (forward scattering). */
export const MIE_G = 0.76;

/**
 * Density-weighted path length (metres of sea-level-equivalent air) of a straight ray of length
 * `L` whose height rises linearly from `h0` to `h1`, through density exp(-h / H):
 * the integral of exp(-h(s) / H) ds = exp(-h0 / H) * L * (1 - e^-x) / x with x = (h1 - h0) / H.
 */
export function atmPath(h0: number, h1: number, L: number, H: number): number {
  const x = (h1 - h0) / H;
  // (1 - e^-x) / x is 0/0 on a level ray; its series is 1 - x/2 + x^2/6, so stopping at the
  // linear term is good to 1e-7 relative below the threshold.
  const factor = Math.abs(x) < 1e-3 ? 1 - x / 2 : (1 - Math.exp(-x)) / x;
  return Math.exp(-h0 / H) * L * factor;
}

/**
 * Per-channel transmittance T = exp(-strength * (betaR * dR + betaM * dM)) along the ray, where
 * dR and dM are the Rayleigh and Mie density-weighted paths. `strength` 1 is the physical value.
 */
export function transmittance(h0: number, h1: number, L: number, strength: number): RGB {
  const dR = atmPath(h0, h1, L, H_R);
  const dM = atmPath(h0, h1, L, H_M);
  const mie = BETA_M0 * dM;
  return [
    Math.exp(-strength * (BETA_R0[0] * dR + mie)),
    Math.exp(-strength * (BETA_R0[1] * dR + mie)),
    Math.exp(-strength * (BETA_R0[2] * dR + mie))
  ];
}

/** Aerial perspective: the surface colour attenuated by T plus airlight scattered in (1 - T). */
export function applyAtmosphere(c: RGB, airlight: RGB, T: RGB): RGB {
  return [
    c[0] * T[0] + airlight[0] * (1 - T[0]),
    c[1] * T[1] + airlight[1] * (1 - T[1]),
    c[2] * T[2] + airlight[2] * (1 - T[2])
  ];
}

/** Cornette-Shanks phase function, normalised over the sphere (integrates to 1 over 4 pi). */
export function cornetteShanks(cosT: number, g: number = MIE_G): number {
  const g2 = g * g;
  return (
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + cosT * cosT))) /
    ((2 + g2) * Math.pow(1 + g2 - 2 * g * cosT, 1.5))
  );
}

/** Rayleigh phase function, normalised over the sphere. */
export function rayleighPhase(cosT: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosT * cosT);
}

// ---- Generated shader constants ----------------------------------------------------------

/** A float literal both WGSL and GLSL accept: always has a decimal point (`8000.0`, `5.8e-6`). */
function floatLiteral(value: number): string {
  const text = String(value);
  if (/e/i.test(text)) {
    const [mantissa, exponent] = text.split(/e/i);
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`;
  }
  return text.includes('.') ? text : `${text}.0`;
}

const betaR = BETA_R0.map(floatLiteral).join(', ');

/** WGSL `const` declarations of the constants above (prefix LK_), for embedding in a snippet. */
export const ATMOSPHERE_WGSL_CONSTANTS = `const LK_BETA_R0: vec3<f32> = vec3<f32>(${betaR});
const LK_BETA_M0: f32 = ${floatLiteral(BETA_M0)};
const LK_H_R: f32 = ${floatLiteral(H_R)};
const LK_H_M: f32 = ${floatLiteral(H_M)};
const LK_MIE_G: f32 = ${floatLiteral(MIE_G)};
`;

/** GLSL ES 3.00 `const` declarations of the same constants. */
export const ATMOSPHERE_GLSL_CONSTANTS = `const vec3 LK_BETA_R0 = vec3(${betaR});
const float LK_BETA_M0 = ${floatLiteral(BETA_M0)};
const float LK_H_R = ${floatLiteral(H_R)};
const float LK_H_M = ${floatLiteral(H_M)};
const float LK_MIE_G = ${floatLiteral(MIE_G)};
`;
