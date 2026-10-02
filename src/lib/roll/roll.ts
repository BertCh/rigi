// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera roll → rolls: group photos into areas (a roll) and spots (a viewpoint), and give each
// photo the best pose we have without running a solver: the user's saved pose, the hand-fitted
// ground truth for the bundled photos, else the EXIF prior (compass + gravity + lens).
//
// Built-in photos form one roll per bundled region. Uploads (any camera roll) are clustered:
// single-linkage on distance (ROLL_LINK_M) so a day's hike stays one roll.

import { storageKey } from "#/lib/ontology/core/storage";
import { hfovFromAspect, isPose, type Pose, vfovFromFocal } from "../camera";
import { priorHeading } from "../geocam/priors/heading";
import { distanceM } from "../geodesy";
import { loadSavedPose, type PhotoMeta, photos, regionNames } from "../photos";
import type { Roll, RollPhoto, SolvedPose, Viewpoint } from "./types";

/** Photos further apart than this (m, to their nearest neighbour) start a new roll. */
export const ROLL_LINK_M = 15_000;
/** Photos within this distance (m) of a viewpoint's first photo share it. */
export const VIEWPOINT_RADIUS_M = 250;

/** One data/ground-truth.json entry as the app reads it (the ontology's ground-truth concept). */
export type GtEntry = {
	width: number;
	height: number;
	yaw: number | null;
	pitch: number | null;
	roll: number | null;
	f: number | null;
	eye: number | null;
	quality: string;
};
// data/ground-truth.json is gitignored: a fresh clone builds with an empty table.
const groundTruthModules = import.meta.glob("../../../data/ground-truth.json", {
	eager: true,
	import: "default",
}) as Record<string, Record<string, GtEntry>>;
const GT: Record<string, GtEntry> = Object.values(groundTruthModules)[0] ?? {};

const SOLVED_KEY = (id: string) => storageKey("solvedPose", id);

/** The roll aligner's pose for a photo (client only; null when none or storage is unavailable). */
export function loadSolvedPose(id: string): SolvedPose | null {
	try {
		const raw =
			typeof localStorage === "undefined"
				? null
				: localStorage.getItem(SOLVED_KEY(id));
		if (!raw) return null;
		const s = JSON.parse(raw) as Partial<SolvedPose> | null;
		// a NaN angle is stored as null (JSON): such a record must not reach a renderer
		return s && isPose(s.pose) && Number.isFinite(s.confidence)
			? (s as SolvedPose)
			: null;
	} catch {
		return null;
	}
}

export function saveSolvedPose(id: string, s: SolvedPose | null) {
	try {
		if (s) localStorage.setItem(SOLVED_KEY(id), JSON.stringify(s));
		else localStorage.removeItem(SOLVED_KEY(id));
	} catch {
		// storage unavailable: the pose just won't persist
	}
}

/**
 * What resolvePose may use. Both default to false. Evaluation (src/lib/roll/align) hides the
 * ground truth to measure the aligner honestly, and a clean re-run can ignore stored poses.
 */
export type ResolveOptions = {
	/** Skip the hand-fitted ground truth (bundled photos). */
	ignoreGroundTruth?: boolean;
	/** Skip the saved (workspace) and solved (roll aligner) poses in localStorage. */
	ignoreStored?: boolean;
};

/**
 * The EXIF prior: compass + gravity + lens (heading 0 when the photo has no compass). The yaw is the
 * true-north heading the photo engines use (priorHeading: declination under ?geoDecl=on for a
 * magnetic-ref upload, else the stored heading unchanged).
 */
export function priorPose(meta: PhotoMeta): Pose {
	return {
		yaw: priorHeading(meta) ?? 0,
		pitch: meta.pitch,
		roll: meta.roll,
		vfov: meta.vfov,
	};
}

/**
 * Best available pose for a photo (see file header), then the roll aligner's accepted pose, then
 * the EXIF prior. Saved and solved poses need localStorage (client only).
 */
export function resolvePose(
	meta: PhotoMeta,
	opts: ResolveOptions = {},
): {
	pose: Pose;
	source: RollPhoto["poseSource"];
	eyeAlt: number | null;
	confidence: number | null;
} {
	const saved =
		typeof localStorage === "undefined" || opts.ignoreStored
			? null
			: loadSavedPose(meta.id);
	const gt = opts.ignoreGroundTruth ? undefined : GT[meta.id];
	const gtEye = gt?.eye ?? null;
	if (saved)
		return {
			pose: saved,
			source: "saved",
			eyeAlt: gtEye ?? meta.alt,
			confidence: null,
		};
	if (
		gt &&
		gt.quality !== "none" &&
		gt.yaw != null &&
		gt.pitch != null &&
		gt.roll != null &&
		gt.f != null
	) {
		// GT was fitted on the full-resolution frame; vfov is resolution-independent
		return {
			pose: {
				yaw: gt.yaw,
				pitch: gt.pitch,
				roll: gt.roll,
				vfov: vfovFromFocal(gt.f, gt.height),
			},
			source: "ground-truth",
			eyeAlt: gtEye,
			confidence: null,
		};
	}
	const solved = opts.ignoreStored ? null : loadSolvedPose(meta.id);
	if (solved)
		return {
			pose: solved.pose,
			source: "solved",
			eyeAlt: meta.alt,
			confidence: solved.confidence,
		};
	return {
		pose: priorPose(meta),
		source: "prior",
		eyeAlt: meta.alt,
		confidence: null,
	};
}

