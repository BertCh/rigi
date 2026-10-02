// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DeckEngine: the PhotoEngine surface (src/lib/renderer.ts) on deck.gl, for `?renderer=deck`.
// Imperative `Deck` on the canvas PhotoWorkspace hands in (no React), mirroring engine.ts:
//   photo view (PhotoView, camera-anchored ENU): the streamed Mapterhorn terrain (TerrainLayer)
//     and the trails (TrailLayer), both `offscreen`: PhotoCompositor (composite.ts, a deck Effect)
//     draws them per frame into three's geoRT (range, 1024 px) and layerRT (colour, MSAA ×4)
//   screen view (orthographic): the composite layer (photo ⊕ layer, ridges/skyline, depth tint,
//     people mask, swipe/lens/range/brush blend) — engine.ts compositeFrag, 1:1
// Queries: a GPU geometry source (geometry-pass.ts, 1024 px, async PBO readback) is what
// sampleAt / peak occlusion / hover / export read, with three's generation semantics (geoGen,
// 90 ms debounced readback, readback() forces it). autoAlign re-ranks its finalists with a 384 px
// GPU source (CPU profile source as the fallback). Peaks snap on the CPU (scene.ts).
//
// World view (mode 'world', world-view.ts): the same Deck switches to a WorldView driven by three's
// OrbitControls on a THREE camera (engine.ts enterWorld framing, damping, polar limit, fly-in
// tween). The terrain draws straight to the canvas (worldStyle hillshade / satellite / topo, haze
// 0.5, three's sky colour) with the photo draped from its camera, occlusion-tested against the
// query geometry buffer (1024 px GPU range, = three's geoRT), plus trails (canvas pass) and the
// photo-camera gizmo (photo plane, frustum, pin) with the terrain's log depth.

import {
	Deck,
	type InteractionState,
	type Layer,
	type MapViewState,
	OrthographicView,
} from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import * as THREE from "three";
import {
	type AlignResult,
	buildEdgeMap,
	type EdgeMap,
	type Pin,
} from "../align";
import { hfovFromAspect, type Pose } from "../camera";
import { tileBounds } from "../dem";
import { heightFromTile } from "../dem/height-from-tile";
import { startLakeFloor } from "../geocam/lakes/fetch";
import { priorHeading } from "../geocam/priors/heading";
import { distanceM, EnuFrame, M_PER_DEG_LAT, wrap180 } from "../geodesy";
import { autoAlignAsync, warmAlignGpu } from "../gpu/align";
import { lookIdle, trackLook } from "../gpu/look/opt-in";
import {
	type FastHorizon,
	startFastHorizon,
} from "../integration/horizon-fast-app";
import { photoUnknowns, type Unknowns } from "../integration/unknown-pose";
import {
	type ClearAirValues,
	clearAirValues,
	wantsClearAirFit,
} from "../look/clear-air";
import {
	blendCut,
	blendCutKey,
	CompositeLook,
	compositeValues,
	gridSize,
	harmonizeValues,
	type RangeGrid,
	STATS_LONG_SIDE,
	trustedRange,
} from "../look/composite";
import {
	buildFlowGrid,
	FLOW_EXTENT_M,
	FLOW_GRID_DIM,
	flowWindFor,
	sampleFlowHeights,
} from "../look/flow/field";
import { FlowSim } from "../look/flow/sim";
import { COMPOSITE_DEFINES } from "../look/glsl/composite";
import { HazeController, rangeGeo } from "../look/haze-controller";
import type { SkyMask } from "../look/haze-fit";
import { drawExportLabels, skylineAt } from "../look/labels";
import { type GlowMarkers, sameGlowMarkers } from "../look/labels/glow";
import { lookKey } from "../look/look-key";
import { ReliefController } from "../look/relief/field";
import { waterWavesAnimate } from "../look/water/waves";
import { precipitationFor } from "../look/weather/precipitation";
import { DeckMapCamera, MAP_VIEW_ID } from "../nearfield/deck-map-camera";
import {
	DeckSplatLayer,
	isDeckSplatLayer,
} from "../nearfield/deck-splat-layer";
import {
	type ByteMask,
	PHOTO_SKY_PARAMETERS,
	PhotoSkyLayer,
	stepMasks,
} from "../nearfield/deck-step";
import {
	loadNearDem,
	type NearDem,
	nearFieldDemRangeFrom,
} from "../nearfield/near-dem";
import { PROVENANCE_TINT_MIX } from "../nearfield/provenance";
import {
	StepCamera,
	type StepInsideOpts,
	type StepView,
} from "../nearfield/step-camera";
import {
	type NearFieldScene,
	type NearFieldViewOpts,
	PixelClass,
} from "../nearfield/types";
import type { PhotoMeta, RegionData, RegionTrail } from "../photos";
import { solvePinsForApp } from "../pins/seed";
import { projectPoint, unprojectDir } from "../pose";
import type { FgMask, Renderer } from "../renderer";
import type { RevealUniforms } from "../reveal/config";
import {
	defaultSettings,
	type PeakLabel,
	type Sample,
	type Settings,
} from "../settings";
import {
	type DeckStyleMode,
	type DeckTerrainStyle,
	deckCompositeStyle,
	deckElevRange,
	deckTerrainStyle,
	deckWorldStyle,
	trailPalette,
} from "../style/deck-apply";
import { CLASSIC } from "../style/defaults";
import type { ViewStyle } from "../style/types";
import { type TerroirShader, terroirShader } from "../terroir/glsl/values";
import type { CoverGrid } from "../terroir/pack";
import { DeckTiles3D } from "../tiles3d/deck-tiles";
import { PhotoCompositor } from "./composite";
import { CpuGeometrySource, TerrainProfiles } from "./cpu-geometry";
import {
	pendingPrograms,
	reviveDevice,
	waitForPrograms,
	watchContextLoss,
} from "./device-lost";
import { FlowLayer } from "./flow-layer";
import { OCC_DVS, occThreshold } from "./geo-query";
import { GpuGeometrySource, geometrySize, rangeMapFrom } from "./geometry-pass";
import {
	type GeometrySource,
	type GeometrySourceFactory,
	logRange,
} from "./geometry-source";
import { GlowMarkerLayer } from "./glow-layer";
import {
	evictImagery,
	IMAGERY_CACHE_CAP_BYTES,
	touchImagery,
} from "./imagery-cache";
import { PhotoView, photoViewProjection } from "./photo-view";
import {
	eyeAltitude,
	localElevRange,
	nearFadeFor,
	type Peak,
	placePeakLabels,
	type SnappedPeak,
	snapPeaksNear,
} from "./scene";
import { compositeFor, terrainLookFor } from "./settings-map";
import { SilhouetteMaskGL } from "./silhouette-gl";
import {
	redrawIfBlank,
	type SilScores,
	scoreFromMask,
	silMaskWords,
	silNonce,
} from "./silhouette-mask";
import {
	type ImagerySource,
	loadImagery,
	type TerrainSet,
	type TileMesh,
	type ViewWedge,
} from "./terrain-data";
import {
	type PhotoRangeMap,
	RANGE_SAMPLER,
	SharedPhotoTexture,
	TerrainLayer,
} from "./terrain-layer";
import { TerrainStreamer } from "./terrain-stream";
import {
	buildTrailSegments,
	recolorTrailSegments,
	TrailLayer,
	type TrailSegments,
} from "./trail-layer";
import { WeatherLayer } from "./weather-layer";
import {
	AtmSkyLayer,
	poseQuaternion,
	WorldCamera,
	WorldGizmoLayer,
	WorldView,
} from "./world-view";

const angleDiff = (a: number, b: number) => Math.abs(wrap180(a - b));

export type DeckEngineOptions = {
	/** Upper bound on the canvas' device pixel ratio (default 2). The landing's Step Inside passes 1.5. */
	pixelRatioCap?: number;
	/**
	 * The world drape's range map straight from the GPU geometry target (default true): a GPU copy
	 * (GpuGeometrySource.copyRangeTo) instead of rangeMapFrom() over the read-back buffer and a
	 * re-upload. false = the CPU path; it also runs whenever the GPU copy can't (CPU geometry
	 * source, the target already re-rendered for a newer pose).
	 */
	gpuDrape?: boolean;
	/**
	 * autoAlign's silhouette re-rank scored on the GPU (default true): a mask pass over each pose's
	 * range target and an 18 KB read per pose (silhouette-mask.ts; identical scores by construction)
	 * instead of reading the range back. false = the CPU scorer, which also runs per pose whenever
	 * the GPU can't decide (CPU geometry source, context lost, an undecided pixel).
	 */
	silhouetteGpu?: boolean;
};

export type DeckEngineStats = {
	terrainTiles: number;
	queryGeneration: number | null;
	profileBins: number;
	horizonSource: "fast" | "cpu" | null;
	horizonDirs: number;
	peaks: number;
	snapped: number;
	tested: number;
	/** Geometry generation / generation in the CPU buffer (equal = fresh). */
	geoGen: number;
	geoBufGen: number;
	geometrySource: "gpu" | "cpu" | null;
	/** Last silhouette re-rank: renders and total ms. */
	silhouette: { renders: number; ms: number; searchMs: number } | null;
	trailSegments: number;
};

/** requestIdleCallback (setTimeout where missing: Safari), with a 3 s deadline. */
const requestIdle = (cb: () => void): number =>
	typeof requestIdleCallback === "function"
		? requestIdleCallback(cb, { timeout: 3000 })
		: window.setTimeout(cb, 1000);
const cancelIdle = (h: number) =>
	typeof cancelIdleCallback === "function"
		? cancelIdleCallback(h)
		: clearTimeout(h);

const samePose = (a: Pose, b: Pose) =>
	a.yaw === b.yaw &&
	a.pitch === b.pitch &&
	a.roll === b.roll &&
	a.vfov === b.vfov;

/**
 * Input idle (ms): a pose / lens / swipe change this soon after the previous one is an interaction
 * (compositor.setInteractive), and the interaction ends this long after the last one.
 */
const INPUT_IDLE_MS = 150;

/**
 * Settings only the composite pass reads (compositeFor), never the terrain / trail layers or the
 * band stats: a change to these alone skips the layer rebuild, so the cached colour pass is reused.
 */
const COMPOSITE_ONLY = new Set<string>([
	"layerOpacity",
	"ridges",
	"depthTint",
	"method",
	"swipe",
	"lens",
	"lensR",
	"rangeKm",
	"keepSky",
	"feather",
	"protectPeople",
]);

/** Settings a pointer drives continuously (the lens follows the mouse, the swipe bar is dragged). */
const POINTER_SETTINGS = new Set<string>(["lens", "swipe"]);

/** Value equality for settings / layer props: identity, or equal small numeric arrays. */
function sameValue(a: unknown, b: unknown) {
	if (a === b) return true;
	if (
		!(Array.isArray(a) || ArrayBuffer.isView(a)) ||
		!(Array.isArray(b) || ArrayBuffer.isView(b))
	)
		return false;
	const x = a as ArrayLike<unknown>;
	const y = b as ArrayLike<unknown>;
	if (x.length !== y.length || x.length > 64) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

function sameProps(a: Record<string, unknown>, b: Record<string, unknown>) {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => k in b && sameValue(a[k], b[k]));
}

/** The world sky's draw state (a stable object, so its layer props compare equal across frames). */
const WORLD_SKY_PARAMETERS = {
	depthCompare: "always",
	depthWriteEnabled: false,
} as const;

/** Engine counters for benches (__engine.metrics()). */
export type DeckEngineCounters = {
	/** Layer instances built / reused unchanged by updateLayers (keepLayer). */
	layerBuilds: number;
	layersKept: number;
	/** setSettings calls that took the composite-only path. */
	compositeOnly: number;
	/** Interactions (setInteractive(true)) so far. */
	interactions: number;
	contextLost: number;
	contextRestored: number;
};

export class DeckEngine implements Renderer {
	readonly photo: PhotoMeta;
	readonly aspect: number;
	readonly prior: Pose;
	readonly unknowns: Unknowns;
	readonly frame: EnuFrame;
	pose: Pose;
	settings: Settings = { ...defaultSettings };
	/** How the views look (src/lib/style), applied through deck-apply.ts; see setStyle(). */
	style: ViewStyle = CLASSIC;
	/** deckTerrainStyle per view mode for `style` (stable objects, so layer props compare equal). */
	private looks = new Map<string, DeckTerrainStyle>();
	/** Fitted haze (airlight 'fitted'), refit after fresh readbacks. */
	private haze = new HazeController();
	/** The Swiss relief's field (LOOK_RELIEF), rebuilt at pose settle when the sun, yaw or tiles change. */
	private relief = new ReliefController();
	/** The look composite's CPU side (refined masks, band stats, photo noise), made at pose settle. */
	private compLook = new CompositeLook();
	private statsTimer = 0;
	/**
	 * Band stats read synchronously (compositor.readLayer: a readPixels that stalls the GL pipeline,
	 * the stats land in the timer's own task) instead of fenced (readLayerAsync, the default: they
	 * land a frame or more later, as the ?lookgpu stats already did). For parity checks / benches.
	 */
	syncStats = false;
	/** The key of the async band-stats read in flight: the same key is not read twice. */
	private statsPending: string | null = null;
	/** Bumps whenever the layer's look changes without a pose change (style, haze fit, relief field): the band stats' key. */
	private layerGen = 0;
	/** Terroir land cover (setTerroirCover) and the terroir shading of it + the style (src/lib/terroir/glsl). */
	private terroirGrid: CoverGrid | null = null;
	private terroirMemo: {
		style: ViewStyle;
		grid: CoverGrid | null;
		t: TerroirShader | null;
	} | null = null;
	/** The photo view's terrain + trail layers as updateLayers last built them (updateComposite reuses them). */
	private sceneLayers: Layer[] = [];
	/** Brush strokes so far (the refined cut's key) and the debounce for re-refining after an edit. */
	private brushVersion = 0;
	private lookTimer = 0;
	/** The TerrainSet the CPU queries read (first complete streamed set; see maybeSwapQueryTerrain). */
	terrain?: TerrainSet;
	eye = { x: 0, y: 0, z: 0 };
	eyeAlt = 0;
	demAtCamera = 0;
	demKnown = false;
	cssSize = { w: 1, h: 1 };
	/**
	 * Makes the GeometrySources the queries (1024 px) and autoAlign's silhouette re-rank (384 px)
	 * render into. Defaults to the GPU pass on this engine's Deck (geometry-pass.ts), with the CPU
	 * profile source (cpu-geometry.ts) as the fallback when the GPU one can't be created.
	 */
	geometryFactory?: GeometrySourceFactory;

