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
import type { Device, Texture } from "@luma.gl/core";
import * as THREE from "three";
import {
	type AlignResult,
	buildEdgeMap,
	type EdgeMap,
	type Pin,
	solvePins,
} from "#/lib/align";
import * as cam from "#/lib/camera";
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { CpuGeometrySource, TerrainProfiles } from "#/lib/deck/cpu-geometry";
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
	type ImagerySource,
	loadImagery,
	type TerrainSet,
	type TileMesh,
	type ViewWedge,
} from "#/lib/deck/terrain-data";
import { terrainMode } from "#/lib/deck/terrain-mode";
import { TerrainStreamer } from "#/lib/deck/terrain-stream";
import {
	buildTrailSegments,
	recolorTrailSegments,
	type TrailSegments,
} from "#/lib/deck/trail-layer";
import { poseQuaternion, WorldCamera } from "#/lib/deck/world-view";
import { tileBounds } from "#/lib/dem";
import { startLakeFloor } from "#/lib/geocam/lakes/fetch";
import { priorHeading } from "#/lib/geocam/priors/heading";
import { distanceM, EnuFrame, M_PER_DEG_LAT } from "#/lib/geodesy";
import { autoAlignAsync, warmAlignGpu } from "#/lib/gpu/align";
import { lookIdle } from "#/lib/gpu/look/opt-in";
import {
	type FastHorizon,
	startFastHorizon,
} from "#/lib/integration/horizon-fast-app";
import { photoUnknowns, type Unknowns } from "#/lib/integration/unknown-pose";
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
import { HazeController, rangeGeo } from "#/lib/look/haze-controller";
import type { SkyMask } from "#/lib/look/haze-fit";
import { drawExportLabels, skylineAt } from "#/lib/look/labels";
import { lookKey } from "#/lib/look/look-key";
import { ReliefController, type ReliefField } from "#/lib/look/relief/field";
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
import { tiles3dConfig } from "#/lib/tiles3d/config";
import { DeckTiles3D } from "#/lib/tiles3d/deck-tiles";
import {
	type CameraUniforms,
	cameraUniforms,
	photoCamera,
	projectToPixel,
	worldCamera,
} from "./camera";
import { deckBuild, webgpuAvailable } from "./device";
import type { Host, HostStats } from "./hosts/direct";
import {
	type CameraPose,
	camerasFor,
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
	GeometryGenerations,
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
import type { FrameState, GpuLayerCore, PassContext, PassKind } from "./pass";
import { PresentCore, type PresentMode } from "./present";
import { ColorTargets, GeometryTargets, geometrySize, USAGE } from "./targets";
import { TerrainCore } from "./terrain";
import { imageTexture } from "./textures";

type V3 = [number, number, number];
type View = "photo" | "world";

const angleDiff = (a: number, b: number) =>
	Math.abs(((a - b + 540) % 360) - 180);

/** deck/engine.ts INPUT_IDLE_MS: a change this soon after the previous one is an interaction. */
const INPUT_IDLE_MS = 150;

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
	reliefFrom: ReliefField | null;
};

