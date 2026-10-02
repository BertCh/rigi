// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import photosJson from "virtual:photos";
import { concordOn } from "#/lib/concord/flags";
import { lensCorrectedVfov } from "#/lib/concord/priors/focal-table";
import { storageKey } from "#/lib/ontology/core/storage";
import type { Pose } from "./camera";
import type { LatLonPair, LonLatPair } from "./ontology/core/geometry";
import type { Height } from "./ontology/core/quantity";

export type PhotoMeta = {
	id: string;
	src: string;
	width: number;
	height: number;
	/** UTC ISO instant */
	takenAt: string;
	takenAtUtc?: string;
	/** photo's local UTC offset, e.g. "+02:00" */
	tzOffset?: string | null;
	lat: number;
	lon: number;
	/** GPS altitude, metres above mean sea level (EXIF GPSAltitude) */
	alt: Height<"msl"> | null;
	hAccuracy: number | null;
	heading: number | null;
	f35: number;
	vfov: number;
	/** EXIF Model / LensModel (absent in photos.json written before 2026-10-02): key the per-lens focal table. */
	model?: string | null;
	lensModel?: string | null;
	gravity: number[] | null;
	pitch: number;
	roll: number;
	holding: string | null;
	region: string;
};

export type RegionPeak = {
	name: string;
	lat: number;
	lon: number;
	/** metres above mean sea level (OSM `ele`) */
	ele: Height<"msl"> | null;
	prominence: number | null;
};
export type RegionTrail = {
	sac: string | null;
	name: string | null;
	coords: LonLatPair[];
};
export type RegionData = {
	id: string;
	center: LatLonPair;
	photos: string[];
	peaks: RegionPeak[];
	trails: RegionTrail[];
	waterNames: string[];
};

export const photos = photosJson as PhotoMeta[];

const localPhotos = new Map<string, PhotoMeta>();

const lensPrior = new WeakMap<PhotoMeta, PhotoMeta>();

/** The photo with its camera prior. ?concord=eye applies the per-lens focal table to vfov (a cached copy; the stored meta is untouched). */
export function getPhoto(id: string) {
	const p = localPhotos.get(id) ?? photos.find((q) => q.id === id);
	if (!p || !concordOn("eye")) return p;
	let q = lensPrior.get(p);
	if (!q) {
		q = { ...p, vfov: lensCorrectedVfov(p) };
		lensPrior.set(p, q);
	}
	return q;
}

/**
 * Make a user-uploaded photo openable at /photo/<meta.id> (ids like `local-<hash>`, src a blob:
 * URL). Its peaks/trails region is seeded under `meta.region` so loadRegion() resolves instantly.
 */
export function registerLocalPhoto(meta: PhotoMeta, region: RegionData | null) {
	localPhotos.set(meta.id, meta);
	if (region) regionCache.set(meta.region, Promise.resolve(region));
}

export function listLocalPhotos() {
	return [...localPhotos.values()];
}

const regionCache = new Map<string, Promise<RegionData>>();
export function loadRegion(id: string) {
	let p = regionCache.get(id);
	if (!p) {
		p = fetch(`/photos/${id}.json`).then((r) => {
			if (!r.ok) throw new Error(`region ${id}: HTTP ${r.status}`);
			return r.json() as Promise<RegionData>;
		});
		p.catch(() => {
			if (regionCache.get(id) === p) regionCache.delete(id);
		});
		regionCache.set(id, p);
	}
	return p;
}

const POSE_KEY = (id: string) => storageKey("savedPose", id);

/** A stored pose is only used when every angle is finite and the fov is a real lens; anything else
 * (e.g. a bench seeding an unlabelled ground-truth entry as `{yaw:null,…,vfov:180}`) is ignored. */
export function loadSavedPose(id: string): Pose | null {
	try {
		const raw = localStorage.getItem(POSE_KEY(id));
		const p = raw ? (JSON.parse(raw) as Partial<Pose> | null) : null;
		const ok =
			p != null &&
			[p.yaw, p.pitch, p.roll, p.vfov].every(Number.isFinite) &&
			(p.vfov as number) > 0 &&
			(p.vfov as number) < 180;
		return ok ? (p as Pose) : null;
	} catch {
		return null;
	}
}

export function savePose(id: string, pose: Pose | null) {
	try {
		if (pose) localStorage.setItem(POSE_KEY(id), JSON.stringify(pose));
		else localStorage.removeItem(POSE_KEY(id));
	} catch {
		// storage unavailable — pose just won't persist
	}
}

/** Rough place names for the gallery, keyed by region. */
export const regionNames: Record<string, string> = {
	"region-0": "Lake Thun · Niederhorn",
	"region-1": "Stoos · Mythen",
	"region-2": "Wasatch · Snowbird",
	"region-3": "Purcells · Panorama",
	"region-4": "Lake Tahoe · Palisades",
	"region-5": "Maine · Sunday River",
	"region-6": "La Palma · Roque de los Muchachos",
	"region-7": "White Mountains · Mt Washington",
};

/** Capture time in the photo's own local time (not the viewer's). The offset may be "+05:30" or EXIF's colon-less "+0530". */
export function formatTakenAt(p: PhotoMeta) {
	const d = new Date(p.takenAt);
	const m = p.tzOffset?.match(/([+-])(\d\d):?(\d\d)/);
	const offMin = m
		? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
		: 0;
	const local = new Date(d.getTime() + offMin * 60000);
	return local.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	});
}
