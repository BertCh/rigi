// WebGPU port of the world view's sky (deck/world-view.ts AtmSkyLayer + engine.ts's flat
// `canvas.style.backgroundColor = ws.sky`) and of the physical aerial perspective
// (look/glsl/atmosphere.ts ATMOSPHERE_FNS, LOOK_ATMOSPHERE) for the terrain colour pass.
//
//   atmosphereModule   luma ShaderModule `atmosphere` (bind group 0): the ATM_BLOCK values as a
//                      WGSL uniform struct with an explicit 16-byte layout, plus the functions
//                        atm_apply(colLinear, enu) -> vec3   terrain colour → hazed (applyAtmosphere)
//                        atm_sky(dir) -> vec3                 analytic sky radiance (atmSky)
//                      Line-for-line port of ATMOSPHERE_FNS; values from look/atmosphere.ts
//                      atmosphereValues() (the same AtmValues the WebGL layers take).
//   AtmSkyCore         colour-pass core, order 90 (drawn LAST): a full-screen triangle at
//                      clip.z = 0 with depthCompare greater-equal and no depth write, so with the
//                      reversed-Z clear of 0 it shades only pixels no surface covered. The WebGL
//                      layer drew the sky FIRST under everything; to keep that result for
//                      translucent layers drawn earlier over the sky (trails, splat fringes, the
//                      gizmo's photo plane) the sky blends UNDER the premultiplied target
//                      (src·(1 − dst.a) + dst). The ray is camera_ray(ndc) (replaces skyRayMatrix).
//                      World view only: in the photo view the sky stays transparent (0,0,0,0)
//                      for the compositor. world.sky.mode 'flat' (or no atmosphere values) draws
//                      the flat style.world.sky.background colour (WORLD_SKY #a9c2da), linearised
//                      exactly so the present / composite sRGB encode gives the CSS colour back.
//   atmosphereFogPart  the FOG_ATMOSPHERE terrain plugin (TerrainShaderPart): replaces the classic
//                      fog_apply(col, range) haze with atm_apply(col, s.enu) (WebGL:
//                      `#ifdef LOOK_ATMOSPHERE applyAtmosphere(base, vWorld)`). It sets
//                      TERRAIN_NO_FOG, so terrain.ts skips fog_apply, and applies the atmosphere
//                      itself; add it as the LAST plugin (after drape / truth, the WebGL order).
//
// Wiring (assembler, lab / engine):
//   const sky = new AtmSkyCore();                        // cores list, any position (order 90)
//   sky.setSky({ mode: style.world.sky.mode, atm: look("world").atm,
//                flatColor: style.world.sky.background });
//   sky.setView(view);                                   // "photo" | "world" (frame.view is also checked)
//   // LOOK_ATMOSPHERE terrain styles (deckTerrainStyle(...).defines includes "LOOK_ATMOSPHERE"):
//   terrain.setShaderParts(shading, [...plugins, atmosphereFogPart(() => look(mode).atm)]);
// atm.eye is ignored: both the sky and the fog use the pass camera's eye (ctx.camera.eye), as the
// WebGL layers used viewport.cameraPosition.
import type { RenderPipelineParameters } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { ATM_CURV, type AtmValues } from "#/lib/look/atmosphere";
import { NEBELMEER_WGSL } from "#/lib/look/nebelmeer";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
	targetKey,
} from "../pass";
import type { TerrainShaderPart } from "../terrain";
import { fullscreenWGSL } from "../wgsl";

/** engine.ts renderWorld's scene.background (deck/world-view.ts WORLD_SKY; style default). */
export const WORLD_SKY = "#a9c2da";

type V3 = [number, number, number];

// ---------- the atmosphere uniform module (ATM_BLOCK) ----------

/** WGSL layout of ATM_BLOCK: each vec3 shares its 16-byte slot with a scalar (no std140 vec4 trap). */
export type AtmosphereUniforms = {
	eye: V3;
	strength: number;
	betaR: V3;
	betaM: number;
	sunDir: V3;
	mieG: number;
	sunColor: V3;
	airlightMix: number;
	airlight: V3;
	pad0: number;
	h: [number, number];
	pad1: number;
	pad2: number;
	nebelColor: V3;
	nebelTop: number;
	nebelDensity: number;
	nebelFalloff: number;
	pad3: number;
	pad4: number;
};

