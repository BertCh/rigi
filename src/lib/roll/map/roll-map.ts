// The roll's 3D map: every photo of a roll draped on the terrain at once, with a frustum per
// photo, click-to-select, hover cards and a fly-in to any photographer's viewpoint, from which the
// user can walk to the previous / next photo or to the nearest one ahead (Mapillary-style).
//
// One ENU frame at the roll centroid. Photo poses live in each photo's own local ENU frame; over a
// roll (≲ 20 km) the difference is the meridian convergence (Δlon·sin lat, applied to yaw, 0.07°
// at 7 km) plus a tilt of the vertical below 0.1°, which is ignored.
//
// Reuses the deck backend without touching it: TerrainLayer for the ground, GpuGeometrySource for
// each photo's range map (the drape's shadow map), WorldCamera/WorldView for the orbit + fly-in
// camera, WorldGizmoLayer for the frustums. The drape itself is MultiDrapeLayer
// (./multi-drape-layer.ts) over the atlases of ./drape-atlas.ts.
//
// Loading is a pipeline so the drape grows instead of appearing at the end: photos upload into
// their atlas cells as they arrive, people masks are segmented while the terrain still streams,
// and each photo drapes as soon as its range map is read back (a few in flight at once).
import { COORDINATE_SYSTEM, Deck } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { Device } from "@luma.gl/core";
import * as THREE from "three";
import type { Pose } from "#/lib/camera";
import { GpuGeometrySource, rangeMapFrom } from "#/lib/deck/geometry-pass";
import { photoViewProjection } from "#/lib/deck/photo-view";
import { eyeAltitude, localElevRange } from "#/lib/deck/scene";
import {
	type ImagerySource,
	loadImagery,
	type TerrainSet,
	type TileMesh,
} from "#/lib/deck/terrain-data";
import { TerrainLayer } from "#/lib/deck/terrain-layer";
import {
	LogDepthExtension,
	WORLD_SKY,
	WorldCamera,
	WorldGizmoLayer,
	WorldView,
} from "#/lib/deck/world-view";
import { tileBounds } from "#/lib/dem";
import { EnuFrame } from "#/lib/geodesy";
import type { ForegroundMask } from "#/lib/segment";
import { vpColor } from "../mosaic/style";
import type { Roll, RollPhoto } from "../types";
import { basemapLook, basemapSource, type RollBasemap } from "./basemap";
import { DrapeAtlas, MAX_PHOTOS } from "./drape-atlas";
import { type DrapePhoto, MultiDrapeLayer } from "./multi-drape-layer";
import { loadRollTerrain } from "./roll-terrain";

/** Range map size (long side, px). The drape only needs it for occlusion. */
const RANGE_LONG = 512;
/** Range maps rendered + read back concurrently (the readback is async: overlap the waits). */
const RANGE_CONCURRENCY = 3;
/** Frustum-plane image size (long side, px): 150 m in front of the camera needs no more. */
const GIZMO_THUMB = 384;
/** WorldCamera's fixed arc over the terrain on a fly-in (world-view.ts tick). */
const WORLD_ARC_M = 600;

/** The mosaic's viewpoint colour (#/lib/roll/mosaic/style) as 0..255 sRGB. */
export const viewpointColor = (i: number): [number, number, number] => {
	const h = vpColor(i);
	return [1, 3, 5].map((k) => Number.parseInt(h.slice(k, k + 2), 16)) as [
		number,
		number,
		number,
	];
};

type Placed = {
	photo: RollPhoto;
	id: string;
	/** Pose in the roll frame (yaw corrected for meridian convergence). */
	pose: Pose;
	eye: [number, number, number];
	aspect: number;
	/** Bumped when the pose or eye changes (updateRoll): its range map is then redone. */
	rev: number;
};

export type RollMapStatus = {
	stage: "terrain" | "photos" | "ranges" | "people" | "ready";
	frac: number;
	note?: string;
};

/** A camera pin under the pointer (canvas CSS px). */
export type RollMapHover = { id: string; x: number; y: number };

export type RollMapOptions = {
	onSelect?: (id: string | null) => void;
	onStatus?: (s: RollMapStatus) => void;
	/** Pin under the pointer changed (null = none). */
	onHover?: (h: RollMapHover | null) => void;
	/** Entered a photographer's viewpoint (its id) or left it for the orbit view (null). */
	onView?: (photoId: string | null) => void;
	/** A photo joined the drape (count so far). */
	onDrape?: (n: number) => void;
};

