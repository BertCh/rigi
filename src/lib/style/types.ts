// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViewStyle: how the photo views look (not per-photo interaction state, which stays in engine
// `Settings`). Pure data, renderer-agnostic: imports neither three nor deck. Design and the
// inventory each field transcribes: out/lead/deck-parity/styling.md §1–2.

/**
 * An sRGB colour: '#rrggbb' / '#rrggbbaa', or an exact 0..1 float triple / quad (rgb[a]).
 * CLASSIC uses float tuples wherever today's constant is a float (casing (0.02,0.03,0.06), ridges,
 * ramps, CSS alphas like white/75) because hex rounding would break pixel identity. The UI writes hex.
 */
export type Hex =
	| `#${string}`
	| [number, number, number]
	| [number, number, number, number];

/** `ease` applies to the segment that ends at this stop ('smooth' = smoothstep over the segment). */
export type RampStop = { t: number; c: Hex; ease?: "linear" | "smooth" };
export type Ramp =
	| { kind: "stops"; stops: RampStop[] } // 2..8 stops, t ascending in [0,1], clamped outside
	| { kind: "turbo" }; // analytic polynomial, as in engine.ts compositeFrag
export type RampName =
	| "hypso-classic"
	| "cool"
	| "turbo"
	| "swiss"
	| "grey"
	| "viridis"
	| "night"
	| "mono-ink"
	| "berann"
	| "swiss-ok"
	| "patterson";
export type RampRef = Ramp | RampName;

export type Sun =
	| { mode: "fixed"; dir: [number, number, number] } // ENU, normalised by the adapter (keeps today's vector exact)
	| { mode: "azel"; azimuthDeg: number; elevationDeg: number }
	| { mode: "photo-time" }; // look/sun.ts sunPosition(photo time); falls back to CLASSIC's fixed dir

/** Shared by the relief / hillshade surfaces in every view. */
export type TerrainLook = {
	sun: Sun;
	ambient: number;
	direct: number;
	reliefRamp: RampRef;
	rampRange: { mode: "local" } | { mode: "absolute"; lo: number; hi: number };
	/** Applied with the legacy double linearisation (THREE.Color.set + shader toLinear), see styling.md §2.3. */
	hazeColor: Hex;
	hazeDensity: number;
	hazeMax: number;
	/** 'classic' = the grey haze above; 'physical' = look/atmosphere (LOOK_ATMOSPHERE), with the airlight
	 *  derived from the sun or fitted to the photo (look/haze-fit, falls back to physical on a weak fit). */
	atmosphere:
		| { mode: "classic" }
		| {
				mode: "physical";
				strength: number;
				airlight: "physical" | "fitted";
				/** Valley fog layer (look/nebelmeer); density 0 = off. */
				nebelmeer?: NebelmeerStyle;
		  };
	/** 'lambert' = ambient/direct above; 'swiss' = multidirectional relief + cast shadow (LOOK_RELIEF).
	 *  realism: 0 cartographic NW light … 1 the photo's sun. */
	relief:
		| { mode: "lambert" }
		| { mode: "swiss"; realism: number; generalize: number; curvature: number };
	/** 'ramp' = reliefRamp; 'alpine' = absolute-elevation Patterson tint with rock, snow and lakes (LOOK_ALPINE); water: lakes get depth tint + Fresnel sky reflection (LOOK_WATER). */
	albedo: { mode: "ramp" } | { mode: "alpine"; water: boolean };
};

/** Valley-fog layer over the physical atmosphere (look/nebelmeer). */
export type NebelmeerStyle = {
	/** Altitude of the fog surface, m ASL. */
	top: number;
	/** Extinction inside the sea, 1/m (0 = off). 0.004 is about 250 m visibility. */
	density: number;
	/** Inverse metres: how fast the fog thins above `top` (0.01 = 100 m scale height). */
	falloff: number;
	/** Fog colour (display sRGB; linearised for the shaders). */
	color: Hex;
};

