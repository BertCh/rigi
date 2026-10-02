// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGpuEngine: the Renderer surface (src/lib/renderer.ts) on WebGPU, the port of the WebGL
// DeckEngine (deck/engine.ts). Same inputs, same queries, same look; the frame is drawn by the
// host-agnostic WGSL cores of this directory (README.md "Layer contract") on a host:
//   DeckHost    deck.gl 9.4 on a WebGPU device (views, lifecycle, the frame loop); needs deck's
//               full build (scripts/deck-webgpu/vite.webgpu.config.ts until vite.config.ts drops
//               the `visgl:webgl-only` condition)
//   DirectHost  plain luma on WebGPU, no deck (the fallback, and the A/B reference)
//
// Frame (hosts/passes.ts): geometry pass (photo camera → GeometryTargets) → 4× MSAA colour pass
// (the view camera: the photo camera, or the world orbit camera) → screen pass (the photo
// compositor in the photo view; a plain present in the world view). One submit.
//
// What maps to what (deck/engine.ts → here):
//   TerrainLayer / batched layer + styles   BatchedTerrainCore (terrain=batched, the default) or
//                                           TerrainCore (terrain=tiles), shaded by TerrainStyles
//                                           (layers/terrain-styles.ts) + the drape plugin
//                                           (layers/drape.ts, world view only)
//   TrailLayer                              TrailCore (colour pass, both views)
//   PhotoCompositor + composite layer       CompositeCore (screen pass, photo view)
//   AtmSkyLayer / canvas background         AtmSkyCore (colour pass, world view: flat or physical)
//   PhotoSkyLayer                           PhotoSkyCore (Step Inside)
//   WorldGizmoLayer                         GizmoCore (world view)
//   DeckSplatLayer                          SplatsCore (world / step view)
//   Tiles3DDeckLayer                        Tiles3DCore (Step Inside, ?tiles3d=)
//   GpuGeometrySource (queries, align)      WebGpuGeometrySource + GeometryGenerations
//                                           (layers/geometry-source.ts): 90 ms debounced async
//                                           readback, readback() forces it, same generations
//   keepLayer / updateComposite             no layer diff here: composite-only changes request a
//                                           "screen" frame (the offscreen targets are reused),
//                                           everything else an "all" frame
//   WorldView + WorldCamera                 WorldCamera (three OrbitControls, no rendering) feeds
//                                           the colour pass camera (host.view); frame.view "world"
//   Step Inside map mode                    deck's MapView + MapController (DeckMapCamera) when
//                                           the host can carry extra deck views (see
//                                           ExtraViewsHost); otherwise StepCamera's own map mode
//   webglcontextlost / restore              device.lost → a new host + cores on the same canvas,
//                                           CPU state re-applied (the WebGL path's revive)
//   export (renderImage / readLayer)        offscreen geometry + colour + screen passes into our
//                                           own targets at the export size, read back
//
// Frame view. The hosts fill FrameState.view from host.frameView (set in sync()); the drape, the
// sky cores and the terrain styles' photo-only near discard read it. Every core is also wrapped
// in a ViewGate that enforces the engine's view (band stats force "photo" through viewOverride)
// and the per-view visibility; the geometry pass always sees "photo".
//
// luma 10: nothing here touches luma beyond Device / Texture / Buffer / Framebuffer; deck only
// through hosts/deck.ts (dynamically imported).
import type { CommandEncoder, Device, Texture } from "@luma.gl/core";
import * as THREE from "three";
import {
	type AlignResult,
	type EdgeMap,
	type Pin,
	solvePins,
} from "#/lib/align";
import * as cam from "#/lib/camera";
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { CpuGeometrySource, TerrainProfiles } from "#/lib/deck/cpu-geometry";
import {
	type OccPlan,
	planOcclusion,
	resolveOcclusion,
	skylineFromRows,
	texelOf,
} from "#/lib/deck/geo-query";
import type {
	GeometrySource,
	GeometrySourceFactory,
} from "#/lib/deck/geometry-source";
import { logRange } from "#/lib/deck/geometry-source";
import {
	eyeAltitude,
	localElevRange,
	nearFadeFor,
	type Peak,
	placePeakLabels,
	type SnappedPeak,
	snapPeaksNear,
} from "#/lib/deck/scene";
import { compositeFor, terrainLookFor } from "#/lib/deck/settings-map";
import {
	redrawIfBlank,
	type SilScores,
	scoreFromMask,
	silMaskWords,
	silNonce,
} from "#/lib/deck/silhouette-mask";
import {
	type ImagerySource,
	loadImagery,
	localMaxOf,
	type TerrainSet,
	type TileMesh,
	type ViewWedge,
} from "#/lib/deck/terrain-data";
import { terrainBuild, terrainMode } from "#/lib/deck/terrain-mode";
import { TerrainStreamer } from "#/lib/deck/terrain-stream";
import {
	buildTrailSegments,
	recolorTrailSegments,
	type TrailSegments,
} from "#/lib/deck/trail-layer";
import { poseQuaternion, WorldCamera } from "#/lib/deck/world-view";
import { tileBounds } from "#/lib/dem";
import { getFlag } from "#/lib/flags";
import { startLakeFloor } from "#/lib/geocam/lakes/fetch";
import { priorHeading } from "#/lib/geocam/priors/heading";
import { distanceM, EnuFrame, M_PER_DEG_LAT } from "#/lib/geodesy";
import { autoAlignAsync, warmAlignGpu } from "#/lib/gpu/align";
import { gpuEnabled } from "#/lib/gpu/core/device";
import { submitWithDefault } from "#/lib/gpu/core/queue";
import { lookIdle } from "#/lib/gpu/look/opt-in";
import {
	buildPhotoPrepAsync,
	type GpuPhotoPrep,
	warmPhotoPrep,
} from "#/lib/gpu/photoprep";
import {
	type FastHorizon,
	startFastHorizon,
} from "#/lib/integration/horizon-fast-app";
import { photoUnknowns, type Unknowns } from "#/lib/integration/unknown-pose";
import {
	clearAirOn,
	clearAirValues,
	wantsClearAirFit,
} from "#/lib/look/clear-air";
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
} from "#/lib/look/composite";
import { COMPOSITE_DEFINES } from "#/lib/look/glsl/composite";
import {
	type BridgedHazeFit,
	HazeController,
	rangeGeo,
} from "#/lib/look/haze-controller";
import type { SkyMask } from "#/lib/look/haze-fit";
import { drawExportLabels, skylineAt } from "#/lib/look/labels";
import { lookKey } from "#/lib/look/look-key";
import { ReliefController } from "#/lib/look/relief/field";
import { DeckMapCamera, MAP_VIEW_ID } from "#/lib/nearfield/deck-map-camera";
import { type ByteMask, stepMasks } from "#/lib/nearfield/deck-step";
import {
	loadNearDem,
	type NearDem,
	nearFieldDemRangeFrom,
} from "#/lib/nearfield/near-dem";
import { PROVENANCE_TINT_MIX } from "#/lib/nearfield/provenance";
import {
	StepCamera,
	type StepInsideOpts,
	type StepView,
} from "#/lib/nearfield/step-camera";
import {
	type NearFieldScene,
	type NearFieldViewOpts,
	PixelClass,
} from "#/lib/nearfield/types";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import type { PhotoMeta, RegionData, RegionTrail } from "#/lib/photos";
import { unprojectDir } from "#/lib/pose";
import type {
	FgMask,
	PeakLabel,
	Renderer,
	Sample,
	Settings,
} from "#/lib/renderer";
import type { RevealUniforms } from "#/lib/reveal/config";
import { defaultSettings } from "#/lib/settings";
import { hexToRgba01 } from "#/lib/style/color";
import {
	type DeckStyleMode,
	type DeckTerrainStyle,
	deckCompositeStyle,
	deckElevRange,
	deckTerrainStyle,
	deckWorldStyle,
	trailPalette,
} from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import type { ViewStyle } from "#/lib/style/types";
import { heightFromTile } from "#/lib/terrain";
import { type TerroirShader, terroirShader } from "#/lib/terroir/glsl/values";
import type { CoverGrid } from "#/lib/terroir/pack";
import { tiles3dConfig } from "#/lib/tiles3d/config";
import { DeckTiles3D } from "#/lib/tiles3d/deck-tiles";
import {
	type CameraUniforms,
	cameraUniforms,
	photoCamera,
	projectToPixel,
	worldCamera,
} from "./camera";
import { createLookBridge, type LookBridge } from "./compute-bridge";
import { deckBuild, releaseForCompute, webgpuAvailable } from "./device";
import { GeoQueryGpu } from "./geo-query-gpu";
import { HeightGather, replayHeights } from "./height-gather";
import type { Host, HostStats } from "./hosts/direct";
import {
	type CameraPose,
	camerasFor,
	prewarmReducedColor,
	runColorPass,
	runGeometryPass,
	runScreenPass,
} from "./hosts/passes";
import { ImageryArray } from "./imagery";
import { AtmSkyCore } from "./layers/atm-sky";
import {
	type BatchedTerrainCore,
	createBatchedTerrain,
} from "./layers/batched-terrain";
import { type CompositeCore, createCompositeCore } from "./layers/composite";
import { createDrape, type DrapePart } from "./layers/drape";
import {
	type FusedWork,
	GeometryGenerations,
	WebGpuGeometrySource,
	webgpuGeometryFactory,
} from "./layers/geometry-source";
import { createGizmoCore, type GizmoCore } from "./layers/gizmo";
import { createPhotoSkyCore, type PhotoSkyCore } from "./layers/photo-sky";
import { createSplatsCore, type SplatsCore } from "./layers/splats";
import {
	createTerrainStyles,
	type TerrainStyles,
	terrainStyleName,
} from "./layers/terrain-styles";
import {
	createTiles3DCore,
	type Tiles3DCore,
	tiles3dCoreOptions,
} from "./layers/tiles3d";
import { createTrailCore, type TrailCore } from "./layers/trail";
import {
	type FrameState,
	type GpuLayerCore,
	modelEpoch,
	type PassContext,
	type PassKind,
	type PrepassContext,
} from "./pass";
import { PresentCore, type PresentMode } from "./present";
import { SilhouetteMaskGpu } from "./silhouette-gpu";
import { ColorTargets, GeometryTargets, geometrySize, USAGE } from "./targets";
import { TerrainCore } from "./terrain";
import { gpuDecodeTileLoader } from "./terrain-gpu-decode";
import { imageTexture } from "./textures";

type View = "photo" | "world";

const angleDiff = (a: number, b: number) =>
	Math.abs(((a - b + 540) % 360) - 180);

/** deck/engine.ts INPUT_IDLE_MS: a change this soon after the previous one is an interaction. */
const INPUT_IDLE_MS = 150;
/** Device losses the engine rebuilds from; the next one hands over to the app's fallback (onUnrecoverable). */
const MAX_DEVICE_LOSSES = 3;

/** Settings only the composite reads (deck/engine.ts COMPOSITE_ONLY): a "screen" frame only. */
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

/** Settings a pointer drives continuously (lens, swipe). */
const POINTER_SETTINGS = new Set<string>(["lens", "swipe"]);

/** Idle time after which the silhouette re-rank's sources are released (WAG W1.6). */
const SIL_IDLE_MS = 2000;
/** Photo camera near plane (deck PhotoView near 1; geometry-source default). */
const PHOTO_NEAR = 1;

/** GPUBufferUsage bits for readback buffers. */
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;

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

const sameKeyList = (a: unknown[], b: unknown[]) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------------------------
// host plumbing

/**
 * A host that can carry extra deck views next to its own (DeckHost after the change in the
 * WIRING notes). Step Inside's top-down map mode then runs on deck's MapView + MapController
 * (nearfield/deck-map-camera.ts), exactly as deck/engine.ts does; without it StepCamera runs its
 * own map mode (the three.js engine's behaviour).
 */
export type ExtraViewsHost = Host & {
	setExtraViews(
		views: readonly unknown[],
		viewState: Record<string, unknown>,
		handlers?: {
			onViewStateChange?: (p: { viewId: string; viewState: unknown }) => void;
			onInteractionStateChange?: (s: Record<string, boolean>) => void;
		},
	): void;
};

const hasExtraViews = (h: Host | null): h is ExtraViewsHost =>
	!!h && typeof (h as Partial<ExtraViewsHost>).setExtraViews === "function";

/**
 * A core as the engine sees it: the frame's view (the hosts always pass "photo") and an extra
 * visibility gate. Geometry passes always run through the photo camera, so they see "photo".
 */
class ViewGate implements GpuLayerCore {
	constructor(
		readonly inner: GpuLayerCore,
		private view: () => View,
		private show: () => boolean = () => true,
	) {}
	get id() {
		return this.inner.id;
	}
	get passes(): readonly PassKind[] {
		return this.inner.passes;
	}
	get order() {
		return this.inner.order;
	}
	get screenParameters() {
		return this.inner.screenParameters;
	}
	draw(ctx: PassContext) {
		const view: View = ctx.kind === "geometry" ? "photo" : this.view();
		this.inner.draw(
			ctx.frame.view === view ? ctx : { ...ctx, frame: { ...ctx.frame, view } },
		);
	}
	prepass(ctx: PrepassContext) {
		this.inner.prepass?.(ctx);
	}
	visible() {
		return this.show() && (this.inner.visible?.() ?? true);
	}
	destroy() {
		this.inner.destroy();
	}
}

/** Everything that lives on the GPU device (rebuilt as a whole after a device loss). */
type Gpu = {
	host: Host;
	device: Device;
	imagery: ImageryArray;
	terrain: TerrainCore | BatchedTerrainCore;
	styles: TerrainStyles;
	drape: DrapePart;
	trails: TrailCore;
	composite: CompositeCore;
	/** world view present (colour target → canvas) */
	present: PresentCore;
	/** photo view debug present (?view=geometry|normal|depth), null mode = off */
	debug: PresentCore;
	debugMode: PresentMode | null;
	atmSky: AtmSkyCore;
	photoSky: PhotoSkyCore;
	gizmo: GizmoCore;
	splats: SplatsCore;
	tiles3d: Tiles3DCore | null;
	photoTex: Texture | null;
	photoTexFrom: HTMLImageElement | null;
	reliefFrom: ReliefController["current"];
	/** look passes on the render targets (compute-bridge.ts); null = the readback path */
	bridge: LookBridge | null;
};

export type WebGpuEngineOptions = {
	/** Force a host (default: deck when deck's full build is bundled, else direct). */
	host?: "deck" | "direct";
	/** The terrain path (default: the ?terrain flag, deck/terrain-mode.ts). */
	terrain?: "batched" | "tiles";
	/** Look passes straight on the render targets (compute-bridge.ts) where the gate allows
	 * (default true); false = the geometry / colour readback path. See setLookBridge. */
	lookBridge?: boolean;
	/** With the bridge on: the fitted haze on the geometry target too (default true; false = the
	 * haze fit keeps the range readback path while masks / stats stay bridged). See setHazeBridge. */
	hazeBridge?: boolean;
	/** With the bridge on: the relief field's height raster gathered in WGSL from the batched
	 * terrain's resident DEM tiles ("gpu", default; falls back per build to the CPU raster when a
	 * tile is not resident) or always rasterised on the CPU ("cpu"). */
	reliefHeights?: "gpu" | "cpu";
	/** autoAlign's silhouette re-rank scored by a WGSL mask kernel on the geometry targets
	 * (default true; deck/silhouette-mask.ts: identical scores by construction, 18 KB read per
	 * pose instead of the rgba32float range). false = the CPU scorer, which also runs per pose
	 * whenever the GPU can't decide. Harnesses flip `silhouetteGpu` for the A/B. */
	silhouetteGpu?: boolean;
	/** The 1024 px query geometry is NOT read back in full on every settle (default true): peak-label
	 * occlusion verdicts and the skyline come from compute passes over the geometry target
	 * (geo-query-gpu.ts, deck/geo-query.ts: identical results by construction, a few hundred bytes
	 * read), point queries gather single texels, and the full rgba32float copy is read lazily only
	 * for the consumers that need it (readback(), the CPU look fallbacks, a fitted haze, Step
	 * Inside). false = the full readback on every settle, which is also what any failing kernel
	 * switches to. Harnesses flip it for the A/B. */
	geometryDiet?: boolean;
	/** With the bridge on: fewer submits per settle (WAG W1.2, default true). The refined masks are
	 * recorded on their own encoder and submitted with the query geometry render (one
	 * queue.submit), then adopted when their inputs still match; the band stats share their layer
	 * render's submit the same way (compute-bridge.ts header). Same graphs, same bytes. false =
	 * each pass its own submit and the original two-texture mask ping-pong, as before. Read live;
	 * harnesses flip it. */
	settleFusion?: boolean;
};