/** AtmValues (look/atmosphere.ts atmosphereValues) → the `atmosphere` module's props. */
export function atmosphereUniforms(
	atm: AtmValues,
	eye: readonly number[],
): AtmosphereUniforms {
	const v3 = (a: readonly number[]): V3 => [a[0], a[1], a[2]];
	return {
		eye: v3(eye),
		strength: atm.strength,
		betaR: v3(atm.betaR),
		betaM: atm.betaM,
		sunDir: v3(atm.sunDir),
		mieG: atm.mieG,
		sunColor: v3(atm.sunColor),
		airlightMix: atm.airlightMix,
		airlight: v3(atm.airlight),
		pad0: 0,
		h: [atm.h[0], atm.h[1]],
		pad1: 0,
		pad2: 0,
		// density 0 (absent) = no Nebelmeer: atm_nebelmeer is the identity
		nebelColor: v3(atm.nebelColor ?? [0, 0, 0]),
		nebelTop: atm.nebel?.[0] ?? 0,
		nebelDensity: atm.nebel?.[1] ?? 0,
		nebelFalloff: atm.nebel?.[2] ?? 0,
		pad3: 0,
		pad4: 0,
	};
}

/** strength 0: transmittance 1 everywhere, i.e. atm_apply is the identity. */
const NEUTRAL_ATM: AtmValues = {
	eye: [0, 0, 0],
	betaR: [5.8e-6, 13.5e-6, 33.1e-6],
	sunDir: [0, 0, 1],
	sunColor: [1, 1, 1],
	airlight: [0.62, 0.7, 0.8],
	h: [8000, 1200],
	betaM: 21e-6,
	strength: 0,
	mieG: 0.76,
	airlightMix: 0,
};

/**
 * ATMOSPHERE_FNS in WGSL (same maths, same constants). GLSL's smoothstep with edge0 > edge1 (the
 * below-horizon fade) is spelled out as atm_smoothstep: WGSL leaves low ≥ high undefined.
 */
