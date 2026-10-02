// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tiles3DSet: the 3D Tiles sources of one photo (config.ts), streamed by @loaders.gl/tiles' Tileset3D
// (the traversal deck's Tile3DLayer uses) around the Step Inside eye and placed in the photo's ENU frame
// (frame.ts, geoid.ts). Both deck engines use it: DeckTiles3D.update(view) refines every source from the
// world camera (viewport.ts), and the layers (deck-layer.ts, deck-webgpu/layers/tiles3d.ts) draw
// visibleMeshes(), plain typed arrays (content.ts), never renderer objects.
// Google tiles are display-only: nothing here reads their geometry back (no raycast, no stats of
// heights), and the browser's HTTP cache is the only cache (no service worker / IndexedDB).
//   · near-field mask: the viewport's far plane is the near-field radius (viewport.ts), so traversal
//     culls (and never downloads) tiles beyond it
//   · unload policy: Tileset3D's byte cache (0.18 GB soft target + 0.07 GB headroom, as the old LRU)
//   · Google auth: the key rides on the root URL; loaders.gl's Tiles3DSource copies it and the
//     session token onto every tile and subtree request

import { Tiles3DLoader } from "@loaders.gl/3d-tiles/bundled";
import { coreApi } from "@loaders.gl/core";
import {
	Tiles3DSource as LoadersTiles3DSource,
	Tileset3D,
} from "@loaders.gl/tiles";
import type { Matrix4 } from "@math.gl/core";
import { getFlag } from "#/lib/flags";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { publicBase } from "#/lib/public-url";
import {
	googleTilesKey,
	TILES3D_SOURCES,
	type Tiles3DConfig,
	type Tiles3DSource,
	type Tiles3DSourceId,
} from "./config";
import {
	releaseImage,
	type TileContentLike,
	type TileMesh,
	tileMeshesFromContent,
} from "./content";
import { enuFromEcef } from "./frame";
import { geoidUndulation } from "./geoid";
import { makeTileSharedUniforms, type TileSharedUniforms } from "./material";
import { EnuViewport, type StepView } from "./viewport";

/** The loaders.gl Tile3D fields read here. */
type TileRef = {
	id: string;
	type?: string;
	content?: (TileContentLike & Record<string, unknown>) | null;
	computedTransform?: ArrayLike<number>;
	contentReady?: boolean;
};

/** Draco decoder files the loaders fetch (public/tiles3d/draco, both decoder profiles). */
export function dracoModules(base: string): Record<string, string> {
	const dir = `${base}tiles3d/draco/`;
	return {
		"draco_wasm_wrapper.js": `${dir}draco_wasm_wrapper.js`,
		"draco_decoder.wasm": `${dir}draco_decoder.wasm`,
		"draco_wasm_wrapper_gltf.js": `${dir}draco_wasm_wrapper.js`,
		"draco_decoder_gltf.wasm": `${dir}draco_decoder.wasm`,
	};
}

/** `reference` resolved against the tile being loaded; a failed parse leaves it as is. */
function resolveAgainst(reference: string, tileUrl: string): string {
	try {
		return new URL(reference, new URL(tileUrl, globalThis.location?.href)).href;
	} catch {
		return reference;
	}
}

/**
 * loaders.gl's core API with a per-load fetch that resolves relative references against the tile's own URL:
 * an i3dm names its model by a relative URI ("../../Tree-1.glb", swisstopo vegetation), and the loader
 * fetches it as written.
 */
export const tileCoreApi = {
	...coreApi,
	load: (
		url: string,
		loader: unknown,
		options: Record<string, unknown> | undefined,
		context: unknown,
	) =>
		(coreApi.load as (...a: unknown[]) => Promise<unknown>)(
			url,
			loader,
			{
				...options,
				core: {
					...(options?.core as Record<string, unknown> | undefined),
					fetch: (reference: string, init?: object) =>
						globalThis.fetch(
							resolveAgainst(String(reference), url),
							// the loader hands its core options as `init` for model files: not a RequestInit
							init && !("fetch" in init) ? (init as RequestInit) : undefined,
						),
				},
			},
			context,
		),
};

/** The app's base URL, absolute when there is a page: a Draco worker resolves `modules` against its own URL. */
function baseUrl(): string {
	const base = publicBase();
	const page = globalThis.location?.href;
	return page ? new URL(base, page).href : base;
}