export type WebGpuEngineStats = {
	terrainTiles: number;
	queryGeneration: number | null;
	profileBins: number;
	horizonSource: "fast" | "cpu" | null;
	horizonDirs: number;
	peaks: number;
	snapped: number;
	tested: number;
	geoGen: number;
	geoBufGen: number;
	geometrySource: "gpu" | "cpu" | null;
	silhouette: { renders: number; ms: number; searchMs: number } | null;
	trailSegments: number;
	host: "deck" | "direct" | null;
	view: View;
};

export type WebGpuEngineCounters = {
	/** Frames requested through schedule() ("all" / "screen"). */
	framesAll: number;
	framesScreen: number;
	compositeOnly: number;
	interactions: number;
	contextLost: number;
	contextRestored: number;
};

// ---------------------------------------------------------------------------------------------

export class WebGpuEngine implements Renderer {
	readonly kind = "deck" as const;
	/** Which deck backend this is (tools that poke WebGL deck internals must check it). */
	readonly backend = "webgpu" as const;
	readonly photo: PhotoMeta;
	readonly aspect: number;
	readonly prior: Pose;
	readonly unknowns: Unknowns;
	readonly frame: EnuFrame;
	pose: Pose;
	settings: Settings = { ...defaultSettings };
	style: ViewStyle = CLASSIC;
	/** The TerrainSet the CPU queries read (deck/engine.ts maybeSwapQueryTerrain). */
	terrain?: TerrainSet;
	eye = { x: 0, y: 0, z: 0 };
	eyeAlt = 0;
	demAtCamera = 0;
	cssSize = { w: 1, h: 1 };
	/** Override the query / silhouette sources (deck/engine.ts geometryFactory). */
	geometryFactory?: GeometrySourceFactory;

	private opts: WebGpuEngineOptions;
	private canvas: HTMLCanvasElement;
	private host: Host | null = null;
	private gpu: Gpu | null = null;
	/** Resolves once the first host is up (rejects when WebGPU is unavailable). */
	private ready: Promise<void>;
	private lost = false;
	/**
	 * Called once when the engine cannot recover from a device loss (the rebuild failed, or the loss
	 * budget below is spent). The host app then replaces it (PhotoWorkspace: WebGL deck, fresh canvas).
	 */
	onUnrecoverable: ((why: string) => void) | null = null;
	private gaveUp = false;
	private looks = new Map<string, DeckTerrainStyle>();
	private haze = new HazeController();
	private relief = new ReliefController();
	/** Terroir land cover (setTerroirCover) and the terroir shading of it + the style. */
	private terroirGrid: CoverGrid | null = null;
	private terroirMemo: {
		style: ViewStyle;
		grid: CoverGrid | null;
		t: TerroirShader | null;
	} | null = null;
	private compLook = new CompositeLook();
	private statsTimer = 0;
	private statsBusy = false;
	private layerGen = 0;
	private brushVersion = 0;
	private lookTimer = 0;
	private region: RegionData | null = null;
	private trails: TrailSegments | null = null;
	private pendingTrails?: RegionTrail[];
	private geoSrc?: GeometrySource;
	private geoSrcKind: "gpu" | "cpu" | null = null;
	private geoSrcEye: Vec3 | null = null;
	private gens: GeometryGenerations;
	private geoBufGen = -1;
	private silTiming: {
		renders: number;
		ms: number;
		searchMs: number;
		scoreMs?: number;
		/** "gpu" = mask kernel (silhouetteGpu), "cpu" = range readback + CPU scorer */
		path?: "gpu" | "cpu";
		/** bytes read back from the GPU for the whole re-rank */
		bytes?: number;
		/** GPU path: poses re-scored on the CPU (undecided pixel / bad header) */
		fallbacks?: number;
		/** finalists whose render came back blank and were drawn again (redrawIfBlank) */
		redraws?: number;
	} | null = null;
	/** WebGpuEngineOptions.silhouetteGpu (harnesses flip it for the A/B). */
	silhouetteGpu = true;
	private silMask: SilhouetteMaskGpu | null = null;
	/** geometry diet (see WebGpuEngineOptions.geometryDiet) */
	private geoQuery: GeoQueryGpu | null = null;
	/**
	 * WAG W2.4: the CPU height readers (camera DEM height, trails, peak snapping) gather lazy tiles'
	 * heights from the atlas (height-gather.ts) while the terrainGpuDecode loader streams; null = heightAt.
	 */
	private heightGather: HeightGather | null = null;
	private heightGatherCore: object | null = null;
	private gpuDecodeOn = false;
	/** trail builds in flight: a newer build (or terrain) supersedes an older one */
	private trailGen = 0;
	/** the latest gathered trail build in flight (settle() waits for it) */
	private trailFlight: Promise<unknown> | null = null;
	/** peak snaps gathered asynchronously: results waiting for snapPeaksNear, peaks in flight, epoch */
	private snapDone = new Map<Peak, { lat: number; lon: number; h: number }>();
	private snapPending = new Set<Peak>();
	private snapFlights = new Set<Promise<void>>();
	private snapGen = 0;
	private snapEmitQueued = false;
	private dietBroken = false;
	/** Occlusion verdicts of a render (peaks in frame only), valid for exactly the inputs they were made from. */
	private occGpu: {
		seq: number;
		pose: Pose;
		eye: Vec3;
		aspect: number;
		snapped: SnappedPeak[];
		vis: Map<SnappedPeak, boolean>;
		applied: boolean;
	} | null = null;
	private skyGpu: { seq: number; sky: Float32Array } | null = null;
	private queryBusy = false;
	/** Gathered texels (x y z w) of the render `seq`, by y * w + x. */
	private ptCache: { seq: number; map: Map<number, Float32Array> } | null =
		null;
	private ptQueue = new Map<
		number,
		{ x: number; y: number; res: ((t: Float32Array | null) => void)[] }
	>();
	private ptFlushing = false;
	/** Bytes the diet's kernels read back, and the full readbacks it still did (evidence / stats). */
	dietStats = { kernelCalls: 0, fullReads: 0, fullBytes: 0 };
	private fullKicked = false;
	private streamer?: TerrainStreamer;
	private renderSet: TerrainSet | null = null;
	private queryWedge?: ViewWedge;
	private streamerWedge?: ViewWedge;
	/** loadFullTerrain: the streamer keeps refining all around the eye (setPose no longer narrows it). */
	private fullWedge?: ViewWedge;
	/** loadFullTerrain completed (the query terrain is the 360° set and the horizon re-traced). */
	private fullTerrainDone = false;
	/** renderPoseView in progress: the photo-view terrain drops its near discard (deck/engine.ts). */
	private poseView = false;
	private elevRange: [number, number] | null = null;
	private photoImg?: HTMLImageElement;
	private fgMask: FgMask | null = null;
	private occluder: FgMask | null = null;
	private reveal: RevealUniforms | null = null;
	private skyMaskStore: SkyMask | null = null;
	/** the photo prep: edge planes resident on the GPU, CPU EdgeMap read on first use (W1.1) */
	private photoPrep?: GpuPhotoPrep;
	/** the CPU EdgeMap (sync readers: the memo, else the CPU reference; same planes as the read) */
	private get edge(): EdgeMap | undefined {
		return this.photoPrep?.cpuSync();
	}
	private horizonDirs?: Float32Array;
	private horizonSource: "fast" | "cpu" | null = null;
	private fastHorizon?: FastHorizon;
	private peaks: Peak[] = [];
	private snaps = new Map<Peak, SnappedPeak | null>();
	private vis = new Map<SnappedPeak, boolean>();
	private profiles?: TerrainProfiles;
	private silSources: GeometrySource[] = [];
	/** silhouette re-ranks in flight; the sources are released SIL_IDLE_MS after the last (W1.6) */
	private silUsers = 0;
	private silIdleTimer = 0;
	private imagery = {
		key: "",
		map: new Map<string, ImageBitmap>(),
		abort: null as AbortController | null,
	};
	private harm?: {
		stats: unknown;
		amount: unknown;
		value: ReturnType<typeof harmonizeValues>;
	};
	private interactive = false;
	private lastInputAt = Number.NEGATIVE_INFINITY;
	private idleTimer = 0;
	/** scheduleWarm: pass.ts modelEpoch the 1× pipelines were last built for. */
	private warmedEpoch = -1;
	private warmTimer = 0;
	private warming = false;
	private listeners = new Set<() => void>();
	private wedgeTimer = 0;
	private disposed = false;
	private world?: WorldCamera;
	private worldRaf = 0;
	private worldStill = 0;
	private worldNear = 5;
	/** Temporarily forces the frame view (band stats render through the photo camera classically). */
	private viewOverride: View | null = null;
	private loadAbort = new AbortController();
	private nearField: {
		scene: NearFieldScene;
		opts: NearFieldViewOpts;
	} | null = null;
	private step: {
		cam: StepCamera;
		enteredWorld: boolean;
		masks: { step: ByteMask; sky: ByteMask } | null;
		map: DeckMapCamera | null;
		view: StepView;
	} | null = null;
	private tiles3d = DeckTiles3D.create(() => {
		if (!this.step || this.disposed) return;
		this.sync();
		this.kickWorld();
	});
	/** Step Inside's exports hide display-only (Google) tiles (tiles3d withoutDisplayOnly). */
	private hideDisplayOnly = false;
	private drapeMaskCache: { key: unknown[]; mask: FgMask | null } | null = null;
	private nearDem: NearDem | null = null;
	private skyCache?: { gen: number; sky: Float32Array };
	private counters: WebGpuEngineCounters = {
		framesAll: 0,
		framesScreen: 0,
		compositeOnly: 0,
		interactions: 0,
		contextLost: 0,
		contextRestored: 0,
	};
	/** Coalesced frame request (schedule): the widest scope asked for this task. */
	private pendingScope: "all" | "screen" | null = null;

	/** WebGPU present and an adapter granted? (never throws) */
	static available() {
		return webgpuAvailable();
	}

	/**
	 * Resolves once the first host (device, canvas context, cores) is up; rejects when it could not be
	 * built. PhotoWorkspace awaits it before start() and falls back to the WebGL DeckEngine on a fresh
	 * canvas when it rejects (src/lib/renderer-select.ts).
	 */
	whenReady(): Promise<void> {
		return this.ready;
	}

	constructor(
		canvas: HTMLCanvasElement,
		photo: PhotoMeta,
		opts: WebGpuEngineOptions = {},
	) {
		this.opts = opts;
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
		this.canvas = canvas;
		this.cssSize = { w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 };
		this.eye = { x: 0, y: 0, z: photo.alt ?? 0 };
		this.haze.onAsync = () => {
			if (this.disposed) return;
			this.looks.clear();
			this.layerGen++;
			this.sync();
		};
		this.relief.onAsync = () => {
			if (this.disposed) return;
			this.layerGen++;
			this.sync();
		};
		this.compLook.onAsync = () => {
			if (this.disposed) return;
			this.updateLook();
			if (this.world?.controls) this.sync();
		};
		this.gens = new GeometryGenerations({
			source: () => this.querySource(),
			pose: () => this.pose,
			canRender: () =>
				!!this.terrain && !!this.gpu && !this.lost && !this.disposed,
			interactive: () => this.interactive,
			beforeRender: () => this.ready,
			onFresh: (gen) => this.onGeometryFresh(gen),
		});
		this.ready = this.boot();
		// an unhandled rejection here would be noise: init() rethrows it
		this.ready.catch(() => {});
	}

	// =============================================================================================
	// GPU lifecycle: host + cores (boot), device loss (rebuild)

	private get view(): View {
		return this.viewOverride ?? (this.world?.controls ? "world" : "photo");
	}

	private get eyeArr(): Vec3 {
		return [this.eye.x, this.eye.y, this.eye.z];
	}

	private get eyeVec() {
		return new THREE.Vector3(this.eye.x, this.eye.y, this.eye.z);
	}

	/** The photo camera as a host CameraPose. */
	private photoPose(pose: Pose = this.pose): CameraPose {
		const c = photoCamera({
			pose,
			eye: this.eyeArr,
			width: 1,
			height: 1,
			near: PHOTO_NEAR,
		});
		return {
			eye: c.eye,
			forward: c.forward,
			up: c.up,
			vfov: c.vfov,
			near: c.near,
		};
	}

	/** The photo camera's uniforms at the geometry target's size (drape, photo sky, tiles fill). */
	private photoUniforms(): CameraUniforms {
		const g = this.gpu?.host.geometry;
		const size = g
			? { width: g.width, height: g.height }
			: geometrySize(this.aspect);
		return cameraUniforms(
			photoCamera({
				pose: this.pose,
				eye: this.eyeArr,
				...size,
				near: PHOTO_NEAR,
			}),
		);
	}

	/** The colour pass camera: the photo camera, or the world orbit camera. */
	private viewPose(): CameraPose {
		const w = this.world;
		if (!w?.controls) return this.photoPose();
		const vs = w.viewState(this.eyeVec);
		const c = worldCamera({
			eye: vs.eye,
			forward: vs.forward,
			up: vs.up,
			camFov: vs.camFov,
			width: 1,
			height: 1,
			near: this.worldNear,
		});
		return {
			eye: c.eye,
			forward: c.forward,
			up: c.up,
			vfov: c.vfov,
			near: c.near,
		};
	}

	private async createHost(): Promise<Host> {
		const avail = await webgpuAvailable();
		if (!avail.ok) throw new Error(`WebGPU unavailable: ${avail.reason}`);
		const pose = this.photoPose();
		const wantDeck = this.opts.host
			? this.opts.host === "deck"
			: deckBuild() === "full";
		if (wantDeck)
			try {
				return await (await import("./hosts/deck")).DeckHost.create(
					this.canvas,
					pose,
				);
			} catch (e) {
				if (this.opts.host === "deck") throw e;
				console.warn("[webgpu-engine] deck host failed, using direct", e);
			}
		return (await import("./hosts/direct")).DirectHost.create(
			this.canvas,
			pose,
		);
	}

	/** Host + cores; CPU state (photo, masks, tiles, imagery, trails, splats…) is re-applied. */
	private async boot(brushFrom?: HTMLCanvasElement) {
		const host = await this.createHost();
		if (this.disposed) {
			host.destroy();
			return;
		}
		// A throw while the cores are built (or applyState) must not leak the device and the cores
		// already created: undo them, release the device, and let compute drop the adopted one.
		const built: { destroy(): void }[] = [];
		const made = <T extends { destroy(): void } | null>(c: T): T => {
			if (c) built.push(c);
			return c;
		};
		try {
			host.setPhotoAspect(this.aspect);
			const device = host.device;
			const imagery = made(new ImageryArray(device));
			const batched = (this.opts.terrain ?? terrainMode()) === "batched";
			const terrain = made(
				batched
					? createBatchedTerrain(device, imagery)
					: new TerrainCore(device, imagery),
			);
			const styles = made(createTerrainStyles(device));
			const drape = made(createDrape(device));
			const trails = made(createTrailCore(device));
			const composite = made(
				createCompositeCore({
					aspect: this.aspect,
					requestRender: (s) => this.schedule(s),
				}),
			);
			if (brushFrom)
				composite.brushCanvas.getContext("2d")?.drawImage(brushFrom, 0, 0);
			const present = made(new PresentCore("world-present"));
			present.mode = "color";
			const debug = made(new PresentCore("debug-present"));
			const atmSky = made(new AtmSkyCore());
			const photoSky = made(createPhotoSkyCore());
			const gizmo = made(createGizmoCore(device));
			const splats = made(createSplatsCore(device));
			splats.onChange = () => this.schedule("all");
			const t3cfg = this.tiles3d ? tiles3dConfig() : null;
			const tiles3d = made(
				this.tiles3d
					? createTiles3DCore(device, tiles3dCoreOptions(t3cfg))
					: null,
			);
			const gpu: Gpu = {
				host,
				device,
				imagery,
				terrain,
				styles,
				drape,
				trails,
				composite,
				present,
				debug,
				debugMode: null,
				atmSky,
				photoSky,
				gizmo,
				splats,
				tiles3d,
				photoTex: null,
				photoTexFrom: null,
				reliefFrom: null,
				bridge: null,
			};
			const view = () => this.view;
			const inPhoto = () => this.view === "photo";
			const inWorld = () => this.view === "world";
			host.cores = [
				new ViewGate(terrain, view),
				new ViewGate(trails, view),
				...(tiles3d ? [new ViewGate(tiles3d, view, inWorld)] : []),
				new ViewGate(gizmo, view, inWorld),
				new ViewGate(atmSky, view, inWorld),
				new ViewGate(photoSky, view, inWorld),
				new ViewGate(splats, view, inWorld),
				new ViewGate(composite, view, inPhoto),
				new ViewGate(present, view, inWorld),
				new ViewGate(debug, view, () => inPhoto() && !!gpu.debugMode),
			];
			imagery.onChange = () => {
				terrain.syncImageryLayers();
				this.schedule("all");
			};
			host.device.lost.then((info) => this.onDeviceLost(host, info));
			this.host = host;
			this.gpu = gpu;
			this.applyState();
			if (this.opts.lookBridge !== false) void this.attachBridge(gpu);
		} catch (e) {
			if (this.host === host) this.host = null;
			this.gpu = null;
			host.cores = []; // the cores are destroyed below, not by host.destroy()
			for (const c of built.reverse())
				try {
					c.destroy();
				} catch {}
			try {
				host.destroy(); // destroys the device (luma.createDevice created it, so the Device owns the GPUDevice)
			} catch (err) {
				console.warn(
					"[webgpu-engine] destroying the host after a failed boot",
					err,
				);
			}
			releaseForCompute();
			throw e;
		}
	}