export const ATMOSPHERE_WGSL = /* wgsl */ `\
${NEBELMEER_WGSL}
struct AtmosphereUniforms {
  eye: vec3<f32>,
  strength: f32,
  betaR: vec3<f32>,
  betaM: f32,
  sunDir: vec3<f32>,
  mieG: f32,
  sunColor: vec3<f32>,
  airlightMix: f32,
  airlight: vec3<f32>,
  pad0: f32,
  h: vec2<f32>,
  pad1: f32,
  pad2: f32,
  nebelColor: vec3<f32>,
  nebelTop: f32,
  nebelDensity: f32,
  nebelFalloff: f32,
  pad3: f32,
  pad4: f32,
};
@group(0) @binding(auto) var<uniform> atmosphere: AtmosphereUniforms;

const ATM_CURV: f32 = ${ATM_CURV.toExponential(9)};

fn atm_smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn atm_altitude(p: vec3<f32>) -> f32 {
  return p.z + dot(p.xy, p.xy) * ATM_CURV;
}

// sea-level-equivalent path length through an exponential layer of scale height H
fn atm_path(h0: f32, h1: f32, L: f32, H: f32) -> f32 {
  let x = (h1 - h0) / H;
  var f: f32;
  if (abs(x) < 1e-3) { f = 1.0 - 0.5 * x; } else { f = (1.0 - exp(-x)) / x; }
  return exp(-h0 / H) * L * f;
}

fn atm_transmittance(worldPos: vec3<f32>) -> vec3<f32> {
  let L = length(worldPos - atmosphere.eye);
  let h0 = atm_altitude(atmosphere.eye);
  let h1 = atm_altitude(worldPos);
  let dR = atm_path(h0, h1, L, atmosphere.h.x);
  let dM = atm_path(h0, h1, L, atmosphere.h.y);
  return exp(-atmosphere.strength * (atmosphere.betaR * dR + vec3<f32>(atmosphere.betaM * dM)));
}

// phase functions normalised so an isotropic scatterer is 1 (i.e. ×4π)
fn atm_phase_r(c: f32) -> f32 {
  return 0.75 * (1.0 + c * c);
}
fn atm_phase_m(c: f32) -> f32 {
  let g = atmosphere.mieG;
  let g2 = g * g;
  let p = 1.5 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  return min(p, 40.0);
}

// physically derived airlight: single scattering of the sun, weighted by the local Rayleigh /
// Mie mix at the eye, plus a multiple-scattering ambient from the blue sky dome
fn atm_phys_airlight(viewDir: vec3<f32>) -> vec3<f32> {
  let c = dot(viewDir, atmosphere.sunDir);
  let h0 = atm_altitude(atmosphere.eye);
  let bR = atmosphere.betaR * exp(-h0 / atmosphere.h.x);
  let bM = atmosphere.betaM * exp(-h0 / atmosphere.h.y);
  let bExt = bR + vec3<f32>(bM);
  // Mie single-scatter albedo ~0.9
  let single = (bR * atm_phase_r(c) + vec3<f32>(0.9 * bM * atm_phase_m(c))) / max(bExt, vec3<f32>(1e-9));
  let day = smoothstep(-0.12, 0.25, atmosphere.sunDir.z);
  let skyAmb = vec3<f32>(0.30, 0.40, 0.56) * (0.25 + 0.75 * day);
  // more Mie → whiter, brighter veil
  let mieFrac = bM / max(bM + bR.g, 1e-9);
  let amb = mix(skyAmb, vec3<f32>(0.62, 0.66, 0.70) * (0.3 + 0.7 * day), mieFrac);
  return 0.42 * atmosphere.sunColor * single * clamp(atmosphere.sunDir.z * 2.0 + 0.4, 0.0, 1.0) + amb;
}

fn atm_airlight(viewDir: vec3<f32>) -> vec3<f32> {
  return mix(atm_phys_airlight(viewDir), atmosphere.airlight, atmosphere.airlightMix);
}

// applyNebelmeer (look/nebelmeer): the valley-fog layer over the hazed colour; identity at density 0
fn atm_nebelmeer(col: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  if (atmosphere.nebelDensity <= 0.0) { return col; }
  let T = nebel_ray_t(length(worldPos - atmosphere.eye), atm_altitude(atmosphere.eye),
    atm_altitude(worldPos), atmosphere.nebelDensity, atmosphere.nebelTop, atmosphere.nebelFalloff);
  return mix(atmosphere.nebelColor, col, T);
}

// applyAtmosphere: linear in, linear out
fn atm_apply(colLinear: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
  let T = atm_transmittance(worldPos);
  return atm_nebelmeer(colLinear * T + atm_airlight(normalize(worldPos - atmosphere.eye)) * (1.0 - T), worldPos);
}

// Preetham-like analytic sky (atmSky): zenith→horizon gradient keyed to sun height, with a Mie
// aureole and a warm horizon band toward a low sun. The horizon converges on the airlight, so
// terrain fades seamlessly into the sky.
fn atm_sky(dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let s = normalize(atmosphere.sunDir);
  let c = dot(d, s);
  let el = d.z;
  let day = smoothstep(-0.12, 0.3, s.z);
  let horizon = atm_airlight(normalize(vec3<f32>(d.xy, 0.0) + vec3<f32>(0.0, 0.0, 1e-4)));
  // turbid skies are paler at the zenith
  let h0 = atm_altitude(atmosphere.eye);
  let turb = clamp(atmosphere.strength * atmosphere.betaM * exp(-h0 / atmosphere.h.y) / 4e-5, 0.0, 1.0);
  let zenith = mix(vec3<f32>(0.10, 0.22, 0.55), vec3<f32>(0.32, 0.42, 0.58), turb * 0.6) * (0.08 + 0.92 * day);
  let t = pow(1.0 - clamp(el, 0.0, 1.0), 3.5 + 2.0 * (1.0 - turb));
  var sky = mix(zenith, horizon, t);
  // aureole and sun-side brightening
  let aureole = atm_phase_m(c) * 0.012 * (0.4 + turb);
  sky += atmosphere.sunColor * aureole * smoothstep(-0.1, 0.05, el);
  // low sun: warm band toward the sun's azimuth
  let low = 1.0 - smoothstep(0.0, 0.35, s.z);
  let toward = pow(max(0.5 + 0.5 * dot(normalize(d.xy + vec2<f32>(1e-5)), normalize(s.xy + vec2<f32>(1e-5))), 0.0), 4.0);
  sky = mix(sky, atmosphere.sunColor * vec3<f32>(1.0, 0.72, 0.45) * (0.6 + 0.4 * day), low * toward * t * 0.55);
  // below the horizon: haze over ground
  if (el < 0.0) { sky = mix(horizon, horizon * 0.8, atm_smoothstep(0.0, -0.3, el)); }
  return sky;
}
`;

