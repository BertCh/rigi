// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tiles3DSet: the 3D Tiles sources of one photo (config.ts), streamed by 3d-tiles-renderer around the
// Step Inside eye and placed in the photo's ENU frame (frame.ts, geoid.ts). Both engines use it:
//   · three (engine.ts): `group` joins the scene on TILES3D_LAYER (only the step camera enables it),
//     update(worldCam) each step frame
//   · deck (deck/engine.ts): the same set is driven by the world camera (a THREE camera) and
//     deck-layer.ts draws its visible meshes; one tile selector for both engines = identical tiles
// Google tiles are display-only: nothing here reads their geometry back (no raycast, no stats of
// heights), and the browser's HTTP cache is the only cache (no service worker / IndexedDB).

import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import {
	GLTFExtensionsPlugin,
	UnloadTilesPlugin,
} from "3d-tiles-renderer/plugins";
import { TilesRenderer } from "3d-tiles-renderer/three";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { getFlag } from "#/lib/flags";
import {
	googleTilesKey,
	TILES3D_LAYER,
	TILES3D_SOURCES,
	type Tiles3DConfig,
	type Tiles3DSource,
	type Tiles3DSourceId,
} from "./config";
import { enuFromEcef } from "./frame";
import { geoidUndulation } from "./geoid";
import {
	makeTileMaterial,
	makeTileSharedUniforms,
	type TileSharedUniforms,
} from "./material";

/** Culls tiles whose bounding volume lies beyond `radius` of an ECEF point (tile frame = ECEF). */
class NearFieldMaskPlugin {
	name = "RIGI_NEARFIELD_MASK";
	constructor(
		public center: THREE.Vector3,
		public radius: number,
	) {}
	calculateTileViewError(
		tile: {
			engineData: {
				boundingVolume: { distanceToPoint(p: THREE.Vector3): number };
			};
		},
		target: { inView: boolean },
	) {
		if (
			tile.engineData.boundingVolume.distanceToPoint(this.center) > this.radius
		) {
			target.inView = false;
			return true;
		}
		return false;
	}
}