	/** compute-bridge.ts on this device when its gate passes (else the readback path stays). */
	private async attachBridge(gpu: Gpu) {
		const b = await createLookBridge(gpu.device);
		if (!b) return;
		if (this.gpu !== gpu || this.disposed || this.opts.lookBridge === false)
			return b.destroy();
		b.fusionOn = () => this.opts.settleFusion !== false;
		b.onAsync = () => {
			if (this.disposed) return;
			this.updateLook();
			if (this.world?.controls) this.sync();
		};
		const terrain = gpu.terrain;
		if (this.opts.reliefHeights !== "cpu" && "residentHeights" in terrain)
			b.heightSource = () => terrain.residentHeights();
		gpu.bridge = b;
		this.compLook.setSky(this.skyMaskStore);
		this.refitHaze();
		this.updateLook();
		this.scheduleStats();
	}

	/** The compute bridge (harnesses), or null on the readback path. */
	get lookBridge(): LookBridge | null {
		return this.gpu?.bridge ?? null;
	}

	/** Switch the look passes between the compute bridge (when gated in) and the readback path. */
	async setLookBridge(on: boolean) {
		this.opts = { ...this.opts, lookBridge: on };
		const g = this.gpu;
		if (!g) return;
		g.bridge?.destroy();
		g.bridge = null;
		g.composite.setMaskTexture(null);
		// both paths recompute from scratch (CompositeLook caches its inputs and stats key)
		this.compLook.setSky(this.skyMaskStore);
		this.layerGen++;
		if (on) await this.attachBridge(g);
		else {
			this.refitHaze();
			this.updateLook();
			this.scheduleStats();
		}
	}

	/** Switch the haze fit between the bridge (when it is on) and the range readback path. */
	setHazeBridge(on: boolean) {
		this.opts = { ...this.opts, hazeBridge: on };
		this.refitHaze();
	}

	/** Drop the haze fit's key (and any fit in flight) and fit again on the current path. */
	private refitHaze() {
		this.haze.setSky(this.skyMaskStore);
		this.fitHaze();
	}

	/** Push the whole CPU state into a fresh set of cores (boot / after a device loss). */
	private applyState() {
		const g = this.gpu;
		if (!g) return;
		g.composite.setStyle(deckCompositeStyle(this.style));
		g.composite.setSettings(compositeFor(this.settings));
		g.composite.setReveal(this.reveal);
		g.composite.setForegroundMask(this.fgMask);
		g.composite.setOccluder(this.occluder);
		this.ensurePhotoTexture();
		if (this.renderSet) g.terrain.setTiles(this.renderSet.tiles);
		this.pushImagery();
		g.trails.setSegments(this.trails);
		if (this.nearField) g.splats.setCloud(this.nearField.scene.splats);
		this.updateLook();
		this.sync();
	}

	/** The photo as one shared sRGB texture (composite, drape, photo sky, gizmo). */
	private ensurePhotoTexture() {
		const g = this.gpu;
		const img = this.photoImg;
		if (!g || !img || g.photoTexFrom === img) return;
		g.photoTex?.destroy();
		g.photoTex = imageTexture(g.device, img, { id: "rigi-photo" });
		g.photoTexFrom = img;
		g.composite.setPhoto(g.photoTex);
		g.drape.setPhotoTexture(g.photoTex);
		g.photoSky.setPhoto(g.photoTex);
	}

	private destroyGpu(g: Gpu) {
		// engine-owned resources first, while the device is alive; then host.destroy() destroys
		// the cores, the deck (if any) and the device
		for (const f of [
			() => g.bridge?.destroy(),
			() => g.imagery.destroy(),
			() => g.styles.destroy(),
			() => g.drape.destroy(),
			() => g.photoTex?.destroy(),
		])
			try {
				f();
			} catch {}
		try {
			g.host.destroy();
		} catch (e) {
			console.warn("[webgpu-engine] destroying the host", e);
		}
	}

	/**
	 * device.lost (driver reset, GPU process crash, or simulateDeviceLoss): a new host + cores on
	 * the same canvas, then the CPU state again. Intentional destroys (dispose, rebuild) detach the
	 * host first, so they never get here.
	 */
	private giveUp(why: string) {
		if (this.gaveUp || this.disposed) return;
		this.gaveUp = true;
		this.onUnrecoverable?.(why);
	}

	private async onDeviceLost(host: Host, info: { message?: string }) {
		if (this.disposed || this.host !== host) return;
		this.lost = true;
		this.counters.contextLost++;
		// same budget as the compute realm (gpu/core/device.ts MAX_LOSSES): a device that keeps dying
		// is not worth another rebuild
		if (this.counters.contextLost > MAX_DEVICE_LOSSES) {
			console.warn(
				`[webgpu-engine] device lost ${this.counters.contextLost} times (${info.message ?? "?"})`,
			);
			this.giveUp(`device lost ${this.counters.contextLost} times`);
			return;
		}
		console.warn(
			`[webgpu-engine] device lost (${info.message ?? "?"}); rebuilding`,
		);
		cancelAnimationFrame(this.worldRaf);
		this.worldRaf = 0;
		clearTimeout(this.statsTimer);
		this.statsTimer = 0;
		const old = this.gpu;
		this.gpu = null;
		this.host = null;
		this.dropGeometrySources();
		const brush = old ? copyCanvas(old.composite.brushCanvas) : undefined;
		if (old) this.destroyGpu(old);
		this.ready = this.boot(brush);
		try {
			await this.ready;
		} catch (e) {
			console.error("[webgpu-engine] rebuild after device loss failed", e);
			this.giveUp(
				`rebuild after device loss failed: ${(e as Error)?.message ?? e}`,
			);
			return;
		}
		if (this.disposed) return;
		this.lost = false;
		// a kernel failure caused by the loss must not keep the diet off for good
		this.dietBroken = false;
		this.counters.contextRestored++;
		if (this.step?.map) this.syncMapViews();
		this.invalidateGeometry();
		if (this.world?.controls) this.kickWorld();
		console.warn("[webgpu-engine] device restored; renderer rebuilt");
	}

	/** Test hook (window.__RIGI_FORCE_DEVICE_LOSS__ in dev): lose the device on purpose (the rebuild path runs as for a real loss). */
	simulateDeviceLoss() {
		this.host?.device.destroy();
	}

	/** Test hook: take the unrecoverable path (the app's WebGL switch) without a real loss. */
	simulateUnrecoverableLoss() {
		this.giveUp("forced (simulated unrecoverable loss)");
	}

	// =============================================================================================
	// frames

	/**
	 * One coalesced frame per task: "all" re-renders geometry + colour, "screen" only the screen
	 * pass on the cached targets (composite-only changes). onRender listeners fire after it.
	 */
	private schedule(scope: "all" | "screen" = "all") {
		if (this.disposed) return;
		const first = this.pendingScope === null;
		if (scope === "all" || first) this.pendingScope = scope;
		if (!first) return;
		queueMicrotask(() => {
			const s = this.pendingScope ?? "all";
			this.pendingScope = null;
			const host = this.host;
			if (!host || this.disposed || this.lost) return;
			if (s === "all") this.counters.framesAll++;
			else this.counters.framesScreen++;
			void host.nextFrame(s).then(() => {
				this.emit();
				this.scheduleWarm();
			});
		});
	}

	/**
	 * Build the interactive 1× colour pipelines once a full frame is up (and again when pass.ts
	 * modelEpoch says the layer set / a shader variant changed), so the first drag does not stall
	 * on pipeline creation. luma 10 alpha.2 only compiles async for Models created under
	 * beginAsyncCompilation, which the layers' draw-time creation cannot use; this runs sync, one
	 * layer per idle slice, into an 8×8 scratch target (nothing visible, no extra frame).
	 */
	private scheduleWarm() {
		if (this.disposed || this.lost || this.warming) return;
		if (this.warmedEpoch === modelEpoch()) return;
		clearTimeout(this.warmTimer);
		this.warmTimer = window.setTimeout(() => void this.prewarm(), 400);
	}

	private async prewarm() {
		const host = this.host;
		if (!host || this.disposed || this.lost || this.warming) return;
		if (this.interactive) return; // inputIdle's "all" frame re-arms it
		this.warming = true;
		const epoch = modelEpoch();
		let scratch: ColorTargets | null = null;
		try {
			scratch = new ColorTargets(host.device, 8, 8, "rigi-prewarm");
			const done = await prewarmReducedColor({
				device: host.device,
				cores: host.cores,
				geometry: host.geometry,
				scratch,
				view: host.view,
				frameView: host.frameView,
				yieldIdle: () =>
					new Promise<void>((r) =>
						typeof requestIdleCallback === "function"
							? requestIdleCallback(() => r(), { timeout: 500 })
							: setTimeout(r, 16),
					),
				stale: () =>
					this.disposed || this.lost || this.interactive || this.host !== host,
			});
			// the epoch read before the pass: models it created at 4× (none) would re-arm
			if (done) this.warmedEpoch = epoch;
		} catch (e) {
			this.warmedEpoch = epoch; // a failing layer must not loop; first drag builds lazily
			console.warn("[webgpu-engine] prewarm failed", e);
		} finally {
			scratch?.destroy();
			this.warming = false;
		}
	}

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

	/** Resolves after the next frame's GPU work (harnesses). */
	async nextFrame(scope: "all" | "screen" = "all") {
		await this.ready;
		await this.host?.nextFrame(scope);
	}

	// =============================================================================================
	// Renderer: lifecycle