export const atmosphereModule = {
	name: "atmosphere",
	source: ATMOSPHERE_WGSL,
	uniformTypes: {
		eye: "vec3<f32>",
		strength: "f32",
		betaR: "vec3<f32>",
		betaM: "f32",
		sunDir: "vec3<f32>",
		mieG: "f32",
		sunColor: "vec3<f32>",
		airlightMix: "f32",
		airlight: "vec3<f32>",
		pad0: "f32",
		h: "vec2<f32>",
		pad1: "f32",
		pad2: "f32",
		nebelColor: "vec3<f32>",
		nebelTop: "f32",
		nebelDensity: "f32",
		nebelFalloff: "f32",
		pad3: "f32",
		pad4: "f32",
	},
	bindingLayout: [{ name: "atmosphere", group: 0 }],
} as const satisfies ShaderModule;

// ---------- the sky core (SKY_BLOCK / SKY_VS / SKY_FS) ----------

/** mode 0 = flat colour, 1 = atmSky. */
const skyModule = {
	name: "sky",
	source: /* wgsl */ `\
struct SkyUniforms {
  flatColor: vec3<f32>,
  mode: f32,
};
@group(0) @binding(auto) var<uniform> sky: SkyUniforms;
`,
	uniformTypes: { flatColor: "vec3<f32>", mode: "f32" },
	bindingLayout: [{ name: "sky", group: 0 }],
} as const satisfies ShaderModule;

const SKY_WGSL = /* wgsl */ `\
${fullscreenWGSL}
@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  if (sky.mode < 0.5) { return vec4<f32>(sky.flatColor, 1.0); }
  return vec4<f32>(atm_sky(camera_ray(v.ndc)), 1.0);
}
`;

/**
 * Colour-pass state: test-only reversed-Z (the triangle sits at depth 0, so only never-covered
 * samples pass) and "under" blending into the premultiplied target, which equals drawing the
 * opaque sky first (the WebGL order) whatever translucent layers drew earlier.
 */
export const skyParameters = (): RenderPipelineParameters => ({
	// built per Model, not once at load: passModelProps carries the colour pass's current
	// sampleCount (4× MSAA, or 1× in the interactive mode), and a frozen copy would pin 4×
	...passModelProps("color", { depth: "test" }).parameters,
	blend: true,
	blendColorOperation: "add",
	blendColorSrcFactor: "one-minus-dst-alpha",
	blendColorDstFactor: "one",
	blendAlphaOperation: "add",
	blendAlphaSrcFactor: "one-minus-dst-alpha",
	blendAlphaDstFactor: "one",
});

export type AtmSkyProps = {
	/** style.world.sky.mode. */
	mode: "flat" | "atmosphere";
	/** deckTerrainStyle(style, "world", ...).atm; null falls back to the flat colour (WebGL). */
	atm: AtmValues | null;
	/** style.world.sky.background (displayed sRGB hex); default WORLD_SKY. */
	flatColor?: string;
};

/**
 * Displayed sRGB colour → linear RGB (exact sRGB curve: the present / composite pass inverts it).
 * Accepts '#rgb' / '#rrggbb[aa]' and CSS 'rgb(r, g, b)' / 'rgba(r, g, b, a)' (deckWorldStyle().sky
 * is a CSS rgb() string); anything unparseable falls back to WORLD_SKY instead of a NaN sky.
 */
