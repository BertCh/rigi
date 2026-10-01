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

let manifest: Promise<DemoManifest> | null = null;

/** Fetch the manifest once and register every photo (and the shared region) with photos.ts. */
export function loadDemo(): Promise<DemoManifest> {
	manifest ??= fetch("/demo/manifest.json")
		.then((r) => {
			if (!r.ok) throw new Error(`demo manifest: HTTP ${r.status}`);
			return r.json() as Promise<DemoManifest>;
		})
		.then((m) => {
			regionNames[m.region.id] = m.name;
			for (const p of m.photos) registerLocalPhoto(p, m.region);
			return m;
		})
		.catch((e) => {
			manifest = null;
			throw e;
		});
	return manifest;
}

/** The bundled pose for a demo photo (null for any other id, or before loadDemo). */
export async function demoPose(id: string): Promise<Pose | null> {
	if (!isDemoPhotoId(id)) return null;
	return (await loadDemo()).poses[id]?.pose ?? null;
}

/** The sample trip as a roll. Photos the user has not touched take the bundled pose. */
export async function loadDemoRoll(): Promise<Roll> {
	const [m, { makeRoll }] = await Promise.all([
		loadDemo(),
		import("../roll/roll"),
	]);
	const roll = makeRoll(DEMO_ROLL_ID, m.name, m.photos, m.region.id);
	for (const p of roll.photos) {
		const b = m.poses[p.meta.id];
		if (!b || p.poseSource === "saved") continue;
		p.pose = b.pose;
		p.poseSource = b.source;
		p.confidence = b.confidence;
	}
	return roll;
}