	async init(
		region: RegionData | null | Promise<RegionData | null>,
		onProgress?: (msg: string, frac: number) => void,
		segment?: (img: HTMLImageElement) => Promise<FgMask | null>,
	) {
		onProgress?.("Loading photo", 0);
		const lakeFloor = startLakeFloor(this.photo, region, this.loadAbort.signal);
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
		const wedge: ViewWedge = this.unknowns.any
			? { headingDeg: this.prior.yaw, halfAngleDeg: 180 }
			: this.wedgeFor(this.prior);
		const terrainLoad = this.startStreaming(wedge, onProgress);
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = this.photo.src;
		await Promise.all([img.decode(), this.ready]);
		if (this.disposed) return;
		// edge-map kernels compile while the terrain streams (buildEdgeMapAsync never waits for them)
		void warmPhotoPrep();
		this.photoImg = img;
		this.ensurePhotoTexture();
		const fgPromise = segment
			? segment(img).catch(() => null)
			: Promise.resolve(null);

		const terrain = await terrainLoad;
		if (!terrain || this.disposed) return;
		const hg = this.heights();
		const demHere = hg
			? await this.cameraDemHeight(hg, terrain)
			: terrain.heightAt(this.photo.lat, this.photo.lon);
		if (this.disposed) return;
		this.terrain = terrain;
		this.queryWedge = wedge;
		const dem = demHere ?? this.photo.alt ?? 0;
		this.demAtCamera = dem;
		this.setEye(eyeAltitude(this.photo.alt, dem));
		this.elevRange = localElevRange(terrain);
		// under terrainGpuDecode the camera gather above spans a GPU round trip, in which onUpdate may
		// have rendered a newer set: keep that one (re-setting the first set would drop its new tiles
		// until the next update). The default path is left as it was.
		this.gpu?.terrain.setTiles(
			(hg ? (this.renderSet ?? terrain) : terrain).tiles,
		);
		this.pushImagery();
		this.updateRelief();
		this.sync();
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
			this.sync();
		}
		if (lakeFloor) {
			const floor = await lakeFloor(dem, (la, lo) => terrain.heightAt(la, lo));
			if (this.disposed) return;
			if (floor != null && floor > this.eyeAlt) {
				this.setEye(floor);
				this.invalidateGeometry();
				this.sync();
			}
		}
		const fg = await fgPromise;
		if (this.disposed) return;
		if (fg) this.setForegroundMask(fg);
		// buildEdgeMap with the post-canvas work on the GPU (bit-identical; CPU fallback inside); the
		// planes stay on the device and the CPU map is read when autoAlign first needs it
		const prep = await buildPhotoPrepAsync(img, 512, fg);
		if (this.disposed) {
			prep.retire();
			return;
		}
		this.photoPrep = prep;
		// read the CPU map in idle time, so sync readers (picker) rarely compute it themselves
		const prefetch = () => {
			if (!this.disposed) void prep.cpu();
		};
		if (typeof requestIdleCallback === "function")
			requestIdleCallback(prefetch, { timeout: 2000 });
		else setTimeout(prefetch, 50);
		void warmAlignGpu();
		onProgress?.("Tracing horizon", 1);
		const dirs = this.takeFastHorizon() ?? (await this.traceHorizon());
		if (this.disposed) return;
		this.horizonDirs = dirs;
		this.sync();
	}

	/** The eye height changed (init, lake floor): the sources render from the old eye, drop them. */
	private setEye(z: number) {
		this.eyeAlt = z;
		this.eye = { x: 0, y: 0, z };
		this.fastHorizon?.setEye(z);
		if (this.geoSrcEye && this.geoSrcEye[2] !== z) this.dropGeometrySources();
	}

	private startStreaming(
		wedge: ViewWedge,
		onProgress?: (msg: string, frac: number) => void,
	) {
		return new Promise<TerrainSet | null>((resolve) => {
			const abort = () => resolve(null);
			this.loadAbort.signal.addEventListener("abort", abort, { once: true });
			const streamer = new TerrainStreamer(this.frame, {
				loadTile: this.gpuDecodeLoader(),
				onProgress: (d, t) =>
					!this.terrain &&
					onProgress?.(`Loading terrain ${d}/${t}`, t ? d / t : 0),
				onUpdate: (set) => {
					if (this.disposed) return;
					this.renderSet = set;
					this.gpu?.terrain.setTiles(set.tiles);
					this.pushImagery();
					if (!this.terrain) {
						this.loadAbort.signal.removeEventListener("abort", abort);
						resolve(set);
						return;
					}
					this.maybeSwapQueryTerrain(set);
					this.sync();
					this.invalidateGeometry();
				},
			});
			this.streamer = streamer;
			streamer.setWedge(wedge);
		});
	}

	/**
	 * The stream's tile loader under flag terrainGpuDecode (batched terrain, ?gpu=on): GPU Terrarium
	 * decode straight into a height-atlas layer the tile keeps, CPU heights on demand
	 * (terrain-gpu-decode.ts); undefined = the
	 * default CPU decode.
	 */
	private gpuDecodeLoader() {
		if (
			getFlag("terrainGpuDecode") !== "on" ||
			!gpuEnabled() ||
			(this.opts.terrain ?? terrainMode()) !== "batched" ||
			terrainBuild().mesh
		)
			return undefined;
		this.gpuDecodeOn = true;
		return gpuDecodeTileLoader(
			async () => {
				await this.ready.catch(() => {});
				return this.disposed || this.lost ? null : (this.gpu?.device ?? null);
			},
			// the batched terrain's height arrays: each tile decodes into a layer it keeps
			() => {
				const t = this.gpu?.terrain;
				return t && "heightAtlases" in t ? t.heightAtlases() : null;
			},
		);
	}

	/** deck/engine.ts maybeSwapQueryTerrain. */
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
		this.dropSnapGathers();
		this.vis.clear();
		this.profiles = undefined;
		if (this.geoSrcKind === "cpu") this.dropGeometrySources();
		this.buildTrails();
	}

	setTrails(trails: RegionTrail[]) {
		if (!this.region || !this.terrain) {
			this.pendingTrails = trails;
			return;
		}
		this.region = { ...this.region, trails };
		this.buildTrails();
		this.sync();
	}

	private buildTrails() {
		const t = this.terrain;
		const region = this.region;
		if (!region || !t) return;
		const gen = ++this.trailGen;
		const hg = this.heights();
		if (!hg) {
			this.trails = buildTrailSegments(
				region,
				this.frame,
				this.photo,
				(lat, lon) => t.heightAt(lat, lon),
				trailPalette(this.style),
			);
			this.gpu?.trails.setSegments(this.trails);
			return;
		}
		// terrainGpuDecode: the same segments, every height in one batched lookup (height-gather.ts)
		const built = replayHeights(
			(heightAt) =>
				buildTrailSegments(
					region,
					this.frame,
					this.photo,
					heightAt,
					trailPalette(this.style),
				),
			(lats, lons) => hg.heightsAt(t, lats, lons),
		);
		const apply = (seg: TrailSegments) => {
			if (gen !== this.trailGen || this.disposed) return false;
			this.trails = seg;
			this.gpu?.trails.setSegments(seg);
			return true;
		};
		if (built instanceof Promise) {
			const flight = built.then(
				(seg) => apply(seg) && this.sync(),
				(e) => console.warn("[height-gather] trail build failed", e),
			);
			this.trailFlight = flight;
			void flight.then(() => {
				if (this.trailFlight === flight) this.trailFlight = null;
			});
		} else apply(built);
	}

	/**
	 * The gathers of height-gather.ts while the terrainGpuDecode loader streams on the batched terrain
	 * (whose atlas holds the lazy tiles' heights), else null: the CPU readers call heightAt.
	 */
	private heights(): HeightGather | null {
		const g = this.gpu;
		if (!this.gpuDecodeOn || !g || !("residentHeights" in g.terrain))
			return null;
		// one per (device, terrain core): the gather reads that core's atlas
		if (
			this.heightGather?.device !== g.device ||
			this.heightGatherCore !== g.terrain
		) {
			this.heightGather?.destroy();
			const terrain = g.terrain;
			this.heightGatherCore = terrain;
			this.heightGather = new HeightGather(g.device, () =>
				this.gpu?.terrain === terrain ? terrain.residentHeights() : null,
			);
		}
		return this.heightGather;
	}

	/** heightAt at the camera (init) from the atlas under terrainGpuDecode (one gather). */
	private async cameraDemHeight(hg: HeightGather, terrain: TerrainSet) {
		const { lat, lon } = this.photo;
		// the stream's first set may have arrived before the device: make it resident first
		this.gpu?.terrain.setTiles(terrain.tiles);
		const h = hg.heightsAt(terrain, [lat], [lon]);
		const v = (h instanceof Float64Array ? h : await h)[0];
		return Number.isNaN(v) ? null : v;
	}

	/**
	 * snapPeaksNear's localMax under terrainGpuDecode: localMaxOf over one batched lookup. Synchronous
	 * when every sample's tile has CPU heights; else the peak is gathered (all peaks of one call share
	 * one dispatch), skipped for now, and handed over on a later call once its summit is known.
	 */
	private gatheredLocalMax(hg: HeightGather, terrain: TerrainSet) {
		return (p: Peak, radiusM: number) => {
			const done = this.snapDone.get(p);
			if (done) {
				this.snapDone.delete(p);
				return done;
			}
			if (this.snapPending.has(p)) return undefined;
			const r = replayHeights(
				(heightAt) => localMaxOf(heightAt, p.lat, p.lon, radiusM),
				(lats, lons) => hg.heightsAt(terrain, lats, lons),
			);
			if (!(r instanceof Promise)) return r;
			const gen = this.snapGen;
			this.snapPending.add(p);
			const flight = r.then((snap) => {
				this.snapFlights.delete(flight);
				if (gen !== this.snapGen || this.disposed) return;
				this.snapPending.delete(p);
				this.snapDone.set(p, snap);
				// the snapped list grew: labels (and their verdicts) re-read it, once per batch
				if (this.snapEmitQueued) return;
				this.snapEmitQueued = true;
				queueMicrotask(() => {
					this.snapEmitQueued = false;
					this.emit();
				});
			});
			this.snapFlights.add(flight);
			return undefined;
		};
	}

	/** The query terrain changed: gathered snaps of the old one are void. */
	private dropSnapGathers() {
		this.snapGen++;
		this.snapDone.clear();
		this.snapPending.clear();
		this.snapFlights.clear();
	}

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
		this.step?.map?.setSize(this.cssSize.w, this.cssSize.h);
		this.sync();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.photoPrep?.retire();
		this.tiles3d?.dispose();
		clearTimeout(this.statsTimer);
		clearTimeout(this.lookTimer);
		clearTimeout(this.idleTimer);
		clearTimeout(this.silIdleTimer);
		clearTimeout(this.warmTimer);
		clearTimeout(this.wedgeTimer);
		cancelAnimationFrame(this.worldRaf);
		this.loadAbort.abort();
		this.fastHorizon?.dispose();
		this.streamer?.dispose();
		this.imagery.abort?.abort();
		for (const b of this.imagery.map.values()) b.close();
		this.imagery.map.clear();
		this.step?.cam.dispose();
		this.step = null;
		this.world?.dispose();
		this.gens.dispose();
		this.dropGeometrySources();
		this.silMask?.destroy();
		this.silMask = null;
		this.geoQuery?.destroy();
		this.geoQuery = null;
		this.heightGather?.destroy();
		this.heightGather = null;
		this.heightGatherCore = null;
		this.listeners.clear();
		const g = this.gpu;
		this.gpu = null;
		this.host = null;
		if (g) this.destroyGpu(g);
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

	/** Diagnostics for harnesses (deck/engine.ts stats + host / view). */
	get stats(): WebGpuEngineStats {
		return {
			terrainTiles: this.renderSet?.tiles.length ?? 0,
			queryGeneration: this.terrain?.stats?.generation ?? null,
			profileBins: this.profiles?.binCount ?? 0,
			horizonSource: this.horizonSource,
			horizonDirs: (this.horizonDirs?.length ?? 0) / 3,
			peaks: this.peaks.length,
			snapped: [...this.snaps.values()].filter(Boolean).length,
			tested: this.vis.size,
			geoGen: this.gens.generation,
			geoBufGen: this.geoBufGen,
			geometrySource: this.geoSrcKind,
			silhouette: this.silTiming,
			trailSegments: this.trails?.count ?? 0,
			host: this.host?.kind ?? null,
			view: this.view,
		};
	}

	/** The host (debugging, harnesses): its targets, stats and — for the deck host — the Deck. */
	get hostInstance(): Host | null {
		return this.host;
	}

	/** The Deck when the deck host runs (null on the direct host). */
	get deckInstance() {
		const h = this.host as (Host & { deck?: unknown }) | null;
		return h?.deck ?? null;
	}

	/** Bench counters (deck/engine.ts metrics(), WebGPU edition). */
	metrics() {
		const d = this.host?.device as
			| (Device & {
					statsManager?: {
						getStats(n: string): { getTable(): Record<string, unknown> };
					};
			  })
			| undefined;
		const table = (name: string) => {
			try {
				return d?.statsManager?.getStats(name).getTable() ?? null;
			} catch {
				return null;
			}
		};
		const g = this.gpu;
		return {
			host: this.host ? { kind: this.host.kind, ...this.host.stats } : null,
			luma: {
				memory: table("GPU Time and Memory"),
				resources: table("GPU Resource Counts"),
			},
			terrain: g ? { ...g.terrain.stats } : null,
			imagery: g ? { ...g.imagery.stats } : null,
			splats: g ? { ...g.splats.stats } : null,
			engine: {
				...this.counters,
				interactive: this.interactive,
				lostNow: this.lost,
				geometryDiet: {
					on: this.dietOn(),
					...this.dietStats,
					kernelBytes: this.geoQuery?.totalBytes ?? 0,
				},
				view: this.view,
			},
		};
	}

	/** Photo-view debug present over the composite (geometry / normal / depth; null = off). */
	setDebugView(mode: PresentMode | null) {
		const g = this.gpu;
		if (!g) return;
		g.debugMode = mode;
		if (mode) g.debug.mode = mode;
		this.schedule("screen");
	}

	// =============================================================================================
	// Renderer: state

	setPose(p: Pose) {
		this.pose = { ...p };
		this.noteInput();
		this.sync();
		this.invalidateGeometry();
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
		if (!this.world?.controls && changed.every((k) => COMPOSITE_ONLY.has(k))) {
			// the composite requests its own "screen" frame; the terrain passes stay cached
			this.counters.compositeOnly++;
			this.gpu?.composite.setSettings(compositeFor(cur));
		} else this.sync();
		this.scheduleLook();
	}

	/** deck/engine.ts noteInput: while an interaction runs the colour pass draws without MSAA
	 * (host.setInteractive; luma pipelines per sample count are cached, pass.ts ModelCache) and the
	 * readback waits; inputIdle restores 4× MSAA with one full "all" frame. */
	private noteInput() {
		const now = performance.now();
		const burst = now - this.lastInputAt < INPUT_IDLE_MS;
		this.lastInputAt = now;
		if (burst && !this.interactive) {
			this.interactive = true;
			this.counters.interactions++;
			this.host?.setInteractive(true);
		}
		clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.inputIdle(), INPUT_IDLE_MS);
	}

	private inputIdle() {
		this.idleTimer = 0;
		if (!this.interactive || this.disposed) return;
		this.interactive = false;
		// the full-quality frame follows the geometry readback (bounded), so the readback waits for
		// no heavy frame; a new interaction meanwhile keeps the reduced mode
		const restore = () => {
			if (this.disposed || this.interactive) return;
			this.host?.setInteractive(false);
			this.schedule("all");
		};
		if (this.terrain && !this.geometryReady() && !this.lost) {
			let t = 0;
			void Promise.race([
				this.gens.readback(),
				new Promise((r) => {
					t = window.setTimeout(r, 250);
				}),
			]).then(() => {
				clearTimeout(t);
				restore();
			});
		} else restore();
	}

	private scheduleLook() {
		if (
			!this.style.composite.refine ||
			!this.gpu?.composite.look.defines.length
		)
			return;
		clearTimeout(this.lookTimer);
		this.lookTimer = window.setTimeout(() => this.updateLook(), 150);
	}

	/** deck/engine.ts setTerroirCover: the pack's class grid (r8 texture in TerrainStyles); null = off. */
	setTerroirCover(grid: CoverGrid | null) {
		if (grid === this.terroirGrid) return;
		this.terroirGrid = grid;
		this.sync();
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

	/** deck/engine.ts setStyle: uniforms for every core; programs rebuild only on define changes. */
	setStyle(style: ViewStyle) {
		if (style === this.style) return;
		const prev = this.style;
		this.style = style;
		this.looks.clear();
		this.layerGen++;
		this.fitHaze();
		this.updateRelief();
		this.gpu?.composite.setStyle(deckCompositeStyle(style));
		this.updateLook();
		if (prev.trails.colors !== style.trails.colors && this.trails) {
			this.trails = recolorTrailSegments(this.trails, trailPalette(style));
			this.gpu?.trails.setSegments(this.trails);
		}
		const ws = deckWorldStyle(style);
		if (this.world) {
			this.world.planeOpacity = ws.planeOpacity;
			if (!this.world.flight) this.world.photoPlaneOpacity = ws.planeOpacity;
		}
		if (this.world?.controls) this.canvas.style.backgroundColor = ws.sky;
		this.sync();
	}

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

	private updateRelief() {
		if (!this.terrain || !this.look("overlay").defines.includes("LOOK_RELIEF"))
			return false;
		const built = !!this.relief.update({
			tiles: this.terrain.tiles,
			frame: this.frame,
			sunDir: this.look("overlay").sunDir,
			yawDeg: this.pose.yaw,
			bridged: this.gpu?.bridge?.relief,
		});
		if (built) this.layerGen++;
		return built;
	}

	setOccluder(m: FgMask | null) {
		this.occluder = m;
		this.gpu?.composite.setOccluder(m);
	}

	setReveal(r: RevealUniforms | null) {
		this.reveal = r;
		this.gpu?.composite.setReveal(r);
	}

	setSkyMask(mask: SkyMask | null) {
		this.skyMaskStore = mask;
		this.haze.setSky(mask);
		this.compLook.setSky(mask);
		this.fitHaze();
		this.updateLook();
	}

	private rangeGrid(): RangeGrid | null {
		const src = this.geoSrc;
		if (!src?.pose) return null;
		// diet: no CPU copy of the current render (callers that need it call needFull())
		if (src instanceof WebGpuGeometrySource && !src.hasCpu) return null;
		const { width: w, height: h, range } = src;
		return { w, h, at: (x, y) => range[y * w + x] };
	}

	/** deck/engine.ts updateLook (refined masks, photo noise, the composite's look). */
	private updateLook() {
		const composite = this.gpu?.composite;
		const defines = lookKey(this.style).filter((d) =>
			(COMPOSITE_DEFINES as readonly string[]).includes(d),
		);
		const ready = this.geometryReady();
		const grid = ready ? this.rangeGrid() : null;
		const bridge = this.gpu?.bridge ?? null;
		const geoTex = this.geometryTexture();
		const cut =
			this.settings.mode === "replace" && composite
				? blendCut(this.settings, composite.brushCanvas, this.brushVersion)
				: null;
		// the bridged masks read the geometry TEXTURE; the CPU range grid is only sampled for a blend
		// cut and for the photo-noise estimate without a photo sky mask (compLook.updateNoise)
		const bridged = !!(defines.length && ready && bridge && geoTex);
		const wantsGrid =
			!bridged ||
			cut !== null ||
			(this.style.composite.output === "neutral" &&
				!!this.photoImg &&
				!this.skyMaskStore);
		if (defines.length && ready && !grid && wantsGrid) {
			// no CPU copy of this render: read it (once) and come back
			void this.needFull().then((ok) => ok && this.updateLook());
		}
		if (bridged && (grid || !wantsGrid)) {
			bridge.updateMasks({
				style: this.style,
				gen: this.geoBufGen,
				img: this.photoImg,
				fg: this.fgMask,
				sky: this.skyMaskStore,
				cut,
				geometry: geoTex,
				geometrySeq:
					this.geoSrc instanceof WebGpuGeometrySource
						? this.geoSrc.renderSeq
						: undefined,
				range: () => grid ?? NO_GRID,
			});
			this.compLook.updateNoise(
				this.style,
				this.photoImg,
				() => grid ?? NO_GRID,
			);
		} else if (!bridged && defines.length && grid) {
			this.compLook.updateMasks({
				style: this.style,
				gen: this.geoBufGen,
				img: this.photoImg,
				fg: this.fgMask,
				cut,
				geo: () => grid,
			});
			this.compLook.updateNoise(this.style, this.photoImg, () => grid);
		}
		if (!composite) return;
		if (!defines.length && !composite.look.defines.length) return;
		const L = this.compLook;
		const c = this.style.composite;
		const gen = this.gens.generation;
		const M = bridge ? bridge.masks : L.masks;
		composite.setMaskTexture(bridge?.masks?.texture ?? null);
		composite.setLook({
			defines,
			values: (outW, outH) =>
				compositeValues(this.style, {
					outW,
					outH,
					refine: M?.gen === gen,
					// the geometry target's normal is written every frame for the current pose
					crease: true,
					cut:
						!!M?.cut && M.cut === blendCutKey(this.settings, this.brushVersion),
					premul:
						this.settings.mode === "replace" &&
						this.settings.mapStyle !== "bands",
					noise: L.noise,
					photoW: this.photo.width,
					visibility: this.haze.fit?.visibility,
				}),
			harmonize: harmonizeValues(bridge ? bridge.stats : L.stats, c.harmonize),
			mask: bridge ? null : L.masks,
			normal: defines.includes("LOOK_INK") && c.ink.crease > 0 ? gen : null,
		});
	}

	/**
	 * WAG W1.2: the bridged masks pass for a query render, recorded on `encoder`, which is submitted
	 * with that render (WebGpuGeometrySource encodeAfterDraw → LookBridge.prepareMasks). updateLook adopts it when
	 * its inputs still match; otherwise it runs its own pass as before. Skipped where updateLook
	 * would sample a blend cut (replace mode, range / brush blend).
	 */
	private prepareMasks(
		seq: number,
		encoder: CommandEncoder,
		geometry: Texture,
	): FusedWork | null {
		const bridge = this.gpu?.bridge;
		const s = this.settings;
		if (
			!bridge ||
			this.opts.settleFusion === false ||
			!this.photoImg ||
			(s.mode === "replace" &&
				(s.method === "range" || s.method === "brush")) ||
			!lookKey(this.style).some((d) =>
				(COMPOSITE_DEFINES as readonly string[]).includes(d),
			)
		)
			return null;
		return bridge.prepareMasks({
			seq,
			style: this.style,
			img: this.photoImg,
			fg: this.fgMask,
			sky: this.skyMaskStore,
			geometry,
			encoder,
		});
	}

	/**
	 * deck/engine.ts scheduleStats: LOOK_HARMONIZE band stats of the terrain colour, rendered at
	 * ≤ 256 px through the photo camera (classic photo-view shading: no drape) once the pose settles.
	 */
	private scheduleStats() {
		const s = this.settings;
		const amount =
			s.mode === "world"
				? this.style.world.drapeHarmonize
				: s.mode === "replace"
					? this.style.composite.harmonize
					: 0;
		const key = `${this.geoBufGen}|${this.layerGen}|${s.mode}|${s.mapStyle}|${s.worldStyle}|${this.imagery.key}|${this.imagery.map.size}`;
		const bridge = this.gpu?.bridge ?? null;
		if (
			!lookKey(this.style).includes("LOOK_HARMONIZE") ||
			!this.geometryReady() ||
			!this.photoImg ||
			!(bridge ?? this.compLook).wantsStats(amount, key) ||
			this.statsTimer ||
			this.statsBusy
		)
			return;
		this.statsTimer = window.setTimeout(async () => {
			this.statsTimer = 0;
			const img = this.photoImg;
			if (this.disposed || !this.geometryReady() || !this.geoSrc?.pose || !img)
				return;
			const [w, h] = gridSize(this.aspect, STATS_LONG_SIDE);
			const geoTex = this.geometryTexture();
			if (bridge && geoTex && bridge === this.gpu?.bridge) {
				this.statsBusy = true;
				const stats = {
					key,
					img,
					geometry: geoTex,
					fg: this.fgMask,
					minRange: trustedRange(this.photo.hAccuracy),
				};
				try {
					// WAG W1.2: the stats graph on the layer render's own submit
					if (this.opts.settleFusion !== false)
						await this.renderLayer(w, h, null, (layer, encoder) =>
							bridge.encodeStats({ ...stats, layer, encoder }),
						);
					else
						await this.renderLayer(w, h, (layer) =>
							bridge.setStats({ ...stats, layer }),
						);
				} catch (e) {
					console.warn("[webgpu-engine] bridged band stats failed", e);
				} finally {
					this.statsBusy = false;
				}
				return;
			}
			// the CPU stats path samples the range grid
			const grid = this.rangeGrid();
			if (!grid) {
				void this.needFull().then((ok) => ok && this.scheduleStats());
				return;
			}
			this.statsBusy = true;
			let layer: Float32Array | null = null;
			try {
				layer = await this.readLayer(w, h);
			} finally {
				this.statsBusy = false;
			}
			if (!layer || this.disposed) return;
			this.compLook.setStats({
				key,
				img,
				layer,
				w,
				h,
				geo: grid,
				fg: this.fgMask,
				minRange: trustedRange(this.photo.hAccuracy),
			});
			this.updateLook();
			if (this.world?.controls) this.sync();
		}, 120);
	}

	get hazeFit() {
		return this.haze.fit;
	}

	private fitHaze() {
		const src = this.geoSrc;
		if (!this.geometryReady() || !src?.pose) return;
		const pose = src.pose;
		// clear air wants the fit in the world view only; geoSrc is always the PHOTO-pose geometry
		// pass (the drape's range map), never an orbit-pose render
		const want = wantsClearAirFit(this.style) && !!this.world?.controls;
		const bridge = this.gpu?.bridge ?? null;
		const img = this.photoImg;
		// the fit's CPU input is the range ×2 decimated: read the full copy first (only for a fitted
		// haze whose pose / eye changed; HazeController.isDue)
		if (
			src instanceof WebGpuGeometrySource &&
			!src.hasCpu &&
			this.haze.isDue({
				style: this.style,
				pose,
				img,
				eyeAlt: this.eyeAlt,
				fg: this.fgMask,
				want,
			})
		) {
			void this.needFull().then((ok) => ok && this.fitHaze());
			return;
		}
		// the geometry target holds the render `src.range` was read from until the next render()
		const seq = src instanceof WebGpuGeometrySource ? src.rangeSeq : -1;
		const bridged =
			bridge &&
			img &&
			this.opts.hazeBridge !== false &&
			src instanceof WebGpuGeometrySource &&
			src.renderSeq === seq
				? (h: Parameters<BridgedHazeFit>[0]) =>
						bridge.fitHaze({
							img,
							geometry: src.targets.geometry,
							...h,
							valid: () =>
								this.geoSrc === src &&
								src.renderSeq === seq &&
								this.gpu?.bridge === bridge,
						})
				: undefined;
		const fitted = this.haze.update({
			bridged,
			style: this.style,
			pose,
			img: this.photoImg,
			eyeAlt: this.eyeAlt,
			sunDir: this.look("overlay").sunDir,
			fg: this.fgMask,
			want,
			geo: () => ({
				geo: rangeGeo(src.range, src.width, src.height, pose),
				w: src.width,
				h: src.height,
			}),
		});
		if (fitted) {
			this.looks.clear();
			this.layerGen++;
			this.sync();
		}
	}

	// =============================================================================================
	// the frame's inputs (deck/engine.ts updateLayers + worldLayers, as core props)

	/**
	 * Push the current state into the cores and request an "all" frame. Cheap (uniform values and
	 * cached pipelines); a style whose LOOK_* set changes rebuilds the terrain colour pipeline.
	 */
	private sync() {
		const g = this.gpu;
		const host = this.host;
		if (this.disposed || !g || !host) return;
		const world = !!this.world?.controls;
		if (world) {
			const near = this.step ? 0.3 : this.nearField ? 1 : 5;
			this.worldNear = near;
		}
		host.photo = this.photoPose();
		host.view = world ? this.viewPose() : host.photo;
		host.frameView = world ? "world" : "photo";
		const photoU = this.photoUniforms();
		// renderPoseView: the whole DEM, as deck/engine.ts (the matcher's renders never discarded)
		const nearDiscard = this.poseView
			? 0
			: nearFadeFor(this.photo.hAccuracy) * 0.5;
		const elevRange = deckElevRange(this.style, this.elevRange) ??
			this.elevRange ?? [400, 4200];
		g.atmSky.setView(world ? "world" : "photo");
		if (world) this.syncWorld(g, photoU, nearDiscard);
		else {
			const look = terrainLookFor(this.settings);
			g.composite.setSettings(compositeFor(this.settings));
			const style = terrainStyleName(look.style);
			g.styles.set({
				style,
				look: this.look(look.mode, look.style === "elevation"),
				contourInterval: look.contourInterval,
				contourOpacity: look.contourOpacity,
				nearFade: look.nearFade,
				nearDiscard,
				terroir: this.terroir(),
			});
			this.imageryDraped = !!look.imagery;
			if (look.imagery && this.renderSet)
				this.syncImagery(this.renderSet, look.imagery);
			// no drape in this look: the imagery layers go after a grace (imagery.ts releaseWhenIdle)
			else if (!look.imagery) g.imagery.releaseWhenIdle();
			g.trails.setEnabled(look.trails && !!this.trails?.count);
			g.gizmo.setProps({ view: "photo" });
			g.photoSky.setEnabled(false);
			g.splats.setEnabled(false);
			g.tiles3d?.setEnabled(false);
		}
		g.trails.setStyle({
			width: this.style.trails.width,
			opacity: this.style.trails.opacity,
			dash: this.style.trails.dash,
		});
		if (this.relief.current !== g.reliefFrom) {
			g.styles.setReliefField(this.relief.current);
			g.reliefFrom = this.relief.current;
		}
		g.drape.setPhotoCamera(photoU);
		g.styles.applyTo(g.terrain, [g.drape.part()]);
		g.terrain.look = g.styles.terrainLook(elevRange);
		this.schedule("all");
		this.scheduleStats();
	}

	/** The photo's forward direction (unit ENU) for clear air's physical airlight. */
	private photoForward(): Vec3 {
		const d = unprojectDir(this.pose, this.aspect, 0.5, 0.5);
		return [d.x, d.y, d.z];
	}

	private syncWorld(g: Gpu, photoU: CameraUniforms, nearDiscard: number) {
		const w = this.world as WorldCamera;
		const s = this.settings;
		const src = s.worldStyle === "hillshade" ? null : s.worldStyle;
		this.imageryDraped = !!src;
		if (src && this.renderSet)
			this.syncImagery(this.renderSet, src, () => this.worldTileOrder(w));
		else if (!src) g.imagery.releaseWhenIdle();
		const wl = this.look("world");
		g.styles.set({
			style: src ? "imagery" : "hillshade",
			look: wl,
			contourInterval: s.contourInterval,
			contourOpacity: 1,
			nearFade: 0,
			// only the photo camera's geometry pass discards (the range map the drape tests)
			nearDiscard,
			terroir: this.terroir(),
		});
		const stepView = this.step?.view === "step";
		const dm = this.drapeMask();
		g.drape.setMask(dm.photoFg);
		g.drape.setSettings({
			projectPhoto: stepView ? 2 : s.projectOpacity,
			minRange: stepView ? 1 : s.minProjectRange,
			protectPeople: dm.protectPeople,
			tint: wl.photoTint,
			tintColor: [...wl.photoTintCol] as Vec3,
			truth: this.nearField?.opts.truth ? PROVENANCE_TINT_MIX : 0,
			harmonize: this.harmonize(this.style.world.drapeHarmonize),
			// the photo's haze inverted on the drape sample (fit = the photo-pose geometry's)
			clearAir: clearAirOn(this.style)
				? clearAirValues(this.style, this.haze.fit, wl.sunDir, {
						eyeAlt: this.eyeAlt,
						dir: this.photoForward(),
					})
				: null,
			views: ["world"],
		});
		g.trails.setEnabled(s.trails && !!this.trails?.count);
		const ws = deckWorldStyle(this.style);
		g.atmSky.setSky({
			mode: this.style.world.sky.mode,
			atm: wl.atm,
			// AtmSkyCore parses '#rrggbb'; deckWorldStyle().sky is a CSS rgb() string
			flatColor: cssHex(this.style.world.sky.background),
		});
		g.gizmo.setProps({
			view: "world",
			pose: this.pose,
			eye: this.eyeArr,
			aspect: this.aspect,
			image: g.photoTex,
			planeOpacity: w.photoPlaneOpacity,
			lineColor: ws.lineColor,
			pinColor: ws.pinColor,
			pinRadiusM: ws.pinRadiusM,
		});
		// Step Inside: the photo's sky pixels on a far sphere
		const sm = this.stepMasks();
		g.photoSky.setSkyMask(sm?.sky ?? null);
		g.photoSky.setPhotoCamera(photoU);
		g.photoSky.setEnabled(!!sm && !!g.photoTex);
		// Step Inside 3D Tiles
		if (g.tiles3d) {
			const on = stepView && !!this.tiles3d?.tiles;
			g.tiles3d.setSet(on ? (this.tiles3d?.tiles ?? null) : null);
			g.tiles3d.setEnabled(on);
			g.tiles3d.setPhotoCamera(photoU);
			g.tiles3d.setPhotoFg(dm.protectPeople ? dm.photoFg : null);
			const truth = !!this.nearField?.opts.truth;
			g.tiles3d.setOptions({
				truth,
				hideDisplayOnly: truth || this.hideDisplayOnly,
			});
		}
		// near-field splats (the world / step view only, as deck/engine.ts)
		const nf = this.nearField;
		const opacity = nf?.opts.opacity ?? 1;
		g.splats.setCloud(nf?.scene.splats.count ? nf.scene.splats : null);
		g.splats.setOptions({ opacity, truth: !!nf?.opts.truth });
		g.splats.setEnabled(!!nf?.scene.splats.count && opacity > 0);
	}

	private harmonize(amount: number) {
		const stats = this.compLook.stats;
		if (!this.harm || this.harm.stats !== stats || this.harm.amount !== amount)
			this.harm = { stats, amount, value: harmonizeValues(stats, amount) };
		return this.harm.value;
	}

	/** Imagery for `set`, fetched incrementally per tile, keyed by source (deck/engine.ts). */
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
		}
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
					if (n++ % 6 === 0) this.pushImagery();
				},
				ac.signal,
			).finally(() => {
				if (c.abort === ac) c.abort = null;
				if (!ac.signal.aborted) {
					this.pushImagery();
					this.sync();
				}
			});
		}
		this.pushImagery();
	}

	/** The current look drapes imagery (set by sync(); pushImagery uploads only then). */
	private imageryDraped = false;

	/** The imagery bitmaps → the texture array (async uploads; imagery.onChange redraws). */
	private pushImagery() {
		const g = this.gpu;
		const set = this.renderSet;
		// a look without a drape uploads nothing: a stream update (pan) would otherwise cancel
		// releaseWhenIdle and re-upload the last drape (imagery.ts); the bitmaps stay cached here
		if (!g || !set || !this.imagery.key || !this.imageryDraped) return;
		g.imagery.sync(
			this.imagery.map,
			set.tiles.map((t) => t.id),
		);
		g.terrain.syncImageryLayers();
	}

	// =============================================================================================
	// horizon

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
			console.warn("[webgpu-engine] horizon-fast unavailable", e);
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
			} catch (e) {
				if (this.disposed) return new Float32Array(0);
				console.warn("[webgpu-engine] horizon-fast failed, CPU horizon", e);
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

	// =============================================================================================
	// queries: the geometry buffer (layers/geometry-source.ts)

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

	private invalidateGeometry() {
		this.gens.invalidate();
	}

	/** A GeometrySource on the render device (terrain cores only), else the CPU profiles. */
	private makeSource(
		width: number,
		height: number,
	): { src: GeometrySource; kind: "gpu" | "cpu" } | null {
		if (this.geometryFactory)
			return { src: this.geometryFactory(width, height), kind: "gpu" };
		const g = this.gpu;
		try {
			if (!g) throw new Error("no device");
			const factory = webgpuGeometryFactory({
				device: g.device,
				cores: () => (this.gpu ? [this.gpu.terrain] : []),
				eye: this.eyeArr,
				near: PHOTO_NEAR,
				lazyQueries: () =>
					this.dietOn()
						? { after: (seq, pose) => this.queryOnDraw(seq, pose) }
						: undefined,
				encodeAfterDraw: (d) =>
					this.prepareMasks(d.seq, d.encoder, d.targets.geometry),
			});
			this.geoSrcEye = this.eyeArr;
			return { src: factory(width, height), kind: "gpu" };
		} catch (e) {
			console.warn("[webgpu-engine] GPU geometry source unavailable, CPU", e);
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

	private querySource(): GeometrySource | null {
		if (!this.geoSrc) {
			const { width, height } = geometrySize(this.aspect);
			const made = this.makeSource(width, height);
			if (!made) return null;
			this.geoSrc = made.src;
			this.geoSrcKind = made.kind;
		}
		return this.geoSrc;
	}

	private dropGeometrySources() {
		this.geoSrc?.dispose?.();
		for (const s of this.silSources) s.dispose?.();
		this.geoSrc = undefined;
		this.occGpu = null;
		this.skyGpu = null;
		this.ptCache = null;
		this.silSources = [];
		this.geoSrcKind = null;
		this.geoSrcEye = null;
	}

	/** The buffer now describes the current pose (deck/engine.ts refreshGeometry's tail). */
	private onGeometryFresh(gen: number) {
		this.geoBufGen = gen;
		this.fitHaze();
		this.updateLook();
		if (this.updateRelief()) this.sync();
		if (this.world?.controls) this.sync();
		this.scheduleStats();
		this.emit();
	}

	/**
	 * Resolves true once the geometry describes the current pose, with the CPU copy (sampleAt,
	 * rangeGrid) too. settle() is the same without the full copy.
	 */
	async readback(): Promise<boolean> {
		// a newer render starting during the copy supersedes it: retry as gens.readback does
		for (let i = 0; i < 4 && !this.disposed; i++) {
			if (!(await this.gens.readback())) return false;
			const src = this.geoSrc;
			if (!(src instanceof WebGpuGeometrySource) || src.hasCpu) return true;
			if ((await this.needFull()) && this.geometryReady()) return true;
		}
		return false;
	}

	/**
	 * Resolves true once the geometry describes the current pose, for peakLabels, skyline and
	 * sampleAtAsync. Under the geometry diet that is the GPU queries only: no full readback.
	 */
	async settle(): Promise<boolean> {
		// terrainGpuDecode: a trail build waiting for its height gather lands before the frame is read
		while (this.trailFlight) {
			await this.trailFlight;
			if (this.disposed) return false;
		}
		if (!(await this.gens.readback())) return false;
		// terrainGpuDecode: the pose's peaks whose summits are being gathered join the list first
		if (this.terrain && this.heights()) {
			this.snapped(this.pose);
			if (this.snapFlights.size) await Promise.all(this.snapFlights);
			if (this.disposed) return false;
		}
		// the verdicts must describe the current snapped list too (peaks can change without a geometry
		// invalidation): recompute them from the target for this render if they don't
		for (let i = 0; i < 3 && !this.disposed; i++) {
			const src = this.geoSrc;
			if (!(src instanceof WebGpuGeometrySource) || !this.terrain) break;
			if (!src.isLazy) {
				// the diet failed: the full copy is what peakLabels / skyline use now
				if (!src.hasCpu) await this.needFull();
				break;
			}
			if (this.applyGpuVerdicts(this.snapped(this.pose))) break;
			if (!src.pose || src.renderSeq !== src.rangeSeq) break;
			if (!(await this.queryOnDraw(src.rangeSeq, src.pose))) continue;
		}
		return this.geometryReady();
	}

	// ---------------------------------------------------------------------------------------------
	// geometry diet (geo-query-gpu.ts, deck/geo-query.ts)

	/** The diet is on: option, no kernel failed so far, a render device. */
	private dietOn() {
		return this.opts.geometryDiet !== false && !this.dietBroken && !!this.gpu;
	}

	/** A diet kernel failed (or the device went): every render reads back in full from now on. */
	private dietFail(why: string) {
		if (this.dietBroken) return;
		this.dietBroken = true;
		console.warn(`[webgpu-engine] geometry diet off (${why}); full readback`);
		const src = this.geoSrc;
		if (src instanceof WebGpuGeometrySource) {
			src.disableLazy();
			void src.ensureFull().then(() => {
				if (!this.disposed) this.emit();
			});
		}
	}

	/** The query source's full CPU copy of the current render (lazy; false = superseded / failed). */
	private async needFull(): Promise<boolean> {
		const src = this.geoSrc;
		if (!(src instanceof WebGpuGeometrySource)) return !!src?.pose;
		if (src.hasCpu) return true;
		const before = src.hasCpu;
		const ok = await src.ensureFull();
		if (ok && !before) {
			this.dietStats.fullReads++;
			this.dietStats.fullBytes += src.readBytes;
		}
		return ok && !this.disposed && this.geoSrc === src;
	}

	private geoQueryGpu(): GeoQueryGpu | null {
		const device = this.gpu?.device;
		if (!device) return null;
		if (this.geoQuery?.device !== device) {
			this.geoQuery?.destroy();
			this.geoQuery = new GeoQueryGpu(device);
		}
		return this.geoQuery;
	}

	/** The peaks of `snapped` inside the frame, projected (the CPU loop's own filter). */
	private inFrameProjections(snapped: SnappedPeak[], pose: Pose) {
		return snapped.map((p) => {
			const pr = this.projectToPhoto(p.position, pose);
			return !pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1 ? null : pr;
		});
	}

	/**
	 * The GPU queries of one render (lazy query source, after its geometry pass): occlusion verdicts
	 * of the snapped peaks and the skyline rows, one kernel each over targets.geometry in ONE graph
	 * run (one submit, a few hundred bytes read), then the gather of undecided samples if any.
	 * false = a kernel failed (the source then reads the render back in full).
	 */
	private async queryOnDraw(seq: number, pose: Pose): Promise<boolean> {
		const src = this.geoSrc;
		const q = this.geoQueryGpu();
		if (!(src instanceof WebGpuGeometrySource) || !q) return false;
		if (src.renderSeq !== seq) return true; // superseded: the source drops this render
		const tex = src.targets.geometry;
		const snapped = this.terrain ? this.snapped(pose) : [];
		const eye = this.eyeArr;
		const aspect = this.aspect;
		const prs = this.inFrameProjections(snapped, pose);
		const plan: OccPlan = planOcclusion(prs, src.width, src.height);
		// one graph run (one submit, one read) for both
		const { codes, rows } = await q.verdictsAndSkyline(
			tex,
			plan.slots.length ? plan.words : new Uint32Array(0),
		);
		if (!codes || !rows) {
			this.dietFail(!rows ? "skyline kernel" : "verdict kernel");
			return false;
		}
		const verdicts = await resolveOcclusion(plan, codes, (xy) =>
			q.gather(tex, xy),
		);
		if (!verdicts) {
			this.dietFail("gather kernel");
			return false;
		}
		this.dietStats.kernelCalls++;
		if (src.renderSeq !== seq) return true;
		const vis = new Map<SnappedPeak, boolean>();
		snapped.forEach((p, i) => {
			if (prs[i]) vis.set(p, verdicts[i] === true);
		});
		this.occGpu = {
			seq,
			pose: { ...pose },
			eye,
			aspect,
			snapped,
			vis,
			applied: false,
		};
		this.skyGpu = { seq, sky: skylineFromRows(rows, src.height) };
		return true;
	}

	/** Recompute the GPU queries for the render the target holds now (state changed without a new render). */
	private kickQueries() {
		const src = this.geoSrc;
		if (
			this.queryBusy ||
			!(src instanceof WebGpuGeometrySource) ||
			!src.isLazy ||
			!src.pose ||
			src.renderSeq !== src.rangeSeq
		)
			return;
		const seq = src.rangeSeq;
		this.queryBusy = true;
		this.queryOnDraw(seq, src.pose)
			.then((ok) => {
				if (ok && !this.disposed) this.emit();
			})
			.catch((e) => this.dietFail(String(e)))
			.finally(() => {
				this.queryBusy = false;
			});
	}

	/** Copies the GPU verdicts into `vis` when they were made from exactly the current inputs. */
	private applyGpuVerdicts(snapped: SnappedPeak[]) {
		const c = this.occGpu;
		const src = this.geoSrc;
		const p = this.pose;
		if (
			!c ||
			!(src instanceof WebGpuGeometrySource) ||
			c.seq !== src.rangeSeq ||
			c.pose.yaw !== p.yaw ||
			c.pose.pitch !== p.pitch ||
			c.pose.roll !== p.roll ||
			c.pose.vfov !== p.vfov ||
			c.eye[0] !== this.eye.x ||
			c.eye[1] !== this.eye.y ||
			c.eye[2] !== this.eye.z ||
			c.aspect !== this.aspect ||
			c.snapped.length !== snapped.length ||
			!c.snapped.every((q, i) => q === snapped[i])
		)
			return false;
		if (!c.applied) {
			for (const [k, v] of c.vis) this.vis.set(k, v);
			c.applied = true;
		}
		return true;
	}

	/** Texel (x y z w) of the render `seq` at buffer pixel (x, y), from the gather cache. */
	private cachedTexel(seq: number, x: number, y: number) {
		const c = this.ptCache;
		return c && c.seq === seq
			? c.map.get(y * (this.geoSrc?.width ?? 0) + x)
			: undefined;
	}

	private sampleFromTexel(t: ArrayLike<number>): Sample | null {
		const range = t[3] > 0 ? t[3] : Number.POSITIVE_INFINITY;
		if (!(range > 0) || !Number.isFinite(range)) return null;
		const world: Vec3 = [t[0], t[1], t[2]];
		const g = this.frame.toGeo(world[0], world[1], world[2]);
		return { lat: g.lat, lon: g.lon, h: g.h, range, world };
	}

	/**
	 * sampleAt for a pixel without the full CPU copy: one gathered texel (16 B read), cached per
	 * render, coalesced with the other requests of the same tick. Same result as sampleAt (the texel
	 * is a bit copy of the buffer sampleAt reads). null = sky / outside / the geometry is stale.
	 */
	async sampleAtAsync(u: number, v: number): Promise<Sample | null> {
		const src = this.geoSrc;
		if (!(src instanceof WebGpuGeometrySource) || !src.pose) return null;
		if (src.hasCpu || !src.isLazy) return this.sampleAt(u, v);
		const t = texelOf(u, v, src.width, src.height);
		if (!t) return null;
		if (src.renderSeq !== src.rangeSeq) return null;
		const seq = src.rangeSeq;
		const hit = this.cachedTexel(seq, t.x, t.y);
		const tex =
			hit ??
			(await new Promise<Float32Array | null>((res) => {
				const key = t.y * src.width + t.x;
				const q = this.ptQueue.get(key);
				if (q) q.res.push(res);
				else this.ptQueue.set(key, { x: t.x, y: t.y, res: [res] });
				if (!this.ptFlushing) {
					this.ptFlushing = true;
					queueMicrotask(() => void this.flushPoints(src, seq));
				}
			}));
		if (!tex || this.geoSrc !== src || src.rangeSeq !== seq) return null;
		return this.sampleFromTexel(tex);
	}

	private async flushPoints(src: WebGpuGeometrySource, seq: number) {
		const batch = [...this.ptQueue.values()];
		this.ptQueue.clear();
		let texels: Float32Array | null = null;
		try {
			const q = this.geoQueryGpu();
			if (q && src.renderSeq === seq && src.rangeSeq === seq) {
				const xy: number[] = [];
				for (const b of batch) xy.push(b.x, b.y);
				texels = await q.gather(src.targets.geometry, xy);
			}
		} catch (e) {
			console.warn("[webgpu-engine] point gather failed", e);
		}
		const ok = texels && src.rangeSeq === seq && this.geoSrc === src;
		if (ok && (!this.ptCache || this.ptCache.seq !== seq))
			this.ptCache = { seq, map: new Map() };
		batch.forEach((b, i) => {
			const t = ok && texels ? texels.slice(i * 4, i * 4 + 4) : null;
			if (t) this.ptCache?.map.set(b.y * src.width + b.x, t);
			for (const r of b.res) r(t);
		});
		this.ptFlushing = false;
		if (this.ptQueue.size) {
			this.ptFlushing = true;
			// the source may have changed meanwhile: flush against the current one
			const cur = this.geoSrc;
			if (cur instanceof WebGpuGeometrySource)
				queueMicrotask(() => void this.flushPoints(cur, cur.rangeSeq));
			else {
				for (const b of this.ptQueue.values()) for (const r of b.res) r(null);
				this.ptQueue.clear();
				this.ptFlushing = false;
			}
		}
	}

	geometryReady() {
		return !this.disposed && this.gens.ready();
	}

	get geometryGeneration() {
		return this.gens.generation;
	}

	sampleAt(u: number, v: number): Sample | null {
		const src = this.geoSrc;
		if (!src?.pose) return null;
		const w = src.width;
		const h = src.height;
		const x = Math.floor(u * w);
		const y = Math.floor(v * h);
		if (x < 0 || y < 0 || x >= w || y >= h) return null;
		if (src instanceof WebGpuGeometrySource && !src.hasCpu) {
			// diet: start the lazy full copy (bulk consumers sample many pixels; hover uses
			// sampleAtAsync) and answer null until it lands. Never answer from the hover gather cache:
			// a render is all-or-nothing here, or geometryBufferState (export) would see one cached texel
			// as a fresh buffer and enginePeaks / the footprint would work from a partial one.
			// (Consumers that read null on the first frame after a render, e.g. terroir Legend /
			// placeNames, get the real answer on the emit that follows the copy.)
			if (!this.fullKicked) {
				this.fullKicked = true;
				void this.needFull().then((ok) => {
					this.fullKicked = false;
					if (ok && !this.disposed) this.emit();
				});
			}
			return null;
		}
		const i = y * w + x;
		const range = src.range[i];
		if (!(range > 0) || !Number.isFinite(range)) return null;
		let world: Vec3;
		if (src.xyz)
			world = [src.xyz[i * 3], src.xyz[i * 3 + 1], src.xyz[i * 3 + 2]];
		else {
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

	/**
	 * A world point in normalised photo coordinates (u right, v down) through the shader's own
	 * projection (camera.ts projectToPixel, the CPU twin of camera_clip), or null behind the eye.
	 */
	projectToPhoto(p: readonly number[], pose: Pose = this.pose) {
		const u = cameraUniforms(
			photoCamera({
				pose,
				eye: this.eyeArr,
				width: this.photo.width,
				height: this.photo.height,
				near: PHOTO_NEAR,
			}),
		);
		const r = projectToPixel(u, [p[0], p[1], p[2]]);
		if (!r) return null;
		return {
			u: r.x / this.photo.width,
			v: r.y / this.photo.height,
			/** metres along the view direction */
			depth: u.near / r.depth,
			range: r.range,
		};
	}

	private snapped(pose: Pose) {
		if (!this.terrain || !this.peaks.length) return [];
		const hg = this.heights();
		return snapPeaksNear(
			this.terrain,
			this.peaks,
			this.photo,
			pose,
			this.eyeArr,
			this.aspect,
			this.snaps,
			hg ? this.gatheredLocalMax(hg, this.terrain) : undefined,
		);
	}

	/** deck/engine.ts peakLabels (occlusion from the fresh geometry buffer, CPU projection). */
	peakLabels(
		max = this.style.labels.maxLabels,
		{ declutter = true } = {},
	): PeakLabel[] {
		if (!this.terrain) return [];
		const snapped = this.snapped(this.pose);
		const wsrc =
			this.geoSrc instanceof WebGpuGeometrySource ? this.geoSrc : null;
		const live = this.geometryReady();
		// the GPU verdicts (identical to the loop below, deck/geo-query.ts); without them and without a
		// CPU copy they are recomputed from the target (kickQueries) and the labels re-emit
		if (live && this.applyGpuVerdicts(snapped)) {
			// verdicts applied
		} else if (live && wsrc && !wsrc.hasCpu) {
			if (wsrc.isLazy) this.kickQueries();
			else
				void this.needFull().then((ok) => ok && !this.disposed && this.emit());
		} else if (live && !this.occlusionFresh(snapped))
			for (const p of snapped) {
				const pr = this.projectToPhoto(p.position);
				if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
				let visible = false;
				for (const dv of [0.004, 0.009]) {
					const s = this.sampleAt(pr.u, pr.v + dv);
					if (!s || s.range > pr.range * 0.97 - 50) visible = true;
				}
				this.vis.set(p, visible);
			}
		let vis = this.vis;
		if (this.settings.protectPeople && this.fgMask) {
			vis = new Map(vis);
			for (const p of snapped) {
				if (vis.get(p) !== true) continue;
				const pr = this.projectToPhoto(p.position);
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
	 * What the occlusion verdicts in `vis` were computed from: the geometry buffer (generation + source;
	 * sampleAt reads its range / xyz / pose), the pose and eye projectToPhoto uses (and sampleAt's
	 * no-xyz unprojection), the aspect, and the snapped peak objects (`vis` is keyed by identity, so a
	 * re-snap or terrain swap changes the list). photo size is readonly; protectPeople / fgMask / max /
	 * declutter apply after the loop.
	 */
	private occKey?: {
		gen: number;
		src: GeometrySource | undefined;
		pose: Pose;
		eye: Vec3;
		aspect: number;
		snapped: SnappedPeak[];
	};

	/** True when the cached verdicts match every input; otherwise records the new key (the caller recomputes). */
	private occlusionFresh(snapped: SnappedPeak[]) {
		const k = this.occKey;
		const p = this.pose;
		if (
			k &&
			k.gen === this.geoBufGen &&
			k.src === this.geoSrc &&
			k.pose.yaw === p.yaw &&
			k.pose.pitch === p.pitch &&
			k.pose.roll === p.roll &&
			k.pose.vfov === p.vfov &&
			k.eye[0] === this.eye.x &&
			k.eye[1] === this.eye.y &&
			k.eye[2] === this.eye.z &&
			k.aspect === this.aspect &&
			k.snapped.length === snapped.length &&
			k.snapped.every((q, i) => q === snapped[i])
		)
			return true;
		this.occKey = {
			gen: this.geoBufGen,
			src: this.geoSrc,
			pose: { ...p },
			eye: this.eyeArr,
			aspect: this.aspect,
			snapped,
		};
		return false;
	}

	skyline(): Float32Array | null {
		const src = this.geoSrc;
		if (!this.geometryReady() || !src?.pose) return null;
		if (src instanceof WebGpuGeometrySource) {
			const c = this.skyGpu;
			if (c && c.seq === src.rangeSeq) return c.sky;
			if (!src.hasCpu) {
				if (src.isLazy) this.kickQueries();
				else
					void this.needFull().then(
						(ok) => ok && !this.disposed && this.emit(),
					);
				return null;
			}
		}
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

	peaksInFrame(): PeakLabel[] {
		const out: PeakLabel[] = [];
		for (const p of this.snapped(this.pose)) {
			const pr = this.projectToPhoto(p.position);
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

	// =============================================================================================
	// alignment

	/** deck/engine.ts autoAlign: skyline search, then finalists re-ranked by rendered silhouettes. */
	async autoAlign(fromPrior = true): Promise<AlignResult | null> {
		this.silUsers++;
		clearTimeout(this.silIdleTimer);
		try {
			return await this.autoAlignRanked(fromPrior);
		} finally {
			this.silUsers--;
			this.releaseSilhouetteSourcesWhenIdle();
		}
	}

	/**
	 * The re-rank's 384 px sources (up to one per finalist, ~3 MiB of targets each) are only used
	 * while an autoAlign runs: drop them once none has run for SIL_IDLE_MS. The next autoAlign
	 * re-creates them (same size, same renders).
	 */
	private releaseSilhouetteSourcesWhenIdle() {
		clearTimeout(this.silIdleTimer);
		if (this.silUsers > 0 || this.disposed) return;
		this.silIdleTimer = window.setTimeout(() => {
			if (this.silUsers > 0 || this.disposed) return;
			for (const s of this.silSources) s.dispose?.();
			this.silSources = [];
		}, SIL_IDLE_MS);
	}

	private async autoAlignRanked(
		fromPrior: boolean,
	): Promise<AlignResult | null> {
		if (!this.horizonDirs || !this.photoPrep) return null;
		const tSearch = performance.now();
		// the search's inputs as of this call (the lazy read below awaits)
		const from = fromPrior ? this.prior : this.pose;
		const { aspect, horizonDirs } = this;
		const edge = await this.photoPrep.cpu();
		if (this.disposed) return null;
		const res = await autoAlignAsync(
			from,
			aspect,
			horizonDirs,
			edge,
			fromPrior ? 25 : 6,
		);
		if (this.disposed) return null;
		const alts = res.alternatives;
		if (!alts || alts.length < 2) return res;
		const t0 = performance.now();
		await this.ready;
		const srcs = alts.map((_, i) => this.silhouetteSource(i));
		let sil: SilScores | null = this.silhouetteGpu
			? await this.silhouetteScoresGpu(alts, srcs, edge)
			: null;
		if (this.disposed) return null;
		if (!sil) {
			await Promise.all(alts.map((a, i) => srcs[i]?.render(a.pose)));
			if (this.disposed) return null;
			// a blank render (a draw that did not happen) is drawn again before it is scored
			let redraws = 0;
			for (let i = 0; i < alts.length; i++) {
				const s = srcs[i];
				if (s && (await redrawIfBlank(s, alts[i].pose))) redraws++;
			}
			if (this.disposed) return null;
			const tScore = performance.now();
			const sils = srcs.map((s) => this.scoreSilhouette(s, edge));
			let bytes = 0;
			for (const s of srcs)
				if (s instanceof WebGpuGeometrySource) bytes += s.readBytes;
			sil = { sils, tScore, bytes, fallbacks: 0, redraws, path: "cpu" };
		}
		const sils = sil.sils;
		const scored = alts.map((a, i) => ({
			...a,
			sil: sils[i],
			total: a.score + 0.5 * sils[i],
		}));
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
	 * The re-rank's scores from GPU masks (silhouette-gpu.ts, deck/silhouette-mask.ts): every pose
	 * drawn into its source's targets, one kernel submit + one 18 KB-per-pose readback, then the
	 * CPU scorer's sum over the set bits. A pose the GPU can't decide is read back and scored on
	 * the CPU (same render). null = not possible (CPU sources, lost device…): the caller takes the
	 * CPU path, from scratch.
	 */
	private async silhouetteScoresGpu(
		alts: { pose: Pose }[],
		srcs: (GeometrySource | null)[],
		edge: EdgeMap,
	): Promise<SilScores | null> {
		const gs: WebGpuGeometrySource[] = [];
		for (const s of srcs) if (s instanceof WebGpuGeometrySource) gs.push(s);
		if (!gs.length || gs.length !== alts.length) return null;
		const { width: W, height: H, gpuDevice: device } = gs[0];
		if (this.silMask?.device !== device) {
			this.silMask?.destroy();
			this.silMask = new SilhouetteMaskGpu(device);
		}
		const seqs: number[] = [];
		for (let i = 0; i < alts.length; i++) {
			if (!gs[i].drawOnly(alts[i].pose)) return null;
			seqs.push(gs[i].renderSeq);
		}
		const nonce = silNonce();
		const words = await this.silMask.run(
			gs.map((s) => s.targets.geometry),
			W,
			H,
			nonce,
		);
		if (!words || this.disposed) return null;
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
				if (await redrawIfBlank(gs[i], alts[i].pose)) {
					if (this.disposed) return null;
					redraws++;
					bytes += gs[i].readBytes;
				}
				s = this.scoreSilhouette(gs[i], edge);
			}
			sils.push(s);
		}
		return { sils, tScore, bytes, fallbacks, redraws, path: "gpu" };
	}

	private silhouetteSource(i = 0): GeometrySource | null {
		if (this.silSources[i]) return this.silSources[i];
		const W = 384;
		const H = Math.round(W / this.aspect);
		const made = this.makeSource(W, H);
		if (!made) return null;
		this.silSources[i] = made.src;
		return made.src;
	}

	async silhouetteScore(pose: Pose) {
		this.silUsers++;
		clearTimeout(this.silIdleTimer);
		try {
			const src = this.silhouetteSource();
			if (!src) return 0;
			await src.render(pose);
			return this.scoreSilhouette(src);
		} finally {
			this.silUsers--;
			this.releaseSilhouetteSourcesWhenIdle();
		}
	}

	/** deck/engine.ts scoreSilhouette (rows top-down). */
	private scoreSilhouette(
		src: GeometrySource | null,
		edge: EdgeMap | undefined = this.edge,
	) {
		if (!edge || !src?.pose) return 0;
		const W = src.width;
		const H = src.height;
		const buf = src.range;
		const lr = (x: number, y: number) => logRange(buf[y * W + x]);
		let sum = 0;
		let n = 0;
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
		return solvePins(
			from,
			this.aspect,
			this.eyeArr,
			pins,
			this.photo.width,
			this.photo.height,
			solveFov,
		);
	}

	/** deck/engine.ts controlPins. */
	controlPins(cp: {
		basis: number;
		points: { x: number; y: number; peak?: string; az?: number; el?: number }[];
	}): Pin[] {
		const D = Math.PI / 180;
		const hBasis = (cp.basis * this.photo.height) / this.photo.width;
		const pins: Pin[] = [];
		const t = this.terrain;
		for (const pt of cp.points) {
			let world: Vec3 | null = null;
			if (pt.peak && t) {
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

	pinError(pose: Pose, pins: Pin[], basis: number) {
		const errs = pins.map((p) => {
			const pr = cam.projectPoint(pose, this.aspect, this.eyeArr, p.world);
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

	// =============================================================================================
	// blend brush, people mask

	paint(u: number, v: number, radius: number, erase: boolean) {
		this.gpu?.composite.paint(u, v, radius, erase);
		this.brushVersion++;
		this.scheduleLook();
	}

	clearBrush(fill = false) {
		this.gpu?.composite.clearBrush(fill);
		this.brushVersion++;
		this.scheduleLook();
	}

	get brushCanvas() {
		return this.gpu?.composite.brushCanvas ?? null;
	}

	setForegroundMask(mask: FgMask | null) {
		this.fgMask = mask;
		this.gpu?.composite.setForegroundMask(mask);
		this.updateLook();
		if (this.world?.controls) this.sync();
	}

	get hasForeground() {
		return !!this.fgMask;
	}

	get foregroundMask() {
		return this.fgMask;
	}

	get skyMaskData() {
		return this.skyMaskStore;
	}

	// =============================================================================================
	// Step Inside (near field)

	setNearField(scene: NearFieldScene | null, opts: NearFieldViewOpts = {}) {
		if (this.disposed || (!scene && !this.nearField)) return;
		if (this.step && this.nearField?.scene !== scene) this.step.masks = null;
		this.nearField = scene ? { scene, opts: { ...opts } } : null;
		// the photo view shows the photo (splats only in the world / step view): cores are gated
		this.gpu?.splats.setCloud(scene?.splats.count ? scene.splats : null);
		if (this.world?.controls) this.sync();
	}

	/** deck/engine.ts drapeMask. */
	private drapeMask(): { photoFg: FgMask | null; protectPeople: boolean } {
		const protect = this.settings.protectPeople;
		const nf = this.nearField;
		if (!nf || nf.opts.maskDrape === false)
			return { photoFg: this.fgMask, protectPeople: protect };
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

	tiles3dAttribution(): string | null {
		return this.tiles3d?.attribution() ?? null;
	}

	get nearFieldScene(): NearFieldScene | null {
		return this.nearField?.scene ?? null;
	}

	get steppingInside() {
		return !!this.step;
	}

	get stepCamera() {
		return this.step?.cam ?? null;
	}

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

	private stepMasks() {
		const st = this.step;
		const nf = this.nearField;
		if (!st || !nf || st.view !== "step") return null;
		if (!st.masks) {
			// the DEM range is sampled per depth pixel: needs the CPU copy (lazy under the diet)
			const src = this.geoSrc;
			const cpu = !(src instanceof WebGpuGeometrySource) || src.hasCpu;
			if (this.geometryReady() && !cpu)
				void this.needFull().then((ok) => {
					if (ok && this.step === st) {
						st.masks = null;
						this.sync();
					}
				});
			const fresh = this.geometryReady() && cpu;
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

	/** deck/engine.ts enterStepInside. */
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
		// deck's MapController (DeckMapCamera) where the host can carry deck views
		const map = hasExtraViews(this.host)
			? new DeckMapCamera(this.frame, groundAt, () => {
					if (this.step?.map !== map) return;
					this.syncMapViews();
					this.kickWorld();
				})
			: null;
		map?.setSize(this.cssSize.w, this.cssSize.h);
		const stepCam = new StepCamera(w.cam, this.canvas, {
			eye: this.eyeVec,
			quaternion: toQ,
			vfov: this.pose.vfov,
			aspect: this.aspect,
			radius: opts.radius ?? this.nearField?.scene.confidenceRadius ?? 10,
			pivotDist: opts.pivotDist,
			mode: opts.mode,
			easeIn: view === "map" && !enteredWorld,
			groundAt,
			...(map ? { mapDriver: map } : {}),
			onChange: () => this.kickWorld(),
			onBack: opts.onBack,
		});
		this.step = { cam: stepCam, enteredWorld, masks: null, map, view };
		this.syncMapViews();
		if (view === "step")
			this.tiles3d?.enter(this.photo.lat, this.photo.lon, this.eyeVec);
		if (!this.geometryReady())
			void this.readback().then(() => {
				if (this.step?.cam === stepCam) {
					this.step.masks = null;
					this.sync();
				}
			});
		this.sync();
		this.kickWorld();
	}

	exitStepInside(restore = true) {
		const st = this.step;
		if (!st) return;
		this.step = null;
		this.tiles3d?.exit();
		st.cam.dispose();
		this.syncMapViews();
		const w = this.world;
		if (st.enteredWorld) this.exitWorld();
		else if (w?.controls) {
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
			this.sync();
			if (w?.controls) this.kickWorld();
		}
	}

	/** The step camera's deck MapView next to the host's views (ExtraViewsHost only). */
	private syncMapViews() {
		const host = this.host;
		if (!hasExtraViews(host)) return;
		const map = this.step?.map;
		if (!map?.active) {
			host.setExtraViews([], {});
			return;
		}
		host.setExtraViews(
			[map.view],
			{ [MAP_VIEW_ID]: map.viewState },
			{
				onViewStateChange: (p) => {
					if (p.viewId === MAP_VIEW_ID && this.step?.map === map && map.active)
						map.onViewStateChange(p.viewState as never);
				},
				onInteractionStateChange: (s) => {
					if (
						this.step?.map === map &&
						map.active &&
						!s.isDragging &&
						!s.inTransition &&
						!s.isPanning &&
						!s.isRotating &&
						!s.isZooming
					)
						map.settle();
				},
			},
		);
	}

	// =============================================================================================
	// world view

	private enterWorld() {
		this.world ??= new WorldCamera(this.canvas, () => this.kickWorld());
		const ws = deckWorldStyle(this.style);
		this.world.planeOpacity = ws.planeOpacity;
		this.world.setAspect(this.cssSize.w / this.cssSize.h);
		this.world.enter(this.pose, this.eyeVec);
		this.world.tick(this.pose, this.eyeVec, this.aspect);
		this.canvas.style.backgroundColor = ws.sky;
		// the drape reads this frame's geometry target; labels / masks want the CPU buffer too
		if (!this.geometryReady()) void this.readback();
		this.fitHaze(); // clear air's fit (world view only)
		this.sync();
		this.kickWorld();
	}

	private exitWorld() {
		this.world?.exit();
		cancelAnimationFrame(this.worldRaf);
		this.worldRaf = 0;
		this.canvas.style.backgroundColor = "";
		this.sync();
	}

	/** deck/engine.ts kickWorld: the world camera's frame loop while it moves, then idle. */
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
			const stepping = this.step?.cam.update() ?? false;
			const moved = w.tick(this.pose, this.eyeVec, this.aspect) || stepping;
			if (this.step)
				this.tiles3d?.update(w.cam, this.canvas.width, this.canvas.height);
			let gizmo = false;
			if (this.step?.view === "map") {
				const o = this.stepGizmoOpacity(w);
				gizmo = Math.abs(o - w.photoPlaneOpacity) > 0.01;
				if (gizmo) w.photoPlaneOpacity = o;
			}
			if (flying || gizmo) this.sync();
			else if (moved && this.host) {
				this.host.view = this.viewPose();
				this.schedule("all");
			}
			if (this.step?.map?.active) this.syncMapViews();
			this.worldStill = moved ? 0 : this.worldStill + 1;
			this.worldRaf =
				flying || this.worldStill < 30 ? requestAnimationFrame(step) : 0;
		};
		this.worldRaf = requestAnimationFrame(step);
	}

	private stepGizmoOpacity(w: WorldCamera) {
		const d = w.cam.position.distanceTo(this.eyeVec);
		return w.planeOpacity * Math.max(0, Math.min(1, (d - 30) / 300));
	}

	private worldTileOrder(w: WorldCamera) {
		const c = w.cam.position.clone();
		const h = this.demAtCamera;
		const score = new Map<TileMesh, number>();
		const of = (t: TileMesh) => {
			let v = score.get(t);
			if (v === undefined) {
				const b = tileBounds(t.key);
				const lat = (b.north + b.south) / 2;
				const p = this.frame.fromGeo(lat, (b.west + b.east) / 2, h);
				const size =
					(b.east - b.west) * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
				v = Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z) / Math.max(size, 1);
				score.set(t, v);
			}
			return v;
		};
		return (a: TileMesh, b: TileMesh) => of(a) - of(b);
	}

	flyToPhoto(dur = 2600) {
		if (!this.world?.controls) return;
		this.world.flyTo(this.pose, dur);
		this.kickWorld();
	}

	flyOut() {
		if (!this.world?.controls) return;
		this.world.enter(this.pose, this.eyeVec);
		this.world.tick(this.pose, this.eyeVec, this.aspect);
		this.sync();
		this.kickWorld();
	}

	// =============================================================================================
	// offscreen pose renders (tools/matcher/server/render_worker.mjs): deck/engine.ts contract

	/** renderer.ts retraceHorizon: the horizon re-traced under the current flags (precision gates). */
	async retraceHorizon(): Promise<"fast" | "cpu" | null> {
		await this.ready;
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
	 * deck/engine.ts loadFullTerrain: the terrain all around the eye. The streamer's high-detail wedge
	 * becomes 360° (and stays so: setPose no longer narrows it), the CPU queries switch to the complete
	 * set, and the horizon is re-traced over 360°. Resolves with the ms it took (0 when already done).
	 * The new tiles go through the same residency as any streamed set (gpu.terrain.setTiles: the batched
	 * height atlas grows by copy; past the device's layer limit tiles are dropped and counted in
	 * stats().terrain overflow, as for an unknown-heading photo's 360° wedge).
	 */
	async loadFullTerrain(timeoutMs = 300_000): Promise<number> {
		// done once it completed: a call that threw (timeout) leaves the wedge at 360°, and the retry
		// waits for that wedge's set again (`already` below) instead of reporting success
		if (this.fullTerrainDone) return 0;
		const t0 = performance.now();
		await this.ready;
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
		this.sync();
		this.horizonDirs = await this.traceHorizon();
		if (!this.disposed) this.sync();
		this.fullTerrainDone = true;
		return Math.round(performance.now() - t0);
	}

	/**
	 * deck/engine.ts loadSatellite: satellite imagery for the render set's tiles within `maxDistM` of
	 * the eye (0 = all), fetched now; failed tiles are re-fetched up to `retries` times. Other tiles
	 * keep streaming in the background. The bitmaps upload into the imagery array asynchronously:
	 * renderPoseView waits for those uploads before it draws.
	 */
	async loadSatellite(maxDistM = 0, retries = 2) {
		await this.ready;
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
	 * deck/engine.ts renderPoseView, the matcher's view: the satellite drape and the geometry buffer
	 * through an arbitrary `pose`, both offscreen at width × height (default: the query geometry size,
	 * 1024 px on the long side). Neither the on-screen view nor the engine's pose changes.
	 *   xyz:  ENU metres in `frame`, 3 per pixel, row 0 = top, 0,0,0 = sky
	 *   rgba: sRGB 8-bit, row 0 = top, opaque; the terrain colour pass alone in the Blend-satellite
	 *         look (no contours, trails or near discard), sky = #b9cde0
	 * Satellite tiles are drawn as far as they are loaded: call loadSatellite first. On WebGPU the
	 * geometry is a private WebGpuGeometrySource (terrain cores, its own targets) and the colour is
	 * renderOffscreen's terrain-only colour pass (rgba16float, linear premultiplied, MSAA-resolved).
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
		await this.ready;
		const g0 = this.gpu;
		if (this.disposed || !this.terrain || !g0) return null;
		const def = geometrySize(this.aspect);
		const width = opts.width ?? def.width;
		const height = opts.height ?? def.height;
		const p: Pose = {
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
		let src: WebGpuGeometrySource | undefined;
		try {
			this.sync();
			// the imagery bitmaps already fetched land in the array first (async resize + upload)
			const t0 = performance.now();
			while (
				this.gpu &&
				this.gpu.imagery.pendingUploads > 0 &&
				!this.disposed &&
				performance.now() - t0 < 30_000
			)
				await new Promise((res) => setTimeout(res, 16));
			const g = this.gpu;
			if (this.disposed || !g || this.lost) return null;
			// geometry: a private source at this size (the query buffer and its pose stay as they are)
			src = new WebGpuGeometrySource(
				{
					device: g.device,
					cores: () => [g.terrain],
					eye: this.eyeArr,
					near: PHOTO_NEAR,
				},
				width,
				height,
				{ xyz: true },
			);
			await src.render(p);
			if (this.disposed || !src.pose) return null;
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
			// colour: the terrain colour pass alone (linear, premultiplied) → sRGB over the sky colour
			const lin = (await this.renderOffscreen({
				width,
				height,
				view: "photo",
				pose: p,
				cores: [new ViewGate(g.terrain, () => "photo")],
				screen: false,
			})) as Float32Array | null;
			if (!lin || this.disposed) return null;
			return { width, height, xyz, rgba: poseViewRgba(lin, width, height) };
		} finally {
			src?.dispose();
			this.poseView = false;
			this.settings = prev;
			if (!this.disposed) this.sync();
		}
	}

	// =============================================================================================
	// offscreen renders: export, band stats

	/**
	 * Geometry + colour + screen passes of the host's cores into our own targets at width × height,
	 * then read back. `screen: false` stops after the colour pass and returns the resolved colour
	 * (rgba16float, linear premultiplied); otherwise the screen pass's rgba8unorm (sRGB) bytes.
	 * Rows top-first. One submit, off the host's frame (its cached targets are untouched).
	 */
	private async renderOffscreen(o: {
		width: number;
		height: number;
		view: View;
		/** the photo camera's pose (default: the engine's pose; renderPoseView) */
		pose?: Pose;
		cores?: readonly GpuLayerCore[];
		screen: boolean;
		/** compute bridge: consume the resolved colour target on the GPU instead of reading it back */
		consume?: (color: Texture) => Promise<unknown>;
		/** compute bridge, same render submit: record work on the colour target on the given encoder
		 * (submitted with the render in one queue.submit); `after` is awaited once submitted,
		 * `cancel` is called if it was not */
		encode?: (color: Texture, encoder: CommandEncoder) => EncodedWork | null;
	}): Promise<Uint8Array | Float32Array | null> {
		await this.ready;
		const g = this.gpu;
		const host = this.host;
		if (!g || !host || this.disposed || this.lost) return null;
		const device = g.device;
		const cores = o.cores ?? host.cores;
		const photo = this.photoPose(o.pose);
		const view = o.view === "world" ? this.viewPose() : photo;
		const gs = geometrySize(this.aspect);
		const geo = new GeometryTargets(
			device,
			gs.width,
			gs.height,
			"rigi-offscreen-geo",
		);
		const color = new ColorTargets(
			device,
			o.width,
			o.height,
			"rigi-offscreen-color",
		);
		let out: Texture | null = null;
		let fb: ReturnType<Device["createFramebuffer"]> | null = null;
		const prevOverride = this.viewOverride;
		this.viewOverride = o.view;
		try {
			const frame: FrameState = {
				frame: -1,
				time: performance.now(),
				view: o.view,
			};
			runGeometryPass({ device, cores, geometry: geo, photo, frame });
			runColorPass({ device, cores, geometry: geo, color, view, frame });
			let read: Texture = color.color;
			if (o.screen) {
				out = device.createTexture({
					id: "rigi-offscreen-out",
					format: "rgba8unorm",
					width: o.width,
					height: o.height,
					usage: USAGE.RENDER | USAGE.COPY_SRC | USAGE.SAMPLE,
				});
				fb = device.createFramebuffer({
					id: "rigi-offscreen-out-fbo",
					width: o.width,
					height: o.height,
					colorAttachments: [out],
				});
				const pass = device.beginRenderPass({
					id: "rigi-offscreen-screen",
					framebuffer: fb,
					clearColor: [0, 0, 0, 1],
				});
				runScreenPass({
					device,
					cores,
					renderPass: pass,
					camera: camerasFor(view, o.width, o.height),
					frame,
					geometry: geo,
					color,
				});
				pass.end();
				read = out;
			}
			let encoded: EncodedWork | null = null;
			if (o.encode) {
				// own encoder, one queue.submit with the render (core submitWithDefault); a throw while
				// recording drops only it
				const encoder = device.createCommandEncoder({
					id: "rigi-offscreen-fused",
				});
				try {
					encoded = o.encode(read, encoder);
				} catch (e) {
					console.warn("[webgpu-engine] fused offscreen work dropped", e);
				}
				if (!encoded) encoder.destroy();
				else {
					// false = the fused buffer was dropped and the render submitted alone
					let sent = false;
					try {
						sent = submitWithDefault(device, [encoder]);
					} finally {
						if (!sent) encoded.cancel();
					}
					if (!sent) return null;
				}
			}
			if (!encoded) device.submit();
			this.viewOverride = prevOverride;
			if (o.encode) {
				// right after the render's submit; the targets live until it resolves
				await encoded?.after();
				return null;
			}
			if (o.consume) {
				// right after the render's submit, same queue; the targets live until it resolves
				await o.consume(read);
				return null;
			}
			const bytes = await readTexture(device, read);
			if (!bytes) return null;
			return o.screen ? bytes : halfToFloat(bytes);
		} finally {
			this.viewOverride = prevOverride;
			// the copy was queued before these: WebGPU defers the frees until it is done
			fb?.destroy();
			out?.destroy();
			color.destroy();
			geo.destroy();
			// the offscreen draw re-set the cores' uniforms: redraw the on-screen frame
			this.schedule("all");
		}
	}

	/**
	 * deck/composite.ts readLayer: the terrain colour at w × h through the photo camera, linear
	 * PREMULTIPLIED RGBA floats in GL row order (row 0 = bottom), as CompositeLook.setStats wants
	 * (look/color-stats.ts bandInputs divides by alpha itself; un-premultiplying here divided twice).
	 */
	private async readLayer(w: number, h: number): Promise<Float32Array | null> {
		const g = this.gpu;
		if (!g) return null;
		const px = (await this.renderOffscreen({
			width: w,
			height: h,
			view: "photo",
			cores: [new ViewGate(g.terrain, () => "photo")],
			screen: false,
		})) as Float32Array | null;
		if (!px) return null;
		const out = new Float32Array(w * h * 4);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const s = (y * w + x) * 4;
				const d = ((h - 1 - y) * w + x) * 4;
				out[d] = px[s];
				out[d + 1] = px[s + 1];
				out[d + 2] = px[s + 2];
				out[d + 3] = px[s + 3];
			}
		return out;
	}

	/** readLayer's render (photo camera, terrain only) with the colour target handed to `consume`
	 * after the render's submit, or to `encode` before it (the same submit). */
	private async renderLayer(
		w: number,
		h: number,
		consume: ((color: Texture) => Promise<unknown>) | null,
		encode?: (color: Texture, encoder: CommandEncoder) => EncodedWork | null,
	) {
		const g = this.gpu;
		if (!g) return;
		await this.renderOffscreen({
			width: w,
			height: h,
			view: "photo",
			cores: [new ViewGate(g.terrain, () => "photo")],
			screen: false,
			...(consume ? { consume } : {}),
			...(encode ? { encode } : {}),
		});
	}

	/** The query geometry target (rgba32float xyz + range, row 0 = top) the look passes read. */
	private geometryTexture(): Texture | null {
		const src = this.geoSrc;
		return src instanceof WebGpuGeometrySource && src.pose
			? src.targets.geometry
			: null;
	}

	/** The on-screen world frame (canvas size, sky included) as a PNG. */
	private async exportWorld(): Promise<Blob | null> {
		await this.ready;
		const host = this.host;
		if (!host || this.disposed) return null;
		this.hideDisplayOnly = true;
		this.sync();
		try {
			const w = host.color.width;
			const h = host.color.height;
			const px = (await this.renderOffscreen({
				width: w,
				height: h,
				view: "world",
				screen: true,
			})) as Uint8Array | null;
			if (!px) return null;
			return toBlob(px, w, h, w, h, "image/png");
		} finally {
			this.hideDisplayOnly = false;
			this.sync();
		}
	}

	/**
	 * deck/engine.ts exportImage: the photo view at the photo's resolution (capped at the device's
	 * maxTextureDimension2D) with the shared label drawer, as a JPEG; the world / step view as the
	 * on-screen frame (PNG, no labels).
	 */
	async exportImage(withLabels = true): Promise<Blob | null> {
		if (this.settings.mode === "world" || this.step) return this.exportWorld();
		if (withLabels) await this.settle();
		await lookIdle();
		await this.ready;
		const g = this.gpu;
		if (!g || this.disposed) return null;
		this.sync();
		const W = this.photo.width;
		const H = this.photo.height;
		const maxDim = g.device.limits.maxTextureDimension2D ?? 8192;
		const k = Math.min(1, maxDim / Math.max(W, H));
		const rw = Math.round(W * k);
		const rh = Math.round(H * k);
		const px = (await this.renderOffscreen({
			width: rw,
			height: rh,
			view: "photo",
			screen: true,
		})) as Uint8Array | null;
		if (!px || this.disposed) return null;
		const canvas = document.createElement("canvas");
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		putPixels(ctx, px, rw, rh, W, H);
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
		return new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
	}
}

// ---------------------------------------------------------------------------------------------
// helpers

/**
 * deck/engine.ts renderPoseView's colour conversion: linear colour + alpha (0 = nothing drawn = sky)
 * → sRGB 8-bit over the matcher's sky colour #b9cde0, opaque. Same arithmetic as the deck engine
 * (colour / alpha, OETF, × alpha + sky × (1 − alpha)); on WebGPU the input is premultiplied, so the
 * division recovers the straight colour.
 */
export function poseViewRgba(
	lin: Float32Array,
	width: number,
	height: number,
): Uint8ClampedArray {
	const rgba = new Uint8ClampedArray(width * height * 4);
	const SKY = [0xb9, 0xcd, 0xe0];
	const oetf = (c: number) =>
		c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
	for (let i = 0; i < width * height; i++) {
		const a = Math.min(1, Math.max(0, lin[i * 4 + 3]));
		for (let k = 0; k < 3; k++) {
			const c = a > 0 ? oetf(Math.min(1, Math.max(0, lin[i * 4 + k] / a))) : 0;
			rgba[i * 4 + k] = Math.round(c * a * 255 + SKY[k] * (1 - a));
		}
		rgba[i * 4 + 3] = 255;
	}
	return rgba;
}

/** GPU work recorded into a render's encoder (renderOffscreen `encode`). */
type EncodedWork = { after: () => Promise<unknown>; cancel: () => void };

/** Stand-in for a range grid nobody will sample (updateLook computed that none is needed). */
const NO_GRID: RangeGrid = { w: 1, h: 1, at: () => Number.POSITIVE_INFINITY };

/** deck/engine.ts objectDrapeMask: people ∪ Object pixels (dilated one split cell), row 0 = top. */
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

/** A style colour as '#rrggbb' (displayed sRGB; alpha dropped). */
function cssHex(c: Parameters<typeof hexToRgba01>[0]) {
	const [r, g, b] = hexToRgba01(c);
	const q = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${q(r)}${q(g)}${q(b)}`;
}

function copyCanvas(src: HTMLCanvasElement) {
	const c = document.createElement("canvas");
	c.width = src.width;
	c.height = src.height;
	c.getContext("2d")?.drawImage(src, 0, 0);
	return c;
}

const BYTES_PER_PIXEL: Record<string, number> = {
	rgba8unorm: 4,
	rgba16float: 8,
	rgba32float: 16,
};

/**
 * A whole mip-0 texture into tightly packed rows (top-first). The render that fills it must be
 * submitted first (the copy is its own submit). null when the device went away.
 */
async function readTexture(
	device: Device,
	tex: Texture,
): Promise<Uint8Array | null> {
	const bpp = BYTES_PER_PIXEL[tex.format];
	if (!bpp) throw new Error(`readTexture: unsupported format ${tex.format}`);
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		id: "rigi-offscreen-readback",
		byteLength: layout.byteLength,
		usage: MAP_READ | COPY_DST,
	});
	try {
		tex.readBuffer({}, buf);
		const data = await buf.readAsync(0, layout.byteLength);
		const row = tex.width * bpp;
		const out = new Uint8Array(row * tex.height);
		for (let y = 0; y < tex.height; y++)
			out.set(
				data.subarray(y * layout.bytesPerRow, y * layout.bytesPerRow + row),
				y * row,
			);
		return out;
	} catch (e) {
		console.warn("[webgpu-engine] readback failed", e);
		return null;
	} finally {
		buf.destroy();
	}
}

/** IEEE half floats (little endian) → Float32Array. */
function halfToFloat(bytes: Uint8Array): Float32Array {
	const h = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 2,
	);
	const out = new Float32Array(h.length);
	for (let i = 0; i < h.length; i++) {
		const v = h[i];
		const s = v & 0x8000 ? -1 : 1;
		const e = (v >> 10) & 0x1f;
		const m = v & 0x3ff;
		out[i] =
			e === 0
				? s * 2 ** -14 * (m / 1024)
				: e === 31
					? m
						? Number.NaN
						: s * Number.POSITIVE_INFINITY
					: s * 2 ** (e - 15) * (1 + m / 1024);
	}
	return out;
}

/** rgba8 pixels (w × h, top-first) onto a W × H 2D canvas (scaled when the export was capped). */
function putPixels(
	ctx: CanvasRenderingContext2D,
	px: Uint8Array,
	w: number,
	h: number,
	W: number,
	H: number,
) {
	const img = new ImageData(
		new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, w * h * 4),
		w,
		h,
	);
	if (w === W && h === H) {
		ctx.putImageData(img, 0, 0);
		return;
	}
	const tmp = document.createElement("canvas");
	tmp.width = w;
	tmp.height = h;
	(tmp.getContext("2d") as CanvasRenderingContext2D).putImageData(img, 0, 0);
	ctx.drawImage(tmp, 0, 0, W, H);
}

function toBlob(
	px: Uint8Array,
	w: number,
	h: number,
	W: number,
	H: number,
	type: string,
): Promise<Blob | null> {
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	putPixels(
		canvas.getContext("2d") as CanvasRenderingContext2D,
		px,
		w,
		h,
		W,
		H,
	);
	return new Promise((res) => canvas.toBlob(res, type));
}

/**
 * The factory the assembler calls (same shape as RendererConstructor plus options). The engine
 * boots its host asynchronously; init() awaits it and throws when WebGPU is unavailable, so check
 * `await WebGpuEngine.available()` first to fall back to the WebGL DeckEngine.
 */
export function createWebGpuEngine(
	canvas: HTMLCanvasElement,
	photo: PhotoMeta,
	opts: WebGpuEngineOptions = {},
): WebGpuEngine {
	return new WebGpuEngine(canvas, photo, opts);
}

export type { HostStats };

/*
 * WIRING (the assembler; nothing here is wired by this file):
 *
 * 1. PhotoWorkspace (its owner), behind a renderer flag, e.g. ?renderer=webgpu:
 *      const { WebGpuEngine } = await import("#/lib/deck-webgpu/engine");
 *      const ok = (await WebGpuEngine.available()).ok;
 *      const engine = ok ? new WebGpuEngine(canvas, photo) : new DeckEngine(canvas, photo);
 *    Everything else is the Renderer surface, unchanged (init, setPose, setSettings, setStyle,
 *    readback, sampleAt, peakLabels, autoAlign, paint, exportImage, setNearField, …). The canvas
 *    must be fresh (no WebGL context on it). Tools that poke WebGL deck internals
 *    (deckInstance.layerManager, compositor) must check `engine.backend === "webgpu"`.
 *    The deck host needs deck's full build: vite.config.ts without the `visgl:webgl-only`
 *    condition; until then the engine falls back to the direct host automatically.
 *
 * 2. Lab route: /lab/deck-webgpu?photo=IMG_7086[&host=deck|direct] is this engine (lab-engine.ts;
 *    toolbar, DOM labels, window.__engine). Isolation check: engine.check.ts runEngineCheck().
 *
 * 3. Host support (done in hosts/*.ts): `host.frameView` carries the view into FrameState (set in
 *    sync(); the ViewGate wrapper stays for the band-stats viewOverride and the visibility gates),
 *    and DeckHost.setExtraViews() gives Step Inside's map mode deck's MapController.
 */