/** Long side (px) of the working copy of each photo: the largest atlas cell. */
const PIXELS_LONG = 1024;

export class RollMapEngine {
	readonly frame: EnuFrame;
	readonly deck: Deck;
	readonly world: WorldCamera;
	private _roll: Roll;
	private placed: Placed[] = [];
	private renderSet: TerrainSet | null = null;
	private imagery = new Map<string, ImageBitmap>();
	private imageryAbort: AbortController | null = null;
	/** The source this.imagery holds (a basemap switch drops the other source's tiles). */
	private imagerySrc: ImagerySource | null = null;
	private elevRange: [number, number] | null = null;
	private loadAbort = new AbortController();
	private atlas: DrapeAtlas | null = null;
	/** Atlas slot per photo id. */
	private slot = new Map<string, number>();
	private atlasVersion = 0;
	private atlasTimer = 0;
	private draped = 0;
	private drapePhotos: DrapePhoto[] = [];
	private drapeKey = "";
	private selected: string | null = null;
	private visible: ReadonlySet<string> | null = null;
	private flying: Placed | null = null;
	/** Arc height (m) for the current flight (short hops stay low). */
	private flightArc = WORLD_ARC_M;
	private raf = 0;
	private still = 0;
	private disposed = false;
	private ready: Promise<void>;
	private downAt: { x: number; y: number } | null = null;
	private hoverId: string | null = null;
	private hoverRaf = 0;
	private centerZ = 0;
	/** Downscaled working copies (≤ PIXELS_LONG), kept until uploaded and segmented. */
	private pixels = new Map<string, ImageBitmap>();
	private uploaded = new Set<string>();
	private thumbs = new Map<string, ImageBitmap>();
	private masks = new Map<string, ForegroundMask | null>();
	/** Range maps to (re)render, and the progress of the current batch. */
	private rangeQueue: Placed[] = [];
	private rangeWorkers = 0;
	private rangeCount = { done: 0, total: 0 };
	private rangesStarted = false;
	settings = {
		drapeOpacity: 1,
		sharpness: 3,
		gizmos: true,
		reachM: 8000,
		protectPeople: true,
		basemap: "satellite" as RollBasemap,
	};

	constructor(
		private canvas: HTMLCanvasElement,
		roll: Roll,
		private opts: RollMapOptions = {},
	) {
		this._roll = roll;
		this.frame = new EnuFrame(roll.center.lat, roll.center.lon, 0);
		this.world = new WorldCamera(canvas, () => this.kick());
		let onLoad = () => {};
		this.ready = new Promise<void>((r) => {
			onLoad = r;
		});
		this.deck = new Deck({
			canvas,
			width: null,
			height: null,
			useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
			// near 0.5 m: at a photographer's eye (≈ 2 m up) a 5 m near plane cut a hole in the ground
			// below the view; every layer writes log depth, so the ratio costs no precision
			views: [new WorldView({ id: "world", near: 0.5, far: 600_000 })],
			layers: [],
			controller: false,
			onLoad: () => onLoad(),
			onError: (e: Error) => console.error("[roll-map]", e),
		} as never);
		canvas.style.backgroundColor = WORLD_SKY;
		canvas.addEventListener("pointerdown", this.onDown);
		canvas.addEventListener("pointerup", this.onUp);
		canvas.addEventListener("pointermove", this.onMove);
		canvas.addEventListener("pointerleave", this.onLeave);
	}

	get roll() {
		return this._roll;
	}

	// ---------------- loading ----------------

	async init() {
		const status = this.opts.onStatus;
		status?.({ stage: "terrain", frac: 0 });
		const photosP = this.loadPhotos();
		// people masks need only the pixels: segment them while the terrain streams
		const masksP = photosP.then(() => this.segmentAll());
		// the atlas layout needs only the photo sizes: allocate it as soon as the GPU is up
		void this.ready.then(() => this.makeAtlas());
		const set = await this.startStreaming();
		if (!set || this.disposed) return;
		this.placePhotos(set);
		this.frameOverview();
		await this.ready;
		if (this.disposed) return;
		this.makeAtlas();
		this.updateLayers();
		// the geometry pass draws the deck's live tile layers
		this.flushLayers();
		this.rangesStarted = true;
		// the selected photo first, then capture order
		const todo = this.placed.filter((p) => this.slot.has(p.id));
		const sel = todo.findIndex((p) => p.id === this.selected);
		if (sel > 0) todo.unshift(...todo.splice(sel, 1));
		await this.enqueueRanges(todo);
		await photosP;
		if (
			this.masks.size < this.pixels.size + this.uploaded.size &&
			this.settings.protectPeople
		) {
			const n = this.roll.photos.length;
			status?.({
				stage: "people",
				frac: this.masks.size / n,
				note: `${this.masks.size}/${n} photos`,
			});
		}
		await masksP;
		if (this.disposed) return;
		status?.({ stage: "ready", frac: 1 });
	}