export type LineStyle = {
	/** 'tanaka' = illuminated contours (LOOK_TANAKA) */
	kind: "plain" | "tanaka";
	color:
		| { mode: "ramp"; ramp: RampRef }
		| { mode: "solid"; minor: Hex; major: Hex };
	width: number;
	majorEvery: number;
	majorWidthMul: number;
	minorAlpha: number;
	majorAlpha: number;
	/** minor lo, minor hi, major lo, major hi (smoothstep on fwidth) */
	densityFade: [number, number, number, number];
	distFade: { near: number; far: number; floor: number };
	casing: {
		on: boolean;
		color: Hex;
		extraPx: number;
		minorMul: number;
		alpha: number;
	};
};

/** Band boundaries drawn by the bands' own line settings instead of the contour ones. */
export type BandLines = {
	width: number;
	/** contour steps per band (band height = contour interval × every) */
	every: number;
	majorWidthMul: number;
	minorAlpha: number;
	majorAlpha: number;
};

export type BandStyle = {
	ramp: RampRef;
	/** 'contours' = boundaries follow overlay.contours (width, majorEvery, alphas), as classic */
	lines: "contours" | BandLines;
	/** bc * (shadeMin + (1 - shadeMin) * shade) */
	shadeMin: number;
	lineWhiten: number;
	lineColor: Hex;
	alpha: number;
	lineAlpha: number;
	groundFade: [number, number];
};

export type RidgeStyle = {
	inner: Hex;
	skyline: Hex;
	gain: number;
	threshold: [number, number];
};

export type ImageryAdjust = {
	saturation: number;
	brightness: number;
	contrast: number;
	tint: Hex;
	tintAmount: number;
};

export type OverlayStyle = {
	contours: LineStyle;
	bands: BandStyle;
	ridges: RidgeStyle;
	/** lumaKeep = [a, b] in turbo * (a + b * luma * 1.4); the 1.4 and the luma weights stay shader constants. */
	depthTint: {
		ramp: RampRef;
		nearM: number;
		farM: number;
		gain: number;
		lumaKeep: [number, number];
	};
	/** The 'slope' layer: FATMAP 30/35/40/45° classes. */
	slope: {
		alpha: number;
		/** 30–35°, 35–40°, 40–45°, > 45° (sRGB) */
		colors: [Hex, Hex, Hex, Hex];
	};
};

export type ReplaceStyle = {
	haze: number;
	imagery: ImageryAdjust;
	/** 'overlay' = reuse overlay.bands (today both share one shader path). */
	bands: "overlay" | BandStyle;
	ridges: Pick<RidgeStyle, "inner" | "gain">;
	hairline: { color: Hex; alpha: number };
};

export type WorldStyle = {
	haze: number;
	imagery: ImageryAdjust;
	/** 'atmosphere' = look/atmosphere's analytic sky instead of the flat colours */
	sky: { mode: "flat" | "atmosphere"; clear: Hex; background: Hex };
	frame: {
		planeOpacity: number;
		lineColor: Hex;
		lineOpacity: number;
		pinColor: Hex;
		pinRadiusM: number;
	};
	projectionTint: { color: Hex; amount: number };
	/** Oklab band transfer of the photo drape toward the photo's own statistics. 0 = off. */
	drapeHarmonize: number;
	/**
	 * Clear air (look/clear-air): take the photo's own haze out of the drape along the photo camera's
	 * rays before the view's haze goes on, so distant ground isn't hazed twice. 'consistent' inverts
	 * the render's own haze model as the photo eye sees it (no fit needed); 'fitted' inverts the
	 * photo's haze fit (look/haze-fit) and falls back to 'consistent' on a weak fit. `amount` blends
	 * the result, `floor` is the lowest transmittance divided by (caps the gain at 1/floor).
	 */
	clearAir: {
		mode: "off" | "consistent" | "fitted";
		amount: number;
		floor: number;
	};
	/** Rain / snow in the deck world view and landing scenes (look/weather); never the photo overlay. */
	weather:
		| { mode: "off" }
		| { mode: "rain" | "snow"; intensity: number; wind: number };
	/**
	 * Lake water in the deck world view (look/water/waves): 'waves' animates the LOOK_WATER lakes
	 * with luma's riverWaterMaterial wave normals. Needs terrain.albedo { mode: 'alpine', water: true };
	 * never the photo overlay, still under webdriver.
	 */
	water: "flat" | "waves";
	/**
	 * Wind drift (look/flow; WebGPU world view only, default off): GPU particles streaming over the DEM
	 * in a uniform wind deflected by the terrain gradient (flow goes around and over ridges). `direction`
	 * is the compass bearing the wind blows FROM in degrees (a south föhn is 180), `speed` m/s, `density`
	 * the fraction of the particle budget drawn.
	 */
	wind: { on: boolean; direction: number; speed: number; density: number };
};