	private deck: Deck;
	private deckReady: Promise<void>;
	private compositor: PhotoCompositor;
	private region: RegionData | null = null;
	private trails: TrailSegments | null = null;
	/** Geometry buffer the queries read (engine.ts geoBuf) and its generations (see geoGen). */
	private geoSrc?: GeometrySource;
	private geoSrcKind: "gpu" | "cpu" | null = null;
	/**
	 * engine.ts geometry generations: `geoGen` bumps on every change that alters the geometry
	 * (pose, terrain meshes); `geoBufGen` is the generation the CPU buffer holds. Fresh when equal.
	 */
	private geoGen = 0;
	private geoBufGen = -1;
	private geoTimer = 0;
	private silTiming: {
		renders: number;
		ms: number;
		searchMs: number;
		/** CPU scoring of the read-back range buffers / GPU masks (part of ms) */
		scoreMs?: number;
		/** "gpu" = mask pass (silhouetteGpu), "cpu" = range readback + CPU scorer */
		path?: "gpu" | "cpu";
		/** bytes read back from the GPU for the whole re-rank */
		bytes?: number;
		/** GPU path: poses re-scored on the CPU (undecided pixel / bad header) */
		fallbacks?: number;
		/** finalists whose render came back blank and were drawn again (redrawIfBlank) */
		redraws?: number;
	} | null = null;
	private streamer?: TerrainStreamer;
	/** Latest streamed set (what the TerrainLayer draws). */
	private renderSet: TerrainSet | null = null;
	/** Wedge the query terrain was selected for. */
	private queryWedge?: ViewWedge;
	private elevRange: [number, number] | null = null;
	private photoImg?: HTMLImageElement;
	private fgMask: FgMask | null = null;
	/** The last P(sky) mask handed to setSkyMask (Step Inside reads it, as engine.ts). */
	private skyMaskStore: SkyMask | null = null;
	private edge?: EdgeMap;
	private horizonDirs?: Float32Array;
	private horizonSource: "fast" | "cpu" | null = null;
	private fastHorizon?: FastHorizon;
	private peaks: Peak[] = [];
	private snaps = new Map<Peak, SnappedPeak | null>();
	private vis = new Map<SnappedPeak, boolean>();
	private profiles?: TerrainProfiles;
	/** One 384 px source per re-rank hypothesis, so their renders + readbacks pipeline. */
	private silSources: GeometrySource[] = [];
	private imagery = {
		key: "",
		map: new Map<string, ImageBitmap>(),
		/** Tile ids evict() must keep: the render set (and the set being synced). */
		keep: new Set<string>(),
		abort: null as AbortController | null,
		/** Bumps on every change to `map`; `snap` is the copy handed to the layers at `snapVersion`. */
		version: 0,
		snap: null as Map<string, ImageBitmap> | null,
		snapVersion: -1,
	};
	/**
	 * The layers passed to deck by the last updateLayers, by id, with the props they were made from:
	 * keepLayer hands the same instance back while the props are unchanged, so deck skips the
	 * layer's diff and the compositor's colour pass (keyed on the layer instances) stays cached.
	 */
	private kept = new Map<
		string,
		{ layer: Layer; ctor: unknown; props: Record<string, unknown> }
	>();
	private nextKept = new Map<
		string,
		{ layer: Layer; ctor: unknown; props: Record<string, unknown> }
	>();
	/** photoViewProjection for the current pose (memoised: a stable array for the layer props). */
	private pvp?: { key: number[]; arr: number[] };
	/** harmonizeValues memo (a stable object for the layer props). */
	private clearAirMemo?: {
		style: ViewStyle;
		fit: unknown;
		key: string;
		value: ClearAirValues;
	};
	private harm?: {
		stats: unknown;
		amount: unknown;
		value: ReturnType<typeof harmonizeValues>;
	};
	/** An interaction runs (compositor.setInteractive(true)); see noteInput. */
	private interactive = false;
	private lastInputAt = Number.NEGATIVE_INFINITY;
	private idleTimer = 0;
	/**
	 * The photo-view terrain layer carries the full-size photo too (unused there: the photo only
	 * drapes in the world view), so its mip-mapped texture is uploaded once, not on every world entry.
	 */
	private photoTexWarm = false;
	/** The one mipmapped GPU copy of the photo (compositor + terrain layers); released in dispose(). */
	private readonly photoShared = new SharedPhotoTexture();
	private warmHandle = 0;
	/** The WebGL context is lost (device-lost.ts); nothing draws until it is restored. */
	private contextLost = false;
	private unwatchContext: () => void = () => {};
	/** The occluder mask last handed to setOccluder (a rebuilt compositor gets it again). */
	private occluder: FgMask | null = null;
	/** style.labels.glow markers (look/labels/glow.ts); null = off, no layer at all. */
	private glow: { markers: GlowMarkers; layer: Layer } | null = null;
	/** Compositors made after a context loss (their effect ids). */
	private compositorGen = 0;
	private deckMetrics: Record<string, unknown> | null = null;
	private counters: DeckEngineCounters = {
		layerBuilds: 0,
		layersKept: 0,
		compositeOnly: 0,
		interactions: 0,
		contextLost: 0,
		contextRestored: 0,
	};
	private listeners = new Set<() => void>();
	private readbackWaiters: ((ok: boolean) => void)[] = [];
	private wedgeTimer = 0;
	private disposed = false;
	private canvas: HTMLCanvasElement;
	private photoViews: unknown[];
	private worldViews: unknown[];
	/** World view camera (three's OrbitControls + fly-in), made on the first enterWorld. */
	private world?: WorldCamera;
	private worldRaf = 0;
	/** World-view rain / snow animation (style.world.weather): a redraw per frame while it is on. */
	private weatherRaf = 0;
	/**
	 * World-view wind drift (style.world.wind, default off): the CPU advection (WebGL2 has no compute;
	 * look/flow/sim.ts), the DEM heights it was gridded from, and its animation frame. All null / 0 while off.
	 */
	private flowSim: FlowSim | null = null;
	private flowRaf = 0;
	private flowHeights: Float32Array | null = null;
	private flowHeightsSet: TerrainSet | null = null;
	private flowGridMemo: {
		heights: Float32Array;
		direction: number;
		speed: number;
	} | null = null;
	private worldStill = 0;
	/** The layers the last worldLayers built, and the gizmo plane opacity they (or a flight frame) used. */
	private worldList: unknown[] = [];
	private worldGizmoOpacity = -1;
	/** The drape's range map (the query geometry buffer's: drapeRange) and its generation. */
	private drape: { gen: number; map: PhotoRangeMap } | null = null;
	/**
	 * Engine-owned r32float textures of the GPU drape (drapeRange): the current generation's and
	 * the previous one's, which a layer may still bind until the new props reach it. A new
	 * generation is copied into the texture no layer has, so a geometry pass re-rendering or
	 * reallocating its target never touches the texture the drape samples.
	 */
	private drapeTex: Texture[] = [];
	private readonly gpuDrape: boolean;
	private readonly pixelRatioCap: number;
	/** DeckEngineOptions.silhouetteGpu (harnesses flip it for the A/B). */
	silhouetteGpu: boolean;
	private silMask: SilhouetteMaskGL | null = null;
	private loadAbort = new AbortController();
	/** Step Inside (setNearField): the scene and its view options; null = off (the classic views). */
	private nearField: {
		scene: NearFieldScene;
		opts: NearFieldViewOpts;
	} | null = null;
	/**
	 * Step Inside camera (enterStepInside): drives the world camera from the photo camera; `enteredWorld`
	 * when stepping switched the world view on from the photo view (exit switches it back).
	 */
	private step: {
		cam: StepCamera;
		enteredWorld: boolean;
		masks: { step: ByteMask; sky: ByteMask } | null;
		/** Map mode's camera: deck's MapController on a hidden MapView (nearfield/deck-map-camera). */
		map: DeckMapCamera;
		/** 'step': Step Inside (splats, photo sky, full drape); 'map': the In-map view's own style. */
		view: StepView;
	} | null = null;
	/** World view near plane (5 m classic; splats metres from the eye need less). */
	private worldNear = 5;
	/** Step Inside 3D Tiles (src/lib/tiles3d, ?tiles3d=); null unless on. Shown only while stepping. */
	private tiles3d = DeckTiles3D.create(() => {
		if (!this.step || this.disposed) return;
		this.updateLayers();
		this.kickWorld();
	});
	/** The world drape's mask: people ∪ the scene's Object pixels, cached per input. */
	private drapeMaskCache: {
		key: unknown[];
		mask: FgMask | null;
	} | null = null;

	constructor(
		canvas: HTMLCanvasElement,
		photo: PhotoMeta,
		opts: DeckEngineOptions = {},
	) {
		this.gpuDrape = opts.gpuDrape ?? true;
		this.pixelRatioCap = opts.pixelRatioCap ?? 2;
		this.silhouetteGpu = opts.silhouetteGpu ?? true;
		this.photo = photo;
		this.aspect = photo.width / photo.height;
		this.prior = {
			yaw: priorHeading(photo) ?? 0,
			pitch: photo.pitch ?? 0,
			roll: photo.roll ?? 0,
			vfov: photo.vfov,
		};
		this.pose = { ...this.prior };
		this.unknowns = photoUnknowns(photo);
		this.frame = new EnuFrame(photo.lat, photo.lon, 0);
		// opt-in look passes on the GPU (gpu/look, ?lookgpu=1): results land after the settle frame
		this.haze.onAsync = () => {
			if (this.disposed) return;
			this.looks.clear();
			this.layerGen++;
			this.updateLayers();
		};
		this.relief.onAsync = () => {
			if (this.disposed) return;
			this.layerGen++;
			this.updateLayers();
		};
		this.compLook.onAsync = () => {
			if (this.disposed) return;
			this.updateLook();
			if (this.world?.controls) this.updateLayers();
		};
		this.cssSize = { w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 };
		this.canvas = canvas;
		this.photoViews = [
			new PhotoView({ id: "photo", near: 1, far: 400_000 }),
			new OrthographicView({ id: "screen", flipY: true }),
		];
		// engine.ts worldCam: near 5, far 600 km
		this.worldViews = [new WorldView({ id: "world", near: 5, far: 600_000 })];
		this.compositor = this.makeCompositor();
		this.deckReady = Promise.resolve();
		this.deck = this.createDeck();
		this.unwatchContext = watchContextLoss(canvas, {
			onLost: () => this.onContextLost(),
			onRestored: () => this.onContextRestored(),
		});
	}

	/** The photo view's compositor; `prev`: a lost context's, whose state it takes over. */
	private makeCompositor(prev?: PhotoCompositor) {
		const c = new PhotoCompositor(this.aspect);
		c.viewId = "photo";
		c.sharePhotoTexture(this.photoShared);
		if (prev) {
			// a new id: deck's EffectManager hands a replacement with the same id no setup() call
			c.id = `photo-composite-${++this.compositorGen}`;
			c.enabled = prev.enabled;
			c.msaaSamples = prev.msaaSamples;
			c.setSettings(prev.settings);
			c.setStyle(prev.style);
			c.setReveal(prev.reveal);
			c.setLook(prev.look);
			c.setPhoto(this.photoImg ?? null);
			c.setForegroundMask(this.fgMask);
			c.setOccluder(this.occluder);
			c.brushCanvas.getContext("2d")?.drawImage(prev.brushCanvas, 0, 0);
		}
		c.onChange = () => this.updateComposite();
		return c;
	}

