// 35 mm-equivalent focal → focal in pixels, aware of crops. Kept dependency-free so both
// camera/index.ts (which re-exports it) and geo/camera.ts can import it without a cycle.

/** Diagonal of a 36×24 mm frame, √(36² + 24²); the one constant for every 35 mm-equivalent conversion. */
export const FF35_DIAGONAL_MM = 43.2666;

export type PixelSize = { width: number; height: number };

/** Relative aspect difference still read as a uniform resample (rounding of a downscale). */
export const CROP_ASPECT_TOL = 0.005;

const ok = (s: Partial<PixelSize> | null | undefined): s is PixelSize =>
	!!s &&
	Number.isFinite(s.width) &&
	Number.isFinite(s.height) &&
	(s.width as number) > 0 &&
	(s.height as number) > 0;
const long = (s: PixelSize) => Math.max(s.width, s.height);
const short = (s: PixelSize) => Math.min(s.width, s.height);

/**
 * True when `pixels` has a different aspect ratio than the EXIF `sensor` size (ExifImageWidth/
 * Height), compared long side / short side so rotation (portrait, EXIF orientation) never counts.
 * A same-aspect size change is a uniform resample (e.g. a downscaled export), not a crop.
 * An aspect-preserving crop can't be told apart from a downscale and is read as one.
 */
export function isCropped(
	sensor: Partial<PixelSize> | null | undefined,
	pixels: PixelSize,
) {
	if (!ok(sensor) || !ok(pixels)) return false;
	const a = long(sensor) / short(sensor);
	const b = long(pixels) / short(pixels);
	return Math.abs(b / a - 1) > CROP_ASPECT_TOL;
}

/**
 * Focal length in px of an `image` (the pixels the camera model uses) from a 35 mm-equivalent
 * focal length, which refers to the diagonal of the full EXIF `sensor` frame.
 *
 * - No usable sensor size, or the same aspect as `source` (uncropped, rotated, or uniformly
 *   resampled): f35 · hypot(W, H) / diag on the image itself. This is the historical
 *   expression, so uncropped photos give bit-identical results.
 * - Different aspect (e.g. cropped in iOS Photos, which keeps ExifImageWidth/Height at the
 *   sensor size): the `source` pixels are assumed to be at native sensor pitch (a crop does
 *   not resample), so f_source = f35 · hypot(sensorW, sensorH) / diag, then scaled by the
 *   resize the pipeline applied itself: image long side / source long side (1 if none).
 *   A crop that was also downscaled on export can't be detected; it reads as native pitch.
 *
 * `source` is the full-resolution pixel size the image was decoded from (any orientation);
 * it defaults to `image`. The principal point of a crop is unknown (Photos may crop
 * off-centre); callers keep it at the image centre.
 */
export function focalPxFromF35(
	f35: number,
	image: PixelSize,
	sensor?: Partial<PixelSize> | null,
	source: PixelSize = image,
) {
	if (!isCropped(sensor, source))
		return (f35 * Math.hypot(image.width, image.height)) / FF35_DIAGONAL_MM;
	const s = sensor as PixelSize;
	return (
		((f35 * Math.hypot(s.width, s.height)) / FF35_DIAGONAL_MM) *
		(long(image) / long(source))
	);
}
