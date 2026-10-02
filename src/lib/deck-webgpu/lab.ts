// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// /lab/deck-webgpu: the foundation end to end. Streams the photo's DEM (deck/terrain-stream.ts,
// lite meshes), drapes imagery (deck/terrain-data.ts loadImagery → ImageryArray) and draws the
// terrain through the photo camera with the batched WGSL terrain core, then presents colour or a debug
// view of the geometry targets. Host: deck.gl on WebGPU, or the luma-direct host (?host=direct).
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { localElevRange } from "#/lib/deck/scene";
import {
	type ImagerySource,
	loadImagery,
	type TerrainSet,
} from "#/lib/deck/terrain-data";
import { TerrainStreamer } from "#/lib/deck/terrain-stream";
import { eyeAltitude } from "#/lib/geo/eye-rule";
import { priorHeading } from "#/lib/geocam/priors/heading";
import { EnuFrame } from "#/lib/geodesy";
import { getPhoto } from "#/lib/photos";
import { deckTerrainStyle } from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import {
	cameraUniforms,
	photoCamera,
	photoCameraModule,
	projectToPixel,
} from "./camera";
import { webgpuAvailable } from "./device";
import type { Host } from "./hosts/direct";
import type { CameraPose } from "./hosts/passes";
import { ImageryArray } from "./imagery";
import { createBatchedTerrain } from "./layers/batched-terrain";
import type { ModelCache } from "./pass";
import { PresentCore, type PresentMode } from "./present";
import { rangeOf, TextureReader } from "./readback";
import { DEFAULT_TERRAIN_LOOK, type TerrainShaderPart } from "./terrain";
import { fogFromLook } from "./wgsl";

export type LabSearch = {
	photo?: string;
	host?: "deck" | "direct";
	view?: PresentMode;
	imagery?: ImagerySource | "none";
	yaw?: number;
	pitch?: number;
	roll?: number;
	vfov?: number;
	/** Demo terrain plugin: 'footprint' tints what the photo camera sees (photoCam + geometry target). */
	plugin?: "footprint";
};

/**
 * A minimal TerrainShaderPart plugin that exercises the drape machinery: photo_uv / photo_range
 * (photoCameraModule) and an occlusion test against the geometry target — terrain seen from the
 * photo camera gets a faint checker, occluded terrain inside the frustum a magenta tint.
 */
function footprintPlugin(
	photoCam: () => ReturnType<typeof cameraUniforms>,
): TerrainShaderPart {
	return {
		key: "lab-footprint",
		modules: [photoCameraModule as never],
		wgsl: /* wgsl */ `\
@group(0) @binding(auto) var footprintGeo: texture_2d<f32>;
fn footprint_apply(c: vec4<f32>, s: TerrainSample) -> vec4<f32> {
  let p = photo_uv(s.enu);
  if (p.z <= 0.0 || any(p.xy <= vec2<f32>(0.0)) || any(p.xy >= vec2<f32>(1.0))) { return c; }
  let dims = vec2<f32>(textureDimensions(footprintGeo));
  let seen = textureLoad(footprintGeo, vec2<i32>(p.xy * dims), 0).w;
  let r = photo_range(s.enu);
  let visible = seen > 0.0 && r < seen * 1.015 + 15.0;
  let q = floor(p.xy * 32.0);
  let checker = f32((i32(q.x) + i32(q.y)) % 2);
  if (visible) { return vec4<f32>(mix(c.rgb, c.rgb * (0.85 + 0.3 * checker), 0.8), c.a); }
  return vec4<f32>(mix(c.rgb, vec3<f32>(1.0, 0.0, 1.0), 0.35), c.a);
}
`,
		apply: "footprint_apply",
		props: (ctx) => ({
			uniforms: { photoCam: photoCam() },
			bindings: ctx.geometry ? { footprintGeo: ctx.geometry.geometry } : {},
		}),
	};
}

type LabHook = {
	ready: boolean;
	host: string;
	error?: string;
	stats(): unknown;
	frame(scope?: "all" | "screen"): Promise<unknown>;
	setPose(p: Partial<Pose>): Promise<unknown>;
	setView(v: PresentMode): Promise<void>;
	/** Geometry readback + CPU re-projection check (camera math vs shader, row order). */
	checkGeometry(): Promise<unknown>;
};