	/**
	 * New poses for the same photos (the roll aligner finished): move the cameras and redo only
	 * the range maps of the photos whose pose or eye changed. Terrain, pixels and masks stay.
	 */
	updateRoll(roll: Roll) {
		this._roll = roll;
		const set = this.renderSet;
		if (!set) return; // placePhotos will use the new poses
		const byId = new Map(roll.photos.map((p) => [p.meta.id, p]));
		const changed: Placed[] = [];
		for (const pl of this.placed) {
			const p = byId.get(pl.id);
			if (!p) continue;
			pl.photo = p;
			const next = this.placeOne(p, set);
			const same =
				(["yaw", "pitch", "roll", "vfov"] as const).every(
					(k) => Math.abs(next.pose[k] - pl.pose[k]) < 1e-6,
				) && next.eye.every((v, i) => Math.abs(v - pl.eye[i]) < 1e-3);
			if (same) continue;
			pl.pose = next.pose;
			pl.eye = next.eye;
			pl.rev++;
			changed.push(pl);
		}
		if (!changed.length) return;
		this.drapeKey = "";
		this.updateLayers();
		this.kick();
		if (this.rangesStarted)
			void this.enqueueRanges(changed.filter((p) => this.slot.has(p.id)));
	}

	/** Every photo: a downscaled working copy (atlas + segmentation) and a thumbnail. */
	private loadPhotos() {
		const status = this.opts.onStatus;
		let done = 0;
		const n = this.roll.photos.length;
		return Promise.all(
			this.roll.photos.map((p) =>
				new Promise<HTMLImageElement | null>((resolve) => {
					const img = new Image();
					img.crossOrigin = "anonymous";
					img.onload = () => resolve(img);
					img.onerror = () => resolve(null);
					img.src = p.meta.src;
				}).then(async (img) => {
					// the full-size decode is dropped as soon as the copies exist (uploads can be 12 MP)
					const px =
						img && !this.disposed
							? await scaled(img, PIXELS_LONG).catch(() => null)
							: null;
					const thumb = px
						? await scaled(px, GIZMO_THUMB).catch(() => null)
						: null;
					status?.({ stage: "photos", frac: ++done / n });
					if (!px || this.disposed) return px?.close();
					if (thumb) this.thumbs.set(p.meta.id, thumb);
					this.pixels.set(p.meta.id, px);
					await this.uploadPhoto(p.meta.id);
				}),
			),
		);
	}

	private makeAtlas() {
		if (this.disposed || this.atlas) return;
		const device = (this.deck as unknown as { device?: Device }).device;
		if (!device) return;
		const photos = this.roll.photos.slice(0, MAX_PHOTOS);
		if (this.roll.photos.length > MAX_PHOTOS)
			console.warn(
				`[roll-map] draping the first ${MAX_PHOTOS} of ${this.roll.photos.length} photos`,
			);
		this.atlas = new DrapeAtlas(
			device,
			photos.map((p) => {
				const r = rangeSize(p.meta.width / p.meta.height);
				return {
					id: p.meta.id,
					width: p.meta.width,
					height: p.meta.height,
					rangeW: r.w,
					rangeH: r.h,
				};
			}),
		);
		for (const [k, p] of photos.entries()) this.slot.set(p.meta.id, k);
		// whatever arrived before the GPU was up
		for (const id of this.pixels.keys()) void this.uploadPhoto(id);
		for (const [id, m] of this.masks)
			if (m) this.atlas.setMask(this.slot.get(id) ?? -1, m);
	}

	private async uploadPhoto(id: string) {
		const px = this.pixels.get(id);
		const k = this.slot.get(id);
		if (!this.atlas || !px || k === undefined || this.uploaded.has(id)) return;
		this.uploaded.add(id);
		await this.atlas.setPhoto(k, px);
		this.release(id);
		this.atlasChanged();
	}

