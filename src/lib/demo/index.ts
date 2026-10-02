// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { wrap360 } from "#/lib/geodesy";
import { publicUrl } from "#/lib/public-url";
// The bundled sample trip (public/demo/, built by scripts/demo/unpack.mjs from an exported upload
// roll). Its photos are registered with photos.ts like uploads, so /photo/demo-NN and /roll/demo use
// the normal workspace and roll code. Each photo ships the pose the roll aligner found on the
// author's device; the user's own saved pose still wins.
import type { Pose } from "../camera";
import {
	type PhotoMeta,
	type RegionData,
	regionNames,
	registerLocalPhoto,
} from "../photos";
import type { PoseSource, Roll } from "../roll/types";

export const DEMO_ROLL_ID = "demo";
export const DEMO_PREFIX = "demo-";
export const isDemoPhotoId = (id: string) => id.startsWith(DEMO_PREFIX);

export type DemoPose = {
	pose: Pose;
	source: Exclude<PoseSource, "prior">;
	confidence: number | null;
};

export type DemoManifest = {
	name: string;
	/** One line under the name, e.g. the place and date. */
	place: string;
	photos: (PhotoMeta & { thumb: string })[];
	poses: Record<string, DemoPose>;
	region: RegionData;
};

let core: Promise<DemoManifest> | null = null;
let full: Promise<DemoManifest> | null = null;

/**
 * The manifest without the region's trails (public/demo/manifest.json, ≈ 0.24 MB; the trails are
 * public/demo/trails.json, ≈ 2.7 MB): photos, poses, peaks. Registers the photos with photos.ts but
 * not the region, so loadRegion() never sees a region without its trails; loadDemo() registers it.
 * For views that draw no trails (the landing's panorama, topo board and live map).
 */
export function loadDemoCore(): Promise<DemoManifest> {
	core ??= fetch(publicUrl("/demo/manifest.json"))
		.then((r) => {
			if (!r.ok) throw new Error(`demo manifest: HTTP ${r.status}`);
			return r.json() as Promise<
				Omit<DemoManifest, "region"> & {
					region: Omit<RegionData, "trails"> & {
						trails?: RegionData["trails"];
					};
				}
			>;
		})
		.then((m): DemoManifest => {
			regionNames[m.region.id] = m.name;
			for (const p of m.photos) registerLocalPhoto(p, null);
			return { ...m, region: { ...m.region, trails: m.region.trails ?? [] } };
		})
		.catch((e) => {
			core = null;
			throw e;
		});
	return core;
}

/** Fetch the manifest and the trails once and register every photo (and the shared region) with photos.ts. */
export function loadDemo(): Promise<DemoManifest> {
	full ??= Promise.all([
		loadDemoCore(),
		fetch(publicUrl("/demo/trails.json")).then((r) => {
			if (!r.ok) throw new Error(`demo trails: HTTP ${r.status}`);
			return r.json() as Promise<RegionData["trails"]>;
		}),
	])
		.then(([m, trails]) => {
			const region: RegionData = { ...m.region, trails };
			for (const p of m.photos) registerLocalPhoto(p, region);
			return { ...m, region };
		})
		.catch((e) => {
			full = null;
			throw e;
		});
	return full;
}

/** The bundled pose for a demo photo (null for any other id, or before loadDemo). */
export async function demoPose(id: string): Promise<Pose | null> {
	if (!isDemoPhotoId(id)) return null;
	return (await loadDemo()).poses[id]?.pose ?? null;
}

/** The sample trip's panorama terrain, baked by scripts/demo/bake-pano-terrain.ts (by terrainKey). */
const PANO_BASE = publicUrl("/demo/pano");
let panoIndex: Promise<Record<string, string>> | null = null;
function bakedTerrainIndex() {
	panoIndex ??= fetch(`${PANO_BASE}/index.json`)
		.then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
		.catch(() => ({}));
	return panoIndex;
}

/** Long side (px) of the landing's photo copies (public/demo/photos-1024, from scripts/demo/unpack.mjs). */
export const DEMO_SMALL_LONG = 1024;

