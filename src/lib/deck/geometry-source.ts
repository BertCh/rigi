// Per-pixel terrain geometry seen through the photo camera, for the deck backend.
//
// Contract shared by the GPU implementation (src/lib/deck/geometry-pass.ts, built in parallel)
// and the CPU fallback (src/lib/deck/cpu-geometry.ts). DeckEngine uses it where three.js reads
// its float geometry target (geoRT / silRT): the silhouette re-rank in autoAlign, and later the
// ridge/skyline composite, occlusion and hover.
//
// Buffer layout (both implementations MUST follow it):
//   - row-major, row 0 = TOP of the image (v = 0), column 0 = left (u = 0); pixel (x, y) covers
//     u ∈ [x/width, (x+1)/width), v ∈ [y/height, (y+1)/height) and is sampled at its centre.
//     (three.js readbacks are bottom-up; this is not.)
//   - `range[i]`: metres from the eye to the first terrain hit along the pixel's ray;
//     Number.POSITIVE_INFINITY for sky / no data. Never 0 or NaN.
//   - `xyz` (optional): the hit point in the camera-anchored ENU frame (x east, y north, z up,
//     metres; same frame as Pose/eye), 3 floats per pixel; NaN for sky.
//   - After `await render(pose)` resolves, the buffers describe exactly `pose` (at the eye the
//     source was created with) and `pose` below equals it, until the next render() call.

import type { Pose } from "../camera";

export interface GeometrySource {
	readonly width: number;
	readonly height: number;
	/** Metres, row 0 = top; Infinity = sky. Length width·height. */
	readonly range: Float32Array;
	/** ENU hit points, 3 per pixel (NaN for sky). Optional. */
	readonly xyz?: Float32Array;
	/** The pose the buffers currently describe (null before the first render). */
	readonly pose?: Pose | null;
	/** Render the geometry for `pose` into range (and xyz). Resolves when the buffers are filled. */
	render(pose: Pose): Promise<void>;
	dispose?(): void;
}

/**
 * Makes a GeometrySource of a given size for the current terrain + eye. DeckEngine keeps one per
 * size (e.g. 384 px wide for the silhouette re-rank) and re-creates them when the terrain or the
 * eye changes.
 */
export type GeometrySourceFactory = (
	width: number,
	height: number,
) => GeometrySource;

/** Natural log of range, with sky as ≈700 km (engine.ts `lr`). */
export function logRange(r: number) {
	return r > 0 && Number.isFinite(r) ? Math.log(r) : 13.5;
}

/**
 * Topmost terrain row per column (the rendered skyline for the source's pose), −1 where the
 * whole column is sky. The "horizon per pixel" view of a GeometrySource.
 */
export function skylineRows(
	src: Pick<GeometrySource, "width" | "height" | "range">,
) {
	const out = new Int32Array(src.width).fill(-1);
	for (let x = 0; x < src.width; x++)
		for (let y = 0; y < src.height; y++)
			if (Number.isFinite(src.range[y * src.width + x])) {
				out[x] = y;
				break;
			}
	return out;
}