/** Photo ⊕ render compositing (overlay and replace). CLASSIC sets no LOOK_* define. */
export type CompositeLookStyle = {
	/** guided-filter-refined coverage / cut / people masks (LOOK_REFINE) */
	refine: boolean;
	/** Oklab per-distance-band transfer of the replacing layer toward the photo (LOOK_HARMONIZE when > 0) */
	harmonize: number;
	/** 'classic' = overlay.ridges; 'ink' = anti-aliased silhouettes + refined skyline (LOOK_INK) */
	ridges: "classic" | "ink";
	/** Optional pencil / ink wobble of the ridge, skyline and crease lines, 0..1 (luma sketchStroke shading); absent / 0 = off. */
	sketch?: number;
	ink: {
		strength: number;
		width: number;
		crease: number;
		inner: Hex;
		skyline: Hex;
	};
	/** keepSky source: 'photo' = the photo's P(sky) (lazy segmentSky) */
	sky: "dem" | "photo";
	/** 'neutral' = PBR Neutral tone map, own sRGB encode, IGN dither and photo-matched grain (LOOK_OUTPUT) */
	output: "classic" | "neutral";
};

export type TrailStyle = {
	width: number;
	opacity: number;
	colors: { hiking: Hex; mountain: Hex; alpine: Hex; other: Hex };
	/** Optional dashed trails: [dashM, gapM] metres along the path (luma pathDash). Absent / empty = solid. */
	dash?: readonly [number, number];
	/** Optional stroke shading: 'solid' (default) | 'pencil' (luma sketchStroke) | 'glow'. Absent = solid. */
	stroke?: "solid" | "pencil" | "glow";
};

export type LabelHalo = {
	kind: "shadow" | "stroke" | "none";
	color: Hex;
	blurPx: number;
	offsetY: number;
	strokePx: number;
	/** backdrop-adaptive contrast (labels/contrast.ts): extra glow on bright backdrops, 0 = off, 1 = full */
	adaptive: number;
};

/** Canvas export metrics (engine.ts exportImage). Every length is at scaleRef px of output width. */
export type LabelExport = {
	scaleRef: number;
	namePx: number;
	subPx: number;
	leaderPx: number;
	leaderW: number;
	dotR: number;
	haloBlur: number;
	/** shadowColor alpha (the export halo is rgba(0,0,0,haloAlpha); 0.85 vs the DOM's 0.9) */
	haloAlpha: number;
	textGap: number;
	lineGap: number;
	subAlpha: number;
	dotShadow: boolean;
};

/**
 * Glowing summit markers (look/labels/glow.ts, luma pointGlow): additive sprites over the label dots,
 * for a dusk or night look. Absent / null = off (the default; the render is untouched).
 */
export type LabelGlow = {
	/** outer radius of the sprite, CSS px */
	radiusPx: number;
	/** sprite tint (sRGB); the core is white */
	tint: Hex;
	/** overall multiplier of the radiance */
	intensity: number;
	/** pointGlow: white core radius, fraction of the sprite (0 = no core) */
	coreRadius: number;
	coreIntensity: number;
	haloIntensity: number;
	/** pointGlow: halo falloff, larger = tighter */
	falloff: number;
};