export type DemoRollOptions = {
	/** The core manifest (loadDemoCore: no trails, region not registered). Landing only. */
	core?: boolean;
	/**
	 * Landing only: point photos' `src` at their 1024 px copies. `true` = every photo (the 3D map,
	 * whose working copies are 1024 px anyway). A function = the device px per degree the built roll
	 * will be shown at (e.g. panoramaPxPerDeg): a photo takes its copy only when the copy's texel
	 * density at its centre is at least that, so the on-screen sharpness never drops (the wide 0.5× shots keep the full size on
	 * a 2× screen). width/height, and so every layout, stay the originals'; the registered metas
	 * (photos.ts, /photo/demo-NN) keep the full-size src. /roll/demo passes nothing.
	 */
	smallPhotos?: true | ((roll: Roll) => number);
};

/** PanoramaStrip's fit() pad around the photos' azimuth span. */
const PANO_FIT_PAD = 1.06;

/**
 * Device px per degree of a full-width fitted PanoramaStrip of `roll` that is `deviceWidth` px wide:
 * fit() spreads the photos' azimuth span (×1.06) over the width. The span is measured from the
 * yaw ± half the horizontal fov of each photo, a lower bound of the meshes' extent (so an upper
 * bound of the density).
 */
export function panoramaPxPerDeg(roll: Roll, deviceWidth: number): number {
	const covered = new Uint8Array(720);
	for (const p of roll.photos) {
		const half = horizontalFovDeg(p.meta, p.pose.vfov) / 2;
		for (let k = 0; k < 720; k++) {
			const d = wrap360(k / 2 - p.pose.yaw + 540) - 180;
			if (Math.abs(d) <= half) covered[k] = 1;
		}
	}
	let gap = 0;
	let run = 0;
	for (let k = 0; k < 1440; k++) {
		run = covered[k % 720] ? 0 : run + 1;
		gap = Math.max(gap, run);
	}
	const span = Math.max(1, 360 - Math.min(gap, 720) / 2);
	return deviceWidth / Math.min(360, span * PANO_FIT_PAD);
}

function horizontalFovDeg(meta: PhotoMeta, vfov: number) {
	const t = Math.tan((vfov * Math.PI) / 360) * (meta.width / meta.height);
	return (360 / Math.PI) * Math.atan(t);
}

/** Texels per degree at the centre of a photo's 1024 px copy (pinhole: the focal length in px). */
function smallCopyPxPerDeg(meta: PhotoMeta, vfov: number) {
	const heightPx =
		(meta.height * DEMO_SMALL_LONG) / Math.max(meta.width, meta.height);
	return (heightPx / 2 / Math.tan((vfov * Math.PI) / 360)) * (Math.PI / 180);
}

/** The sample trip as a roll. Photos the user has not touched take the bundled pose. */
export async function loadDemoRoll(opts: DemoRollOptions = {}): Promise<Roll> {
	const [m, { makeRoll }, { setBakedTerrain }, { decodeTerrain }] =
		await Promise.all([
			opts.core ? loadDemoCore() : loadDemo(),
			import("../roll/roll"),
			import("../roll/mosaic/viewpointTerrain"),
			import("../roll/mosaic/terrainCodec"),
		]);
	setBakedTerrain(async (key) => {
		const file = (await bakedTerrainIndex())[key];
		if (!file) return null;
		const r = await fetch(`${PANO_BASE}/${file}`);
		return r.ok ? decodeTerrain(await r.arrayBuffer()) : null;
	});
	// copies of the metas: the registered ones (photos.ts) keep the full-size src
	const metas = opts.smallPhotos ? m.photos.map((p) => ({ ...p })) : m.photos;
	const roll = makeRoll(DEMO_ROLL_ID, m.name, metas, m.region.id);
	for (const p of roll.photos) {
		const b = m.poses[p.meta.id];
		if (!b || p.poseSource === "saved") continue;
		p.pose = b.pose;
		p.poseSource = b.source;
		p.confidence = b.confidence;
	}
	const need =
		typeof opts.smallPhotos === "function"
			? opts.smallPhotos(roll)
			: opts.smallPhotos;
	if (need)
		for (const p of roll.photos)
			if (need === true || smallCopyPxPerDeg(p.meta, p.pose.vfov) >= need)
				p.meta.src = publicUrl(
					`/demo/photos-${DEMO_SMALL_LONG}/${p.meta.id}.jpg`,
				);
	return roll;
}
