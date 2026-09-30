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
import * as THREE from "three";
import {
	type AlignResult,
	buildEdgeMap,
	type EdgeMap,
	type Pin,
	solvePins,
} from "../align";
import { hfovFromAspect, type Pose } from "../camera";
import { tileBounds } from "../dem";
import {
	defaultSettings,
	type PeakLabel,
	type Sample,
	type Settings,
} from "../engine";
import { startLakeFloor } from "../geocam/lakes/fetch";
import { priorHeading } from "../geocam/priors/heading";
import { distanceM, EnuFrame, M_PER_DEG_LAT } from "../geodesy";
import { autoAlignAsync, warmAlignGpu } from "../gpu/align";
import { lookIdle } from "../gpu/look/opt-in";
import {
	type FastHorizon,
	startFastHorizon,
} from "../integration/horizon-fast-app";
import { photoUnknowns, type Unknowns } from "../integration/unknown-pose";
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
import { COMPOSITE_DEFINES } from "../look/glsl/composite";
import { HazeController, rangeGeo } from "../look/haze-controller";
import type { SkyMask } from "../look/haze-fit";
import { drawExportLabels, skylineAt } from "../look/labels";
import { lookKey } from "../look/look-key";
import { ReliefController } from "../look/relief/field";
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
import { projectPoint, unprojectDir } from "../pose";
import type { FgMask, Renderer } from "../renderer";
import type { RevealUniforms } from "../reveal/config";
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
import { heightFromTile } from "../terrain";
import { DeckTiles3D } from "../tiles3d/deck-tiles";
import { PhotoCompositor } from "./composite";
import { CpuGeometrySource, TerrainProfiles } from "./cpu-geometry";
import { GpuGeometrySource, geometrySize, rangeMapFrom } from "./geometry-pass";
import {
	type GeometrySource,
	type GeometrySourceFactory,
	logRange,
} from "./geometry-source";
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
import {
	type ImagerySource,
	loadImagery,
	type TerrainSet,
	type TileMesh,
	type ViewWedge,
} from "./terrain-data";
import { type PhotoRangeMap, TerrainLayer } from "./terrain-layer";
import { TerrainStreamer } from "./terrain-stream";
import {
	buildTrailSegments,
	recolorTrailSegments,
	TrailLayer,
	type TrailSegments,
} from "./trail-layer";
import {
	AtmSkyLayer,
	poseQuaternion,
	WorldCamera,
	WorldGizmoLayer,
	WorldView,
} from "./world-view";

const angleDiff = (a: number, b: number) =>
	Math.abs(((a - b + 540) % 360) - 180);

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

const samePose = (a: Pose, b: Pose) =>
	a.yaw === b.yaw &&
	a.pitch === b.pitch &&
	a.roll === b.roll &&
	a.vfov === b.vfov;

export class DeckEngine implements Renderer {
	readonly kind = "deck" as const;
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
	/** Bumps whenever the layer's look changes without a pose change (style, haze fit, relief field): the band stats' key. */
	private layerGen = 0;
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
		/** CPU scoring of the read-back range buffers (part of ms) */
		scoreMs?: number;
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
		abort: null as AbortController | null,
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
	private worldStill = 0;
	/** The drape's range map (rangeMapFrom the query geometry buffer) and its generation. */
	private drape: { gen: number; map: PhotoRangeMap } | null = null;
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