	/** Drop a working copy once it is in the atlas and segmented (or masks are off). */
	private release(id: string) {
		if (
			!this.uploaded.has(id) ||
			(this.settings.protectPeople && !this.masks.has(id))
		)
			return;
		this.pixels.get(id)?.close();
		this.pixels.delete(id);
	}

	private atlasChanged() {
		if (!this.atlas || this.disposed) return;
		this.atlasVersion = this.atlas.version;
		const n = this.atlas.ready.filter(Boolean).length;
		if (n !== this.draped) {
			this.draped = n;
			this.opts.onDrape?.(n);
		}
		// coalesce: while range maps stream in, a redraw per photo would queue canvas frames on the
		// GPU ahead of the next readbacks
		if (this.atlasTimer) return;
		this.atlasTimer = window.setTimeout(() => {
			this.atlasTimer = 0;
			this.updateLayers();
		}, 60);
	}

	/** The roll's terrain, refined around every viewpoint (./roll-terrain.ts). */
	private async startStreaming() {
		const set = await loadRollTerrain(this.frame, {
			foci: this.roll.viewpoints,
			// the roll plus the skyline country around it
			radiusM: Math.max(40_000, this.roll.radiusM + 30_000),
			signal: this.loadAbort.signal,
			onProgress: (d, t) =>
				this.opts.onStatus?.({
					stage: "terrain",
					frac: t ? d / t : 0,
					note: `${d}/${t} tiles`,
				}),
		});
		if (set) {
			this.renderSet = set;
			this.elevRange = null;
		}
		return set;
	}

	/** A photo's camera in the roll frame. */
	private placeOne(p: RollPhoto, set: TerrainSet) {
		const m = p.meta;
		const sinLat = Math.sin((this.frame.lat * Math.PI) / 180);
		const dem = set.heightAt(m.lat, m.lon) ?? 0;
		// the app's eye rule for every source: fitted (ground truth) eyes came from a coarser DEM
		// and can sit under the z17 surface here
		const alt = eyeAltitude(p.eyeAlt, dem);
		const e = this.frame.fromGeo(m.lat, m.lon, alt);
		return {
			pose: { ...p.pose, yaw: p.pose.yaw - (m.lon - this.frame.lon) * sinLat },
			eye: [e[0], e[1], e[2]] as [number, number, number],
		};
	}

	private placePhotos(set: TerrainSet) {
		this.placed = this.roll.photos.map((p) => ({
			photo: p,
			id: p.meta.id,
			...this.placeOne(p, set),
			aspect: p.meta.width / p.meta.height,
			rev: 0,
		}));
		this.centerZ = set.heightAt(this.frame.lat, this.frame.lon) ?? 0;
	}

	/**
	 * Range maps through the GPU geometry pass, a few in flight (the readback is asynchronous),
	 * each written into the atlas as it lands. The raw map is used: the shader filters the test
	 * (see multi-drape-layer.ts on drape acne), so no dilation. Resolves when the queue is empty.
	 */
	private enqueueRanges(ps: Placed[]) {
		const fresh = ps.filter((p) => !this.rangeQueue.includes(p));
		if (!this.rangeQueue.length && !this.rangeWorkers)
			this.rangeCount = { done: 0, total: 0 };
		this.rangeQueue.push(...fresh);
		this.rangeCount.total += fresh.length;
		const worker = async () => {
			this.rangeWorkers++;
			try {
				for (
					let p = this.rangeQueue.shift();
					p && !this.disposed;
					p = this.rangeQueue.shift()
				) {
					const rev = p.rev;
					const { w, h } = rangeSize(p.aspect);
					const src = new GpuGeometrySource(this.deck, p.eye, w, h, {
						xyz: false,
					});
					try {
						await src.render(p.pose);
						if (this.disposed) return;
						// moved while rendering (updateRoll): its newer pose is queued again
						if (p.rev !== rev) {
							if (!this.rangeQueue.includes(p)) this.rangeQueue.push(p);
							continue;
						}
						this.atlas?.setRange(
							this.slot.get(p.id) ?? -1,
							rangeMapFrom(src).data,
						);
						const c = this.rangeCount;
						c.done++;
						this.opts.onStatus?.({
							stage: "ranges",
							frac: c.done / Math.max(1, c.total),
							note: `${c.done}/${c.total} photos`,
						});
						this.atlasChanged();
					} finally {
						src.dispose();
					}
				}
			} finally {
				this.rangeWorkers--;
			}
		};
		const n = Math.min(
			RANGE_CONCURRENCY - this.rangeWorkers,
			this.rangeQueue.length,
		);
		return Promise.all(Array.from({ length: Math.max(0, n) }, worker)).then(
			() => {},
		);
	}