export type LabelStyle = {
	/** 'panorama' / 'inline': look/labels/layout.ts */
	layout: "classic" | "panorama" | "inline";
	/** Canvas export font. The DOM labels inherit the app's --font-sans (same Fira Sans face). */
	fontFamily: string;
	name: { px: number; weight: number; color: Hex };
	sub: {
		px: number;
		weight: number;
		color: Hex;
		show: "ele+dist" | "ele" | "dist" | "none";
	};
	halo: LabelHalo;
	leader: { lengthPx: number; widthPx: number; color: Hex; fade: boolean };
	/** glowPx: blur radius of the dot's glow (box-shadow 0 0 glowPx glow) */
	dot: { px: number; color: Hex; glow: Hex | null; glowPx: number };
	maxLabels: number;
	/** Opt-in glowing summit markers (GPU, both engines); absent / null = off. */
	glow?: LabelGlow | null;
	/** null = derive from the screen metrics (see labels-canvas, chunk 3). */
	export: LabelExport | null;
};

/**
 * Terroir cartography (reports/terroir-cartography.md): place-specific layers on top of every view.
 * Purely additive: CLASSIC switches every part off, so classic stays pixel-identical. Display-only;
 * nothing here feeds the matcher, pose, confidence or exports' measurements.
 */
export type TerroirStyle = {
	/** Names beyond peaks from the region's terroir pack (water, settlements, passes, huts, glaciers…). */
	names: {
		on: boolean;
		/** 'near' = landscape names only within ~12 km (alps, field names); 'all' = every class at any range */
		reach: "near" | "all";
		/** 'local' = the official local-language form; 'local+usual' adds the usual/bilingual form as a second line */
		language: "local" | "local+usual";
		maxLabels: number;
	};
	/** Peak labels sized by prominence class (major / summit / minor) instead of one size. */
	peakTiers: boolean;
	/** A soft backing behind the elevation · distance line so it reads on bright cloud. */
	subPill: boolean;
	contours: {
		/** thin the interval with range (screen density) instead of a fixed interval to the horizon */
		adaptive: boolean;
		/** index contours on round 100 m (Swiss maps) whatever the interval */
		swissIndex: boolean;
		/** brown on soil, black on rock and scree, blue on ice and water (needs the pack's cover) */
		inkByCover: boolean;
	};
	/** Real land cover from the pack in Blend / In map instead of the elevation belts. */
	/** Slope-driven Swiss rock hatching and scree dots on hillshaded terrain (no pack needed); display only. */
	hatch: boolean;
	cover: {
		on: boolean;
		snow: "none" | "date";
		/** scree dots, rock hatching, glacier crevasse lines on the class rendering (needs cover.on) */
		pattern: boolean;
	};
	/** A glacier's former extent registered on the photo (GLAMOS / pack), labelled with its year. */
	glacier: { on: boolean; year: number; style: "outline" | "fill" };
	/** The sun's arc for the capture date above the skyline, with sunrise / sunset azimuths. */
	sunPath: boolean;
	/** Elevation key + land-cover key for whatever the view encodes. */
	legend: boolean;
	/** Soften labels and lines while the pose is unverified (far field first). */
	uncertainty: boolean;
	/** Tap the photo for a "read this view" card: name, class, elevation, distance, aspect, cover. */
	placeCard: boolean;
	/** Scale, north and a sun / time chip. */
	furniture: boolean;
};

export type ViewStyle = {
	v: 1;
	terrain: TerrainLook;
	overlay: OverlayStyle;
	replace: ReplaceStyle;
	world: WorldStyle;
	composite: CompositeLookStyle;
	trails: TrailStyle;
	labels: LabelStyle;
	terroir: TerroirStyle;
};

export type PresetId =
	| "classic"
	| "minimal"
	| "topo-map"
	| "night"
	| "high-contrast"
	| "photo-matched"
	| "swiss"
	| "berann"
	| "topo-ink"
	| "slope"
	| "terroir"
	| "field-sketch";

/** Tuples / arrays are replaced wholesale, objects merge key by key. */
export type DeepPartial<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

export type StyleState = {
	preset: PresetId;
	overrides: DeepPartial<ViewStyle>;
};
