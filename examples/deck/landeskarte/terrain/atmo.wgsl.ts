// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Aerial perspective and the panorama grade (WGSL). Pure functions: no textures, no uniforms, no
// derivatives; every input is a parameter, so the terrain fragment and the sky dome share one
// implementation. Heights are metres above sea level, directions are unit ENU vectors.
//
// Model: homogeneous single scattering per path, Rayleigh (H_R) and Mie (H_M) with exponential
// density. Transmittance T = exp(-strength (beta_R dR + beta_M dM)) and the airlight is the colour
// an infinitely thick atmosphere would show along the ray, so  C T + A (1 - T)  fades the surface
// into exactly the colour the sky dome paints at that direction. "Physically inspired", not exact:
// no ozone, no multiple scattering (the sky dome fakes that with a density gain).

import {ATMOSPHERE_WGSL_CONSTANTS} from '../geo/atmosphere';

export const ATMO_WGSL = /* wgsl */ `
${ATMOSPHERE_WGSL_CONSTANTS}

// Display weights for the grade; one place so the plan and panorama grades stay comparable.
const LK_SUN_GAIN: f32 = 0.78;
const LK_FILL_GAIN: f32 = 0.62;

// Optical path of an exponential atmosphere along a straight segment of length L from height h0 to
// h1: integral of exp(-h/H) ds = exp(-h0/H) L (1 - e^-x) / x with x = (h1 - h0) / H.
fn lk_atmPath(h0: f32, h1: f32, pathLength: f32, scaleHeight: f32) -> f32 {
  let x = (h1 - h0) / scaleHeight;
  var factor = 1.0 - 0.5 * x;
  if (abs(x) >= 1e-3) {
    factor = (1.0 - exp(-x)) / x;
  }
  return exp(-h0 / scaleHeight) * pathLength * factor;
}

// Relative phase functions (1 = isotropic), so they scale the airlight directly.
fn lk_phaseRayleigh(cosTheta: f32) -> f32 {
  return 0.75 * (1.0 + cosTheta * cosTheta);
}

// Cornette-Shanks times 4 pi. The forward peak is capped: without multiple scattering and a real
// tone curve an uncapped g = 0.76 lobe would clip a wide white disc around the sun.
fn lk_phaseMie(cosTheta: f32) -> f32 {
  let g2 = LK_MIE_G * LK_MIE_G;
  let denominator = pow(1.0 + g2 - 2.0 * LK_MIE_G * cosTheta, 1.5);
  let phase = 1.5 * (1.0 - g2) * (1.0 + cosTheta * cosTheta) / ((2.0 + g2) * denominator);
  return min(phase, 16.0);
}

// Kasten-Young (1989) relative air mass, same fit as sun.ts, for a view elevation given as
// sin(elevation), clamped to the horizon (the dome below it repeats the horizon colour).
fn lk_viewAirMass(sinElevation: f32) -> f32 {
  let s = clamp(sinElevation, 0.0, 1.0);
  let elevationDeg = degrees(asin(s));
  return 1.0 / (s + 0.50572 * pow(elevationDeg + 6.07995, -1.6364));
}

// Light that scatters towards the eye. Sunlight is warm and bright near the sun's side of the sky,
// and the far side is lit by light that crossed less air, so it is neutral. Below the horizon the
// sun goes out over a few degrees and a faint twilight glow remains. sunColor is the already
// extinguished direct colour from the sun table.
fn lk_illumination(sunColor: vec3<f32>, sunUp: f32, cosTheta: f32) -> vec3<f32> {
  let visibility = smoothstep(-0.09, 0.05, sunUp);
  let luminance = dot(sunColor, vec3<f32>(0.2126, 0.7152, 0.0722));
  let toward = pow(clamp(0.5 + 0.5 * cosTheta, 0.0, 1.0), 3.0);
  let direct = mix(vec3<f32>(luminance), sunColor, 0.3 + 0.7 * toward) * visibility;
  let twilight = vec3<f32>(0.020, 0.030, 0.065) * smoothstep(-0.35, 0.0, sunUp);
  return direct + twilight;
}

// Colour of an infinitely thick atmosphere along a ray whose Rayleigh and Mie paths are dR and dM:
// sum(beta phase) / sum(beta) per channel times the illumination, with a soft shoulder so a
// forward-scatter peak rolls off instead of clipping.
fn lk_airlight(
  pathRayleigh: f32,
  pathMie: f32,
  cosTheta: f32,
  illumination: vec3<f32>
) -> vec3<f32> {
  let betaRayleigh = LK_BETA_R0 * pathRayleigh;
  let betaMie = vec3<f32>(LK_BETA_M0 * pathMie);
  let scattered = betaRayleigh * lk_phaseRayleigh(cosTheta) + betaMie * lk_phaseMie(cosTheta);
  let ratio = scattered / max(betaRayleigh + betaMie, vec3<f32>(1e-12));
  return vec3<f32>(1.0) - exp(-1.6 * ratio * illumination);
}

// Aerial perspective for a surface point seen from the eye. viewDir points from the eye to the
// fragment. strength 0 returns the colour untouched (plan mode), 1 is the physical single scatter.
fn lk_atmosphere(
  color: vec3<f32>,
  eyeH: f32,
  fragH: f32,
  distM: f32,
  viewDir: vec3<f32>,
  sunDir: vec3<f32>,
  sunColor: vec3<f32>,
  strength: f32
) -> vec3<f32> {
  let pathRayleigh = lk_atmPath(eyeH, fragH, distM, LK_H_R);
  let pathMie = lk_atmPath(eyeH, fragH, distM, LK_H_M);
  let transmittance = exp(-strength * (LK_BETA_R0 * pathRayleigh + vec3<f32>(LK_BETA_M0 * pathMie)));
  let cosTheta = dot(viewDir, sunDir);
  let airlight = lk_airlight(pathRayleigh, pathMie, cosTheta, lk_illumination(sunColor, sunDir.z, cosTheta));
  return color * transmittance + airlight * (vec3<f32>(1.0) - transmittance);
}

// Sky radiance along a view direction from an eye at eyeH metres: the airlight of the whole
// atmosphere above the eye, plus the sun disc. The haze strength is floored at 0.25 so the haze
// slider can thin the terrain without blacking out the sky. skyGain stands in for multiple scattering, which
// single scatter lacks and which is most of why a real sky is brighter than 1 - T suggests.
fn lk_sky(
  viewDir: vec3<f32>,
  eyeH: f32,
  sunDir: vec3<f32>,
  sunColor: vec3<f32>,
  strength: f32,
  skyGain: f32
) -> vec3<f32> {
  let airMass = lk_viewAirMass(viewDir.z);
  let pathRayleigh = LK_H_R * exp(-eyeH / LK_H_R) * airMass;
  let pathMie = LK_H_M * exp(-eyeH / LK_H_M) * airMass;
  let transmittance = exp(-max(strength, 0.25) * skyGain * (LK_BETA_R0 * pathRayleigh + vec3<f32>(LK_BETA_M0 * pathMie)));
  let cosTheta = dot(viewDir, sunDir);
  let illumination = lk_illumination(sunColor, sunDir.z, cosTheta);
  var sky = lk_airlight(pathRayleigh, pathMie, cosTheta, illumination) * (vec3<f32>(1.0) - transmittance);
  // Sun disc, about 0.5 degrees across, only above the horizon and when the sun is up.
  let disc = smoothstep(0.999955, 0.999990, cosTheta) * smoothstep(-0.02, 0.01, sunDir.z) * step(0.0, viewDir.z);
  sky += sunColor * (6.0 * disc);
  return clamp(sky, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Panorama grade. nDotL is signed: the lit side takes the sun's colour, the shaded side a cool
// fill that leans towards the complement of the sun's hue (Berann's warm/cool pairing), scaled by
// the sky-view factor. shadow is the cast-shadow lookup (1 lit). In plan (panoramaMix 0) the
// relief snippet already carries the fixed NW light, so the colour passes through unchanged.
// screenY01 is 0 at the top of the canvas, 1 at the bottom.
fn lk_grade(
  color: vec3<f32>,
  nDotL: f32,
  shadow: f32,
  ambient: f32,
  sunColor: vec3<f32>,
  skyColor: vec3<f32>,
  panoramaMix: f32,
  screenY01: f32
) -> vec3<f32> {
  let lit = shadow * smoothstep(-0.02, 0.18, nDotL);
  let sunPeak = max(max(sunColor.r, sunColor.g), max(sunColor.b, 1e-4));
  let sunTrough = min(min(sunColor.r, sunColor.g), sunColor.b);
  let complement = vec3<f32>(sunPeak + sunTrough) / sunPeak - sunColor / sunPeak;
  let shadeTint = mix(skyColor, complement * dot(skyColor, vec3<f32>(0.3333)) / max(dot(complement, vec3<f32>(0.3333)), 1e-4), 0.35);
  let light = LK_SUN_GAIN * sunColor * lit + LK_FILL_GAIN * ambient * shadeTint;
  // The bottom 22 % of the frame darkens so the foreground sits down and the skyline leads.
  let foreground = 1.0 - 0.28 * smoothstep(0.78, 1.0, screenY01);
  return mix(color, color * light * foreground, panoramaMix);
}
`;