	/** People masks (#/lib/segment, cached per photo), one photo at a time. */
	private async segmentAll() {
		const n = this.roll.photos.length;
		for (const p of this.roll.photos) {
			if (this.disposed || !this.settings.protectPeople) return;
			const id = p.meta.id;
			const px = this.pixels.get(id);
			if (!px || this.masks.has(id)) continue;
			const { segmentForeground } = await import("#/lib/segment");
			const m = await segmentForeground(px);
			this.masks.set(id, m);
			const k = this.slot.get(id);
			if (this.atlas && k !== undefined && m) {
				this.atlas.setMask(k, m);
				this.atlasChanged();
			}
			this.release(id);
			// after the range maps, the masks are what the map still waits for
			if (
				this.rangeCount.total &&
				!this.rangeQueue.length &&
				!this.rangeWorkers
			)
				this.opts.onStatus?.({
					stage: "people",
					frac: this.masks.size / n,
					note: `${this.masks.size}/${n} photos`,
				});
		}
	}

	// ---------------- camera ----------------

	/** Oblique overview of the whole roll from the south. */
	frameOverview() {
		const p0 = this.placed[0];
		// WorldCamera.enter builds the OrbitControls; the framing is then replaced by the overview
		this.world.setAspect(
			this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
		);
		this.world.enter(
			p0?.pose ?? { yaw: 0, pitch: 0, roll: 0, vfov: 50 },
			new THREE.Vector3(...(p0?.eye ?? [0, 0, 0])),
		);
		const c = this.world.controls;
		if (!c) return;
		const d = Math.max(7000, this.roll.radiusM * 2.6);
		c.target.set(0, 0, this.centerZ);
		this.world.cam.position.set(0, -d * 0.8, this.centerZ + d * 0.75);
		c.update();
		const was = this.flying;
		this.flying = null;
		if (was) this.opts.onView?.(null);
		this.kick();
	}

	/**
	 * Fly into a photographer's viewpoint along an arc from wherever the camera is. Hops between
	 * nearby photos are quicker and flatter than the fly-in from the overview.
	 */
	flyTo(id: string, dur?: number) {
		const p = this.placed.find((x) => x.id === id);
		if (!p) return;
		if (!this.world.controls) this.frameOverview();
		const hop = this.world.cam.position.distanceTo(new THREE.Vector3(...p.eye));
		this.flightArc = Math.min(WORLD_ARC_M, hop * 0.3);
		this.flying = p;
		this.world.flyTo(
			p.pose,
			dur ?? Math.min(2400, Math.max(900, 800 + hop * 0.35)),
		);
		this.opts.onView?.(id);
		this.kick();
	}

	/** True while the camera is at (or flying into) a photographer's viewpoint. */
	get inPhoto() {
		return !!this.flying;
	}

	/** The photo whose viewpoint the camera is at (or flying into). */
	get photoId() {
		return this.flying?.id ?? null;
	}

	/**
	 * The nearest photo taken ahead of (dir 1) or behind (dir −1) the camera, within ±50° of the
	 * view direction on the ground: distance, penalised for being off-axis. Photos from (almost) the
	 * same spot are turns, not steps, and are skipped. Null when there is none.
	 */
	photoAhead(dir: 1 | -1 = 1): string | null {
		const f = new THREE.Vector3(0, 0, -1).applyQuaternion(
			this.world.cam.quaternion,
		);
		const fx = f.x * dir;
		const fy = f.y * dir;
		const fl = Math.hypot(fx, fy);
		if (fl < 1e-6) return null;
		const c = this.world.cam.position;
		let best: string | null = null;
		let bestS = Number.POSITIVE_INFINITY;
		for (const p of this.placed) {
			if (p === this.flying || this.gain(p.id) === 0) continue;
			const dx = p.eye[0] - c.x;
			const dy = p.eye[1] - c.y;
			const d = Math.hypot(dx, dy);
			if (d < 20) continue;
			const ang =
				(Math.acos(Math.min(1, Math.max(-1, (dx * fx + dy * fy) / (d * fl)))) *
					180) /
				Math.PI;
			if (ang > 50) continue;
			const s = d * (1 + 2 * (ang / 50) ** 2);
			if (s < bestS) {
				bestS = s;
				best = p.id;
			}
		}
		return best;
	}

