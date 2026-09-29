// Camera-roll mode: many photos of one area, viewed together as a mosaic and draped on terrain.
// Contract shared by the roll data layer (roll.ts), the mosaic UI and the map (roll-map.ts).

import type { Pose } from "../camera";
import type { PhotoMeta } from "../photos";

/** Where a roll photo's pose came from, best first. */
export type PoseSource = "saved" | "ground-truth" | "solved" | "prior";

/** A pose found by aligning the roll (src/lib/roll/align), stored per photo in localStorage. */
export type SolvedPose = {
	pose: Pose;
	/** Solver confidence 0..1 (the cascade's). */
	confidence: number;
	/** Which stage accepted it, e.g. 'cascade' or 'viewpoint'. */
	method: string;
	/** ISO time it was solved. */
	at: string;
};

export type RollPhoto = {
	meta: PhotoMeta;
	pose: Pose;
	poseSource: PoseSource;
	/** Solver confidence for 'solved' poses, else null. */
	confidence: number | null;
	/** Eye altitude, m MSL (null = DEM + 1.8 m once terrain is known). */
	eyeAlt: number | null;
	/** Seconds since the roll's first photo. */
	t: number;
	/** Index of the viewpoint (photos taken within VIEWPOINT_RADIUS_M of each other) in roll.viewpoints. */
	viewpoint: number;
};

/** Photos taken from (almost) the same spot: their poses stitch into one panorama. */
export type Viewpoint = {
	lat: number;
	lon: number;
	photoIds: string[];
};

export type Roll = {
	id: string;
	name: string;
	/** Sorted by capture time. */
	photos: RollPhoto[];
	viewpoints: Viewpoint[];
	/** Centroid of the photo positions. */
	center: { lat: number; lon: number };
	/** Largest distance from the centroid to a photo, metres. */
	radiusM: number;
	/** Built-in region id (public/photos/<region>.json) whose peaks/trails cover the roll, if any. */
	region: string | null;
};