export function hexToLinear(hex: string): V3 {
	const dec = (v: number) => {
		const c = Math.min(255, Math.max(0, v)) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const rgb = /^\s*rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(hex);
	if (rgb) return [dec(+rgb[1]), dec(+rgb[2]), dec(+rgb[3])];
	const h = hex.trim().replace("#", "");
	if (!/^[0-9a-f]{3,8}$/i.test(h))
		return hex === WORLD_SKY ? [0.4, 0.54, 0.7] : hexToLinear(WORLD_SKY);
	return hexDigitsToLinear(h, dec);
}

function hexDigitsToLinear(h: string, dec: (v: number) => number): V3 {
	const n = Number.parseInt(
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h.slice(0, 6),
		16,
	);
	return [dec((n >> 16) & 255), dec((n >> 8) & 255), dec(n & 255)];
}

export class AtmSkyCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	/** Last in the colour pass: after every surface and overlay (see skyParameters). */
	readonly order = 90;
	private models = new ModelCache();
	private props: AtmSkyProps = { mode: "flat", atm: null };
	private flatLinear: V3 = hexToLinear(WORLD_SKY);
	/** The view the next frames render (null = rely on ctx.frame.view alone). */
	private view: "photo" | "world" | null = null;
	enabled = true;

	constructor(readonly id = "world-sky") {}

	setSky(p: AtmSkyProps) {
		this.props = p;
		this.flatLinear = hexToLinear(p.flatColor ?? WORLD_SKY);
	}

	/** The sky exists in the world view only; the photo view's sky stays transparent. */
	setView(view: "photo" | "world") {
		this.view = view;
	}

	/** True when the atmospheric sky (not the flat colour) is drawn. */
	get atmospheric() {
		return this.props.mode === "atmosphere" && !!this.props.atm;
	}

	visible() {
		return this.enabled && this.view !== "photo";
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "color" || ctx.frame.view !== "world") return;
		const model = this.models.get(
			targetKey(ctx),
			() =>
				new Model(ctx.device, {
					id: `${this.id}-model`,
					source: SKY_WGSL,
					vertexEntryPoint: "fullscreenVertex",
					fragmentEntryPoint: "fragmentMain",
					modules: [cameraModule, atmosphereModule, skyModule] as never,
					...passModelProps("color", { depth: "test" }),
					parameters: skyParameters(),
					topology: "triangle-list",
					vertexCount: 3,
				} as never),
		);
		const atm = this.atmospheric ? (this.props.atm as AtmValues) : NEUTRAL_ATM;
		model.shaderInputs.setProps({
			camera: ctx.camera,
			atmosphere: atmosphereUniforms(atm, ctx.camera.eye),
			sky: { flatColor: this.flatLinear, mode: this.atmospheric ? 1 : 0 },
		} as never);
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
	}
}

/** Factory for the assembler (see the wiring note at the top). */
export function createAtmSky(p?: AtmSkyProps & { view?: "photo" | "world" }) {
	const core = new AtmSkyCore();
	if (p) core.setSky(p);
	if (p?.view) core.setView(p.view);
	return core;
}

// ---------- FOG_ATMOSPHERE: the terrain's physical aerial perspective ----------

/** Define name the fog part sets (plus TERRAIN_NO_FOG, which makes terrain.ts skip fog_apply). */
export const FOG_ATMOSPHERE = "FOG_ATMOSPHERE";

/**
 * The plugin body: applyAtmosphere on the (premultiplied) terrain colour at the fragment's ENU
 * position. For a = 1 this is exactly the WebGL `applyAtmosphere(base, vWorld)`; translucent
 * shadings (premultiplied contours) get the airlight scaled by their coverage.
 */
export const FOG_ATMOSPHERE_WGSL = /* wgsl */ `\
fn atm_fog_terrain(c: vec4<f32>, s: TerrainSample) -> vec4<f32> {
  let T = atm_transmittance(s.enu);
  let air = atm_airlight(normalize(s.enu - atmosphere.eye));
  // premultiplied: the fog colour is scaled by the coverage like the airlight
  let hazed = c.rgb * T + air * (1.0 - T) * c.a;
  if (atmosphere.nebelDensity <= 0.0) { return vec4<f32>(hazed, c.a); }
  let N = nebel_ray_t(length(s.enu - atmosphere.eye), atm_altitude(atmosphere.eye),
    atm_altitude(s.enu), atmosphere.nebelDensity, atmosphere.nebelTop, atmosphere.nebelFalloff);
  return vec4<f32>(hazed * N + atmosphere.nebelColor * (1.0 - N) * c.a, c.a);
}
`;

/**
 * FOG_ATMOSPHERE as a terrain plugin (terrain.setShaderParts(shading, [...others, this])): the
 * LOOK_ATMOSPHERE haze in place of fog_apply. `getAtm` returns the current look's AtmValues
 * (deckTerrainStyle(...).atm); null → no haze (strength 0).
 */
export function atmosphereFogPart(
	getAtm: () => AtmValues | null,
): TerrainShaderPart {
	return {
		key: "fog-atmosphere",
		wgsl: FOG_ATMOSPHERE_WGSL,
		modules: [atmosphereModule as unknown as ShaderModule],
		defines: { TERRAIN_NO_FOG: true, [FOG_ATMOSPHERE]: true },
		apply: "atm_fog_terrain",
		props: (ctx) => ({
			uniforms: {
				atmosphere: atmosphereUniforms(getAtm() ?? NEUTRAL_ATM, ctx.camera.eye),
			},
		}),
	};
}