type Layer = {
	source: Tiles3DSource;
	tileset: Tileset3D;
	/** ENU ← ECEF with the source's geoid lowering. */
	placement: Matrix4;
	meshes: Map<TileRef, TileMesh[]>;
	visible: boolean;
	failed: number;
	/** Selection signature of the last traversal (a change bumps `version`). */
	selectionKey: string;
	/** Pose signature of the last update() (an unchanged pose skips traversal once loaded). */
	poseKey: string;
};

export type Tiles3DStats = {
	source: Tiles3DSourceId;
	visible: number;
	loading: number;
	failed: number;
	bytes: number;
}[];

export type Tiles3DOptions = {
	/** Merged over the default load options (deck-tiles.ts: the Draco worker; tests, offline). */
	loadOptions?: Record<string, unknown>;
	/** Test hook: builds the Tileset3D of a source instead of loading its URL. */
	createTileset?: (source: Tiles3DSource, url: string) => Tileset3D;
};

export class Tiles3DSet {
	readonly uniforms: TileSharedUniforms;
	readonly config: Tiles3DConfig;
	/** EGM2008 N at the photo (m); applied only to "ellipsoidal" sources (config.ts heights). */
	readonly geoidN: number;
	private at: { lat: number; lon: number; eye: Vec3 };
	private layers: Layer[] = [];
	private disposed = false;
	private readonly options: Tiles3DOptions;
	/** Bumps whenever the visible meshes change (deck-layer.ts redraw key). */
	version = 0;
	/** Called when a tile loads, unloads or changes visibility: render another frame. */
	onChange?: () => void;
	/** Per-mesh cleanup hooks (the layers free their GPU copies). */
	readonly onDisposeMesh = new Set<(m: TileMesh) => void>();

	constructor(
		config: Tiles3DConfig,
		at: { lat: number; lon: number; eye: Vec3 },
		uniforms: Partial<TileSharedUniforms> = {},
		options: Tiles3DOptions = {},
	) {
		this.config = config;
		this.options = options;
		this.uniforms = { ...makeTileSharedUniforms(), ...uniforms };
		this.uniforms.eye = [...at.eye];
		this.uniforms.fade = [config.fadeStart, config.radius];
		this.geoidN = geoidUndulation(at.lat, at.lon);
		this.at = { lat: at.lat, lon: at.lon, eye: [...at.eye] };
		for (const id of config.sources) this.addSource(TILES3D_SOURCES[id]);
	}

	private addSource(source: Tiles3DSource) {
		let url = source.url;
		if (source.id === "google") {
			const key = googleTilesKey();
			if (!key) return;
			url = `${url}?key=${encodeURIComponent(key)}`;
		}
		const placement = enuFromEcef(
			this.at.lat,
			this.at.lon,
			source.heights === "ellipsoidal" ? this.geoidN : 0,
		);
		const layer: Layer = {
			source,
			tileset: null as unknown as Tileset3D,
			placement,
			meshes: new Map(),
			visible: true,
			failed: 0,
			selectionKey: "",
			poseKey: "",
		};
		const changed = () => {
			this.version++;
			this.onChange?.();
		};
		const props = {
			maximumScreenSpaceError: source.errorTarget,
			// a smaller cache than the 0.5 GB default: the far plane keeps the working set to a few km
			cacheBytes: 0.18 * 2 ** 30,
			maximumCacheOverflowBytes: 0.07 * 2 ** 30,
			onTileLoad: (tile: TileRef) => {
				this.prepareTile(layer, tile);
				changed();
				// refine again with the same viewport now that this tile's content is in
				layer.tileset?.update();
			},
			onTileUnload: (tile: TileRef) => {
				this.disposeTile(layer, tile);
				changed();
			},
			onTileError: (_tile: TileRef, message: string, tileUrl: string) => {
				layer.failed++;
				console.warn(`[tiles3d] ${source.id}: ${message} ${tileUrl ?? ""}`);
			},
			onTraversalComplete: (selected: TileRef[]) => {
				const key = selected.map((t) => t.id).join("|");
				if (key !== layer.selectionKey) {
					layer.selectionKey = key;
					changed();
				}
				return selected;
			},
			onTilesetError: (error: Error) =>
				console.warn(`[tiles3d] ${source.id}: ${String(error)}`),
		};
		layer.tileset =
			this.options.createTileset?.(source, url) ??
			new Tileset3D(
				new LoadersTiles3DSource(
					{
						url,
						loader: Tiles3DLoader as never,
						coreApi: tileCoreApi as never,
					},
					{
						"3d-tiles": { loadGLTF: true, decodeQuantizedPositions: true },
						gltf: { loadImages: true, decompressMeshes: true },
						modules: dracoModules(baseUrl()),
						...this.options.loadOptions,
					} as never,
				) as never,
				props as never,
			);
		this.layers.push(layer);
	}