	private kick() {
		this.still = 0;
		if (this.raf || this.disposed) return;
		const step = () => {
			if (this.disposed) {
				this.raf = 0;
				return;
			}
			const f = this.flying;
			let moved = this.world.tick(
				f?.pose ?? IDLE_POSE,
				new THREE.Vector3(...(f?.eye ?? [0, 0, 0])),
				f?.aspect ?? 1,
			);
			const fl = this.world.flight;
			if (fl && !fl.held && this.flightArc < WORLD_ARC_M) {
				// WorldCamera arcs every flight 600 m up; lower it for short hops (same easing as tick)
				const t = Math.min((performance.now() - fl.t0) / fl.dur, 1);
				const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
				this.world.cam.position.z -=
					Math.sin(e * Math.PI) * (WORLD_ARC_M - this.flightArc);
				moved = true;
			}
			if (moved) this.updateLayers();
			this.still = moved ? 0 : this.still + 1;
			const inFlight = !!this.world.flight && !this.world.flight.held;
			this.raf = inFlight || this.still < 30 ? requestAnimationFrame(step) : 0;
		};
		this.raf = requestAnimationFrame(step);
	}

	resize() {
		this.world.setAspect(
			this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
		);
		this.updateLayers();
	}

	// ---------------- state ----------------

	setSelected(id: string | null) {
		if (id === this.selected) return;
		this.selected = id;
		this.updateLayers();
	}

	setVisible(ids: ReadonlySet<string> | null) {
		this.visible = ids;
		this.updateLayers();
	}

	setSettings(s: Partial<RollMapEngine["settings"]>) {
		Object.assign(this.settings, s);
		this.updateLayers();
	}

	// ---------------- layers ----------------

	private gain(id: string) {
		if (this.visible && !this.visible.has(id)) return 0;
		if (!this.selected) return 1;
		return id === this.selected ? 3 : 0.3;
	}

	private flushLayers() {
		(
			this.deck as unknown as { layerManager?: { updateLayers(): void } }
		).layerManager?.updateLayers();
	}

	private imageryFor(set: TerrainSet) {
		const src = basemapSource(this.settings.basemap);
		if (src !== this.imagerySrc) {
			this.dropImagery();
			this.imagerySrc = src;
		}
		if (!src) return new Map<string, ImageBitmap>();
		const missing = set.tiles.filter((t) => !this.imagery.has(t.id));
		if (missing.length && !this.imageryAbort) {
			const ac = new AbortController();
			this.imageryAbort = ac;
			missing.sort(this.tileOrder());
			let n = 0;
			loadImagery(
				missing,
				src,
				(id, bmp) => {
					if (ac.signal.aborted) return bmp.close();
					this.imagery.set(id, bmp);
					if (n++ % 6 === 0) this.updateLayers();
				},
				ac.signal,
			).finally(() => {
				if (this.imageryAbort === ac) this.imageryAbort = null;
				if (!ac.signal.aborted) this.updateLayers();
			});
		}
		return new Map(this.imagery);
	}

	private dropImagery() {
		this.imageryAbort?.abort();
		this.imageryAbort = null;
		for (const b of this.imagery.values()) b.close();
		this.imagery.clear();
	}

	/**
	 * Imagery order: biggest on screen first (tile size / distance from the camera), so the coarse
	 * tiles that fill the overview and the near tiles after a fly-in both come early.
	 */
	private tileOrder() {
		const cam = this.world.cam.position;
		const score = new Map<TileMesh, number>();
		const of = (t: TileMesh) => {
			let v = score.get(t);
			if (v === undefined) {
				const b = tileBounds(t.key);
				const c = this.frame.fromGeo(
					(b.north + b.south) / 2,
					(b.west + b.east) / 2,
					this.centerZ,
				);
				const size =
					(b.east - b.west) *
					111_320 *
					Math.cos((this.frame.lat * Math.PI) / 180);
				v =
					Math.hypot(c[0] - cam.x, c[1] - cam.y, c[2] - cam.z) /
					Math.max(size, 1);
				score.set(t, v);
			}
			return v;
		};
		return (a: TileMesh, b: TileMesh) => of(a) - of(b);
	}