	/**
	 * The Deck on this.canvas (constructor; again after a context loss, then `withEffects` false:
	 * the compositor joins once the Deck knows the canvas size, see onContextRestored).
	 */
	private createDeck(withEffects = true) {
		const canvas = this.canvas;
		let onLoad = () => {};
		this.deckReady = new Promise<void>((r) => {
			onLoad = r;
		});
		const map = this.step?.map;
		return new Deck({
			canvas,
			// null: never touch the canvas' CSS size (PhotoWorkspace sizes it); the canvas context
			// follows its client size
			width: null,
			height: null,
			useDevicePixels: Math.min(
				window.devicePixelRatio || 1,
				this.pixelRatioCap,
			),
			// Only applies when the canvas' context is created. preserveDrawingBuffer (luma's default
			// is true) is not needed: exports render offscreen (composite.ts renderImage) or draw the
			// world frame and read it in the same task (exportWorld), and no harness reads a deck
			// canvas outside a frame (style-baseline, which does, is pinned to three.js).
			// antialias (luma's default is true) multisamples the canvas' default framebuffer. The
			// world view draws straight onto it and is fill-bound there at DPR 2: orbit 29–39 fps
			// with it, ~59 without (reports/deck-default.md). At DPR ≥ 2 the pixels hide the
			// aliasing, so it is off; below that it stays on. The photo view is unaffected either
			// way: it renders into the compositor's own MSAA target. Decided once, when the context
			// is created (a later DPR change does not revisit it).
			deviceProps: {
				powerPreference: "high-performance",
				webgl: {
					preserveDrawingBuffer: false,
					antialias:
						Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) < 2,
				},
			},
			views: this.world?.controls
				? map?.active
					? [...this.worldViews, map.view]
					: this.worldViews
				: this.photoViews,
			viewState: this.viewState(),
			layers: [],
			effects: withEffects ? [this.compositor] : [],
			layerFilter: ({
				layer,
				viewport,
			}: {
				layer: { id: string };
				viewport: { id: string };
			}) =>
				viewport.id !== MAP_VIEW_ID &&
				layer.id.startsWith("screen-") === (viewport.id === "screen"),
			controller: false,
			// Step Inside map mode: deck's MapController drives the world camera (DeckMapCamera)
			onViewStateChange: (p: { viewId: string; viewState: MapViewState }) => {
				const map = this.step?.map;
				if (p.viewId === MAP_VIEW_ID && map?.active)
					map.onViewStateChange(p.viewState);
				return p.viewState;
			},
			onInteractionStateChange: (s: InteractionState) => {
				const map = this.step?.map;
				if (
					map?.active &&
					!s.isDragging &&
					!s.inTransition &&
					!s.isPanning &&
					!s.isRotating &&
					!s.isZooming
				)
					map.settle();
			},
			onLoad: () => onLoad(),
			onAfterRender: () => this.emit(),
			onError: (e: Error) => console.error("[deck-engine]", e),
			// once a second (deck's own fps / memory / timing counters): metrics()
			_onMetrics: (m: Record<string, unknown>) => {
				this.deckMetrics = { ...m };
			},
		} as never);
	}

	// ---------------- GPU context loss (device-lost.ts) ----------------

	private onContextLost() {
		if (this.disposed) return;
		this.contextLost = true;
		this.counters.contextLost++;
		console.warn("[deck-engine] WebGL context lost; waiting for the restore");
		cancelAnimationFrame(this.worldRaf);
		this.worldRaf = 0;
		this.syncWeatherTick(false);
		this.syncFlowTick(false);
		clearTimeout(this.geoTimer);
		this.geoTimer = 0;
		clearTimeout(this.statsTimer);
		this.statsTimer = 0;
		// every GL call is a no-op now: stop deck's frame loop until the rebuild
		(
			this.deck as unknown as { animationLoop?: { stop(): void } | null }
		).animationLoop?.stop();
	}

	/**
	 * The context is back (empty): revive deck's device, then a new Deck, compositor, layers and
	 * geometry sources on it. CPU state (terrain, imagery bitmaps, masks, the brush, the query
	 * buffers' generations) is kept; the geometry buffer is re-read for the current pose.
	 */
	private onContextRestored() {
		if (this.disposed || !this.contextLost) return;
		const old = this.deck;
		const device = (
			old as unknown as { device?: Parameters<typeof reviveDevice>[0] }
		).device;
		if (!device || !reviveDevice(device)) {
			console.error(
				"[deck-engine] context restored but the device could not be revived",
			);
			return;
		}
		this.contextLost = false;
		this.counters.contextRestored++;
		try {
			old.finalize();
		} catch (e) {
			console.warn("[deck-engine] finalizing the lost Deck", e);
		}
		// the GPU drape's textures die with the context: keep the drape on the CPU buffer, still
		// readable here, so it isn't blank until the next geometry read
		if (this.drape?.map.texture) {
			const src = this.geoSrc;
			this.drape = src?.pose
				? { gen: this.drape.gen, map: rangeMapFrom(src) }
				: null;
		}
		try {
			this.dropGeometrySources();
		} catch {}
		// the silhouette-mask helper's GL handles died with the context (the revived device keeps
		// its identity, so the device check in silhouetteScoresGpu would not rebuild it)
		try {
			this.silMask?.destroy();
		} catch {}
		this.silMask = null;
		this.drapeTex = [];
		const prev = this.compositor;
		prev.onChange = undefined;
		this.compositor = this.makeCompositor(prev);
		this.kept.clear();
		this.sceneLayers = [];
		// deck's first frame on the reused device can come before it knows the canvas size (seen: a
		// zero viewport, "Pixel project matrix not invertible"): the compositor joins once the Deck
		// is up, then a few redraws; settleAfterRestore finishes the job once the programs link.
		const deck = this.createDeck(false);
		this.deck = deck;
		this.updateLayers();
		this.invalidateGeometry();
		if (this.world?.controls) this.kickWorld();
		void this.deckReady.then(() => {
			let n = 0;
			const again = () => {
				if (this.disposed || this.deck !== deck || this.contextLost) return;
				if (n === 0) deck.setProps({ effects: [this.compositor] } as never);
				this.updateLayers();
				deck.redraw("context restored");
				if (++n < 3) requestAnimationFrame(again);
			};
			requestAnimationFrame(again);
		});
		void this.settleAfterRestore(deck);
		console.warn("[deck-engine] WebGL context restored; renderer rebuilt");
	}

	/**
	 * Every program recompiles after a restore, asynchronously (KHR_parallel_shader_compile): a pass
	 * drawn before its program links draws nothing, and both the geometry buffer (generation
	 * semantics) and the compositor (geometry pass cached per pose) would keep that empty result.
	 * So: one readback to create the query programs, wait until nothing is linking (≤ 5 s), then
	 * read the geometry again and put a fresh compositor in, which redraws every pass.
	 */
	private async settleAfterRestore(deck: Deck) {
		const live = () =>
			!this.disposed && this.deck === deck && !this.contextLost;
		await this.deckReady;
		await this.readback();
		const device = (
			deck as unknown as { device?: Parameters<typeof pendingPrograms>[0] }
		).device;
		for (let t = 0; t < 100 && live(); t++) {
			await new Promise((r) => setTimeout(r, 50));
			if (device && pendingPrograms(device) === 0) break;
		}
		if (!live()) return;
		this.invalidateGeometry();
		await this.readback();
		if (!live()) return;
		const cur = this.compositor;
		cur.onChange = undefined;
		this.compositor = this.makeCompositor(cur);
		deck.setProps({ effects: [this.compositor] } as never);
		this.updateLayers();
	}

	// ---------------- Renderer: lifecycle ----------------

	onRender(cb: () => void) {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	private emit() {
		if (this.disposed) return;
		for (const cb of this.listeners) cb();
	}

	async init(
		region: RegionData | null | Promise<RegionData | null>,
		onProgress?: (msg: string, frac: number) => void,
		segment?: (img: HTMLImageElement) => Promise<FgMask | null>,
	) {
		// disposed before init ran (StrictMode double mount): starting the streamer now would leak it, as
		// loadAbort has already fired; resolve like every other disposed-mid-init exit
		if (this.disposed) return;
		onProgress?.("Loading photo", 0);
		// ?geoLakeFloor (null when off): lake outlines load in parallel; eye ≥ lake level, fail-open
		const lakeFloor = startLakeFloor(this.photo, region, this.loadAbort.signal);
		// CPU skyline in a worker (engine.ts init): starts with the photo decode and the tiles
		if (!this.fastHorizon) {
			const fast = this.startFastHorizon();
			this.fastHorizon = fast;
			if (fast)
				heightFromTile(
					this.photo.lat,
					this.photo.lon,
					14,
					this.loadAbort.signal,
				)
					.then(
						(dem) =>
							dem != null && fast.setEye(eyeAltitude(this.photo.alt, dem)),
					)
					.catch(() => {});
		}
		// the viewing wedge + the yaw search range up front; 360° without a trustworthy prior.
		// Started before the photo decode (it needs only the photo's metadata) so the two overlap.
		const wedge: ViewWedge = this.unknowns.any
			? { headingDeg: this.prior.yaw, halfAngleDeg: 180 }
			: {
					headingDeg: this.prior.yaw,
					halfAngleDeg: Math.min(
						180,
						hfovFromAspect(this.prior.vfov, this.aspect) / 2 + 32,
					),
				};
		const terrainLoad = this.startStreaming(wedge, onProgress);
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = this.photo.src;
		await img.decode();
		if (this.disposed) return;
		this.photoImg = img;
		this.photoShared.setSource(img);
		this.compositor.setPhoto(img);
		const fgPromise = segment
			? segment(img).catch(() => null)
			: Promise.resolve(null);

		const terrain = await terrainLoad;
		if (!terrain || this.disposed) return;
		this.terrain = terrain;
		this.queryWedge = wedge;
		const demHere = terrain.heightAt(this.photo.lat, this.photo.lon);
		const dem = demHere ?? this.photo.alt ?? 0;
		this.demAtCamera = dem;
		this.demKnown = demHere != null;
		this.eyeAlt = eyeAltitude(this.photo.alt, dem);
		this.eye = { x: 0, y: 0, z: this.eyeAlt };
		this.fastHorizon?.setEye(this.eyeAlt);
		this.elevRange = localElevRange(terrain);
		this.updateRelief();
		this.updateLayers();
		// the first geometry buffer (resolves readback() calls made before the terrain existed)
		this.invalidateGeometry();

		let regionData = await region;
		if (this.disposed) return;
		if (regionData && this.pendingTrails)
			regionData = { ...regionData, trails: this.pendingTrails };
		this.pendingTrails = undefined;
		if (regionData) {
			onProgress?.("Placing peaks and trails", 1);
			this.region = regionData;
			this.peaks = regionData.peaks;
			this.buildTrails();
			this.updateLayers();
		}
		if (lakeFloor) {
			// rule (b) wants the DEM at the fix, not the GPS-altitude stand-in for a missing one
			const floor = await lakeFloor(demHere ?? Number.NaN, (la, lo) =>
				terrain.heightAt(la, lo),
			);
			if (this.disposed) return;
			if (floor != null && floor > this.eyeAlt) {
				this.eyeAlt = floor;
				this.eye = { x: 0, y: 0, z: floor };
				this.fastHorizon?.setEye(floor);
				this.invalidateGeometry();
				this.updateLayers();
			}
		}
		const fg = await fgPromise;
		if (this.disposed) return;
		if (fg) this.setForegroundMask(fg);
		this.edge = buildEdgeMap(img, 512, fg);
		void warmAlignGpu(); // W2: compute device + pose-grid kernel ready before autoAlign
		onProgress?.("Tracing horizon", 1);
		const dirs = this.takeFastHorizon() ?? (await this.traceHorizon());
		if (this.disposed) return;
		this.horizonDirs = dirs;
		this.updateLayers();
		this.warmPhotoTexture();
	}

	/** Starts the streamer; resolves with its first complete TerrainSet (null if disposed first). */
	private startStreaming(
		wedge: ViewWedge,
		onProgress?: (msg: string, frac: number) => void,
	) {
		return new Promise<TerrainSet | null>((resolve) => {
			const abort = () => resolve(null);
			this.loadAbort.signal.addEventListener("abort", abort, { once: true });
			const streamer = new TerrainStreamer(this.frame, {
				onProgress: (d, t) =>
					!this.terrain &&
					onProgress?.(`Loading terrain ${d}/${t}`, t ? d / t : 0),
				onUpdate: (set) => {
					if (this.disposed) return;
					this.renderSet = set;
					if (!this.terrain) {
						this.loadAbort.signal.removeEventListener("abort", abort);
						resolve(set);
						return;
					}
					this.maybeSwapQueryTerrain(set);
					this.updateLayers();
					// new meshes: the geometry buffer no longer matches what is drawn
					this.invalidateGeometry();
				},
			});
			this.streamer = streamer;
			streamer.setWedge(wedge);
		});
	}

	/**
	 * The CPU queries keep reading one TerrainSet (three keeps its terrain fixed too), so labels,
	 * occlusion verdicts and profiles stay stable while the streamer refines. A later complete set
	 * replaces it only once the view has left the wedge the query set was selected for.
	 */
	private maybeSwapQueryTerrain(set: TerrainSet) {
		if (
			(set.stats?.pending ?? 0) > 0 ||
			!this.queryWedge ||
			!this.streamerWedge
		)
			return;
		const hf = hfovFromAspect(this.pose.vfov, this.aspect) / 2;
		const q = this.queryWedge;
		if (angleDiff(this.pose.yaw, q.headingDeg) + hf <= q.halfAngleDeg) return;
		this.terrain = set;
		this.queryWedge = this.streamerWedge;
		this.snaps.clear();
		this.vis.clear();
		this.profiles = undefined;
		if (this.geoSrcKind === "cpu") this.dropGeometrySources();
		this.buildTrails();
	}

	private pendingTrails?: RegionTrail[];

	setTrails(trails: RegionTrail[]) {
		if (!this.region || !this.terrain) {
			this.pendingTrails = trails; // init() applies them once the region arrives
			return;
		}
		this.region = { ...this.region, trails };
		this.buildTrails();
		this.updateLayers();
	}

	/** engine.ts buildTrails on the query terrain. */
	private buildTrails() {
		const t = this.terrain;
		if (!this.region || !t) return;
		this.trails = buildTrailSegments(
			this.region,
			this.frame,
			this.photo,
			(lat, lon) => t.heightAt(lat, lon),
			trailPalette(this.style),
		);
	}

	private streamerWedge?: ViewWedge;
	/** loadFullTerrain: the streamer keeps refining all around the eye (setPose no longer narrows it). */
	private fullWedge?: ViewWedge;
	/** loadFullTerrain completed (the query terrain is the 360° set and the horizon re-traced). */
	private fullTerrainDone = false;
	/** renderPoseView in progress: the photo-view terrain layer drops its near discard. */
	private poseView = false;

	private wedgeFor(pose: Pose): ViewWedge {
		return {
			headingDeg: pose.yaw,
			halfAngleDeg: Math.min(
				180,
				hfovFromAspect(pose.vfov, this.aspect) / 2 + 32,
			),
		};
	}

	resize(w: number, h: number) {
		this.cssSize = { w: Math.max(1, w), h: Math.max(1, h) };
		this.world?.setAspect(this.cssSize.w / this.cssSize.h);
		this.step?.map.setSize(this.cssSize.w, this.cssSize.h);
		this.updateLayers();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.unwatchContext();
		this.photoShared.release();
		this.tiles3d?.dispose();
		clearTimeout(this.statsTimer);
		clearTimeout(this.lookTimer);
		clearTimeout(this.idleTimer);
		if (this.warmHandle) cancelIdle(this.warmHandle);
		this.kept.clear();
		this.loadAbort.abort();
		this.fastHorizon?.dispose();
		this.streamer?.dispose();
		this.imagery.abort?.abort();
		for (const b of this.imagery.map.values()) b.close();
		this.imagery.map.clear();
		clearTimeout(this.geoTimer);
		clearTimeout(this.wedgeTimer);
		cancelAnimationFrame(this.worldRaf);
		cancelAnimationFrame(this.weatherRaf);
		cancelAnimationFrame(this.flowRaf);
		this.step?.cam.dispose();
		this.step = null;
		this.world?.dispose();
		for (const r of this.readbackWaiters) r(false);
		this.readbackWaiters = [];
		this.dropGeometrySources();
		this.silMask?.destroy();
		this.silMask = null;
		this.compositor.onChange = undefined;
		this.listeners.clear();
		this.deck.finalize();
		for (const t of this.drapeTex) t.destroy();
		this.drapeTex = [];
	}

	get photoElement() {
		return this.photoImg;
	}

	get isFlying() {
		return this.world?.isFlying ?? false;
	}

	get hasPeople() {
		return !!this.fgMask?.data.some((v) => v > 128);
	}

	/** Diagnostics for harnesses. */
	get stats(): DeckEngineStats {
		return {
			terrainTiles: this.renderSet?.tiles.length ?? 0,
			queryGeneration: this.terrain?.stats?.generation ?? null,
			profileBins: this.profiles?.binCount ?? 0,
			horizonSource: this.horizonSource,
			horizonDirs: (this.horizonDirs?.length ?? 0) / 3,
			peaks: this.peaks.length,
			snapped: [...this.snaps.values()].filter(Boolean).length,
			tested: this.vis.size,
			geoGen: this.geoGen,
			geoBufGen: this.geoBufGen,
			geometrySource: this.geoSrcKind,
			silhouette: this.silTiming,
			trailSegments: this.trails?.count ?? 0,
		};
	}

	/** The deck instance (for the GPU geometry pass / debugging). */
	get deckInstance() {
		return this.deck;
	}

	/**
	 * Performance counters for benches (window.__engine.metrics()): deck's once-a-second metrics
	 * (fps, cpu / gpu time per frame, layer and memory counts; `live` = its current object), luma's
	 * GPU memory and resource-count tables, the compositor's last pass timing, and this engine's
	 * counters (layers built vs reused, composite-only settings, interactions, context losses).
	 */
	metrics() {
		const deck = this.deck as unknown as {
			metrics?: Record<string, unknown>;
			device?: {
				statsManager?: {
					getStats(name: string): { getTable(): Record<string, unknown> };
				};
			};
		};
		const table = (name: string) => {
			try {
				return deck.device?.statsManager?.getStats(name).getTable() ?? null;
			} catch {
				return null;
			}
		};
		return {
			deck: this.deckMetrics,
			deckLive: deck.metrics ? { ...deck.metrics } : null,
			luma: {
				memory: table("GPU Time and Memory"),
				resources: table("GPU Resource Counts"),
			},
			composite: this.compositor.timing ? { ...this.compositor.timing } : null,
			engine: {
				...this.counters,
				interactive: this.interactive,
				lostNow: this.contextLost,
				photoTexWarm: this.photoTexWarm,
			},
		};
	}

	// ---------------- Renderer: state ----------------

	setPose(p: Pose) {
		this.pose = { ...p };
		this.noteInput();
		this.updateLayers();
		this.invalidateGeometry();
		// the DEM's high-detail wedge follows the view, ~300 ms after it settles
		clearTimeout(this.wedgeTimer);
		this.wedgeTimer = window.setTimeout(() => {
			if (this.disposed || !this.terrain) return;
			const w = this.fullWedge ?? this.wedgeFor(this.pose);
			this.streamerWedge = w;
			this.streamer?.setWedge(w);
		}, 300);
	}

	setSettings(s: Partial<Settings>) {
		if (this.step && s.mode !== undefined && s.mode !== this.settings.mode)
			this.exitStepInside(false);
		const prev = this.settings;
		this.settings = { ...prev, ...s };
		const cur = this.settings;
		if (cur.mode === "world" && prev.mode !== "world") this.enterWorld();
		if (cur.mode !== "world" && prev.mode === "world") this.exitWorld();
		const changed = (Object.keys(cur) as (keyof Settings)[]).filter(
			(k) => !sameValue(prev[k], cur[k]),
		);
		if (changed.some((k) => POINTER_SETTINGS.has(k))) this.noteInput();
		// the lens, swipe and blend sliders only change the composite pass: keep the terrain layers
		// (and with them the cached colour pass); PhotoWorkspace hands the whole Settings every time
		if (!this.world?.controls && changed.every((k) => COMPOSITE_ONLY.has(k))) {
			this.counters.compositeOnly++;
			this.compositor.setSettings(compositeFor(cur));
			this.updateComposite();
		} else this.updateLayers();
		this.scheduleLook();
	}

	/**
	 * Interaction tracking (pose drags, the lens / swipe following the pointer): a change within
	 * INPUT_IDLE_MS of the previous one starts an interaction, so a lone setPose (auto-align, a
	 * harness) still draws the full-quality frame. While it runs the compositor draws its colour
	 * pass the cheap way (setInteractive) and the geometry readback waits; INPUT_IDLE_MS after the
	 * last change inputIdle reads the geometry back, then restores the full-quality frame.
	 */
	private noteInput() {
		const now = performance.now();
		const burst = now - this.lastInputAt < INPUT_IDLE_MS;
		this.lastInputAt = now;
		if (burst && !this.interactive) {
			this.interactive = true;
			this.counters.interactions++;
			// the debounced readback of the previous change must not fire mid-drag
			clearTimeout(this.geoTimer);
			this.geoTimer = 0;
			this.compositor.setInteractive?.(true);
		}
		clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.inputIdle(), INPUT_IDLE_MS);
	}

	private inputIdle() {
		this.idleTimer = 0;
		if (!this.interactive || this.disposed) return;
		this.interactive = false;
		const restore = () => {
			// a new interaction may have started meanwhile
			if (!this.disposed && !this.interactive)
				this.compositor.setInteractive?.(false);
		};
		// read the geometry back before the full-quality frame is queued: the readback then waits
		// for no heavy frame (bounded, so a slow read never holds the quality back for long)
		if (this.terrain && !this.geometryReady() && !this.contextLost) {
			let t = 0;
			void Promise.race([
				this.refreshGeometry(),
				new Promise((r) => {
					t = window.setTimeout(r, 250);
				}),
			]).then(() => {
				clearTimeout(t);
				restore();
			});
		} else restore();
	}

	/** engine.ts scheduleLook: updateLook once a blend edit (range, feather, brush) settles. */
	private scheduleLook() {
		if (!this.style.composite.refine || !this.compositor.look.defines.length)
			return;
		clearTimeout(this.lookTimer);
		this.lookTimer = window.setTimeout(() => this.updateLook(), 150);
	}

	/**
	 * Apply a view style (src/lib/style) through deck-apply.ts: uniform values for the terrain,
	 * composite and trail layers, the world view's sky and photo-camera gizmo, the label count and
	 * export labels. No mesh rebuild; the tile programs rebuild only when the look's LOOK_* set
	 * changes (a preset, never a slider). The geometry pass reads none of it.
	 */
	setStyle(style: ViewStyle) {
		if (style === this.style) return;
		const prev = this.style;
		this.style = style;
		this.looks.clear();
		this.layerGen++;
		this.fitHaze();
		this.updateRelief();
		this.compositor.setStyle(deckCompositeStyle(style));
		this.updateLook();
		if (prev.trails.colors !== style.trails.colors && this.trails)
			this.trails = recolorTrailSegments(this.trails, trailPalette(style));
		const ws = deckWorldStyle(style);
		if (this.world) {
			this.world.planeOpacity = ws.planeOpacity;
			if (!this.world.flight) this.world.photoPlaneOpacity = ws.planeOpacity;
		}
		if (this.world?.controls) this.canvas.style.backgroundColor = ws.sky;
		this.updateLayers();
		if (this.world?.controls && waterWavesAnimate(style)) this.kickWorld();
	}

	/** The terrain uniforms of the current style for one view mode (bands: a band pass). */
	private look(mode: DeckStyleMode, bands = false): DeckTerrainStyle {
		const key = bands ? `${mode}:bands` : mode;
		let l = this.looks.get(key);
		if (!l) {
			l = deckTerrainStyle(
				this.style,
				mode,
				{
					takenAt: this.photo.takenAt,
					lat: this.photo.lat,
					lon: this.photo.lon,
				},
				this.haze.fit,
				bands,
			);
			this.looks.set(key, l);
		}
		return l;
	}

	/** engine.ts updateRelief, on the query terrain; true when a new field was built. */
	private updateRelief() {
		if (!this.terrain || !this.look("overlay").defines.includes("LOOK_RELIEF"))
			return false;
		const built = !!this.relief.update({
			tiles: this.terrain.tiles,
			frame: this.frame,
			sunDir: this.look("overlay").sunDir,
			yawDeg: this.pose.yaw,
		});
		if (built) this.layerGen++;
		return built;
	}

	/**
	 * Terroir land cover (src/lib/terroir, Renderer.setTerroirCover): the pack's class grid for
	 * style.terroir.cover / contours.inkByCover; null = off. Display-only: it reaches the terrain's
	 * colour programs (TERROIR_* defines), never the geometry pass's range.
	 */
	setTerroirCover(grid: CoverGrid | null) {
		if (grid === this.terroirGrid) return;
		this.terroirGrid = grid;
		this.layerGen++;
		this.updateLayers();
	}

	/** The terroir shading for the current style and cover (null = off: the classic programs). */
	private terroir(): TerroirShader | null {
		const m = this.terroirMemo;
		if (m && m.style === this.style && m.grid === this.terroirGrid) return m.t;
		const t = terroirShader(
			this.style,
			this.terroirGrid,
			this.frame,
			this.photo.takenAt,
		);
		this.terroirMemo = { style: this.style, grid: this.terroirGrid, t };
		return t;
	}

	/** concord DSM occluder dim mask (?concord=occl; row 0 = top, 255 = dim); null = off. Composite-only. */
	setOccluder(m: FgMask | null) {
		this.occluder = m;
		this.compositor.setOccluder(m);
	}

	/** The screen-view layers over the terrain: the composite, then the opt-in glow (null = no layer). */
	private screenLayers(): Layer[] {
		const out: Layer[] = [this.compositor.layer("screen-composite")];
		if (this.glow) out.push(this.glow.layer);
		return out;
	}

	/** style.labels.glow: glowing summit markers over the composite (null = off). Composite-only. */
	setGlowMarkers(m: GlowMarkers | null) {
		if (sameGlowMarkers(this.glow?.markers ?? null, m)) return;
		this.glow = m
			? {
					markers: m,
					layer: new GlowMarkerLayer({
						id: "screen-glow",
						markers: m,
					}) as never,
				}
			: null;
		this.updateComposite();
	}

	/** One frame of the overlay reveal (src/lib/reveal); null = off. Composite-only: no terrain pass. */
	setReveal(r: RevealUniforms | null) {
		this.compositor.setReveal(r);
	}

	/** P(sky) of the photo (#/lib/sky segmentSky, row 0 = top): the haze fit's sky. */
	setSkyMask(mask: SkyMask | null) {
		this.skyMaskStore = mask;
		this.haze.setSky(mask);
		this.compLook.setSky(mask);
		this.fitHaze();
		this.updateLook();
	}

	/** The geometry buffer as a range grid (row 0 = top). */
	private rangeGrid(): RangeGrid | null {
		const src = this.geoSrc;
		if (!src?.pose) return null;
		const { width: w, height: h, range } = src;
		return { w, h, at: (x, y) => range[y * w + x] };
	}

	/**
	 * engine.ts updateLook + applyCompositeLook: the look composite's CPU side after a fresh
	 * geometry buffer (refined masks, photo noise) and the compositor's look (defines, values,
	 * masks). The values read the live state, so a pose change turns the refined masks off at once.
	 */
	private updateLook() {
		const defines = lookKey(this.style).filter((d) =>
			(COMPOSITE_DEFINES as readonly string[]).includes(d),
		);
		const grid = this.geometryReady() ? this.rangeGrid() : null;
		if (defines.length && grid) {
			this.compLook.updateMasks({
				style: this.style,
				gen: this.geoBufGen,
				img: this.photoImg,
				fg: this.fgMask,
				cut:
					this.settings.mode === "replace"
						? blendCut(
								this.settings,
								this.compositor.brushCanvas,
								this.brushVersion,
							)
						: null,
				geo: () => grid,
			});
			this.compLook.updateNoise(this.style, this.photoImg, () => grid);
		}
		// classic stays classic: no look, no extra redraw
		if (!defines.length && !this.compositor.look.defines.length) return;
		const L = this.compLook;
		const c = this.style.composite;
		this.compositor.setLook({
			defines,
			values: (outW, outH) =>
				compositeValues(this.style, {
					outW,
					outH,
					refine: L.masks?.gen === this.geoGen,
					// the normal pass is drawn at settle: creases only while it matches the pose
					crease: this.compositor.look.normal === this.geoGen,
					cut:
						!!L.masks?.cut &&
						L.masks.cut === blendCutKey(this.settings, this.brushVersion),
					premul:
						this.settings.mode === "replace" &&
						this.settings.mapStyle !== "bands",
					noise: L.noise,
					photoW: this.photo.width,
					visibility: this.haze.fit?.visibility,
				}),
			harmonize: harmonizeValues(L.stats, c.harmonize),
			mask: L.masks,
			normal:
				defines.includes("LOOK_INK") && c.ink.crease > 0 && grid
					? this.geoBufGen
					: this.compositor.look.normal,
		});
	}

	/** The band stats' key: what their layer depends on (geometry, look, mode, imagery so far). */
	private statsKey() {
		const s = this.settings;
		return `${this.geoBufGen}|${this.layerGen}|${s.mode}|${s.mapStyle}|${s.worldStyle}|${this.imagery.key}|${this.imagery.map.size}`;
	}

	/**
	 * engine.ts layerStats: band stats (LOOK_HARMONIZE) of the replace layer or the world's own
	 * render, drawn at ≤ 256 px through the photo camera once the pose settles (and as imagery streams in).
	 * The layer is read back fenced (compositor.readLayerAsync) unless `syncStats`: the stats land a
	 * frame or more after the settle frame (with ?lookgpu they already did) and only if the key still
	 * stands (otherwise the newer state is scheduled); export waits for them (trackLook → lookIdle).
	 */
	private scheduleStats() {
		const s = this.settings;
		const amount =
			s.mode === "world"
				? this.style.world.drapeHarmonize
				: s.mode === "replace"
					? this.style.composite.harmonize
					: 0;
		const key = this.statsKey();
		if (
			!lookKey(this.style).includes("LOOK_HARMONIZE") ||
			!this.geometryReady() ||
			!this.photoImg ||
			!this.compLook.wantsStats(amount, key) ||
			this.statsPending === key ||
			this.statsTimer
		)
			return;
		this.statsTimer = window.setTimeout(() => {
			this.statsTimer = 0;
			const grid = this.rangeGrid();
			const img = this.photoImg;
			if (this.disposed || !this.geometryReady() || !grid || !img) return;
			this.flushLayers();
			const [w, h] = gridSize(this.aspect, STATS_LONG_SIDE);
			if (this.syncStats) {
				const layer = this.compositor.readLayer(
					this.liveLayers(),
					this.pose,
					this.eyeArr,
					w,
					h,
				);
				if (layer) this.landStats(key, layer, w, h, grid, img);
				return;
			}
			// the key of the state this render actually draws (it may have moved on since the schedule)
			const drawn = this.statsKey();
			this.statsPending = drawn;
			trackLook(
				this.compositor
					.readLayerAsync(this.liveLayers(), this.pose, this.eyeArr, w, h)
					.then(
						(layer) => {
							if (this.statsPending === drawn) this.statsPending = null;
							if (this.disposed) return;
							const g = this.rangeGrid();
							const im = this.photoImg;
							if (
								layer &&
								this.statsKey() === drawn &&
								this.geometryReady() &&
								g &&
								im
							)
								this.landStats(drawn, layer, w, h, g, im);
							// superseded: the state that stands now asks again (a lost context's
							// null waits for the rebuild's updateLayers)
							else if (layer) this.scheduleStats();
						},
						(e) => {
							if (this.statsPending === drawn) this.statsPending = null;
							if (!this.disposed)
								console.warn("[deck-engine] band stats readback failed", e);
						},
					),
			);
		}, 120);
	}

	/** Hand a band-stats layer (readLayer's GL rows) to the look composite and apply the stats. */
	private landStats(
		key: string,
		layer: Float32Array,
		w: number,
		h: number,
		geo: RangeGrid,
		img: HTMLImageElement,
	) {
		this.compLook.setStats({
			key,
			img,
			layer,
			w,
			h,
			geo,
			fg: this.fgMask,
			minRange: trustedRange(this.photo.hAccuracy),
		});
		this.updateLook();
		if (this.world?.controls) this.updateLayers();
	}

	/** The haze fit (look/haze-controller), for the atmosphere and dev tools. */
	get hazeFit() {
		return this.haze.fit;
	}

	/** engine.ts fitHaze, from the range buffer and the pixel rays. */
	private fitHaze() {
		const src = this.geoSrc;
		if (!this.geometryReady() || !src?.pose) return;
		const pose = src.pose;
		// the fit reads the PHOTO-pose buffer (geoSrc only ever renders this.pose; orbit readbacks
		// use other sources): skip a buffer left over from a pose the photo has since left
		if (this.world?.controls && !samePose(pose, this.pose)) return;
		const fitted = this.haze.update({
			style: this.style,
			pose,
			img: this.photoImg,
			eyeAlt: this.eyeAlt,
			sunDir: this.look("overlay").sunDir,
			// clear air needs the fit in the world view too (never fitted just for it elsewhere)
			want: !!this.world?.controls && wantsClearAirFit(this.style),
			fg: this.fgMask,
			geo: () => ({
				geo: rangeGeo(src.range, src.width, src.height, pose),
				w: src.width,
				h: src.height,
			}),
		});
		if (fitted) {
			this.looks.clear();
			this.layerGen++;
			this.updateLayers();
		}
	}

	// ---------------- rendering ----------------

	private viewState() {
		if (this.world?.controls) {
			const map = this.step?.map;
			return {
				world: this.world.viewState(this.eyeVec),
				...(map?.active ? { [MAP_VIEW_ID]: map.viewState } : {}),
			};
		}
		const { w, h } = this.cssSize;
		return {
			screen: { target: [w / 2, h / 2, 0], zoom: 0 },
			photo: { ...this.pose, eye: [this.eye.x, this.eye.y, this.eye.z] },
		};
	}

	/**
	 * engine.ts renderNow as deck layers: the terrain (layer pass style, offscreen) + trails, both
	 * drawn by the compositor's offscreen passes, and the composite on screen.
	 */
	private updateLayers() {
		if (this.disposed) return;
		if (this.world?.controls) {
			// splats stand metres from the eye: the classic 5 m near plane would cut them (engine.ts)
			const near = this.step ? 0.3 : this.nearField ? 1 : 5;
			if (near !== this.worldNear) {
				this.worldNear = near;
				this.worldViews = [new WorldView({ id: "world", near, far: 600_000 })];
				this.syncWorldViews();
			}
			this.nextKept = new Map();
			const layers = this.worldLayers();
			this.kept = this.nextKept;
			this.deck.setProps({
				viewState: this.viewState(),
				layers,
			} as never);
			this.scheduleStats();
			return;
		}
		const look = terrainLookFor(this.settings);
		this.compositor.setSettings(compositeFor(this.settings));
		const layers: Layer[] = [];
		const set = this.renderSet;
		this.nextKept = new Map();
		if (set && this.terrain) {
			const imagery = look.imagery
				? this.syncImagery(set, look.imagery)
				: undefined;
			layers.push(
				this.keepLayer(TerrainLayer, {
					id: "terrain",
					tiles: set.tiles,
					imagery,
					style: look.style,
					look: this.look(look.mode, look.style === "elevation"),
					contourInterval: look.contourInterval,
					contourOpacity: look.contourOpacity,
					nearFade: look.nearFade,
					// renderPoseView: the whole DEM, like the matcher's three.js renders had
					nearDiscard: this.poseView ? 0 : nearFadeFor(this.photo.hAccuracy),
					elevRange: deckElevRange(this.style, this.elevRange) ?? undefined,
					relief: this.relief.field,
					terroir: this.terroir(),
					offscreen: true,
					// the world drape's texture, kept across mode switches (the photo view never samples
					// it: projectPhoto is 0 in its offscreen passes); see warmPhotoTexture
					...(this.photoTexWarm ? { photoTexture: this.photoTexture() } : {}),
				}),
			);
			if (look.trails && this.trails?.count)
				layers.push(
					this.keepLayer(TrailLayer, {
						id: "trails",
						segments: this.trails,
						widthPx: this.style.trails.width,
						lineOpacity: this.style.trails.opacity,
						dash: this.style.trails.dash,
						stroke: this.style.trails.stroke,
					}),
				);
		}
		this.kept = this.nextKept;
		// Step Inside splats draw only in the world / step view (engine.ts NEARFIELD_LAYER): the photo view
		// shows the photo
		this.sceneLayers = layers;
		this.deck.setProps({
			viewState: this.viewState(),
			layers: [...layers, ...this.screenLayers()],
		} as never);
		this.scheduleStats();
	}

	/**
	 * `new Ctor(props)`, or the instance the last updateLayers passed to deck under this id when it
	 * was made from equal props (sameProps: identity, or equal small numeric arrays). Deck then
	 * skips the layer's diff, a composite layer keeps its sublayers, and the compositor's colour
	 * pass (keyed on the layer instances) stays cached. Only layers still live in deck are reused.
	 */
	private keepLayer<C extends new (...props: never[]) => unknown>(
		Ctor: C,
		props: ConstructorParameters<C>[0] & { id: string },
	): Layer {
		const p = props as unknown as Record<string, unknown>;
		const id = p.id as string;
		const k = this.kept.get(id);
		if (k && k.ctor === Ctor && sameProps(k.props, p)) {
			this.counters.layersKept++;
			this.nextKept.set(id, k);
			return k.layer;
		}
		const layer = new (Ctor as unknown as new (p: unknown) => Layer)(props);
		this.counters.layerBuilds++;
		this.nextKept.set(id, { layer, ctor: Ctor, props: p });
		return layer;
	}

	/** photoViewProjection of the current pose, memoised (a stable array for layer props). */
	private photoViewProj(): number[] {
		const p = this.pose;
		const key = [p.yaw, p.pitch, p.roll, p.vfov, ...this.eyeArr, this.aspect];
		if (!this.pvp || !sameValue(this.pvp.key, key))
			this.pvp = {
				key,
				arr: Array.from(photoViewProjection(p, this.eyeArr, this.aspect)),
			};
		return this.pvp.arr;
	}

	/** clearAirValues (world drape) memoised on its inputs: a stable object for layer props. */
	private clearAir() {
		const fit = this.haze.fit;
		const p = this.pose;
		const key = `${p.yaw},${p.pitch},${p.roll},${p.vfov},${this.aspect},${this.eyeAlt}`;
		const c = this.clearAirMemo;
		if (c && c.style === this.style && c.fit === fit && c.key === key)
			return c.value;
		const d = unprojectDir(this.pose, this.aspect, 0.5, 0.5);
		const value = clearAirValues(this.style, fit, this.look("world").sunDir, {
			eyeAlt: this.eyeAlt,
			dir: [d.x, d.y, d.z],
		});
		this.clearAirMemo = { style: this.style, fit, key, value };
		return value;
	}

	/** harmonizeValues memoised on its inputs (a stable object for layer props). */
	private harmonize(amount: number) {
		const stats = this.compLook.stats;
		if (!this.harm || this.harm.stats !== stats || this.harm.amount !== amount)
			this.harm = { stats, amount, value: harmonizeValues(stats, amount) };
		return this.harm.value;
	}

	/** The shared photo texture on the deck device (uploaded on first use), or null before deck has one. */
	private photoTexture() {
		const device = (this.deck as unknown as { device?: Device }).device;
		return (device && this.photoShared.get(device)) ?? null;
	}

	/**
	 * Upload the world drape's photo texture ahead of the first world entry, when the browser is
	 * idle (about 90 ms for a 2048 px photo with mips) and no interaction runs. From then on the
	 * photo-view terrain layer carries it too, so no mode switch re-creates it.
	 */
	private warmPhotoTexture() {
		if (this.photoTexWarm || this.warmHandle || this.disposed) return;
		this.warmHandle = requestIdle(() => {
			this.warmHandle = 0;
			if (this.disposed || this.photoTexWarm) return;
			if (this.interactive || !this.photoImg) {
				this.warmPhotoTexture();
				return;
			}
			this.photoTexWarm = true;
			this.updateLayers();
		});
	}

	/**
	 * A composite-only change (reveal frame, brush, masks, look): swap in a new composite layer and
	 * pass the SAME terrain / trail layer instances, so deck skips their diff and the compositor's
	 * colour pass (keyed on the layer instances) stays cached. Rebuilding them here re-rendered the
	 * whole terrain, MSAA and all, on every reveal frame.
	 */
	private updateComposite() {
		if (this.disposed) return;
		if (this.world?.controls) return this.updateLayers();
		this.deck.setProps({
			layers: [...this.sceneLayers, ...this.screenLayers()],
		} as never);
	}

	/** Apply pending layer props now (deck otherwise does it at the next animation frame). */
	private flushLayers() {
		(
			this.deck as unknown as { layerManager?: { updateLayers(): void } }
		).layerManager?.updateLayers();
	}

	private liveLayers(): Layer[] {
		return (
			(
				this.deck as unknown as { layerManager?: { getLayers(): Layer[] } }
			).layerManager?.getLayers() ?? []
		);
	}

	/** CR-14: bound the bitmap cache (LRU, render-set tiles kept); `bump` re-snapshots for the layers. */
	private evictImagery(bump: boolean) {
		const c = this.imagery;
		const gone = evictImagery(c.map, c.keep, IMAGERY_CACHE_CAP_BYTES, (b) =>
			b.close(),
		);
		if (gone.length && bump) c.version++;
	}

	/** Imagery for `set`, fetched incrementally per tile (deck.tsx's cache), keyed by source. */
	private syncImagery(
		set: TerrainSet,
		src: ImagerySource,
		order?: () => (a: TileMesh, b: TileMesh) => number,
	) {
		const c = this.imagery;
		if (c.key !== src) {
			c.abort?.abort();
			c.abort = null;
			for (const b of c.map.values()) b.close();
			c.key = src;
			c.map = new Map();
			c.version++;
		}
		c.keep = new Set([
			...set.tiles.map((t) => t.id),
			...(this.renderSet?.tiles ?? []).map((t) => t.id),
		]);
		touchImagery(c.map, c.keep);
		this.evictImagery(true);
		const missing = set.tiles.filter((t) => !c.map.has(t.id));
		if (order && missing.length > 1) missing.sort(order());
		if (missing.length && !c.abort) {
			const ac = new AbortController();
			c.abort = ac;
			let n = 0;
			loadImagery(
				missing,
				src,
				(id, bmp) => {
					if (ac.signal.aborted) return bmp.close();
					c.map.set(id, bmp);
					this.evictImagery(true);
					c.version++;
					if (n++ % 6 === 0) this.updateLayers();
				},
				ac.signal,
			).finally(() => {
				if (c.abort === ac) c.abort = null;
				if (!ac.signal.aborted) this.updateLayers();
			});
		}
		// a new Map only when a tile arrived (the layers compare it by identity): an unchanged
		// imagery set keeps the terrain layer, and the cached colour pass, as they are
		if (!c.snap || c.snapVersion !== c.version) {
			c.snap = new Map(c.map);
			c.snapVersion = c.version;
		}
		return c.snap;
	}

	// ---------------- horizon ----------------

	/** engine.ts startFastHorizon: the terrain wedge (yaw search ±25° + half the frame), or 360°. */
	private startFastHorizon(): FastHorizon | undefined {
		if (typeof Worker === "undefined") return undefined;
		try {
			const half = hfovFromAspect(this.prior.vfov, this.aspect) / 2 + 34;
			const full = this.unknowns.any || half >= 180;
			return startFastHorizon({
				lat: this.photo.lat,
				lon: this.photo.lon,
				az0: full ? 0 : this.prior.yaw - half,
				az1: full ? 360 : this.prior.yaw + half,
				signal: this.loadAbort.signal,
			});
		} catch (e) {
			console.warn(
				"[deck-engine] horizon-fast unavailable, using the CPU profile horizon",
				e,
			);
			return undefined;
		}
	}

	private takeFastHorizon() {
		const r = this.fastHorizon?.take(this.eyeAlt);
		if (!r || r.dirs.length < 300) return null;
		this.fastHorizon = undefined;
		this.horizonSource = "fast";
		return r.dirs;
	}

	/** horizon-fast first; the CPU profile horizon if it fails, is too sparse or takes > 10 s. */
	private async traceHorizon(): Promise<Float32Array> {
		const fast = this.fastHorizon;
		this.fastHorizon = undefined;
		if (fast) {
			let timer = 0;
			try {
				const timeout = new Promise<never>((_, reject) => {
					timer = window.setTimeout(
						() => reject(new Error("timed out")),
						10_000,
					);
				});
				const r = await Promise.race([fast.dirs(this.eyeAlt), timeout]);
				if (r.dirs.length >= 300) {
					this.horizonSource = "fast";
					return r.dirs;
				}
				console.warn(
					`[deck-engine] horizon-fast returned ${r.dirs.length / 3} directions, using the CPU horizon`,
				);
			} catch (e) {
				if (this.disposed) return new Float32Array(0);
				console.warn(
					"[deck-engine] horizon-fast failed, using the CPU horizon",
					e,
				);
			} finally {
				clearTimeout(timer);
				fast.dispose();
			}
		}
		this.horizonSource = "cpu";
		return (
			this.getProfiles()?.horizonDirs(0.2, 60, this.loadAbort.signal) ??
			new Float32Array(0)
		);
	}

	// ---------------- queries ----------------

	private get eyeArr(): [number, number, number] {
		return [this.eye.x, this.eye.y, this.eye.z];
	}

	private getProfiles() {
		const t = this.terrain;
		if (!t) return null;
		if (
			!this.profiles ||
			this.profiles.terrain !== t ||
			this.profiles.eyeZ !== this.eye.z
		)
			this.profiles = new TerrainProfiles(t, this.eye.z);
		return this.profiles;
	}

	// ---- geometry buffer (engine.ts geoRT / geoBuf / readback) ----

	/** The geometry no longer matches the buffer (pose or meshes changed): re-read it 90 ms later. */
	private invalidateGeometry() {
		this.geoGen++;
		clearTimeout(this.geoTimer);
		this.geoTimer = 0;
		// mid-interaction the readback waits for input idle (inputIdle), never a pause in the frames
		if (!this.terrain || this.disposed || this.interactive || this.contextLost)
			return;
		// the float readback (labels, hover) waits until the pose stops changing; readback() forces it
		this.geoTimer = window.setTimeout(() => {
			this.geoTimer = 0;
			void this.refreshGeometry();
		}, 90);
	}

	/**
	 * The query GeometrySource: the GPU pass on this Deck at geoRT's size (1024 px long side) with
	 * xyz, or the CPU profile source if the GPU one can't be made (no float targets, no device).
	 */
	private makeSource(
		width: number,
		height: number,
		xyz: boolean,
	): { src: GeometrySource; kind: "gpu" | "cpu" } | null {
		if (this.geometryFactory)
			return { src: this.geometryFactory(width, height), kind: "gpu" };
		try {
			return {
				src: new GpuGeometrySource(this.deck, this.eyeArr, width, height, {
					xyz,
				}),
				kind: "gpu",
			};
		} catch (e) {
			console.warn(
				"[deck-engine] GPU geometry pass unavailable, using CPU profiles",
				e,
			);
			const prof = this.getProfiles();
			return prof
				? {
						src: new CpuGeometrySource(
							prof,
							this.eyeArr,
							this.aspect,
							width,
							height,
						),
						kind: "cpu",
					}
				: null;
		}
	}

	private dropGeometrySources() {
		this.geoSrc?.dispose?.();
		for (const s of this.silSources) s.dispose?.();
		this.geoSrc = undefined;
		this.silSources = [];
		this.geoSrcKind = null;
	}

	/** Waits until the Deck's programs have linked (waitForPrograms); a no-op before the device exists. */
	private settlePrograms = () => {
		const device = (
			this.deck as unknown as { device?: Parameters<typeof pendingPrograms>[0] }
		)?.device;
		return device ? waitForPrograms(device) : Promise.resolve(true);
	};

	/** Render + read back the geometry for the current pose; true if the buffer is fresh after. */
	private async refreshGeometry(): Promise<boolean> {
		if (this.disposed || !this.terrain || this.contextLost) return false;
		await this.deckReady;
		if (this.disposed) return false;
		if (!this.geoSrc) {
			const { width, height } = geometrySize(this.aspect);
			const made = this.makeSource(width, height, true);
			if (!made) return false;
			this.geoSrc = made.src;
			this.geoSrcKind = made.kind;
		}
		const gen = this.geoGen;
		const pose = { ...this.pose };
		this.flushLayers();
		await this.geoSrc.render(pose);
		// the first pass of a fresh page can draw nothing while its programs link: draw it again
		if (!this.disposed && this.geoSrc)
			await redrawIfBlank(this.geoSrc, pose, this.settlePrograms);
		if (this.disposed) return false;
		const got = this.geoSrc?.pose; // undefined after a context restore dropped the source
		// a newer pose / mesh change arrived meanwhile: its own refresh takes over
		if (gen !== this.geoGen || !got || !samePose(got, pose))
			return this.geometryReady();
		this.geoBufGen = gen;
		this.fitHaze();
		this.updateLook();
		if (this.updateRelief()) this.updateLayers();
		// the world view's drape reads this buffer (its range map)
		if (this.world?.controls) this.updateLayers();
		const w = this.readbackWaiters;
		this.readbackWaiters = [];
		for (const r of w) r(true);
		this.emit();
		return true;
	}

	/**
	 * Resolves once the geometry buffer describes the current pose (true), or false if the engine
	 * is disposed first. With terrain it renders + reads back now instead of waiting for the
	 * debounced readback, so `setPose(p); await engine.readback()` always gives a fresh buffer.
	 */
	async readback(): Promise<boolean> {
		if (this.geometryReady()) return true;
		if (this.disposed) return false;
		if (!this.terrain)
			return new Promise((res) => this.readbackWaiters.push(res));
		clearTimeout(this.geoTimer);
		this.geoTimer = 0;
		// a pose / mesh change during the async readback supersedes it: try again (bounded)
		for (let i = 0; i < 4 && !this.disposed; i++)
			if (await this.refreshGeometry()) return true;
		return this.geometryReady();
	}

	/** True when the geometry buffer (sampleAt, peak occlusion, hover) describes the current pose. */
	geometryReady() {
		return (
			!this.disposed && this.geoBufGen >= 0 && this.geoBufGen === this.geoGen
		);
	}

	/** Generation counter of the geometry (bumps on every pose / terrain change). */
	get geometryGeneration() {
		return this.geoGen;
	}

	/** Terrain under a normalised photo coordinate (u right, v down), from the geometry buffer. */
	sampleAt(u: number, v: number): Sample | null {
		const src = this.geoSrc;
		if (!src?.pose) return null;
		const w = src.width;
		const h = src.height;
		const x = Math.floor(u * w);
		const y = Math.floor(v * h);
		if (x < 0 || y < 0 || x >= w || y >= h) return null;
		const i = y * w + x;
		const range = src.range[i];
		if (!(range > 0) || !Number.isFinite(range)) return null;
		let world: [number, number, number];
		// a GPU source computes the one pixel on demand (its full xyz array is lazy)
		const lazy = src instanceof GpuGeometrySource ? src.xyzAt(i) : null;
		if (lazy) world = lazy;
		else if (src.xyz)
			world = [src.xyz[i * 3], src.xyz[i * 3 + 1], src.xyz[i * 3 + 2]];
		else {
			// the buffer's own pose (not the current one): a stale buffer must look stale
			const d = unprojectDir(
				src.pose,
				this.aspect,
				(x + 0.5) / w,
				(y + 0.5) / h,
			);
			world = [
				this.eye.x + d.x * range,
				this.eye.y + d.y * range,
				this.eye.z + d.z * range,
			];
		}
		const g = this.frame.toGeo(world[0], world[1], world[2]);
		return { lat: g.lat, lon: g.lon, h: g.h, range, world };
	}

	isForeground(u: number, v: number) {
		const m = this.fgMask;
		if (!m) return false;
		const x = Math.min(m.width - 1, Math.max(0, Math.floor(u * m.width)));
		const y = Math.min(m.height - 1, Math.max(0, Math.floor(v * m.height)));
		return m.data[y * m.width + x] > 128;
	}

	private snapped(pose: Pose) {
		if (!this.terrain || !this.peaks.length) return [];
		return snapPeaksNear(
			this.terrain,
			this.peaks,
			this.photo,
			pose,
			this.eyeArr,
			this.aspect,
			this.snaps,
		);
	}

	/**
	 * engine.ts peakLabels: occlusion from the geometry buffer only when it matches the current
	 * pose (a couple of pixels below the summit); while it lags, a peak keeps the verdict from the
	 * last fresh buffer (occlusion depends on the eye, not the rotation) and an untested peak gets
	 * no label. Then the people mask, rank and declutter (scene.ts placePeakLabels); `declutter:
	 * false` gives every visible peak, ranked, for the panorama / inline layouts.
	 */
	peakLabels(
		max = this.style.labels.maxLabels,
		{ declutter = true } = {},
	): PeakLabel[] {
		const t = this.terrain;
		if (!t) return [];
		const snapped = this.snapped(this.pose);
		const eyeV = new THREE.Vector3(...this.eyeArr);
		if (this.geometryReady() && !this.occlusionFresh(snapped))
			for (const p of snapped) {
				const pr = projectPoint(this.pose, this.aspect, eyeV, p.position);
				if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
				const range = Math.hypot(
					p.position[0] - this.eye.x,
					p.position[1] - this.eye.y,
					p.position[2] - this.eye.z,
				);
				let visible = false;
				for (const dv of OCC_DVS) {
					const s = this.sampleAt(pr.u, pr.v + dv);
					if (!s || s.range > occThreshold(range)) visible = true;
				}
				this.vis.set(p, visible);
			}
		let vis = this.vis;
		if (this.settings.protectPeople && this.fgMask) {
			vis = new Map(vis);
			for (const p of snapped) {
				if (vis.get(p) !== true) continue;
				const pr = projectPoint(this.pose, this.aspect, eyeV, p.position);
				if (pr && this.isForeground(pr.u, pr.v)) vis.set(p, false);
			}
		}
		return placePeakLabels(snapped, vis, this.pose, this.eyeArr, this.aspect, {
			max,
			declutter,
		})
			.slice(0, max)
			.map((l) => ({
				name: l.name,
				ele: l.ele,
				prominence: l.prominence,
				u: l.u,
				v: l.v,
				distKm: l.distKm,
				rank: l.rank,
				visible: true,
				world: l.position,
			}));
	}

	/**
	 * What the occlusion verdicts in `vis` were computed from: the geometry buffer (generation + source),
	 * the pose, eye and aspect the peaks are projected with, and the snapped peak objects themselves
	 * (`vis` is keyed by identity, so a re-snap or a terrain swap changes the list). The loop reads
	 * nothing else (protectPeople / the people mask / max / declutter apply after it).
	 */
	private occKey?: {
		gen: number;
		src: unknown;
		pose: Pose;
		eye: { x: number; y: number; z: number };
		aspect: number;
		snapped: SnappedPeak[];
	};

	/** True when the cached verdicts still match every input; otherwise records the new key (the caller recomputes). */
	private occlusionFresh(snapped: SnappedPeak[]) {
		const k = this.occKey;
		if (
			k &&
			k.gen === this.geoBufGen &&
			k.src === this.geoSrc &&
			samePose(k.pose, this.pose) &&
			k.eye.x === this.eye.x &&
			k.eye.y === this.eye.y &&
			k.eye.z === this.eye.z &&
			k.aspect === this.aspect &&
			k.snapped.length === snapped.length &&
			k.snapped.every((p, i) => p === snapped[i])
		)
			return true;
		this.occKey = {
			gen: this.geoBufGen,
			src: this.geoSrc,
			pose: { ...this.pose },
			eye: { ...this.eye },
			aspect: this.aspect,
			snapped,
		};
		return false;
	}

	private skyCache?: { gen: number; sky: Float32Array };

	/** Per-column skyline (fraction of the height from the top) of the fresh geometry buffer, else null. */
	skyline(): Float32Array | null {
		const src = this.geoSrc;
		if (!this.geometryReady() || !src?.pose) return null;
		if (this.skyCache?.gen !== this.geoBufGen)
			this.skyCache = {
				gen: this.geoBufGen,
				sky: skylineAt(src.range, src.width, src.height, {
					rowsTopDown: true,
					stride: 1,
					channel: 0,
				}),
			};
		return this.skyCache.sky;
	}

	/** All candidate peaks in frame (for pinning), visible or not. */
	peaksInFrame(): PeakLabel[] {
		const out: PeakLabel[] = [];
		const eyeV = new THREE.Vector3(...this.eyeArr);
		for (const p of this.snapped(this.pose)) {
			const pr = projectPoint(this.pose, this.aspect, eyeV, p.position);
			if (!pr || pr.u < -0.1 || pr.u > 1.1 || pr.v < -0.1 || pr.v > 1.1)
				continue;
			out.push({
				name: p.name,
				ele: p.ele,
				u: pr.u,
				v: pr.v,
				distKm: pr.depth / 1000,
				rank: 0,
				visible: true,
				world: p.position,
			});
		}
		return out;
	}

	// ---------------- alignment ----------------

	/**
	 * engine.ts autoAlign: skyline search (align.ts) ±25° around the prior (±6° from the current
	 * pose), then the finalists re-ranked with inner silhouettes rendered into a GeometrySource.
	 */
	async autoAlign(fromPrior = true): Promise<AlignResult | null> {
		if (!this.horizonDirs || !this.edge) return null;
		const tSearch = performance.now();
		// coarse grid on the WebGPU compute device when available (CPU otherwise; same result)
		const res = await autoAlignAsync(
			fromPrior ? this.prior : this.pose,
			this.aspect,
			this.horizonDirs,
			this.edge,
			fromPrior ? 25 : 6,
		);
		if (this.disposed) return null;
		const alts = res.alternatives;
		if (!alts || alts.length < 2) return res;
		const scored: { pose: Pose; score: number; sil: number; total: number }[] =
			[];
		const t0 = performance.now();
		await this.deckReady;
		this.flushLayers();
		const srcs = alts.map((_, i) => this.silhouetteSource(i));
		let sil: SilScores | null = this.silhouetteGpu
			? await this.silhouetteScoresGpu(alts, srcs)
			: null;
		if (this.disposed) return null;
		if (!sil) {
			// all hypotheses are submitted at once and their async readbacks overlap (three renders
			// and reads each one back synchronously)
			await Promise.all(alts.map((a, i) => srcs[i]?.render(a.pose)));
			if (this.disposed) return null;
			// a blank render (a draw that did not happen) is drawn again before it is scored
			let redraws = 0;
			for (let i = 0; i < alts.length; i++) {
				const s = srcs[i];
				if (s && (await redrawIfBlank(s, alts[i].pose, this.settlePrograms)))
					redraws++;
			}
			if (this.disposed) return null;
			const tScore = performance.now();
			const sils = srcs.map((s) => this.scoreSilhouette(s));
			let bytes = 0;
			for (const s of srcs)
				if (s instanceof GpuGeometrySource) bytes += s.readBytes;
			sil = { sils, tScore, bytes, fallbacks: 0, redraws, path: "cpu" };
		}
		for (let i = 0; i < alts.length; i++) {
			const s = sil.sils[i];
			scored.push({ ...alts[i], sil: s, total: alts[i].score + 0.5 * s });
		}
		this.silTiming = {
			renders: alts.length,
			ms: performance.now() - t0,
			searchMs: t0 - tSearch,
			scoreMs: performance.now() - sil.tScore,
			path: sil.path,
			bytes: sil.bytes,
			fallbacks: sil.fallbacks,
			redraws: sil.redraws,
		};
		const ranked = scored.sort((a, b) => b.total - a.total);
		const best = ranked[0];
		const second = ranked.find((r) => Math.abs(r.pose.yaw - best.pose.yaw) > 3);
		const margin = second
			? (best.total - second.total) / Math.max(Math.abs(best.total), 1e-3)
			: 1;
		const confidence =
			Math.max(0, Math.min(1, margin * 4)) *
			Math.min(1, Math.max(0, best.score * 2.5));
		return {
			pose: best.pose,
			score: best.total,
			confidence,
			alternatives: ranked,
		};
	}

	/**
	 * The re-rank's scores from GPU masks (silhouette-mask.ts): every pose drawn into its source's
	 * target, one mask pass + one 18 KB-per-pose readback, then the CPU scorer's sum over the set
	 * bits. A pose the GPU can't decide is read back and scored on the CPU (same render). null =
	 * not possible (non-GPU sources, context lost…): the caller takes the CPU path, from scratch.
	 */
	private async silhouetteScoresGpu(
		alts: { pose: Pose }[],
		srcs: (GeometrySource | null)[],
	): Promise<SilScores | null> {
		const gs: GpuGeometrySource[] = [];
		for (const s of srcs) if (s instanceof GpuGeometrySource) gs.push(s);
		if (!gs.length || gs.length !== alts.length) return null;
		const { width: W, height: H, device } = gs[0];
		if (this.silMask?.device !== device) {
			this.silMask?.destroy();
			this.silMask = new SilhouetteMaskGL(device);
		}
		const seqs: number[] = [];
		for (let i = 0; i < alts.length; i++) {
			if (!gs[i].drawOnly(alts[i].pose)) return null;
			seqs.push(gs[i].drawSeq);
		}
		const nonce = silNonce();
		const words = await this.silMask.run(
			gs.map((s) => s.texture),
			W,
			H,
			nonce,
		);
		const edge = this.edge;
		if (!words || this.disposed || !edge) return null;
		const tScore = performance.now();
		let bytes = this.silMask.lastBytes;
		let fallbacks = 0;
		let redraws = 0;
		const per = silMaskWords(W, H);
		const sils: number[] = [];
		for (let i = 0; i < gs.length; i++) {
			let s = scoreFromMask(words, i * per, W, H, edge, nonce);
			if (s === null) {
				fallbacks++;
				// the same draw the mask read, or nothing (a concurrent autoAlign redrew it)
				if (!(await gs[i].readDrawn(seqs[i], alts[i].pose)) || this.disposed)
					return null;
				bytes += gs[i].readBytes;
				// an all-sky mask whose readback is blank too: the draw did not happen, draw it again
				if (await redrawIfBlank(gs[i], alts[i].pose, this.settlePrograms)) {
					if (this.disposed) return null;
					redraws++;
					bytes += gs[i].readBytes;
				}
				s = this.scoreSilhouette(gs[i]);
			}
			sils.push(s);
		}
		return { sils, tScore, bytes, fallbacks, redraws, path: "gpu" };
	}

	private silhouetteSource(i = 0): GeometrySource | null {
		if (this.silSources[i]) return this.silSources[i];
		const W = 384;
		const H = Math.round(W / this.aspect);
		const made = this.makeSource(W, H, false);
		if (!made) return null;
		this.silSources[i] = made.src;
		return made.src;
	}

	/** Mean photo edge strength along rendered inner silhouettes (log-range jumps): engine.ts silhouetteScore. */
	async silhouetteScore(pose: Pose) {
		const src = this.silhouetteSource();
		if (!src) return 0;
		await src.render(pose);
		return this.scoreSilhouette(src);
	}

	private scoreSilhouette(src: GeometrySource | null) {
		const edge = this.edge;
		if (!edge || !src?.pose) return 0;
		const W = src.width;
		const H = src.height;
		const buf = src.range;
		const lr = (x: number, y: number) => logRange(buf[y * W + x]);
		let sum = 0;
		let n = 0;
		// rows top-down here (three's readback is bottom-up): "up" is y − 1
		for (let y = 1; y < H - 1; y++)
			for (let x = 1; x < W - 1; x++) {
				const r = buf[y * W + x];
				if (!(r > 0) || r > 25000) continue;
				const c = lr(x, y);
				const up = lr(x, y - 1);
				const right = lr(x + 1, y);
				const left = lr(x - 1, y);
				const far = Math.max(
					up < 13 ? up : 0,
					right < 13 ? right : 0,
					left < 13 ? left : 0,
				);
				if (far - c < 0.5) continue;
				const u = x / W;
				const v = (y + 1) / H;
				const ex = Math.min(edge.w - 1, Math.floor(u * edge.w));
				const ey = Math.min(edge.h - 1, Math.floor(v * edge.h));
				const i = ey * edge.w + ex;
				if (edge.fg[i] > 0.3) continue;
				sum += edge.coarse[i];
				n++;
			}
		return n > 30 ? sum / n : 0;
	}

	solvePins(pins: Pin[], from: Pose = this.pose, solveFov = true) {
		return solvePinsForApp(
			from,
			this.aspect,
			this.eyeArr,
			pins,
			this.photo.width,
			this.photo.height,
			solveFov,
		);
	}

	/** engine.ts controlPins: hand-labelled control points → pins in this engine's frame. */
	controlPins(cp: {
		basis: number;
		points: { x: number; y: number; peak?: string; az?: number; el?: number }[];
	}): Pin[] {
		const D = Math.PI / 180;
		const hBasis = (cp.basis * this.photo.height) / this.photo.width;
		const pins: Pin[] = [];
		const t = this.terrain;
		for (const pt of cp.points) {
			let world: [number, number, number] | null = null;
			if (pt.peak && t) {
				// OSM has duplicate names: take the one whose direction is nearest the clicked ray (prior)
				const ray = unprojectDir(
					this.prior,
					this.aspect,
					pt.x / cp.basis,
					pt.y / hBasis,
				);
				let bestDot = -2;
				for (const pk of this.peaks) {
					if (pk.name !== pt.peak) continue;
					const snap = this.snapOne(pk);
					if (!snap) continue;
					const [x, y, z] = snap.position;
					const l = Math.hypot(x - this.eye.x, y - this.eye.y, z - this.eye.z);
					const d =
						((x - this.eye.x) * ray.x +
							(y - this.eye.y) * ray.y +
							(z - this.eye.z) * ray.z) /
						l;
					if (d > bestDot) {
						bestDot = d;
						world = snap.position;
					}
				}
			} else if (pt.az != null && pt.el != null) {
				const r = 50000;
				world = [
					this.eye.x + r * Math.sin(pt.az * D) * Math.cos(pt.el * D),
					this.eye.y + r * Math.cos(pt.az * D) * Math.cos(pt.el * D),
					this.eye.z + r * Math.sin(pt.el * D),
				];
			}
			if (world) pins.push({ world, u: pt.x / cp.basis, v: pt.y / hBasis });
		}
		return pins;
	}

	/** One peak snapped regardless of the frame (snapPeaksNear only snaps near the view). */
	private snapOne(p: Peak): SnappedPeak | null {
		const cached = this.snaps.get(p);
		if (cached !== undefined) return cached;
		const t = this.terrain as TerrainSet;
		const dist = distanceM(this.photo, p);
		if (dist > 110000 || dist < 150) return null;
		const snap = t.localMax(p.lat, p.lon, Math.min(250, 60 + dist * 0.004));
		if (!Number.isFinite(snap.h)) return null;
		const w = t.frame.fromGeo(snap.lat, snap.lon, snap.h);
		const s: SnappedPeak = {
			name: p.name,
			ele: p.ele,
			prominence: p.prominence,
			position: [w[0], w[1], w[2]],
		};
		this.snaps.set(p, s);
		return s;
	}

	/** engine.ts pinError: reprojection error (px on a basis-wide image) of `pose` at the pins. */
	pinError(pose: Pose, pins: Pin[], basis: number) {
		const eyeV = new THREE.Vector3(...this.eyeArr);
		const errs = pins.map((p) => {
			const pr = projectPoint(pose, this.aspect, eyeV, p.world);
			if (!pr) return Number.POSITIVE_INFINITY;
			return Math.hypot(
				(pr.u - p.u) * basis,
				((pr.v - p.v) * basis) / this.aspect,
			);
		});
		return {
			mean: errs.reduce((a, b) => a + b, 0) / Math.max(errs.length, 1),
			max: Math.max(...errs),
		};
	}

	// ---------------- blend brush, people mask ----------------

	/** Paint into the replace-mode brush mask (normalised coords, v down). */
	paint(u: number, v: number, radius: number, erase: boolean) {
		this.compositor.paint(u, v, radius, erase);
		this.brushVersion++;
		this.scheduleLook();
	}

	clearBrush(fill = false) {
		this.compositor.clearBrush(fill);
		this.brushVersion++;
		this.scheduleLook();
	}

	/** The brush mask canvas (engine.ts brushCanvas). */
	get brushCanvas() {
		return this.compositor.brushCanvas;
	}

	/** Foreground (people) mask, row 0 = top. Protects those pixels from overlays and blends. */
	setForegroundMask(mask: FgMask | null) {
		this.fgMask = mask;
		this.compositor.setForegroundMask(mask);
		this.updateLook();
	}

	get hasForeground() {
		return !!this.fgMask;
	}

	// ---------------- Step Inside (near field) ----------------

	/**
	 * Renderer.setNearField: the scene's splats in the world / step view (never the photo view, as
	 * three), and its Object pixels masked out of the world drape (opts.maskDrape, default true). null = off: both views are exactly the classic
	 * ones. A change here never rebuilds the photo view's terrain layers (updateComposite).
	 */
	setNearField(scene: NearFieldScene | null, opts: NearFieldViewOpts = {}) {
		if (this.disposed || (!scene && !this.nearField)) return;
		if (this.step && this.nearField?.scene !== scene) this.step.masks = null;
		this.nearField = scene ? { scene, opts: { ...opts } } : null;
		if (this.world?.controls) {
			this.updateLayers();
			return;
		}
		// the photo view shows the photo (as three: splats only in the world / step view); drop a stale
		// splat layer, otherwise the photo view is untouched
		if (this.sceneLayers.some((l) => isDeckSplatLayer(l))) {
			this.sceneLayers = this.sceneLayers.filter((l) => !isDeckSplatLayer(l));
			for (const [id, k] of this.kept)
				if (isDeckSplatLayer(k.layer)) this.kept.delete(id);
			this.updateComposite();
		}
	}

	/** The world / step view's splat layer (drawn on the canvas), or null. */
	private nearFieldLayer(): Layer | null {
		const nf = this.nearField;
		if (!nf?.scene.splats.count) return null;
		const opacity = nf.opts.opacity ?? 1;
		if (!(opacity > 0)) return null;
		return this.keepLayer(DeckSplatLayer, {
			id: "world-nearfield-splats",
			cloud: nf.scene.splats,
			opacity,
			truth: !!nf.opts.truth,
			pass: "canvas",
		});
	}

	/**
	 * The world drape's people-mask props: the people mask (protectPeople) and, with Step Inside on
	 * (maskDrape), the scene's Object pixels, which stand up as splats instead of smearing over the
	 * slope. Off: exactly { photoFg: fgMask, protectPeople }.
	 */
	private drapeMask(): { photoFg: FgMask | null; protectPeople: boolean } {
		const protect = this.settings.protectPeople;
		const nf = this.nearField;
		if (!nf || nf.opts.maskDrape === false)
			return { photoFg: this.fgMask, protectPeople: protect };
		// stepping: only the Object pixels splats really cover (engine.ts masks.step), so from the photo
		// camera everything else drapes exactly and the step view starts as the photo
		const sm = this.stepMasks();
		if (sm) return { photoFg: sm.step, protectPeople: true };
		const people = protect ? this.fgMask : null;
		const key = [people, nf.scene.split];
		const c = this.drapeMaskCache;
		if (!c || !sameKeyList(c.key, key))
			this.drapeMaskCache = { key, mask: objectDrapeMask(nf.scene, people) };
		const mask = this.drapeMaskCache?.mask ?? null;
		return { photoFg: mask, protectPeople: !!mask };
	}

	/** Renderer.tiles3dAttribution: the 3D Tiles credit line while stepping (null = none on screen). */
	tiles3dAttribution(): string | null {
		return this.tiles3d?.attribution() ?? null;
	}

	/** The people / foreground mask (row 0 = top), or null (Step Inside, as engine.ts). */
	get foregroundMask() {
		return this.fgMask;
	}

	/** The last P(sky) mask handed to setSkyMask (0..255, row 0 = top), or null. */
	get skyMaskData() {
		return this.skyMaskStore;
	}

	/** The shown near-field scene (the splat export reads it), or null. */
	get nearFieldScene(): NearFieldScene | null {
		return this.nearField?.scene ?? null;
	}

	/** True while the step-inside camera drives the view. */
	get steppingInside() {
		return !!this.step;
	}

	/** The step-inside camera (dev tools / UI), or null. */
	get stepCamera() {
		return this.step?.cam ?? null;
	}

	/** Near-field state for dev tools (window.__nearfield). */
	get nearFieldInfo() {
		const nf = this.nearField;
		return nf
			? {
					splats: nf.scene.splats.count,
					opts: { ...nf.opts },
					stepping: !!this.step,
				}
			: null;
	}

	/**
	 * Step Inside's terrain range for the current pose (controller NearFieldHost.nearFieldDemRange): the
	 * shared near-DEM source (nearfield/near-dem.ts, the same in engine.ts), CPU terrain profiles within
	 * NEAR_DEM_CPU_MAX, sampleAt beyond. Here that matters twice: the query buffer discards terrain within
	 * nearDiscard / 2 of the eye, which is exactly where the anchor finds people's ground. Classic queries
	 * are unchanged.
	 */
	/** The shared near-camera DEM (nearfield/near-dem.ts), once prepareNearFieldDem() loaded it. */
	private nearDem: NearDem | null = null;

	/** Load the shared near DEM for Step Inside (controller, before it samples nearFieldDemRange). */
	async prepareNearFieldDem() {
		this.nearDem ??= await loadNearDem(
			this.photo.lat,
			this.photo.lon,
			this.photo.alt,
			{ signal: this.loadAbort.signal },
		);
	}

	nearFieldDemRange(
		width: number,
		height: number,
	): (u: number, v: number) => number | null {
		return nearFieldDemRangeFrom(
			this.nearDem ?? this.terrain,
			{ pose: this.pose, aspect: this.aspect, eye: this.eye },
			width,
			height,
			(u, v) => this.sampleAt(u, v)?.range ?? null,
		);
	}

	/** The step view's drape / sky masks (split grid), built once per scene while stepping. */
	private stepMasks() {
		const st = this.step;
		const nf = this.nearField;
		if (!st || !nf || st.view !== "step") return null;
		if (!st.masks) {
			const fresh = this.geometryReady();
			const dem = this.nearFieldDemRange(
				nf.scene.split.width,
				nf.scene.split.height,
			);
			st.masks = stepMasks(
				nf.scene,
				{
					pose: this.pose,
					aspect: this.aspect,
					eye: this.eye,
					frame: this.frame,
				},
				(u, v) => (fresh ? dem(u, v) : null),
			);
		}
		return st.masks;
	}

	/**
	 * Step inside the photo (engine.ts enterStepInside): the world view, its camera driven by a
	 * StepCamera that starts exactly at the photo camera and may move within `radius` metres, drawn
	 * with the drape, the near-field splats and the photo's sky on a far sphere. From the photo view the
	 * world view is switched on for the duration (settings.mode is unchanged); `onBack` fires when
	 * backToPhoto() arrives.
	 */
	enterStepInside(opts: StepInsideOpts = {}) {
		if (!this.terrain || this.disposed) return;
		this.exitStepInside(false);
		const view = opts.view ?? "step";
		const enteredWorld = !this.world?.controls;
		if (enteredWorld) this.enterWorld();
		const w = this.world;
		if (!w?.controls) return;
		w.controls.enabled = false;
		const toQ = poseQuaternion(this.pose);
		// a held flight: WorldCamera.tick leaves the camera to the step camera (no OrbitControls update)
		w.flight = {
			t0: 0,
			dur: 1,
			fromPos: w.cam.position.clone(),
			fromQ: w.cam.quaternion.clone(),
			fromFov: w.cam.fov,
			toQ,
			held: true,
		};
		w.photoPlaneOpacity = view === "map" ? this.stepGizmoOpacity(w) : 0;
		const terrain = this.terrain;
		const groundAt = (x: number, y: number) => {
			const g = this.frame.toGeo(x, y, 0);
			const h = terrain.heightAt(g.lat, g.lon);
			return h == null ? null : this.frame.fromGeo(g.lat, g.lon, h)[2];
		};
		const map = new DeckMapCamera(this.frame, groundAt, (views) => {
			if (this.step?.map !== map) return;
			if (views) this.syncWorldViews();
			else this.deck.setProps({ viewState: this.viewState() } as never);
			this.kickWorld();
		});
		map.setSize(this.cssSize.w, this.cssSize.h);
		const cam = new StepCamera(w.cam, this.canvas, {
			eye: this.eyeVec,
			quaternion: toQ,
			vfov: this.pose.vfov,
			aspect: this.aspect,
			radius: opts.radius ?? this.nearField?.scene.confidenceRadius ?? 10,
			pivotDist: opts.pivotDist,
			mode: opts.mode,
			easeIn: view === "map" && !enteredWorld,
			groundAt,
			mapDriver: map,
			onChange: () => this.kickWorld(),
			onBack: opts.onBack,
		});
		this.step = { cam, enteredWorld, masks: null, map, view };
		// the camera may have opened in map mode (its MapView joins the views)
		this.syncWorldViews();
		if (view === "step")
			this.tiles3d?.enter(this.photo.lat, this.photo.lon, this.eyeVec);
		if (!this.geometryReady())
			void this.readback().then(() => {
				if (this.step?.cam === cam) {
					this.step.masks = null;
					this.updateLayers();
				}
			});
		this.updateLayers();
		this.kickWorld();
	}

	/**
	 * Leave the step camera. From the photo view: back to it. In the world view the camera stays on
	 * the photo (a held flight, as after flyToPhoto). `restore` false: a mode switch follows.
	 */
	exitStepInside(restore = true) {
		const st = this.step;
		if (!st) return;
		this.step = null;
		this.tiles3d?.exit();
		st.cam.dispose();
		const w = this.world;
		if (st.enteredWorld) {
			this.exitWorld();
		} else if (w?.controls) {
			this.syncWorldViews();
			w.controls.enabled = true;
			w.flight = {
				t0: 0,
				dur: 1,
				fromPos: w.cam.position.clone(),
				fromQ: w.cam.quaternion.clone(),
				fromFov: w.cam.fov,
				toQ: poseQuaternion(this.pose),
				held: true,
			};
		}
		if (restore) {
			this.updateLayers();
			if (w?.controls) this.kickWorld();
		}
	}

	// ---------------- world view ----------------

	private get eyeVec() {
		return new THREE.Vector3(this.eye.x, this.eye.y, this.eye.z);
	}

	/** engine.ts enterWorld: three's framing + OrbitControls, the world view, the sky. */
	private enterWorld() {
		// the drape's photo texture stays up from now on (no re-upload on the next entry)
		this.photoTexWarm = true;
		this.world ??= new WorldCamera(this.canvas, () => this.kickWorld());
		const ws = deckWorldStyle(this.style);
		this.world.planeOpacity = ws.planeOpacity;
		this.world.setAspect(this.cssSize.w / this.cssSize.h);
		this.world.enter(this.pose, this.eyeVec);
		this.world.tick(this.pose, this.eyeVec, this.aspect);
		this.compositor.enabled = false;
		this.canvas.style.backgroundColor = ws.sky;
		this.deck.setProps({ views: this.worldViews } as never);
		// clear air's haze fit (the world view only; no-op until the geometry is ready)
		this.fitHaze();
		// the drape needs the range buffer for the current pose
		if (!this.geometryReady()) void this.readback();
		this.kickWorld();
	}

	/**
	 * The world view, plus the step camera's MapView while its map mode runs. Views and view state go
	 * together: a MapView without its view state builds a controller without a map centre.
	 */
	private syncWorldViews() {
		const map = this.step?.map;
		this.deck.setProps({
			views: map?.active ? [...this.worldViews, map.view] : this.worldViews,
			viewState: this.viewState(),
		} as never);
	}

	/** engine.ts exitWorld. */
	private exitWorld() {
		this.world?.exit();
		cancelAnimationFrame(this.worldRaf);
		this.worldRaf = 0;
		this.syncWeatherTick(false);
		this.syncFlowTick(false);
		this.compositor.enabled = true;
		this.canvas.style.backgroundColor = "";
		this.deck.setProps({ views: this.photoViews } as never);
	}

	/**
	 * The world camera's frame loop (three: OrbitControls 'change' → requestRender → controls.update
	 * in renderWorld): runs while a drag, damping or a flight moves the camera, then idles.
	 */
	private kickWorld() {
		this.worldStill = 0;
		if (this.worldRaf || this.disposed) return;
		const step = () => {
			const w = this.world;
			if (this.disposed || !w?.controls) {
				this.worldRaf = 0;
				return;
			}
			const flying = !!w.flight && !w.flight.held;
			// Step Inside: the step camera eases the world camera (its flight is held, so tick() only reports)
			const stepping = this.step?.cam.update() ?? false;
			// worldRaf is still set here: a 'change' fired inside tick() only resets worldStill
			const moved = w.tick(this.pose, this.eyeVec, this.aspect) || stepping;
			// 3D Tiles refine from the world camera (its loads come back through updateLayers)
			if (this.step)
				this.tiles3d?.update(w.cam, this.canvas.width, this.canvas.height);
			// the photo plane fades during the flight (a layer prop); orbiting only moves the view
			// the In-map step camera: the photo frustum fades in as the camera leaves the eye
			let gizmo = false;
			if (this.step?.view === "map") {
				const o = this.stepGizmoOpacity(w);
				gizmo = Math.abs(o - w.photoPlaneOpacity) > 0.01;
				if (gizmo) w.photoPlaneOpacity = o;
			}
			// a flight / the In-map fade changes only the gizmo's plane opacity: swap that one layer and
			// keep every other instance (terrain, trails, sky, splats) as it is
			if ((flying || gizmo) && w.photoPlaneOpacity !== this.worldGizmoOpacity)
				this.updateWorldGizmo(w);
			else if (moved)
				this.deck.setProps({ viewState: this.viewState() } as never);
			// animated lake waves (style.world.water, off under webdriver): one redraw a frame
			const waves = waterWavesAnimate(this.style);
			if (waves && !moved) this.deck.redraw("water");
			this.worldStill = moved ? 0 : this.worldStill + 1;
			// damping settles over some frames; a new drag sends 'change' → kickWorld again
			this.worldRaf =
				flying || waves || this.worldStill < 30
					? requestAnimationFrame(step)
					: 0;
		};
		this.worldRaf = requestAnimationFrame(step);
	}

	/** In-map step camera: the photo plane's opacity, 0 at the eye, full a few hundred metres out. */
	private stepGizmoOpacity(w: WorldCamera) {
		const d = w.cam.position.distanceTo(this.eyeVec);
		return w.planeOpacity * Math.max(0, Math.min(1, (d - 30) / 300));
	}

	/** The drape's range map, rebuilt when the query geometry buffer has a new generation. */
	private drapeRange(): PhotoRangeMap | null {
		const src = this.geoSrc;
		if (!src?.pose || this.geoBufGen < 0) return this.drape?.map ?? null;
		if (this.drape?.gen !== this.geoBufGen)
			this.drape = {
				gen: this.geoBufGen,
				map: this.gpuDrapeRange(src) ?? rangeMapFrom(src),
			};
		return this.drape.map;
	}

	/**
	 * The query buffer's range map as a GPU copy of the geometry target (gpuDrape), the same texels
	 * rangeMapFrom would upload; null = take the CPU path (option off, a CPU source, or the target
	 * no longer holds the buffer's render).
	 */
	private gpuDrapeRange(src: GeometrySource): PhotoRangeMap | null {
		if (!this.gpuDrape || !(src instanceof GpuGeometrySource)) return null;
		const device = (this.deck as unknown as { device?: Device }).device;
		if (!device) return null;
		const { width, height } = src;
		// the texture the layers may bind until this generation's props reach them
		// (the last generation may have fallen to CPU, so also the ones the world layers still hold)
		const bound = new Set<unknown>(
			this.worldList.map(
				(l) =>
					(l as { props?: { photoRange?: PhotoRangeMap | null } } | null)?.props
						?.photoRange?.texture,
			),
		);
		bound.add(this.drape?.map.texture);
		let tex = this.drapeTex.find(
			(t) => !bound.has(t) && t.width === width && t.height === height,
		);
		if (!tex) {
			tex = device.createTexture({
				id: "drape-range",
				format: "r32float",
				width,
				height,
				sampler: RANGE_SAMPLER,
			});
			this.drapeTex.push(tex);
		}
		if (!src.copyRangeTo(tex)) return null;
		// older textures (a resize) are no layer's any more
		const keep = tex;
		this.drapeTex = this.drapeTex.filter((t) => {
			if (t === keep || bound.has(t)) return true;
			t.destroy();
			return false;
		});
		return { width, height, texture: tex };
	}

	/**
	 * World view imagery order: biggest on screen first (tile size / distance from the world
	 * camera), so the coarse tiles that fill an orbit frame and the near tiles after a fly-in both
	 * come early (the photo view's order, by distance from the photographer, suits neither).
	 */
	private worldTileOrder(w: WorldCamera) {
		const cam = w.cam.position.clone();
		const h = this.demAtCamera;
		const score = new Map<TileMesh, number>();
		const of = (t: TileMesh) => {
			let v = score.get(t);
			if (v === undefined) {
				const b = tileBounds(t.key);
				const lat = (b.north + b.south) / 2;
				const c = this.frame.fromGeo(lat, (b.west + b.east) / 2, h);
				const size =
					(b.east - b.west) * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
				v =
					Math.hypot(c[0] - cam.x, c[1] - cam.y, c[2] - cam.z) /
					Math.max(size, 1);
				score.set(t, v);
			}
			return v;
		};
		return (a: TileMesh, b: TileMesh) => of(a) - of(b);
	}

	/** engine.ts renderWorld as deck layers: terrain (+ drape), trails, the photo-camera gizmo. */
	private worldLayers(): unknown[] {
		const set = this.renderSet;
		const w = this.world;
		if (!set || !this.terrain || !w) return [];
		const s = this.settings;
		const src = s.worldStyle === "hillshade" ? null : s.worldStyle;
		const imagery = src
			? this.syncImagery(set, src, () => this.worldTileOrder(w))
			: undefined;
		const atm = this.look("world").atm;
		const out: unknown[] = [
			this.style.world.sky.mode === "atmosphere" &&
				atm &&
				this.keepLayer(AtmSkyLayer, {
					id: "world-sky",
					atm,
					parameters: WORLD_SKY_PARAMETERS,
				}),
			this.photoSkyLayer(),
			this.keepLayer(TerrainLayer, {
				id: "terrain",
				tiles: set.tiles,
				imagery,
				style: src ? "imagery" : "hillshade",
				look: this.look("world"),
				elevRange: deckElevRange(this.style, this.elevRange) ?? undefined,
				nearFade: 0,
				// photo-camera geometry pass only (the range map the drape tests); the canvas draw keeps it all
				nearDiscard: nearFadeFor(this.photo.hAccuracy),
				relief: this.relief.field,
				terroir: this.terroir(),
				offscreen: false,
				photoTexture: this.photoTexture(),
				photoRange: this.drapeRange(),
				...this.drapeMask(),
				photoViewProj: this.photoViewProj(),
				photoPos: this.eyeArr,
				// Step Inside: the full photo on the drape, at every incidence (terrain-layer.ts: > 1.5)
				projectPhoto: this.step?.view === "step" ? 2 : s.projectOpacity,
				// from the photo camera the near terrain drapes exactly: no grazing-angle cut-off (engine.ts)
				photoMinRange: this.step?.view === "step" ? 1 : s.minProjectRange,
				harmonize: this.harmonize(this.style.world.drapeHarmonize),
				clearAir: this.look("world").defines.includes("LOOK_CLEARAIR")
					? this.clearAir()
					: null,
				// Truth toggle: the terrain tinted by provenance too (terrain-layer.ts truth; 0 = classic)
				truth: this.nearField?.opts.truth ? PROVENANCE_TINT_MIX : 0,
			}),
		];
		if (s.trails && this.trails?.count)
			out.push(
				this.keepLayer(TrailLayer, {
					id: "world-trails",
					segments: this.trails,
					widthPx: this.style.trails.width,
					lineOpacity: this.style.trails.opacity,
					dash: this.style.trails.dash,
					stroke: this.style.trails.stroke,
					onCanvas: true,
				}),
			);
		out.push(this.worldGizmo(w));
		// Step Inside 3D Tiles (opaque, log depth): before the splats
		if (this.step?.view === "step" && this.tiles3d) {
			const dm = this.drapeMask();
			const tl = this.tiles3d.layer({
				photoViewProj: this.photoViewProj(),
				photoPos: this.eyeArr,
				photoRange: this.drapeRange(),
				photoFg: dm.protectPeople ? dm.photoFg : null,
				truth: !!this.nearField?.opts.truth,
				camera: w.cam.position,
			});
			if (tl) out.push(tl);
		}
		// Step Inside splats last: they blend without writing depth, so everything opaque must be in
		// the depth buffer first (the trails would otherwise draw over them)
		const nf = this.nearFieldLayer();
		if (nf) out.push(nf);
		// opt-in wind drift (style.world.wind, default off): blends without writing depth, like the weather
		const flow = this.flowLayer();
		if (flow) out.push(flow);
		// opt-in rain / snow (style.world.weather, default off): last, it blends without writing depth
		const wx = precipitationFor(this.style.world.weather);
		this.syncWeatherTick(!!wx);
		if (wx)
			out.push(
				this.keepLayer(WeatherLayer, {
					id: "world-weather",
					precipitation: wx,
				}),
			);
		this.worldList = out.filter(Boolean);
		return this.worldList;
	}

	/**
	 * Wind drift as a world layer, or null (off: the sim, its heights and the tick are released, so
	 * nothing is allocated or drawn). The flow grid is the style's wind deflected by the DEM gradient,
	 * from heights read once per settled tile set (the WebGPU engine's syncFlow does the same).
	 */
	private flowLayer(): Layer | null {
		const wind = flowWindFor(this.style.world.wind);
		const set = this.renderSet;
		if (!wind || !this.terrain) {
			this.releaseFlow();
			return null;
		}
		// streaming sets arrive in bursts: read the heights again only once the set has settled
		if (
			set &&
			set !== this.flowHeightsSet &&
			(!this.flowHeights || (set.stats?.pending ?? 0) === 0)
		) {
			const terrain = this.terrain;
			this.flowHeightsSet = set;
			this.flowHeights = sampleFlowHeights(this.frame, (lat, lon) =>
				terrain.heightAt(lat, lon),
			);
		}
		const heights = this.flowHeights;
		if (!heights) {
			this.syncFlowTick(false);
			return null;
		}
		if (!this.flowSim) this.flowSim = new FlowSim();
		const sim = this.flowSim;
		sim.setWind(wind);
		const m = this.flowGridMemo;
		if (
			!m ||
			m.heights !== heights ||
			m.direction !== wind.direction ||
			m.speed !== wind.speed
		) {
			this.flowGridMemo = {
				heights,
				direction: wind.direction,
				speed: wind.speed,
			};
			sim.setGrid(buildFlowGrid(heights, FLOW_GRID_DIM, FLOW_EXTENT_M, wind));
		}
		this.syncFlowTick(true);
		return this.keepLayer(FlowLayer, { id: "world-flow", sim });
	}

	private releaseFlow() {
		this.syncFlowTick(false);
		this.flowSim = null;
		this.flowHeights = null;
		this.flowHeightsSet = null;
		this.flowGridMemo = null;
	}

	/**
	 * The wind-drift animation: a CPU advection step and one deck redraw per tick (about 30 Hz) while
	 * the world view shows it. Off under webdriver and for reduced motion: the layer then shows its
	 * deterministic warm-up state (the same rule as the WebGPU engine).
	 */
	private syncFlowTick(on: boolean) {
		const still =
			(typeof navigator !== "undefined" && navigator.webdriver) ||
			(typeof matchMedia === "function" &&
				matchMedia("(prefers-reduced-motion: reduce)").matches);
		if (!on || still || this.disposed) {
			cancelAnimationFrame(this.flowRaf);
			this.flowRaf = 0;
			return;
		}
		if (this.flowRaf) return;
		let last = performance.now();
		const tick = (t: number) => {
			if (this.disposed || !this.world?.controls || !this.flowSim) {
				this.flowRaf = 0;
				return;
			}
			this.flowRaf = requestAnimationFrame(tick);
			if (t - last < 33) return;
			this.flowSim.advance((t - last) / 1000);
			last = t;
			this.deck.redraw("flow");
		};
		this.flowRaf = requestAnimationFrame(tick);
	}

	/** Start / stop the weather animation: one deck redraw per frame while the world view shows weather. */
	private syncWeatherTick(on: boolean) {
		if (!on || this.disposed) {
			cancelAnimationFrame(this.weatherRaf);
			this.weatherRaf = 0;
			return;
		}
		if (this.weatherRaf) return;
		const step = () => {
			if (this.disposed || !this.world?.controls) {
				this.weatherRaf = 0;
				return;
			}
			this.deck.redraw("weather");
			this.weatherRaf = requestAnimationFrame(step);
		};
		this.weatherRaf = requestAnimationFrame(step);
	}

	/** The photo-camera gizmo (null once the plane has faded: engine.ts hides the frustum then). */
	private worldGizmo(w: WorldCamera): Layer | null {
		this.worldGizmoOpacity = w.photoPlaneOpacity;
		if (w.photoPlaneOpacity <= 0.02) {
			this.kept.delete("world-gizmo");
			this.nextKept.delete("world-gizmo");
			return null;
		}
		const ws = deckWorldStyle(this.style);
		return this.keepLayer(WorldGizmoLayer, {
			id: "world-gizmo",
			pose: this.pose,
			eye: this.eyeArr,
			aspect: this.aspect,
			image: this.photoImg ?? null,
			planeOpacity: w.photoPlaneOpacity,
			lineColor: ws.lineColor,
			pinColor: ws.pinColor,
			pinRadiusM: ws.pinRadiusM,
		});
	}

	/**
	 * A flight frame: the camera and the gizmo's plane opacity only. The last world layer list with
	 * the gizmo swapped (or dropped); every other layer instance stays, so deck diffs nothing else.
	 */
	private updateWorldGizmo(w: WorldCamera) {
		const list = this.worldList;
		const i = list.findIndex((l) => (l as Layer | null)?.id === "world-gizmo");
		// no gizmo in the list yet (or no list): the full rebuild
		if (i < 0 && w.photoPlaneOpacity > 0.02) return this.updateLayers();
		const g = this.worldGizmo(w);
		const next = list.slice();
		if (i >= 0) {
			if (g) next[i] = g;
			else next.splice(i, 1);
		}
		this.worldList = next;
		this.deck.setProps({ viewState: this.viewState(), layers: next } as never);
	}

	/** Stepping: the photo's Sky pixels on a far sphere, over the world sky (step-camera.ts makePhotoSky). */
	private photoSkyLayer() {
		const sm = this.stepMasks();
		if (!sm || !this.photoImg) return null;
		return this.keepLayer(PhotoSkyLayer, {
			id: "world-photo-sky",
			parameters: PHOTO_SKY_PARAMETERS,
			photo: this.photoImg,
			skyMask: sm.sky,
			photoViewProj: this.photoViewProj(),
			photoPos: this.eyeArr,
		});
	}

	/** engine.ts flyToPhoto: animate the free camera into the photographer's exact viewpoint. */
	flyToPhoto(dur = 2600) {
		if (!this.world?.controls) return;
		this.world.flyTo(this.pose, dur);
		this.kickWorld();
	}

	/** engine.ts flyOut: back to the initial world framing. */
	flyOut() {
		if (!this.world?.controls) return;
		this.world.enter(this.pose, this.eyeVec);
		this.world.tick(this.pose, this.eyeVec, this.aspect);
		this.updateLayers();
		this.kickWorld();
	}

	/** engine.ts exportImage in world mode: the current world frame (canvas size, sky) as a PNG. */
	private async exportWorld(): Promise<Blob | null> {
		await this.deckReady;
		if (this.disposed) return null;
		this.updateLayers();
		this.flushLayers();
		// synchronous draw: the drawing buffer is still valid for drawImage in this task
		this.deck.redraw("export");
		const c = this.canvas;
		const out = document.createElement("canvas");
		out.width = c.width;
		out.height = c.height;
		const ctx = out.getContext("2d") as CanvasRenderingContext2D;
		ctx.fillStyle = deckWorldStyle(this.style).sky;
		ctx.fillRect(0, 0, out.width, out.height);
		ctx.drawImage(c, 0, 0);
		return new Promise((res) => out.toBlob(res, "image/png"));
	}

	/**
	 * engine.ts exportImage: the photo view at the photo's full resolution (the composite rendered
	 * offscreen, composite.ts renderImage) with engine.ts's label drawing, as a JPEG blob.
	 * In world mode (as three): the current world frame as a PNG, without labels.
	 */
	// ---------------- offscreen pose renders (tools/matcher/server/render_worker.mjs) ----------------

	/** renderer.ts retraceHorizon: the horizon re-traced under the current flags (precision gates). */
	async retraceHorizon(): Promise<"fast" | "cpu" | null> {
		await this.deckReady;
		if (!this.horizonDirs || this.disposed) return null;
		// as init (horizon-fast over the initial wedge) or as loadFullTerrain (the CPU horizon, 360° set)
		if (!this.fullTerrainDone) {
			this.fastHorizon?.dispose();
			this.fastHorizon = this.startFastHorizon();
		}
		const dirs = await this.traceHorizon();
		if (this.disposed) return null;
		this.horizonDirs = dirs;
		return this.horizonSource;
	}

	/**
	 * The terrain all around the eye: the streamer's high-detail wedge becomes 360° (and stays so),
	 * the CPU queries switch to the complete set, and the horizon is re-traced over 360°. The matcher's
	 * `fullTerrain` (the former three.js `terrain.loadPending()` + `computeHorizon()`). Resolves
	 * with the ms it took (0 when already done).
	 */
	async loadFullTerrain(timeoutMs = 300_000): Promise<number> {
		// done once it completed: a call that threw (timeout) leaves the wedge at 360°, and the retry
		// waits for that wedge's set again (`already` below) instead of reporting success
		if (this.fullTerrainDone) return 0;
		const t0 = performance.now();
		await this.deckReady;
		const streamer = this.streamer;
		if (!streamer || !this.terrain || this.disposed)
			throw new Error("loadFullTerrain: no terrain yet");
		const w: ViewWedge = { headingDeg: this.prior.yaw, halfAngleDeg: 180 };
		this.fullWedge = w;
		clearTimeout(this.wedgeTimer);
		const before = this.renderSet;
		this.streamerWedge = w;
		// the streamer already selected 360° (an unknown-heading photo's initial wedge, or a call that
		// timed out): setWedge is a no-op and emits no new set, so the current one counts once complete
		const already = !streamer.setWedge(w);
		// a fresh, complete set (the streamer emits as tiles land; pending 0 = this wedge fully loaded)
		for (;;) {
			const set = this.renderSet;
			if (set && (set !== before || already) && (set.stats?.pending ?? 0) === 0)
				break;
			if (this.disposed) throw new Error("loadFullTerrain: disposed");
			if (performance.now() - t0 > timeoutMs)
				throw new Error("loadFullTerrain: timed out");
			await new Promise((res) => setTimeout(res, 100));
		}
		// maybeSwapQueryTerrain, unconditionally
		this.terrain = this.renderSet as TerrainSet;
		this.queryWedge = w;
		this.snaps.clear();
		this.vis.clear();
		this.profiles = undefined;
		this.dropGeometrySources();
		this.buildTrails();
		this.invalidateGeometry();
		this.horizonDirs = await this.traceHorizon();
		this.fullTerrainDone = true;
		return Math.round(performance.now() - t0);
	}

	/**
	 * Satellite imagery for the render set's tiles within `maxDistM` of the eye (0 = all), fetched now;
	 * failed tiles are re-fetched up to `retries` times. The matcher's
	 * satellite imagery load (the former three.js `terrain.loadImagery("satellite")`). Other tiles keep streaming in the background.
	 */
	async loadSatellite(maxDistM = 0, retries = 2) {
		await this.deckReady;
		const c = this.imagery;
		const sleep = () => new Promise((res) => setTimeout(res, 100));
		const want = () =>
			(this.renderSet?.tiles ?? []).filter(
				(t) => !(maxDistM > 0) || t.distance < maxDistM,
			);
		const missing = () => want().filter((t) => !c.map.has(t.id));
		let tries = 0;
		for (;;) {
			if (this.disposed || !missing().length) break;
			// a load already running (it may cover these tiles): let it land first
			while (c.abort && !this.disposed) await sleep();
			if (this.disposed || !missing().length || tries > retries) break;
			tries++;
			this.syncImagery(
				{ tiles: missing() } as unknown as TerrainSet,
				"satellite",
			);
		}
		return {
			tiles: want().length,
			missing: missing().length,
			retries: Math.max(0, tries - 1),
		};
	}

	/**
	 * The matcher's view (the removed three.js engine's geoRT readback + a canvas render with uStyle 1):
	 * the satellite drape and the geometry buffer through an arbitrary `pose`, both offscreen at
	 * width × height (default: the query geometry size, 1024 px on the long side, as three's geoRT).
	 * Neither the on-screen view nor the engine's pose changes.
	 *   xyz:  ENU metres in `frame` (EnuFrame(lat, lon, 0)), 3 per pixel, row 0 = top, 0,0,0 = sky
	 *   rgba: sRGB 8-bit, row 0 = top, opaque; the terrain colour pass in the Blend-satellite look
	 *         (haze 0.6 = CLASSIC.replace.haze, no contours, trails or near fade), sky = #b9cde0
	 * Satellite tiles are drawn as far as they are loaded: call loadSatellite first.
	 */
	async renderPoseView(
		pose: Pose,
		opts: { width?: number; height?: number } = {},
	): Promise<{
		width: number;
		height: number;
		xyz: Float32Array;
		rgba: Uint8ClampedArray;
	} | null> {
		if (this.world?.controls || this.step)
			throw new Error("renderPoseView: photo views only");
		await this.deckReady;
		if (this.disposed || !this.terrain) return null;
		const def = geometrySize(this.aspect);
		const width = opts.width ?? def.width;
		const height = opts.height ?? def.height;
		const p = {
			yaw: pose.yaw,
			pitch: pose.pitch,
			roll: pose.roll,
			vfov: pose.vfov,
		};
		const prev = this.settings;
		this.settings = {
			...prev,
			mode: "replace",
			mapStyle: "satellite",
			trails: false,
		};
		this.poseView = true;
		let src: GeometrySource | undefined;
		try {
			this.updateLayers();
			this.flushLayers();
			// geometry: a private source at this size (the query buffer and its pose stay as they are)
			src = new GpuGeometrySource(this.deck, this.eyeArr, width, height, {
				xyz: true,
			});
			await src.render(p);
			if (this.disposed) return null;
			const xyz = new Float32Array(width * height * 3);
			const sx = src.xyz;
			for (let i = 0; i < width * height; i++) {
				if (!(src.range[i] > 0) || !Number.isFinite(src.range[i])) continue;
				if (sx) {
					xyz[i * 3] = sx[i * 3];
					xyz[i * 3 + 1] = sx[i * 3 + 1];
					xyz[i * 3 + 2] = sx[i * 3 + 2];
				}
			}
			// colour: the terrain colour pass alone, linear + straight alpha → sRGB over the sky colour
			const lin = await this.compositor.renderColorPixels(
				this.liveLayers(),
				p,
				this.eyeArr,
				width,
				height,
			);
			if (!lin || this.disposed) return null;
			const rgba = new Uint8ClampedArray(width * height * 4);
			const SKY = [0xb9, 0xcd, 0xe0];
			const oetf = (c: number) =>
				c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
			for (let i = 0; i < width * height; i++) {
				const a = Math.min(1, Math.max(0, lin[i * 4 + 3]));
				for (let k = 0; k < 3; k++) {
					const c =
						a > 0 ? oetf(Math.min(1, Math.max(0, lin[i * 4 + k] / a))) : 0;
					rgba[i * 4 + k] = Math.round(c * a * 255 + SKY[k] * (1 - a));
				}
				rgba[i * 4 + 3] = 255;
			}
			return { width, height, xyz, rgba };
		} finally {
			src?.dispose?.();
			this.poseView = false;
			this.settings = prev;
			this.updateLayers();
			// the on-screen frame redraws its passes (the offscreen colour pass resized the MSAA buffers)
			this.deck.redraw("pose-view");
		}
	}

	async exportImage(withLabels = true): Promise<Blob | null> {
		// display-only 3D Tiles (Google) never enter an export (tiles3d/deck-tiles.ts)
		// as three: the world view, or stepping inside from the photo view (the world view on screen)
		if (this.settings.mode === "world" || this.step)
			return this.tiles3d
				? this.tiles3d.withoutDisplayOnly(() => this.exportWorld())
				: this.exportWorld();
		// labels need occlusion for THIS pose, not the debounced previous one
		if (withLabels) await this.readback();
		// GPU look passes (gpu/look) still in flight land before the export draws
		await lookIdle();
		await this.deckReady;
		if (this.disposed) return null;
		this.updateLayers();
		this.flushLayers();
		const W = this.photo.width;
		const H = this.photo.height;
		const device = (
			this.deck as unknown as {
				device?: { limits: { maxTextureDimension2D: number } };
			}
		).device;
		const maxDim = device?.limits.maxTextureDimension2D ?? 4096;
		const k = Math.min(1, maxDim / Math.max(W, H));
		const rw = Math.round(W * k);
		const rh = Math.round(H * k);
		const px = await this.compositor.renderImage(
			this.liveLayers(),
			this.pose,
			this.eyeArr,
			rw,
			rh,
		);
		// the on-screen frame redraws its passes (the export freed the MSAA buffers)
		this.deck.redraw("export");
		if (!px) return null;
		const out = document.createElement("canvas");
		out.width = W;
		out.height = H;
		const ctx = out.getContext("2d") as CanvasRenderingContext2D;
		const img = new ImageData(
			new Uint8ClampedArray(
				px.buffer as ArrayBuffer,
				px.byteOffset,
				px.byteLength,
			),
			rw,
			rh,
		);
		if (k === 1) ctx.putImageData(img, 0, 0);
		else {
			const tmp = document.createElement("canvas");
			tmp.width = rw;
			tmp.height = rh;
			(tmp.getContext("2d") as CanvasRenderingContext2D).putImageData(
				img,
				0,
				0,
			);
			ctx.drawImage(tmp, 0, 0, W, H);
		}
		// labels: the canvas drawer shared with three (style.labels; classic = the old drawing)
		if (withLabels) {
			const classic = this.style.labels.layout === "classic";
			drawExportLabels(
				ctx,
				this.peakLabels(classic ? undefined : 100, { declutter: classic }),
				this.style.labels,
				W,
				H,
				W / this.cssSize.w,
				this.skyline(),
			);
		}
		return new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
	}
}

const sameKeyList = (a: unknown[], b: unknown[]) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * People ∪ Object pixels (dilated by one split cell), row 0 = top, 0 / 255, at the people mask's
 * size when there is one (nearest), else the split grid's. null when neither marks anything.
 */
function objectDrapeMask(
	scene: NearFieldScene,
	people: FgMask | null,
): FgMask | null {
	const { width: sw, height: sh, cls } = scene.split;
	if (!sw || !sh || cls.length < sw * sh) return people;
	const obj = new Uint8Array(sw * sh);
	let any = false;
	for (let y = 0; y < sh; y++)
		for (let x = 0; x < sw; x++) {
			if (cls[y * sw + x] !== PixelClass.Object) continue;
			any = true;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx >= 0 && yy >= 0 && xx < sw && yy < sh) obj[yy * sw + xx] = 255;
				}
		}
	if (!any) return people;
	if (!people) return { width: sw, height: sh, data: obj };
	const { width: w, height: h } = people;
	const data = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const oy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
		for (let x = 0; x < w; x++) {
			const ox = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
			const i = y * w + x;
			data[i] = obj[oy * sw + ox] ? 255 : people.data[i];
		}
	}
	return { width: w, height: h, data };
}