declare global {
	interface Window {
		__deckWebgpuLab?: LabHook;
	}
}

export async function startLab(
	canvas: HTMLCanvasElement,
	search: LabSearch,
	setStatus: (s: string) => void,
): Promise<() => void> {
	const avail = await webgpuAvailable();
	if (!avail.ok) {
		setStatus(`WebGPU unavailable: ${avail.reason}`);
		window.__deckWebgpuLab = {
			ready: false,
			host: "none",
			error: avail.reason,
		} as LabHook;
		return () => {};
	}
	const photo = getPhoto(search.photo ?? "IMG_7086");
	if (!photo) throw new Error(`unknown photo ${search.photo}`);
	const t0 = performance.now();
	const aspect = photo.width / photo.height;
	let pose: Pose = {
		yaw: search.yaw ?? priorHeading(photo) ?? photo.heading ?? 0,
		pitch: search.pitch ?? photo.pitch ?? 0,
		roll: search.roll ?? photo.roll ?? 0,
		vfov: search.vfov ?? photo.vfov,
	};
	let eye: [number, number, number] = [0, 0, photo.alt ?? 2000];
	const cam = (): CameraPose => {
		const c = photoCamera({ pose, eye, width: 1, height: 1, near: 1 });
		return {
			eye: c.eye,
			forward: c.forward,
			up: c.up,
			vfov: c.vfov,
			near: c.near,
		};
	};

	const useDeck = search.host !== "direct";
	setStatus(`creating ${useDeck ? "deck" : "direct"} host…`);
	const host: Host = useDeck
		? await (await import("./hosts/deck")).DeckHost.create(canvas, cam())
		: await (await import("./hosts/direct")).DirectHost.create(canvas, cam());
	host.setPhotoAspect(aspect);
	host.device.lost.then((info) => {
		setStatus(`device lost: ${info.message}`);
	});

	const imagerySrc = search.imagery ?? "satellite";
	const imagery = imagerySrc === "none" ? null : new ImageryArray(host.device);
	const terrain = createBatchedTerrain(host.device, imagery);
	const present = new PresentCore();
	present.mode = search.view ?? "color";
	host.cores = [terrain, present];
	const look = deckTerrainStyle(CLASSIC, "replace");
	terrain.look = {
		...DEFAULT_TERRAIN_LOOK,
		style: imagery ? "imagery" : "hillshade",
		relief: look.relief,
		fog: fogFromLook(look),
	};

	if (search.plugin === "footprint")
		terrain.setShaderParts(null, [
			footprintPlugin(() =>
				cameraUniforms(
					photoCamera({
						pose,
						eye,
						width: host.geometry.width,
						height: host.geometry.height,
						near: 1,
					}),
				),
			),
		]);

	const frame = new EnuFrame(photo.lat, photo.lon, 0);
	const imgMap = new Map<string, ImageBitmap>();
	const imgAbort = new AbortController();
	let set: TerrainSet | null = null;
	let firstSetMs: number | null = null;
	let imageryLoading = false;
	const syncImagery = () => {
		if (!imagery || !set) return;
		imagery.sync(
			imgMap,
			set.tiles.map((t) => ({ id: t.id, distance: t.distance })),
		);
		terrain.syncImageryLayers();
	};
	if (imagery)
		imagery.onChange = () => {
			terrain.syncImageryLayers();
			host.requestRender();
		};
	const loadMissingImagery = () => {
		if (!imagery || !set || imageryLoading) return;
		const missing = set.tiles.filter((t) => !imgMap.has(t.id));
		if (!missing.length) return;
		imageryLoading = true;
		loadImagery(
			missing,
			imagerySrc as ImagerySource,
			(id, bmp) => {
				imgMap.set(id, bmp);
				syncImagery();
			},
			imgAbort.signal,
		).finally(() => {
			imageryLoading = false;
			if (!imgAbort.signal.aborted) loadMissingImagery();
		});
	};

	const streamer = new TerrainStreamer(frame, {
		onProgress: (d, t) => !set && setStatus(`terrain ${d}/${t}`),
		onUpdate: (s) => {
			const first = !set;
			set = s;
			if (first) {
				firstSetMs = performance.now() - t0;
				const dem = s.heightAt(photo.lat, photo.lon) ?? photo.alt ?? 0;
				eye = [0, 0, eyeAltitude(photo.alt, dem)];
				const er = localElevRange(s);
				terrain.look = { ...terrain.look, elevRange: er };
				host.photo = host.view = cam();
			}
			terrain.setTiles(s.tiles);
			syncImagery();
			loadMissingImagery();
			host.requestRender();
			setStatus(
				`${host.kind} host · ${s.tiles.length} tiles · ${s.stats?.pending ?? 0} pending`,
			);
			if (first) hook.ready = true;
		},
	});
	streamer.setWedge({
		headingDeg: pose.yaw,
		halfAngleDeg: Math.min(180, hfovFromAspect(pose.vfov, aspect) / 2 + 32),
	});

	const reader = new TextureReader(host.device);
	const hook: LabHook = {
		ready: false,
		host: host.kind,
		stats: () => ({
			host: host.kind,
			adapter: avail.adapter,
			photo: photo.id,
			pose,
			eye,
			firstSetMs,
			host_: host.stats,
			terrain: terrain.stats,
			imagery: imagery?.stats ?? null,
			geometry: [host.geometry.width, host.geometry.height],
			color: [host.color.width, host.color.height],
		}),
		frame: async (scope = "all") => {
			const t = performance.now();
			await host.nextFrame(scope);
			return { ms: performance.now() - t, ...host.stats };
		},
		setPose: async (p) => {
			pose = { ...pose, ...p };
			host.photo = host.view = cam();
			await host.nextFrame();
			return pose;
		},
		setView: async (v) => {
			present.mode = v;
			await host.nextFrame("screen");
		},
		checkGeometry: async () => {
			await host.nextFrame();
			const g = host.geometry;
			const data = await reader.read(g.geometry);
			if (!data) return null;
			const range = rangeOf(data);
			const u = cameraUniforms(
				photoCamera({ pose, eye, width: g.width, height: g.height, near: 1 }),
			);
			// re-project stored ENU points; they must land on their own pixel centres
			let n = 0;
			let sky = 0;
			let maxErr = 0;
			let sumErr = 0;
			let minR = Infinity;
			let maxR = 0;
			for (let y = 0; y < g.height; y += 7)
				for (let x = 0; x < g.width; x += 7) {
					const i = y * g.width + x;
					if (range[i] <= 0) {
						sky++;
						continue;
					}
					const p = projectToPixel(u, [
						data[i * 4],
						data[i * 4 + 1],
						data[i * 4 + 2],
					]);
					if (!p) continue;
					const e = Math.hypot(p.x - (x + 0.5), p.y - (y + 0.5));
					maxErr = Math.max(maxErr, e);
					sumErr += e;
					n++;
					minR = Math.min(minR, range[i]);
					maxR = Math.max(maxR, range[i]);
				}
			return {
				size: [g.width, g.height],
				samples: n,
				skySamples: sky,
				meanErrPx: n ? sumErr / n : null,
				maxErrPx: maxErr,
				rangeM: [minR, maxR],
				topRowSky: range.slice(0, g.width).every((r) => r <= 0),
			};
		},
	};
	window.__deckWebgpuLab = hook;
	// debugging handles (not API). bindings(key) / wgsl(key): luma's binding debug table / the
	// assembled WGSL of every cached model whose "<core id>/<ModelCache key>" contains `key`
	// (e.g. "color|" for the terrain colour pipelines); diffing wgsl() between ?host=deck and
	// ?host=direct shows whether both hosts assemble the same program.
	const cachedModels = (key: string) =>
		[terrain, present].flatMap((core) =>
			(core as unknown as { models: ModelCache }).models
				.entries()
				.map(([k, m]) => [`${core.id}/${k}`, m] as const)
				.filter(([k]) => k.includes(key)),
		);
	(hook as unknown as { _debug: unknown })._debug = {
		host,
		terrain,
		imagery,
		present,
		bindings: (key = "") =>
			Object.fromEntries(
				cachedModels(key).map(([k, m]) => [k, m.getBindingDebugTable()]),
			),
		wgsl: (key = "") =>
			Object.fromEntries(cachedModels(key).map(([k, m]) => [k, m.source])),
	};
	host.requestRender();

	return () => {
		imgAbort.abort();
		streamer.dispose();
		reader.destroy();
		imagery?.destroy();
		host.destroy();
		for (const b of imgMap.values()) b.close();
	};
}