	private updateLayers() {
		if (this.disposed) return;
		const set = this.renderSet;
		const w = this.world;
		if (!set || !w.controls) return;
		// keep the array identity while nothing changed (MultiDrapeLayer rebuilds its params and
		// per-tile lists on change)
		const key = this.placed.map((p) => `${p.id}:${this.gain(p.id)}`).join();
		if (key !== this.drapeKey) {
			this.drapeKey = key;
			this.drapePhotos = this.placed.map((p) => ({
				id: p.id,
				viewProj: Array.from(photoViewProjection(p.pose, p.eye, p.aspect)),
				eye: p.eye,
				minRange: Math.max(
					30,
					Math.min(150, (p.photo.meta.hAccuracy ?? 10) * 3),
				),
				gain: this.gain(p.id),
				aspect: p.aspect,
				vfov: p.pose.vfov,
			}));
		}
		const target = w.controls.target;
		const base = basemapLook(this.settings.basemap);
		if (base.style !== "imagery" && !this.elevRange)
			this.elevRange = localElevRange(set);
		const layers: unknown[] = [
			new TerrainLayer({
				id: "terrain",
				tiles: set.tiles,
				imagery: this.imageryFor(set),
				style: base.style,
				look: base.look,
				...(this.elevRange && { elevRange: this.elevRange }),
				nearFade: 0,
				projectPhoto: 0,
				offscreen: false,
			}),
			// opacity 0 = drape off: skip its per-fragment photo loop altogether
			this.settings.drapeOpacity > 0 &&
				new MultiDrapeLayer({
					id: "drape",
					tiles: set.tiles,
					atlas: this.atlas,
					atlasVersion: this.atlasVersion,
					photos: this.drapePhotos,
					opacity: this.settings.drapeOpacity,
					sharpness: this.settings.sharpness,
					reachM: this.settings.reachM,
					people: this.settings.protectPeople ? 1 : 0,
				}),
		];
		const flyingIn = this.flying && w.flight;
		if (this.settings.gizmos)
			for (const p of this.placed) {
				const g = this.gain(p.id);
				if (g === 0) continue;
				// the photo being flown into fades out like the single-photo world view; its neighbours'
				// frustums would fill the frame from inside the viewpoint
				if (flyingIn && p === this.flying && w.photoPlaneOpacity < 0.02)
					continue;
				if (
					flyingIn &&
					p !== this.flying &&
					this.flying &&
					dist3(p.eye, this.flying.eye) < 500
				)
					continue;
				const col = viewpointColor(p.photo.viewpoint);
				const sel = p.id === this.selected;
				layers.push(
					new WorldGizmoLayer({
						id: `gizmo-${p.id}`,
						pose: p.pose,
						eye: p.eye,
						aspect: p.aspect,
						// small thumbnails: a full-size texture per frustum would cost ~16 MB each (the
						// BitmapLayer underneath takes any image source; the prop is typed for <img>)
						image:
							sel || !this.selected
								? ((this.thumbs.get(p.id) ?? null) as HTMLImageElement | null)
								: null,
						planeOpacity:
							p === this.flying ? w.photoPlaneOpacity : sel ? 0.95 : 0.8,
						lineColor: [...col, sel ? 255 : g < 1 ? 90 : 200],
						pinColor: [...col, 255],
						pinRadiusM: sel ? 26 : 16,
					}),
				);
			}
		// selection targets: always on top, sized in pixels
		const hover = this.hoverId;
		layers.push(
			new ScatterplotLayer<Placed>({
				id: "pins",
				data: this.placed.filter(
					(p) => this.gain(p.id) > 0 && !this.atCamera(p),
				),
				coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				getPosition: (p: Placed) => p.eye,
				getRadius: (p: Placed) =>
					p.id === this.selected ? 8 : p.id === hover ? 7 : 5,
				radiusUnits: "pixels",
				getFillColor: (p: Placed) => [
					...viewpointColor(p.photo.viewpoint),
					255,
				],
				getLineColor: [255, 255, 255, 230],
				lineWidthUnits: "pixels",
				getLineWidth: (p: Placed) =>
					p.id === this.selected || p.id === hover ? 2.5 : 1.2,
				stroked: true,
				billboard: true,
				extensions: [new LogDepthExtension()],
				parameters: { depthCompare: "always", depthWriteEnabled: false },
				updateTriggers: {
					getRadius: [this.selected, hover],
					getLineWidth: [this.selected, hover],
				},
			}),
		);
		this.deck.setProps({
			viewState: {
				world: w.viewState(new THREE.Vector3(target.x, target.y, target.z)),
			},
			layers,
		} as never);
	}
	// ---------------- picking ----------------

