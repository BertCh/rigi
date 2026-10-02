// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure geometry for the SheetMap's followed camera: the phone's guess wedge, the solved wedge, the
// short-way correction arc between them and the pencil rays to the summits the photo names. No React.

export interface FollowInput {
	guessYaw: number;
	guessHfov: number;
	/** The photo's solved pose (the sheet's own viewpoint yaw is the compass heading for a refused photo). */
	solvedYaw: number;
	solvedHfov: number;
	accepted: boolean;
	names: string[];
}

export interface FollowViewpoint {
	x: number;
	y: number;
}

export interface FollowGeometry {
	guessWedge: string;
	solvedWedge: string;
	arc: string;
	arcLabel: { x: number; y: number };
	signedDeg: string;
	rays: { name: string; to: [number, number] }[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** A sheet-space point at compass `bearing` (north up) and distance `r` from (x, y). */
export const polarPoint = (
	x: number,
	y: number,
	bearing: number,
	r: number,
): [number, number] => [
	Number((x + r * Math.sin(rad(bearing))).toFixed(1)) + 0, // + 0 folds -0
	Number((y - r * Math.cos(rad(bearing))).toFixed(1)) + 0,
];

const pt = (p: [number, number]) => `${p[0]} ${p[1]}`;

/** The view cone as a closed wedge path (the SheetMap's cone maths). */
export function wedgePath(
	x: number,
	y: number,
	yaw: number,
	hfov: number,
	r: number,
) {
	const a0 = yaw - hfov / 2;
	const a1 = yaw + hfov / 2;
	return `M${x} ${y}L${pt(polarPoint(x, y, a0, r))}A${r} ${r} 0 0 1 ${pt(polarPoint(x, y, a1, r))}z`;
}

/** "+3.4" or "−1.0" (a true minus), one decimal; zero is unsigned. */
export const signedDegrees = (v: number) => {
	const text = Math.abs(v).toFixed(1);
	return `${Number(text) === 0 ? "" : v > 0 ? "+" : "−"}${text}`;
};

const fold = (s: string) =>
	s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The sheet peaks a photo names: exact names first, then case and accent-insensitive; each peak once. */
export function matchPeaks<P extends { name: string }>(
	sheetPeaks: readonly P[],
	names: readonly string[],
): P[] {
	const out: P[] = [];
	for (const name of names) {
		const hit =
			sheetPeaks.find((p) => p.name === name) ??
			sheetPeaks.find((p) => fold(p.name) === fold(name));
		if (hit && !out.includes(hit)) out.push(hit);
	}
	return out;
}

export function followGeometry(
	vp: FollowViewpoint,
	follow: FollowInput,
	sheetPeaks: readonly { name: string; x: number; y: number }[],
	r: number,
): FollowGeometry {
	const delta = wrap180(follow.solvedYaw - follow.guessYaw);
	const arcR = r * 0.42;
	const from = polarPoint(vp.x, vp.y, follow.guessYaw, arcR);
	const to = polarPoint(vp.x, vp.y, follow.guessYaw + delta, arcR);
	const mid = follow.guessYaw + delta / 2;
	const [lx, ly] = polarPoint(vp.x, vp.y, mid, arcR + 22);
	return {
		guessWedge: wedgePath(vp.x, vp.y, follow.guessYaw, follow.guessHfov, r),
		solvedWedge: wedgePath(vp.x, vp.y, follow.solvedYaw, follow.solvedHfov, r),
		arc: `M${pt(from)}A${arcR} ${arcR} 0 0 ${delta >= 0 ? 1 : 0} ${pt(to)}`,
		arcLabel: { x: lx, y: ly },
		signedDeg: signedDegrees(delta),
		rays: matchPeaks(sheetPeaks, follow.names).map((p) => ({
			name: p.name,
			to: [p.x, p.y] as [number, number],
		})),
	};
}