function centroid(ms: PhotoMeta[]) {
	const lat = ms.reduce((s, m) => s + m.lat, 0) / ms.length;
	const lon = ms.reduce((s, m) => s + m.lon, 0) / ms.length;
	return { lat, lon };
}

function groupViewpoints(ms: PhotoMeta[]): {
	viewpoints: Viewpoint[];
	index: Map<string, number>;
} {
	const viewpoints: Viewpoint[] = [];
	const index = new Map<string, number>();
	for (const m of ms) {
		let vi = viewpoints.findIndex((v) => distanceM(v, m) < VIEWPOINT_RADIUS_M);
		if (vi < 0) {
			vi = viewpoints.length;
			viewpoints.push({ lat: m.lat, lon: m.lon, photoIds: [] });
		}
		viewpoints[vi].photoIds.push(m.id);
		index.set(m.id, vi);
	}
	// re-centre each viewpoint on its members
	for (const v of viewpoints) {
		const c = centroid(ms.filter((m) => v.photoIds.includes(m.id)));
		v.lat = c.lat;
		v.lon = c.lon;
	}
	return { viewpoints, index };
}

/** Build a roll from photos of one area. */
export function makeRoll(
	id: string,
	name: string,
	ms: PhotoMeta[],
	region: string | null,
	opts: ResolveOptions = {},
): Roll {
	const sorted = [...ms].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
	const t0 = sorted.length ? Date.parse(sorted[0].takenAt) : 0;
	const center = centroid(sorted);
	const { viewpoints, index } = groupViewpoints(sorted);
	const rollPhotos: RollPhoto[] = sorted.map((meta) => {
		const r = resolvePose(meta, opts);
		return {
			meta,
			pose: r.pose,
			poseSource: r.source,
			confidence: r.confidence,
			eyeAlt: r.eyeAlt,
			t: (Date.parse(meta.takenAt) - t0) / 1000,
			viewpoint: index.get(meta.id) ?? 0,
		};
	});
	const radiusM = Math.max(0, ...sorted.map((m) => distanceM(center, m)));
	return { id, name, photos: rollPhotos, viewpoints, center, radiusM, region };
}

/** Single-linkage clusters of photos by distance (a camera roll → areas). */
export function clusterPhotos(
	ms: PhotoMeta[],
	linkM = ROLL_LINK_M,
): PhotoMeta[][] {
	const ok = ms.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
	const parent = ok.map((_, i) => i);
	const size = ok.map(() => 1);
	const find = (i: number): number => {
		let r = i;
		while (parent[r] !== r) r = parent[r];
		while (parent[i] !== r) {
			const next = parent[i];
			parent[i] = r;
			i = next;
		}
		return r;
	};
	for (let i = 0; i < ok.length; i++)
		for (let j = i + 1; j < ok.length; j++)
			if (distanceM(ok[i], ok[j]) < linkM) {
				let a = find(i);
				let b = find(j);
				if (a === b) continue;
				if (size[a] < size[b]) [a, b] = [b, a];
				parent[b] = a;
				size[a] += size[b];
			}
	const groups = new Map<number, PhotoMeta[]>();
	ok.forEach((m, i) => {
		const r = find(i);
		const g = groups.get(r);
		if (g) g.push(m);
		else groups.set(r, [m]);
	});
	return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** One roll per bundled region (public/photos), largest first. */
export function builtinRolls(): Roll[] {
	const byRegion = new Map<string, PhotoMeta[]>();
	for (const p of photos) {
		const g = byRegion.get(p.region);
		if (g) g.push(p);
		else byRegion.set(p.region, [p]);
	}
	return [...byRegion.entries()]
		.map(([region, ms]) =>
			makeRoll(region, regionNames[region] ?? region, ms, region),
		)
		.sort((a, b) => b.photos.length - a.photos.length);
}

/** Prefix of upload-roll ids. */
export const UPLOAD_ROLL_PREFIX = "local-roll-";

/**
 * Stable id for a cluster of uploads: `local-roll-<hash>` from its earliest photo (by capture
 * time, then id), so it survives reloads and new rolls elsewhere. It changes only when an
 * earlier photo joins the cluster.
 */
export function uploadRollId(ms: PhotoMeta[]): string {
	const first = ms.reduce(
		(a, b) =>
			b.takenAt < a.takenAt || (b.takenAt === a.takenAt && b.id < a.id) ? b : a,
		ms[0],
	);
	return `${UPLOAD_ROLL_PREFIX}${first.id.replace(/^local-/, "")}`;
}

/** Rolls from uploaded photos (ids from uploadRollId), in cluster order: largest first. */
export function uploadRolls(ms: PhotoMeta[]): Roll[] {
	return clusterPhotos(ms).map((g) => {
		const c = centroid(g);
		return makeRoll(
			uploadRollId(g),
			`Your photos near ${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}°`,
			g,
			g[0].region ?? null,
		);
	});
}

export function getBuiltinRoll(id: string): Roll | null {
	return builtinRolls().find((r) => r.id === id) ?? null;
}

/** Horizontal FOV (deg) of a pose on an image of the given aspect (w/h). */
export function hfovOf(pose: Pose, aspect: number) {
	return hfovFromAspect(pose.vfov, aspect);
}