	private onDown = (e: PointerEvent) => {
		this.downAt = { x: e.clientX, y: e.clientY };
		this.setHover(null);
	};

	private onUp = (e: PointerEvent) => {
		const d = this.downAt;
		this.downAt = null;
		if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
		const id = this.pick(e.offsetX, e.offsetY);
		this.opts.onSelect?.(id);
	};

	private onMove = (e: PointerEvent) => {
		if (e.buttons || e.pointerType === "touch") return;
		const x = e.offsetX;
		const y = e.offsetY;
		cancelAnimationFrame(this.hoverRaf);
		this.hoverRaf = requestAnimationFrame(() => {
			const id = this.pick(x, y);
			this.setHover(id ? { id, x, y } : null);
		});
	};

	private onLeave = () => {
		cancelAnimationFrame(this.hoverRaf);
		this.setHover(null);
	};

	private setHover(h: RollMapHover | null) {
		const id = h?.id ?? null;
		if (id !== this.hoverId) {
			this.hoverId = id;
			this.canvas.style.cursor = id ? "pointer" : "";
			this.updateLayers();
		}
		this.opts.onHover?.(h);
	}

	/**
	 * A pin at (or right next to) the photographer's viewpoint the camera is in: the flown-into
	 * photo and others taken from the same spot. Their pins would sit on the lens.
	 */
	private atCamera(p: Placed) {
		return !!this.flying && dist3(p.eye, this.flying.eye) < 30;
	}

	/** Nearest photo pin within 14 px of a canvas point (CSS px). */
	pick(x: number, y: number): string | null {
		const vp = (
			this.deck as unknown as {
				getViewports(): { project(p: number[]): number[] }[];
			}
		).getViewports()[0];
		if (!vp) return null;
		let best: string | null = null;
		let bestD = 14;
		for (const p of this.placed) {
			if (this.gain(p.id) === 0 || this.atCamera(p)) continue;
			const [sx, sy, sz] = vp.project(p.eye);
			if (!(sz < 1)) continue;
			const dd = Math.hypot(sx - x, sy - y);
			if (dd < bestD) {
				bestD = dd;
				best = p.id;
			}
		}
		return best;
	}

	/** Test hook: the placed photos in the roll frame. */
	debugPlaced() {
		return this.placed.map((p) => ({ id: p.id, pose: p.pose, eye: p.eye }));
	}

	/** Test hook: drape state. */
	debugDrape() {
		const a = this.atlas;
		return a
			? {
					photos: a.ids.length,
					draped: a.ready.filter(Boolean).length,
					atlases: a.photo.map((t) => `${t.width}x${t.height}`),
					mb: Math.round(a.bytes / 2 ** 20),
				}
			: null;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		cancelAnimationFrame(this.hoverRaf);
		this.canvas.removeEventListener("pointerdown", this.onDown);
		this.canvas.removeEventListener("pointerup", this.onUp);
		this.canvas.removeEventListener("pointermove", this.onMove);
		this.canvas.removeEventListener("pointerleave", this.onLeave);
		this.loadAbort.abort();
		this.dropImagery();
		this.world.dispose();
		this.deck.finalize();
		this.atlas?.destroy();
		this.atlas = null;
		window.clearTimeout(this.atlasTimer);
		for (const b of [...this.thumbs.values(), ...this.pixels.values()])
			b.close();
		this.thumbs.clear();
		this.pixels.clear();
	}
}

const dist3 = (a: number[], b: number[]) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const IDLE_POSE: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 50 };

/** Range map size for a photo aspect (w/h): RANGE_LONG on the long side. */
function rangeSize(aspect: number) {
	return aspect >= 1
		? { w: RANGE_LONG, h: Math.round(RANGE_LONG / aspect) }
		: { w: Math.round(RANGE_LONG * aspect), h: RANGE_LONG };
}

/** A downscaled copy of an image (long side ≤ `long` px), decoded off the main thread. */
function scaled(img: HTMLImageElement | ImageBitmap, long: number) {
	const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
	const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
	const s = Math.min(1, long / Math.max(w, h));
	return createImageBitmap(img, {
		resizeWidth: Math.max(1, Math.round(w * s)),
		resizeHeight: Math.max(1, Math.round(h * s)),
		resizeQuality: "high",
	});
}