	constructor(canvas: HTMLCanvasElement, photo: PhotoMeta) {
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
		this.compositor = new PhotoCompositor(this.aspect);
		this.compositor.viewId = "photo";
		this.compositor.onChange = () => this.updateComposite();
		let onLoad = () => {};
		this.deckReady = new Promise<void>((r) => {
			onLoad = r;
		});
		this.deck = new Deck({
			canvas,
			// null: never touch the canvas' CSS size (PhotoWorkspace sizes it); the canvas context
			// follows its client size
			width: null,
			height: null,
			useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
			views: this.photoViews,
			viewState: this.viewState(),
			layers: [],
			effects: [this.compositor],
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
		} as never);
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
		this.compositor.setPhoto(img);
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
			const floor = await lakeFloor(dem, (la, lo) => terrain.heightAt(la, lo));
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
		this.tiles3d?.dispose();
		clearTimeout(this.statsTimer);
		clearTimeout(this.lookTimer);
		this.loadAbort.abort();
		this.fastHorizon?.dispose();
		this.streamer?.dispose();
		this.imagery.abort?.abort();
		for (const b of this.imagery.map.values()) b.close();
		this.imagery.map.clear();
		clearTimeout(this.geoTimer);
		clearTimeout(this.wedgeTimer);
		cancelAnimationFrame(this.worldRaf);
		this.step?.cam.dispose();
		this.step = null;
		this.world?.dispose();
		for (const r of this.readbackWaiters) r(false);
		this.readbackWaiters = [];
		this.dropGeometrySources();
		this.compositor.onChange = undefined;
		this.listeners.clear();
		this.deck.finalize();
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

	// ---------------- Renderer: state ----------------

	setPose(p: Pose) {
		this.pose = { ...p };
		this.updateLayers();
		this.invalidateGeometry();
		// the DEM's high-detail wedge follows the view, ~300 ms after it settles
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
		this.updateLayers();
		this.scheduleLook();
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

	/** concord DSM occluder dim mask (?concord=occl; row 0 = top, 255 = dim); null = off. Composite-only. */
	setOccluder(m: FgMask | null) {
		this.compositor.setOccluder(m);
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

	/**
	 * engine.ts layerStats: band stats (LOOK_HARMONIZE) of the replace layer or the world's own
	 * render, drawn at ≤ 256 px through the photo camera once the pose settles (and as imagery streams in).
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
			const layer = this.compositor.readLayer(
				this.liveLayers(),
				this.pose,
				this.eyeArr,
				w,
				h,
			);
			if (!layer) return;
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
			if (this.world?.controls) this.updateLayers();
		}, 120);
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
			this.deck.setProps({
				viewState: this.viewState(),
				layers: this.worldLayers(),
			} as never);
			this.scheduleStats();
			return;
		}
		const look = terrainLookFor(this.settings);
		this.compositor.setSettings(compositeFor(this.settings));
		const layers: unknown[] = [];
		const set = this.renderSet;
		if (set && this.terrain) {
			const imagery = look.imagery
				? this.syncImagery(set, look.imagery)
				: undefined;
			layers.push(
				new TerrainLayer({
					id: "terrain",
					tiles: set.tiles,
					imagery,
					style: look.style,
					look: this.look(look.mode, look.style === "elevation"),
					contourInterval: look.contourInterval,
					contourOpacity: look.contourOpacity,
					nearFade: look.nearFade,
					nearDiscard: nearFadeFor(this.photo.hAccuracy),
					elevRange: deckElevRange(this.style, this.elevRange) ?? undefined,
					relief: this.relief.field,
					offscreen: true,
				}),
			);
			if (look.trails && this.trails?.count)
				layers.push(
					new TrailLayer({
						id: "trails",
						segments: this.trails,
						widthPx: this.style.trails.width,
						lineOpacity: this.style.trails.opacity,
					}),
				);
		}
		// Step Inside splats draw only in the world / step view (engine.ts NEARFIELD_LAYER): the photo view
		// shows the photo
		this.sceneLayers = layers as Layer[];
		this.deck.setProps({
			viewState: this.viewState(),
			layers: [...layers, this.compositor.layer("screen-composite")],
		} as never);
		this.scheduleStats();
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
			layers: [...this.sceneLayers, this.compositor.layer("screen-composite")],
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

	/** Imagery for `set`, fetched incrementally per tile (deck.tsx's cache), keyed by source. */
	private syncImagery(
		set: TerrainSet,
		src: ImagerySource,
		order?: (a: TileMesh, b: TileMesh) => number,
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
		if (order) missing.sort(order);
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
					if (n++ % 6 === 0) this.updateLayers();
				},
				ac.signal,
			).finally(() => {
				if (c.abort === ac) c.abort = null;
				if (!ac.signal.aborted) this.updateLayers();
			});
		}
		return new Map(c.map);
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
		if (!this.terrain || this.disposed) return;
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

	/** Render + read back the geometry for the current pose; true if the buffer is fresh after. */
	private async refreshGeometry(): Promise<boolean> {
		if (this.disposed || !this.terrain) return false;
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
		if (this.disposed) return false;
		const got = this.geoSrc.pose;
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
		if (src.xyz)
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
		if (this.geometryReady())
			for (const p of snapped) {
				const pr = projectPoint(this.pose, this.aspect, eyeV, p.position);
				if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
				const range = Math.hypot(
					p.position[0] - this.eye.x,
					p.position[1] - this.eye.y,
					p.position[2] - this.eye.z,
				);
				let visible = false;
				for (const dv of [0.004, 0.009]) {
					const s = this.sampleAt(pr.u, pr.v + dv);
					if (!s || s.range > range * 0.97 - 50) visible = true;
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
		// all hypotheses are submitted at once and their async readbacks overlap (three renders and
		// reads each one back synchronously)
		const srcs = alts.map((_, i) => this.silhouetteSource(i));
		await Promise.all(alts.map((a, i) => srcs[i]?.render(a.pose)));
		if (this.disposed) return null;
		const tScore = performance.now();
		for (let i = 0; i < alts.length; i++) {
			const sil = this.scoreSilhouette(srcs[i]);
			scored.push({ ...alts[i], sil, total: alts[i].score + 0.5 * sil });
		}
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
			this.updateComposite();
		}
	}

	/** The world / step view's splat layer (drawn on the canvas), or null. */
	private nearFieldLayer(): DeckSplatLayer | null {
		const nf = this.nearField;
		if (!nf?.scene.splats.count) return null;
		const opacity = nf.opts.opacity ?? 1;
		if (!(opacity > 0)) return null;
		return new DeckSplatLayer({
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
		this.world ??= new WorldCamera(this.canvas, () => this.kickWorld());
		const ws = deckWorldStyle(this.style);
		this.world.planeOpacity = ws.planeOpacity;
		this.world.setAspect(this.cssSize.w / this.cssSize.h);
		this.world.enter(this.pose, this.eyeVec);
		this.world.tick(this.pose, this.eyeVec, this.aspect);
		this.compositor.enabled = false;
		this.canvas.style.backgroundColor = ws.sky;
		this.deck.setProps({ views: this.worldViews } as never);
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
			if (flying || gizmo) this.updateLayers();
			else if (moved)
				this.deck.setProps({ viewState: this.viewState() } as never);
			this.worldStill = moved ? 0 : this.worldStill + 1;
			// damping settles over some frames; a new drag sends 'change' → kickWorld again
			this.worldRaf =
				flying || this.worldStill < 30 ? requestAnimationFrame(step) : 0;
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
			this.drape = { gen: this.geoBufGen, map: rangeMapFrom(src) };
		return this.drape.map;
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
			? this.syncImagery(set, src, this.worldTileOrder(w))
			: undefined;
		const ws = deckWorldStyle(this.style);
		const atm = this.look("world").atm;
		const out: unknown[] = [
			this.style.world.sky.mode === "atmosphere" &&
				atm &&
				new AtmSkyLayer({
					id: "world-sky",
					atm,
					parameters: { depthCompare: "always", depthWriteEnabled: false },
				}),
			this.photoSkyLayer(),
			new TerrainLayer({
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
				offscreen: false,
				photo: this.photoImg ?? null,
				photoRange: this.drapeRange(),
				...this.drapeMask(),
				photoViewProj: Array.from(
					photoViewProjection(this.pose, this.eyeArr, this.aspect),
				),
				photoPos: this.eyeArr,
				// Step Inside: the full photo on the drape, at every incidence (terrain-layer.ts: > 1.5)
				projectPhoto: this.step?.view === "step" ? 2 : s.projectOpacity,
				// from the photo camera the near terrain drapes exactly: no grazing-angle cut-off (engine.ts)
				photoMinRange: this.step?.view === "step" ? 1 : s.minProjectRange,
				harmonize: harmonizeValues(
					this.compLook.stats,
					this.style.world.drapeHarmonize,
				),
				// Truth toggle: the terrain tinted by provenance too (terrain-layer.ts truth; 0 = classic)
				truth: this.nearField?.opts.truth ? PROVENANCE_TINT_MIX : 0,
			}),
		];
		if (s.trails && this.trails?.count)
			out.push(
				new TrailLayer({
					id: "world-trails",
					segments: this.trails,
					widthPx: this.style.trails.width,
					lineOpacity: this.style.trails.opacity,
					onCanvas: true,
				}),
			);
		// engine.ts: the frustum is hidden once the plane has faded (end of the fly-in)
		if (w.photoPlaneOpacity > 0.02)
			out.push(
				new WorldGizmoLayer({
					id: "world-gizmo",
					pose: this.pose,
					eye: this.eyeArr,
					aspect: this.aspect,
					image: this.photoImg ?? null,
					planeOpacity: w.photoPlaneOpacity,
					lineColor: ws.lineColor,
					pinColor: ws.pinColor,
					pinRadiusM: ws.pinRadiusM,
				}),
			);
		// Step Inside 3D Tiles (opaque, log depth): before the splats
		if (this.step?.view === "step" && this.tiles3d) {
			const dm = this.drapeMask();
			const tl = this.tiles3d.layer({
				photoViewProj: Array.from(
					photoViewProjection(this.pose, this.eyeArr, this.aspect),
				),
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
		return out.filter(Boolean);
	}

	/** Stepping: the photo's Sky pixels on a far sphere, over the world sky (step-camera.ts makePhotoSky). */
	private photoSkyLayer() {
		const sm = this.stepMasks();
		if (!sm || !this.photoImg) return null;
		return new PhotoSkyLayer({
			id: "world-photo-sky",
			parameters: PHOTO_SKY_PARAMETERS,
			photo: this.photoImg,
			skyMask: sm.sky,
			photoViewProj: Array.from(
				photoViewProjection(this.pose, this.eyeArr, this.aspect),
			),
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
	async exportImage(withLabels = true): Promise<Blob | null> {
		// display-only 3D Tiles (Google) never enter an export (tiles3d/deck-tiles.ts)
		if (this.settings.mode === "world")
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
