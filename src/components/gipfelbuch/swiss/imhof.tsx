// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Imhof colouring as SVG filters over greyscale rasters (design book P4): a luminance ramp becomes a printed colour
 * ramp, then the image is multiplied onto the paper. The shading ramp needs no extra data; the hypsometric ramp uses
 * the small baked tint raster (elevation normalised over the land).
 */

type Rgb = [number, number, number];

/** Valley yellow-green, mid-slope warm, summit cool grey (Imhof's aerial-perspective ordering, printed pale). */
export const IMHOF_TINT_STOPS: Rgb[] = [
	[0.86, 0.9, 0.72],
	[0.95, 0.88, 0.7],
	[0.86, 0.87, 0.9],
];

/** Shade slopes cool blue-violet, flats near neutral, sun slopes warm cream. */
export const IMHOF_SHADING_STOPS: Rgb[] = [
	[0.52, 0.6, 0.72],
	[0.9, 0.9, 0.88],
	[1, 0.95, 0.82],
];

const channel = (stops: Rgb[], index: number) =>
	stops.map((stop) => stop[index].toFixed(3)).join(" ");

/** A filter that turns a greyscale image into the colour ramp `stops` (dark to light). */
export function ImhofRampFilter({ id, stops }: { id: string; stops: Rgb[] }) {
	return (
		<filter id={id} colorInterpolationFilters="sRGB">
			<feColorMatrix
				type="matrix"
				values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0"
			/>
			<feComponentTransfer>
				<feFuncR type="table" tableValues={channel(stops, 0)} />
				<feFuncG type="table" tableValues={channel(stops, 1)} />
				<feFuncB type="table" tableValues={channel(stops, 2)} />
			</feComponentTransfer>
		</filter>
	);
}