export type WebGpuEngineOptions = {
	/** Force a host (default: deck when deck's full build is bundled, else direct). */
	host?: "deck" | "direct";
	/** The terrain path (default: the ?terrain flag, deck/terrain-mode.ts). */
	terrain?: "batched" | "tiles";
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
	private looks = new Map<string, DeckTerrainStyle>();
	private haze = new HazeController();
	private relief = new ReliefController();
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
	private geoSrcEye: V3 | null = null;
	private gens: GeometryGenerations;
	private geoBufGen = -1;
	private silTiming: {
		renders: number;
		ms: number;
		searchMs: number;
		scoreMs?: number;
	} | null = null;
	private streamer?: TerrainStreamer;
	private renderSet: TerrainSet | null = null;
	private queryWedge?: ViewWedge;
	private streamerWedge?: ViewWedge;
	private elevRange: [number, number] | null = null;
	private photoImg?: HTMLImageElement;
	private fgMask: FgMask | null = null;
	private occluder: FgMask | null = null;
	private reveal: RevealUniforms | null = null;
	private skyMaskStore: SkyMask | null = null;
	private edge?: EdgeMap;
	private horizonDirs?: Float32Array;
	private horizonSource: "fast" | "cpu" | null = null;
	private fastHorizon?: FastHorizon;
	private peaks: Peak[] = [];
	private snaps = new Map<Peak, SnappedPeak | null>();
	private vis = new Map<SnappedPeak, boolean>();
	private profiles?: TerrainProfiles;
	private silSources: GeometrySource[] = [];
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

	constructor(
		canvas: HTMLCanvasElement,
		photo: PhotoMeta,
		opts: WebGpuEngineOptions = {},
	) {
		this.opts = opts;
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

	private get eyeArr(): V3 {
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
		host.setPhotoAspect(this.aspect);
		const device = host.device;
		const imagery = new ImageryArray(device);
		const batched = (this.opts.terrain ?? terrainMode()) === "batched";
		const terrain = batched
			? createBatchedTerrain(device, imagery)
			: new TerrainCore(device, imagery);
		const styles = createTerrainStyles(device);
		const drape = createDrape(device);
		const trails = createTrailCore(device);
		const composite = createCompositeCore({
			aspect: this.aspect,
			requestRender: (s) => this.schedule(s),
		});
		if (brushFrom)
			composite.brushCanvas.getContext("2d")?.drawImage(brushFrom, 0, 0);
		const present = new PresentCore("world-present");
		present.mode = "color";
		const debug = new PresentCore("debug-present");
		const atmSky = new AtmSkyCore();
		const photoSky = createPhotoSkyCore();
		const gizmo = createGizmoCore(device);
		const splats = createSplatsCore(device);
		splats.onChange = () => this.schedule("all");
		const t3cfg = this.tiles3d ? tiles3dConfig() : null;
		const tiles3d = this.tiles3d
			? createTiles3DCore(device, tiles3dCoreOptions(t3cfg))
			: null;
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
	private async onDeviceLost(host: Host, info: { message?: string }) {
		if (this.disposed || this.host !== host) return;
		this.lost = true;
		this.counters.contextLost++;
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
			return;
		}
		if (this.disposed) return;
		this.lost = false;
		this.counters.contextRestored++;
		if (this.step?.map) this.syncMapViews();
		this.invalidateGeometry();
		if (this.world?.controls) this.kickWorld();
		console.warn("[webgpu-engine] device restored; renderer rebuilt");
	}

	/** Test hook: lose the device on purpose (the rebuild path runs as for a real loss). */
	simulateDeviceLoss() {
		this.host?.device.destroy();
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
			void host.nextFrame(s).then(() => this.emit());
		});
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
		this.photoImg = img;
		this.ensurePhotoTexture();
		const fgPromise = segment
			? segment(img).catch(() => null)
			: Promise.resolve(null);

		const terrain = await terrainLoad;
		if (!terrain || this.disposed) return;
		this.terrain = terrain;
		this.queryWedge = wedge;
		const dem =
			terrain.heightAt(this.photo.lat, this.photo.lon) ?? this.photo.alt ?? 0;
		this.demAtCamera = dem;
		this.setEye(eyeAltitude(this.photo.alt, dem));
		this.elevRange = localElevRange(terrain);
		this.gpu?.terrain.setTiles(terrain.tiles);
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
		this.edge = buildEdgeMap(img, 512, fg);
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
		if (!this.region || !t) return;
		this.trails = buildTrailSegments(
			this.region,
			this.frame,
			this.photo,
			(lat, lon) => t.heightAt(lat, lon),
			trailPalette(this.style),
		);
		this.gpu?.trails.setSegments(this.trails);
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
		this.tiles3d?.dispose();
		clearTimeout(this.statsTimer);
		clearTimeout(this.lookTimer);
		clearTimeout(this.idleTimer);
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
			const w = this.wedgeFor(this.pose);
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

	/** deck/engine.ts noteInput (the WebGPU compositor has no cheap interactive mode: only the
	 * readback waits for input idle). */
	private noteInput() {
		const now = performance.now();
		const burst = now - this.lastInputAt < INPUT_IDLE_MS;
		this.lastInputAt = now;
		if (burst && !this.interactive) {
			this.interactive = true;
			this.counters.interactions++;
		}
		clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.inputIdle(), INPUT_IDLE_MS);
	}

	private inputIdle() {
		this.idleTimer = 0;
		if (!this.interactive || this.disposed) return;
		this.interactive = false;
		if (this.terrain && !this.geometryReady() && !this.lost) {
			let t = 0;
			void Promise.race([
				this.gens.readback(),
				new Promise((r) => {
					t = window.setTimeout(r, 250);
				}),
			]).then(() => clearTimeout(t));
		}
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
		const { width: w, height: h, range } = src;
		return { w, h, at: (x, y) => range[y * w + x] };
	}

	/** deck/engine.ts updateLook (refined masks, photo noise, the composite's look). */
	private updateLook() {
		const composite = this.gpu?.composite;
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
					this.settings.mode === "replace" && composite
						? blendCut(this.settings, composite.brushCanvas, this.brushVersion)
						: null,
				geo: () => grid,
			});
			this.compLook.updateNoise(this.style, this.photoImg, () => grid);
		}
		if (!composite) return;
		if (!defines.length && !composite.look.defines.length) return;
		const L = this.compLook;
		const c = this.style.composite;
		const gen = this.gens.generation;
		composite.setLook({
			defines,
			values: (outW, outH) =>
				compositeValues(this.style, {
					outW,
					outH,
					refine: L.masks?.gen === gen,
					// the geometry target's normal is written every frame for the current pose
					crease: true,
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
			normal: defines.includes("LOOK_INK") && c.ink.crease > 0 ? gen : null,
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
		if (
			!lookKey(this.style).includes("LOOK_HARMONIZE") ||
			!this.geometryReady() ||
			!this.photoImg ||
			!this.compLook.wantsStats(amount, key) ||
			this.statsTimer ||
			this.statsBusy
		)
			return;
		this.statsTimer = window.setTimeout(async () => {
			this.statsTimer = 0;
			const grid = this.rangeGrid();
			const img = this.photoImg;
			if (this.disposed || !this.geometryReady() || !grid || !img) return;
			const [w, h] = gridSize(this.aspect, STATS_LONG_SIDE);
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
		const fitted = this.haze.update({
			style: this.style,
			pose,
			img: this.photoImg,
			eyeAlt: this.eyeAlt,
			sunDir: this.look("overlay").sunDir,
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
		const nearDiscard = nearFadeFor(this.photo.hAccuracy) * 0.5;
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
			});
			if (look.imagery && this.renderSet)
				this.syncImagery(this.renderSet, look.imagery);
			g.trails.setEnabled(look.trails && !!this.trails?.count);
			g.gizmo.setProps({ view: "photo" });
			g.photoSky.setEnabled(false);
			g.splats.setEnabled(false);
			g.tiles3d?.setEnabled(false);
		}
		g.trails.setStyle({
			width: this.style.trails.width,
			opacity: this.style.trails.opacity,
		});
		if (this.relief.field !== g.reliefFrom) {
			g.styles.setReliefField(this.relief.field);
			g.reliefFrom = this.relief.field;
		}
		g.drape.setPhotoCamera(photoU);
		g.styles.applyTo(g.terrain, [g.drape.part()]);
		g.terrain.look = g.styles.terrainLook(elevRange);
		this.schedule("all");
		this.scheduleStats();
	}

	private syncWorld(g: Gpu, photoU: CameraUniforms, nearDiscard: number) {
		const w = this.world as WorldCamera;
		const s = this.settings;
		const src = s.worldStyle === "hillshade" ? null : s.worldStyle;
		if (src && this.renderSet)
			this.syncImagery(this.renderSet, src, () => this.worldTileOrder(w));
		const wl = this.look("world");
		g.styles.set({
			style: src ? "imagery" : "hillshade",
			look: wl,
			contourInterval: s.contourInterval,
			contourOpacity: 1,
			nearFade: 0,
			// only the photo camera's geometry pass discards (the range map the drape tests)
			nearDiscard,
		});
		const stepView = this.step?.view === "step";
		const dm = this.drapeMask();
		g.drape.setMask(dm.photoFg);
		g.drape.setSettings({
			projectPhoto: stepView ? 2 : s.projectOpacity,
			minRange: stepView ? 1 : s.minProjectRange,
			protectPeople: dm.protectPeople,
			tint: wl.photoTint,
			tintColor: [...wl.photoTintCol] as V3,
			truth: this.nearField?.opts.truth ? PROVENANCE_TINT_MIX : 0,
			harmonize: this.harmonize(this.style.world.drapeHarmonize),
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

	/** The imagery bitmaps → the texture array (async uploads; imagery.onChange redraws). */
	private pushImagery() {
		const g = this.gpu;
		const set = this.renderSet;
		if (!g || !set || !this.imagery.key) return;
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

	readback(): Promise<boolean> {
		return this.gens.readback();
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
		const i = y * w + x;
		const range = src.range[i];
		if (!(range > 0) || !Number.isFinite(range)) return null;
		let world: V3;
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

	/** deck/engine.ts peakLabels (occlusion from the fresh geometry buffer, CPU projection). */
	peakLabels(
		max = this.style.labels.maxLabels,
		{ declutter = true } = {},
	): PeakLabel[] {
		if (!this.terrain) return [];
		const snapped = this.snapped(this.pose);
		if (this.geometryReady())
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
		if (!this.horizonDirs || !this.edge) return null;
		const tSearch = performance.now();
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
		const t0 = performance.now();
		await this.ready;
		const srcs = alts.map((_, i) => this.silhouetteSource(i));
		await Promise.all(alts.map((a, i) => srcs[i]?.render(a.pose)));
		if (this.disposed) return null;
		const tScore = performance.now();
		const scored = alts.map((a, i) => {
			const sil = this.scoreSilhouette(srcs[i]);
			return { ...a, sil, total: a.score + 0.5 * sil };
		});
		this.silTiming = {
			renders: alts.length,
			ms: performance.now() - t0,
			searchMs: t0 - tSearch,
			scoreMs: performance.now() - tScore,
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
		const src = this.silhouetteSource();
		if (!src) return 0;
		await src.render(pose);
		return this.scoreSilhouette(src);
	}

	/** deck/engine.ts scoreSilhouette (rows top-down). */
	private scoreSilhouette(src: GeometrySource | null) {
		const edge = this.edge;
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
			let world: V3 | null = null;
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
		cores?: readonly GpuLayerCore[];
		screen: boolean;
	}): Promise<Uint8Array | Float32Array | null> {
		await this.ready;
		const g = this.gpu;
		const host = this.host;
		if (!g || !host || this.disposed || this.lost) return null;
		const device = g.device;
		const cores = o.cores ?? host.cores;
		const photo = this.photoPose();
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
			device.submit();
			this.viewOverride = prevOverride;
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
	 * straight-alpha RGBA floats in GL row order (row 0 = bottom), as CompositeLook.setStats wants.
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
				const a = px[s + 3];
				const k = a > 1e-6 ? 1 / a : 0;
				out[d] = px[s] * k;
				out[d + 1] = px[s + 1] * k;
				out[d + 2] = px[s + 2] * k;
				out[d + 3] = a;
			}
		return out;
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
		if (withLabels) await this.readback();
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
