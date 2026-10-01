// CLASSIC: a literal transcription of today's hard-coded look (styling.md §1). Each value cites
// the line it comes from (tree as of 2026-09-25 12:55; engine.ts lines after ~690 are re-verified
// and differ from styling.md, which predates a +7-line edit there). The chunk-0 pixel diff and scripts/style-check.ts
// guard it; changing a number here changes the classic look, so don't.
import type { NebelmeerStyle, ViewStyle } from "./types";

/** Valley fog (look/nebelmeer) when a style turns it on; density 0 = off. */
export const NEBELMEER_DEFAULT: NebelmeerStyle = {
	top: 1400,
	density: 0,
	falloff: 0.01,
	color: "#dfe6ee",
};

export const CLASSIC: ViewStyle = {
	v: 1,
	terrain: {
		sun: { mode: "fixed", dir: [-0.5, -0.4, 0.75] }, // materials.ts:16 (normalised there)
		ambient: 0.25, // materials.ts:126 (0.25 * sky, sky = 0.5 + 0.5 n.z at :125)
		direct: 0.85, // materials.ts:126 (0.85 * max(n·sun, 0) at :124)
		reliefRamp: "hypso-classic", // materials.ts:92–105
		rampRange: { mode: "local" }, // engine.ts:372–381 (local min/max within 25 km, ≥ 500 m)
		hazeColor: "#b9cde0", // materials.ts:26 (0xb9cde0, double-linearised by :131)
		hazeDensity: 0.000018, // materials.ts:130
		hazeMax: 0.85, // materials.ts:131
		atmosphere: { mode: "classic" }, // new look features: off (lookKey sets no define)
		relief: { mode: "lambert" },
		albedo: { mode: "ramp" },
	},
	overlay: {
		contours: {
			kind: "plain",
			color: { mode: "ramp", ramp: "cool" }, // materials.ts:161–162
			width: 1.2, // materials.ts:19
			majorEvery: 5, // materials.ts:18
			majorWidthMul: 1.8, // materials.ts:160
			minorAlpha: 0.45, // materials.ts:165
			majorAlpha: 0.95, // materials.ts:165
			densityFade: [0.08, 0.2, 0.1, 0.25], // materials.ts:156, :159
			distFade: { near: 4000, far: 25000, floor: 0.3 }, // materials.ts:20–21, :165
			casing: {
				on: true, // materials.ts:174–176
				color: [0.02, 0.03, 0.06], // materials.ts:175
				extraPx: 2, // materials.ts:174 (width + 2.0)
				minorMul: 0.45, // materials.ts:174
				alpha: 0.55, // materials.ts:176
			},
		},
		bands: {
			ramp: "cool", // materials.ts:169
			lines: "contours", // band boundaries share the contour uniforms
			shadeMin: 0.55, // materials.ts:169 (0.55 + 0.45 * shade)
			lineWhiten: 0.8, // materials.ts:171 (a * 0.8)
			lineColor: "#ffffff", // materials.ts:171 (vec3(1.0))
			alpha: 0.55, // materials.ts:171 (0.55 + 0.4 * a)
			lineAlpha: 0.4, // materials.ts:171
			groundFade: [60, 450], // materials.ts:171 smoothstep(60.0, 450.0, range)
		},
		ridges: {
			inner: [1, 0.95, 0.85], // engine.ts:148
			skyline: [1, 0.45, 0.25], // engine.ts:148
			gain: 0.9, // engine.ts:149 (uRidges * 0.9)
			threshold: [0.12, 0.45], // engine.ts:139
		},
		depthTint: {
			ramp: "turbo", // engine.ts:107–118, :145
			nearM: 200, // engine.ts:144
			farM: 80000, // engine.ts:144
			gain: 0.75, // engine.ts:145 (uDepthTint * 0.75)
			lumaKeep: [0.35, 0.65], // engine.ts:145 (0.35 + 0.65 * luma * 1.4)
		},
		slope: {
			alpha: 0.5, // only drawn by the 'slope' layer
			colors: [
				[0.98, 0.86, 0.18],
				[0.97, 0.55, 0.12],
				[0.88, 0.16, 0.16],
				[0.55, 0.22, 0.7],
			], // look/glsl/ramps.ts slopeClass (FATMAP)
		},
	},
	replace: {
		haze: 0.6, // engine.ts:706
		imagery: {
			saturation: 1,
			brightness: 1,
			contrast: 1,
			tint: "#ffffff",
			tintAmount: 0,
		}, // materials.ts:183–184 (raw texture)
		bands: "overlay", // engine.ts:701 (replace-bands renders STYLE.elevation with the same uniforms)
		ridges: { inner: [1, 0.95, 0.85], gain: 0.5 }, // engine.ts:167
		hairline: { color: "#ffffff", alpha: 0.6 }, // engine.ts:166
	},
	world: {
		haze: 0.5, // engine.ts:872
		imagery: {
			saturation: 1,
			brightness: 1,
			contrast: 1,
			tint: "#ffffff",
			tintAmount: 0,
		}, // materials.ts:183–184
		sky: { mode: "flat", clear: "#9fb8d0", background: "#a9c2da" }, // engine.ts:883, :884
		frame: {
			planeOpacity: 0.95, // engine.ts:792, :846
			lineColor: "#ffffff", // engine.ts:805
			lineOpacity: 0.9, // engine.ts:805
			pinColor: "#ff5533", // engine.ts:811
			pinRadiusM: 18, // engine.ts:811
		},
		projectionTint: { color: [1, 0.85, 0.6], amount: 0 }, // materials.ts:208, :34 (uPhotoTint always 0)
		drapeHarmonize: 0,
		clearAir: { mode: "fitted", amount: 0.85, floor: 0.3 },
		weather: { mode: "off" },
	},
	composite: {
		refine: false,
		harmonize: 0,
		ridges: "classic",
		// unused while ridges = 'classic'; the photo-matched warm ink (the former studio's WARM_INK / WARM_SKY)
		ink: {
			strength: 0.6,
			width: 1,
			crease: 0,
			inner: [1, 0.95, 0.86],
			skyline: [1, 0.56, 0.36],
		},
		sky: "dem",
		output: "classic",
	},
	trails: {
		width: 2.2, // engine.ts:462
		opacity: 0.95, // engine.ts:462
		colors: {
			hiking: [1.0, 0.82, 0.25], // engine.ts:424
			mountain: [1.0, 0.32, 0.36], // engine.ts:425–426
			alpine: [0.3, 0.67, 0.97], // engine.ts:427–429
			other: [1, 1, 1], // engine.ts:439
		},
	},
	labels: {
		layout: "classic",
		fontFamily: "Manrope, system-ui, sans-serif", // engine.ts:1175 (DOM inherits styles.css:121 --font-sans)
		name: { px: 12, weight: 600, color: "#ffffff" }, // PhotoWorkspace.tsx:483 text-[12px] font-semibold text-white
		sub: { px: 10, weight: 400, color: [1, 1, 1, 0.75], show: "ele+dist" }, // PhotoWorkspace.tsx:484–487 text-[10px] text-white/75
		halo: {
			kind: "shadow",
			color: [0, 0, 0, 0.9],
			blurPx: 3,
			offsetY: 1,
			strokePx: 0,
			adaptive: 1, // labels/contrast.ts: a stronger glow where the backdrop is bright (cloud, snow)
		}, // PhotoWorkspace.tsx:479 drop-shadow(0 1px 3px rgba(0,0,0,0.9))
		leader: { lengthPx: 28, widthPx: 1, color: [1, 1, 1, 0.9], fade: true }, // PhotoWorkspace.tsx:471–474 h-7 w-px from-white/90 to-white/0
		dot: { px: 6, color: "#ffffff", glow: [0, 0, 0, 0.6], glowPx: 6 }, // PhotoWorkspace.tsx:476 size-1.5 bg-white shadow-[0_0_6px_rgba(0,0,0,0.6)]
		maxLabels: 28, // engine.ts:919 peakLabels(max = 28)
		export: {
			scaleRef: 1400, // engine.ts:1156 (s = W / 1400)
			namePx: 15, // engine.ts:1175
			subPx: 12, // engine.ts:1177
			leaderPx: 34, // engine.ts:1162
			leaderW: 1.5, // engine.ts:1167
			dotR: 3.5, // engine.ts:1170
			haloBlur: 4, // engine.ts:1173
			haloAlpha: 0.85, // engine.ts:1172
			textGap: 16, // engine.ts:1174
			lineGap: 15, // engine.ts:1179
			subAlpha: 0.8, // engine.ts:1178
			dotShadow: false, // engine.ts:1168–1171 (dot drawn before shadowBlur is set)
		},
	},
	// Terroir layers (reports/terroir-cartography.md): all off, so classic stays pixel-identical.
	terroir: {
		names: { on: false, reach: "near", language: "local", maxLabels: 24 },
		peakTiers: false,
		subPill: false,
		contours: { adaptive: false, swissIndex: false, inkByCover: false },
		cover: { on: false, snow: "none" },
		glacier: { on: false, year: 1850, style: "outline" },
		sunPath: false,
		legend: false,
		uncertainty: false,
		placeCard: false,
		furniture: false,
	},
};
