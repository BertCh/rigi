// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GLSL twin of atmo.wgsl.ts: same functions, same constants, same arithmetic order. Read the WGSL
// file for the model and the reasons; a change here is a change there.

import {ATMOSPHERE_GLSL_CONSTANTS} from '../geo/atmosphere';

export const ATMO_GLSL = /* glsl */ `
${ATMOSPHERE_GLSL_CONSTANTS}

const float LK_SUN_GAIN = 0.78;
const float LK_FILL_GAIN = 0.62;

float lk_atmPath(float h0, float h1, float pathLength, float scaleHeight) {
  float x = (h1 - h0) / scaleHeight;
  float factor = 1.0 - 0.5 * x;
  if (abs(x) >= 1e-3) {
    factor = (1.0 - exp(-x)) / x;
  }
  return exp(-h0 / scaleHeight) * pathLength * factor;
}

float lk_phaseRayleigh(float cosTheta) {
  return 0.75 * (1.0 + cosTheta * cosTheta);
}

float lk_phaseMie(float cosTheta) {
  float g2 = LK_MIE_G * LK_MIE_G;
  float denominator = pow(1.0 + g2 - 2.0 * LK_MIE_G * cosTheta, 1.5);
  float phase = 1.5 * (1.0 - g2) * (1.0 + cosTheta * cosTheta) / ((2.0 + g2) * denominator);
  return min(phase, 16.0);
}

float lk_viewAirMass(float sinElevation) {
  float s = clamp(sinElevation, 0.0, 1.0);
  float elevationDeg = degrees(asin(s));
  return 1.0 / (s + 0.50572 * pow(elevationDeg + 6.07995, -1.6364));
}

vec3 lk_illumination(vec3 sunColor, float sunUp, float cosTheta) {
  float visibility = smoothstep(-0.09, 0.05, sunUp);
  float luminance = dot(sunColor, vec3(0.2126, 0.7152, 0.0722));
  float toward = pow(clamp(0.5 + 0.5 * cosTheta, 0.0, 1.0), 3.0);
  vec3 direct = mix(vec3(luminance), sunColor, 0.3 + 0.7 * toward) * visibility;
  vec3 twilight = vec3(0.020, 0.030, 0.065) * smoothstep(-0.35, 0.0, sunUp);
  return direct + twilight;
}

vec3 lk_airlight(float pathRayleigh, float pathMie, float cosTheta, vec3 illumination) {
  vec3 betaRayleigh = LK_BETA_R0 * pathRayleigh;
  vec3 betaMie = vec3(LK_BETA_M0 * pathMie);
  vec3 scattered = betaRayleigh * lk_phaseRayleigh(cosTheta) + betaMie * lk_phaseMie(cosTheta);
  vec3 ratio = scattered / max(betaRayleigh + betaMie, vec3(1e-12));
  return vec3(1.0) - exp(-1.6 * ratio * illumination);
}

vec3 lk_atmosphere(
  vec3 color,
  float eyeH,
  float fragH,
  float distM,
  vec3 viewDir,
  vec3 sunDir,
  vec3 sunColor,
  float strength
) {
  float pathRayleigh = lk_atmPath(eyeH, fragH, distM, LK_H_R);
  float pathMie = lk_atmPath(eyeH, fragH, distM, LK_H_M);
  vec3 transmittance = exp(-strength * (LK_BETA_R0 * pathRayleigh + vec3(LK_BETA_M0 * pathMie)));
  float cosTheta = dot(viewDir, sunDir);
  vec3 airlight = lk_airlight(pathRayleigh, pathMie, cosTheta, lk_illumination(sunColor, sunDir.z, cosTheta));
  return color * transmittance + airlight * (vec3(1.0) - transmittance);
}

vec3 lk_sky(
  vec3 viewDir,
  float eyeH,
  vec3 sunDir,
  vec3 sunColor,
  float strength,
  float skyGain
) {
  float airMass = lk_viewAirMass(viewDir.z);
  float pathRayleigh = LK_H_R * exp(-eyeH / LK_H_R) * airMass;
  float pathMie = LK_H_M * exp(-eyeH / LK_H_M) * airMass;
  vec3 transmittance = exp(-max(strength, 0.25) * skyGain * (LK_BETA_R0 * pathRayleigh + vec3(LK_BETA_M0 * pathMie)));
  float cosTheta = dot(viewDir, sunDir);
  vec3 illumination = lk_illumination(sunColor, sunDir.z, cosTheta);
  vec3 sky = lk_airlight(pathRayleigh, pathMie, cosTheta, illumination) * (vec3(1.0) - transmittance);
  float disc = smoothstep(0.999955, 0.999990, cosTheta) * smoothstep(-0.02, 0.01, sunDir.z) * step(0.0, viewDir.z);
  sky += sunColor * (6.0 * disc);
  return clamp(sky, vec3(0.0), vec3(1.0));
}

vec3 lk_grade(
  vec3 color,
  float nDotL,
  float shadow,
  float ambient,
  vec3 sunColor,
  vec3 skyColor,
  float panoramaMix,
  float screenY01
) {
  float lit = shadow * smoothstep(-0.02, 0.18, nDotL);
  float sunPeak = max(max(sunColor.r, sunColor.g), max(sunColor.b, 1e-4));
  float sunTrough = min(min(sunColor.r, sunColor.g), sunColor.b);
  vec3 complement = vec3(sunPeak + sunTrough) / sunPeak - sunColor / sunPeak;
  vec3 shadeTint = mix(skyColor, complement * dot(skyColor, vec3(0.3333)) / max(dot(complement, vec3(0.3333)), 1e-4), 0.35);
  vec3 light = LK_SUN_GAIN * sunColor * lit + LK_FILL_GAIN * ambient * shadeTint;
  float foreground = 1.0 - 0.28 * smoothstep(0.78, 1.0, screenY01);
  return mix(color, color * light * foreground, panoramaMix);
}
`;