	/** glTF content → TileMeshes (once per load), keyed by tile. */
	private prepareTile(layer: Layer, tile: TileRef) {
		if (tile.type !== "scenegraph" || !tile.content) return;
		layer.meshes.set(
			tile,
			tileMeshesFromContent(
				tile.content,
				layer.placement,
				layer.source,
				this.depthBias(layer.source),
				tile.computedTransform,
			),
		);
	}

	private disposeTile(layer: Layer, tile: TileRef) {
		const meshes = layer.meshes.get(tile);
		if (!meshes) return;
		layer.meshes.delete(tile);
		for (const m of meshes) {
			for (const f of this.onDisposeMesh) f(m);
			releaseImage(m.image);
		}
	}

	/** Point every source at the camera and refine. Call once per rendered step frame. */
	update(view: StepView, width: number, height: number) {
		if (this.disposed) return;
		// quantised pose: an unchanged camera need not re-traverse once everything is in
		const poseKey = [
			...view.position,
			...Array.from(view.viewMatrix).slice(0, 12),
			view.fovY,
			width,
			height,
		]
			.map((v) => Math.round(v * 1e3))
			.join(",");
		const eye = this.uniforms.eye;
		const cam = view.position;
		const far =
			this.config.radius +
			Math.hypot(cam[0] - eye[0], cam[1] - eye[1], cam[2] - eye[2]);
		for (const layer of this.layers) {
			if (layer.poseKey === poseKey && layer.tileset.isLoaded()) continue;
			layer.poseKey = poseKey;
			layer.tileset.update(
				new EnuViewport({
					id: "step",
					view,
					width,
					height,
					enuFromEcef: layer.placement,
					far,
					origin: this.at,
				}) as never,
			);
		}
	}

	/** Visible tile meshes (ENU matrices current): the selected tiles of every shown source. */
	visibleMeshes(): TileMesh[] {
		const out: TileMesh[] = [];
		for (const layer of this.layers) {
			if (!layer.visible) continue;
			for (const tile of layer.tileset.selectedTiles as unknown as TileRef[]) {
				const meshes = layer.meshes.get(tile);
				if (meshes) out.push(...meshes);
			}
		}
		return out;
	}

	/** The source's log-depth bias; ?tiles3dBias=<w scale> overrides it (tuning). */
	private depthBias(source: Tiles3DSource) {
		return getFlag("tiles3dBias") ?? source.depthBias;
	}

	/** Show / hide one source (Truth view and exports hide Google). */
	setSourceVisible(id: Tiles3DSourceId, visible: boolean) {
		for (const l of this.layers) if (l.source.id === id) l.visible = visible;
		this.version++;
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
			const line = googleCopyrights(
				google.tileset.selectedTiles as unknown as TileRef[],
			).join("; ");
			parts.unshift(
				/\bGoogle\b/.test(line) ? line : line ? `Google · ${line}` : "Google",
			);
		}
		return parts.join(" · ");
	}

	stats(): Tiles3DStats {
		return this.layers.map(({ source, tileset, failed }) => ({
			source: source.id,
			visible: tileset.selectedTiles.length,
			loading: (tileset.requestedTiles as unknown as TileRef[]).filter(
				(t) => !t.contentReady,
			).length,
			failed,
			bytes: tileset.gpuMemoryUsageInBytes ?? 0,
		}));
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const layer of this.layers) {
			for (const tile of [...layer.meshes.keys()])
				this.disposeTile(layer, tile);
			layer.tileset.destroy();
		}
		this.layers = [];
		this.onChange = undefined;
	}
}

/**
 * Google's per-tile copyright strings (glTF asset.copyright, ";"-separated holders), most frequent
 * first (ties by first appearance): the order the Map Tiles policy lists them.
 */
export function googleCopyrights(tiles: TileRef[]): string[] {
	const counts = new Map<string, number>();
	for (const t of tiles) {
		const copyright = t.content?.gltf?.asset?.copyright;
		if (!copyright) continue;
		for (const holder of copyright.split(";")) {
			const name = holder.trim();
			if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}