let draco: DRACOLoader | null = null;
function dracoLoader(): DRACOLoader {
	if (!draco) {
		draco = new DRACOLoader();
		const base =
			(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
		draco.setDecoderPath(`${base}tiles3d/draco/`);
	}
	return draco;
}

type Layer = { source: Tiles3DSource; tiles: TilesRenderer };

export type Tiles3DStats = {
	source: Tiles3DSourceId;
	visible: number;
	loading: number;
	failed: number;
	bytes: number;
}[];

export class Tiles3DSet {
	/** Parent of every source's TilesRenderer group (identity; the groups carry ENU←ECEF). */
	readonly group = new THREE.Group();
	readonly uniforms: TileSharedUniforms;
	readonly config: Tiles3DConfig;
	/** EGM2008 N at the photo (m); applied only to "ellipsoidal" sources (config.ts heights). */
	readonly geoidN: number;
	private at: { lat: number; lon: number; eye: THREE.Vector3 };
	private layers: Layer[] = [];
	private disposed = false;
	/** Bumps whenever the visible meshes change (deck-layer.ts redraw key). */
	version = 0;
	/** Called when a tile loads, unloads or changes visibility: render another frame. */
	onChange?: () => void;
	/** Per-mesh cleanup hooks (deck-layer.ts frees its GPU copies). */
	readonly onDisposeMesh = new Set<(m: THREE.Mesh) => void>();

	constructor(
		config: Tiles3DConfig,
		at: { lat: number; lon: number; eye: THREE.Vector3 },
		uniforms: Partial<TileSharedUniforms> = {},
	) {
		this.config = config;
		this.uniforms = { ...makeTileSharedUniforms(), ...uniforms };
		this.uniforms.uEye.value.copy(at.eye);
		this.uniforms.uFade.value.set(config.fadeStart, config.radius);
		// ?tiles3dGeoid=<m>: override N (datum debugging)
		this.geoidN = getFlag("tiles3dGeoid") ?? geoidUndulation(at.lat, at.lon);
		this.at = { lat: at.lat, lon: at.lon, eye: at.eye.clone() };
		this.group.name = "tiles3d";
		this.group.layers.set(TILES3D_LAYER);
		for (const id of config.sources) this.addSource(TILES3D_SOURCES[id]);
	}

	private addSource(source: Tiles3DSource) {
		const tiles = new TilesRenderer(
			source.id === "google" ? undefined : source.url,
		);
		if (source.id === "google") {
			const key = googleTilesKey();
			if (!key) return;
			tiles.registerPlugin(
				new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }),
			);
		}
		tiles.registerPlugin(
			new GLTFExtensionsPlugin({ dracoLoader: dracoLoader(), rtc: true }),
		);
		tiles.registerPlugin(new UnloadTilesPlugin({ delay: 2000 }));
		const m = enuFromEcef(
			this.at.lat,
			this.at.lon,
			source.heights === "ellipsoidal" ? this.geoidN : 0,
		);
		const maskCenter = this.at.eye.clone().applyMatrix4(m.clone().invert());
		tiles.registerPlugin(
			new NearFieldMaskPlugin(maskCenter, this.config.radius),
		);
		tiles.errorTarget = source.errorTarget;
		// a smaller cache than the 0.4 GB default: the mask keeps the working set to a few km
		tiles.lruCache.maxBytesSize = 0.25 * 2 ** 30;
		tiles.lruCache.minBytesSize = 0.18 * 2 ** 30;
		tiles.group.matrixAutoUpdate = false;
		tiles.group.matrix.copy(m);
		tiles.group.matrixWorldNeedsUpdate = true;
		tiles.group.layers.set(TILES3D_LAYER);
		const changed = () => {
			this.version++;
			this.onChange?.();
		};
		tiles.addEventListener("load-model", (e) => {
			this.prepareModel(e.scene as THREE.Object3D, source);
			changed();
		});
		tiles.addEventListener("dispose-model", (e) => {
			this.disposeModel(e.scene as THREE.Object3D);
			changed();
		});
		tiles.addEventListener("tile-visibility-change", changed);
		tiles.addEventListener("needs-update", () => this.onChange?.());
		tiles.addEventListener("load-error", (e) =>
			console.warn(`[tiles3d] ${source.id}: ${String(e.error)}`),
		);
		this.group.add(tiles.group);
		this.layers.push({ source, tiles });
	}

	/** Swap the glTF materials for the tile material (material.ts), keep only what we draw. */
	private prepareModel(scene: THREE.Object3D, source: Tiles3DSource) {
		scene.traverse((o) => {
			o.layers.set(TILES3D_LAYER);
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh) return;
			const old = mesh.material as
				| THREE.MeshBasicMaterial
				| THREE.MeshStandardMaterial;
			const map = (Array.isArray(old) ? old[0] : old)?.map ?? null;
			const c = (Array.isArray(old) ? old[0] : old)?.color;
			const color: [number, number, number] =
				c && !map && !(c.r === 1 && c.g === 1 && c.b === 1)
					? [c.r, c.g, c.b]
					: source.fallbackColor;
			mesh.material = makeTileMaterial(this.uniforms, {
				map,
				color,
				vertexColors: !!mesh.geometry.attributes.color,
				depthBias: this.depthBias(source),
			});
			mesh.userData.tiles3dSource = source.id;
			for (const m of Array.isArray(old) ? old : [old]) m?.dispose();
		});
	}

	private disposeModel(scene: THREE.Object3D) {
		scene.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh) return;
			for (const f of this.onDisposeMesh) f(mesh);
			const m = mesh.material as THREE.ShaderMaterial;
			if (m?.name === "tiles3d") {
				(m.uniforms.uMap.value as THREE.Texture | null)?.dispose();
				m.dispose();
			}
		});
	}

	/** Point every source at the camera and refine. Call once per rendered step frame. */
	update(camera: THREE.PerspectiveCamera, width: number, height: number) {
		if (this.disposed) return;
		camera.updateMatrixWorld();
		this.group.updateMatrixWorld(true);
		for (const { tiles } of this.layers) {
			if (!tiles.hasCamera(camera)) tiles.setCamera(camera);
			tiles.setResolution(camera, width, height);
			tiles.update();
		}
	}

	/** Visible tile meshes, world (ENU) matrices current (deck-layer.ts). */
	visibleMeshes(): { mesh: THREE.Mesh; source: Tiles3DSource }[] {
		const out: { mesh: THREE.Mesh; source: Tiles3DSource }[] = [];
		this.group.updateMatrixWorld(true);
		if (!this.group.visible) return out;
		for (const { tiles, source } of this.layers) {
			if (!tiles.group.visible) continue;
			for (const scene of tiles.group.children)
				scene.traverse((o) => {
					const mesh = o as THREE.Mesh;
					if (mesh.isMesh && mesh.visible) out.push({ mesh, source });
				});
		}
		return out;
	}

	/** The source's log-depth bias; ?tiles3dBias=<w scale> overrides it (tuning). */
	private depthBias(source: Tiles3DSource) {
		return getFlag("tiles3dBias") ?? source.depthBias;
	}

	/** Show / hide one source (Truth view and exports hide Google). */
	setSourceVisible(id: Tiles3DSourceId, visible: boolean) {
		for (const l of this.layers)
			if (l.source.id === id) l.tiles.group.visible = visible;
	}

	get hasGoogle() {
		return this.layers.some((l) => l.source.id === "google");
	}

	/** On-screen credit line: static source credits, then Google's per-tile copyrights by occurrence. */
	attributions(): string {
		const parts = this.layers
			.filter((l) => l.source.id !== "google")
			.map((l) => l.source.credit);
		const google = this.layers.find((l) => l.source.id === "google");
		if (google) {
			// GoogleCloudAuthPlugin counts asset.copyright over the visible tiles, sorted by occurrence
			const g = google.tiles
				.getAttributions()
				.filter((a) => a.type === "string" && a.value)
				.map((a) => String(a.value));
			const line = g.join("; ");
			parts.unshift(
				/\bGoogle\b/.test(line) ? line : line ? `Google · ${line}` : "Google",
			);
		}
		return parts.join(" · ");
	}

	stats(): Tiles3DStats {
		return this.layers.map(({ source, tiles }) => {
			const s =
				(tiles as unknown as { stats?: Record<string, number> }).stats ?? {};
			return {
				source: source.id,
				visible: tiles.visibleTiles.size,
				loading: (s.downloading ?? 0) + (s.parsing ?? 0),
				failed: s.failed ?? 0,
				bytes:
					(tiles.lruCache as unknown as { cachedBytes?: number }).cachedBytes ??
					0,
			};
		});
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const { tiles } of this.layers) tiles.dispose();
		this.layers = [];
		this.group.removeFromParent();
		this.onChange = undefined;
	}
}
