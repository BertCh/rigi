// Provenance helpers: the "Truth" tint and the export filter. Generated content never enters measurement
// exports (XYZ readout, GeoJSON, COLMAP, .ply/.splat-v1 exports): every exporter must go through
// filterForExport.
import { type GaussianCloud, PROVENANCE_CODE, type Provenance } from "./types";

/** Truth-toggle tint per provenance, RGB 0..255 (Okabe-Ito-like, distinguishable for colour-blind users). */
export const PROVENANCE_COLORS: Record<Provenance, [number, number, number]> = {
	observed: [0, 158, 115], // green: seen in the photo, depth-lifted
	reconstructed: [86, 180, 233], // sky blue: model/multi-view reconstruction
	dem: [230, 159, 0], // orange: terrain model
	generated: [204, 121, 167], // magenta: invented, never measurable
};

/** How much of the provenance tint replaces the colour with Truth on (splats and, in the world view, terrain). */
export const PROVENANCE_TINT_MIX = 0.65;

/** PROVENANCE_COLORS indexed by PROVENANCE_CODE (for shaders / per-splat lookup). */
export const PROVENANCE_COLORS_BY_CODE: [number, number, number][] = (
	Object.keys(PROVENANCE_CODE) as Provenance[]
).reduce<[number, number, number][]>((a, p) => {
	a[PROVENANCE_CODE[p]] = PROVENANCE_COLORS[p];
	return a;
}, []);

/**
 * Truth-toggle tint per PROVENANCE_CODE (observed, reconstructed, dem, generated), sRGB 0..1 (mixed with
 * the stored sRGB colour by the splat renderers; also the Step Inside legend swatches).
 */
export const SPLAT_PROVENANCE_COLORS: readonly [number, number, number][] =
	PROVENANCE_COLORS_BY_CODE.map(
		(c) => [c[0] / 255, c[1] / 255, c[2] / 255] as [number, number, number],
	);

/** Provenance name of a code, or null for an unknown code. */
export function provenanceOf(code: number): Provenance | null {
	for (const p of Object.keys(PROVENANCE_CODE) as Provenance[])
		if (PROVENANCE_CODE[p] === code) return p;
	return null;
}

/** True when a code may appear in a measurement export (known and not generated). */
export const isMeasurable = (code: number) => {
	const p = provenanceOf(code);
	return p !== null && p !== "generated";
};

/**
 * Copy of the cloud without `generated` (and unknown-code) splats, for any measurement export. Always
 * returns fresh arrays, so the caller may transfer them.
 */
export function filterForExport(cloud: GaussianCloud): GaussianCloud {
	const idx: number[] = [];
	for (let i = 0; i < cloud.count; i++)
		if (isMeasurable(cloud.provenance[i])) idx.push(i);
	return selectSplats(cloud, idx);
}

/** Copy of the cloud with only the given splat indices (in order). */
export function selectSplats(
	cloud: GaussianCloud,
	idx: ArrayLike<number>,
): GaussianCloud {
	const n = idx.length;
	const out: GaussianCloud = {
		count: n,
		frame: cloud.frame,
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: new Uint8Array(n),
	};
	if (cloud.source) out.source = new Uint16Array(n);
	for (let k = 0; k < n; k++) {
		const i = idx[k];
		out.positions.set(cloud.positions.subarray(3 * i, 3 * i + 3), 3 * k);
		out.scales.set(cloud.scales.subarray(3 * i, 3 * i + 3), 3 * k);
		out.rotations.set(cloud.rotations.subarray(4 * i, 4 * i + 4), 4 * k);
		out.colors.set(cloud.colors.subarray(4 * i, 4 * i + 4), 4 * k);
		out.provenance[k] = cloud.provenance[i];
		if (out.source && cloud.source) out.source[k] = cloud.source[i];
	}
	return out;
}
