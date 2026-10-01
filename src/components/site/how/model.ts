// Data and math for the "how it works" scene. The scene file (public/demo/how/scene.json) is baked
// by scripts/howitworks/bake.ts from real src/lib/geo output. The pinhole below mirrors
// src/lib/geo/camera (cameraFromAngles / project / unproject), inlined so the landing page does not
// pull in the pipeline.

export type Angles = { yaw: number; pitch: number; roll: number; vfov: number };

export type Scene = {
	id: string;
	photo: string;
	place: string;
	width: number;
	height: number;
	eye: number;
	ground: number;
	/** The phone's GPS altitude (m), before the eye is snapped to the DEM. */
	gpsAlt: number | null;
	hAccuracy: number | null;
	prior: Angles;
	solved: Angles;
	confidence: number;
	/** Photo skyline: rows as a fraction of the image height, one per `step` of the width. */
	skyline: { step: number; rows: (number | null)[]; weight: number[] };
	/** DEM skyline elevation (deg) and distance (m) from az0 in `step` degree steps. */
	horizon: {
		az0: number;
		step: number;
		elevation: number[];
		distance: number[];
	};
	peaks: { name: string; ele: number; az: number; el: number; dist: number }[];
	/** Heights (m) on a grid aligned with `yaw`: u across (±u/2), v ahead (v0..v1), row-major by v. */
	heightfield: {
		yaw: number;
		u: number;
		v0: number;
		v1: number;
		nu: number;
		nv: number;
		heights: number[];
	};
	dem: string;
};

const DEG = Math.PI / 180;
/** Matches geodesy.ts: curvature with refraction k = 0.13. */
export const R_EFF = 6371008.8 / (1 - 0.13);

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
	const l = Math.hypot(a[0], a[1], a[2]);
	return [a[0] / l, a[1] / l, a[2] / l];
};

export type Cam = {
	w: number;
	h: number;
	f: number;
	east: V3;
	north: V3;
	up: V3;
};

/** cameraFromAngles from src/lib/geo/camera, in the display frame (x right, y down, z forward). */
export function camera(a: Angles, w: number, h: number): Cam {
	const p = a.pitch * DEG;
	const r = a.roll * DEG;
	const up: V3 = [
		-Math.sin(r) * Math.cos(p),
		-Math.cos(r) * Math.cos(p),
		Math.sin(p),
	];
	const fh = norm([-up[2] * up[0], -up[2] * up[1], 1 - up[2] * up[2]]);
	const rh: V3 = [
		fh[1] * up[2] - fh[2] * up[1],
		fh[2] * up[0] - fh[0] * up[2],
		fh[0] * up[1] - fh[1] * up[0],
	];
	const s = Math.sin(a.yaw * DEG);
	const c = Math.cos(a.yaw * DEG);
	return {
		w,
		h,
		f: h / 2 / Math.tan((a.vfov * DEG) / 2),
		north: [
			fh[0] * c - rh[0] * s,
			fh[1] * c - rh[1] * s,
			fh[2] * c - rh[2] * s,
		],
		east: [fh[0] * s + rh[0] * c, fh[1] * s + rh[1] * c, fh[2] * s + rh[2] * c],
		up,
	};
}

export function dirENU(az: number, el: number): V3 {
	const a = az * DEG;
	const e = el * DEG;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

export function project(cam: Cam, d: V3): [number, number] | null {
	const x = cam.east[0] * d[0] + cam.north[0] * d[1] + cam.up[0] * d[2];
	const y = cam.east[1] * d[0] + cam.north[1] * d[1] + cam.up[1] * d[2];
	const z = cam.east[2] * d[0] + cam.north[2] * d[1] + cam.up[2] * d[2];
	if (z <= 1e-6) return null;
	return [cam.w / 2 + (cam.f * x) / z, cam.h / 2 + (cam.f * y) / z];
}

/** Pixel → [azimuth, elevation] in degrees. */
export function azEl(cam: Cam, px: number, py: number): [number, number] {
	const c = norm([(px - cam.w / 2) / cam.f, (py - cam.h / 2) / cam.f, 1]);
	const d: V3 = [dot(cam.east, c), dot(cam.north, c), dot(cam.up, c)];
	return [
		(((Math.atan2(d[0], d[1]) / DEG) % 360) + 360) % 360,
		Math.asin(d[2]) / DEG,
	];
}

const wrap = (az: number) => (((az % 360) + 540) % 360) - 180;

/** DEM skyline elevation at an azimuth (deg), NaN outside the baked window. */
export function horizonAt(s: Scene, az: number): number {
	const { az0, step, elevation } = s.horizon;
	const t = ((((az - az0) % 360) + 360) % 360) / step;
	const i = Math.floor(t);
	if (i < 0 || i >= elevation.length - 1) return Number.NaN;
	return elevation[i] + (elevation[i + 1] - elevation[i]) * (t - i);
}

export function horizonDistAt(s: Scene, az: number): number {
	const { az0, step, distance } = s.horizon;
	const i = Math.round(((((az - az0) % 360) + 360) % 360) / step);
	return i < distance.length ? distance[i] : Number.NaN;
}

/** The DEM skyline under `cam`, as polyline runs in image pixels. */
export function demSkyline(s: Scene, cam: Cam): [number, number][][] {
	const runs: [number, number][][] = [];
	let run: [number, number][] = [];
	const { az0, step, elevation } = s.horizon;
	for (let i = 0; i < elevation.length; i++) {
		const p = project(cam, dirENU(az0 + i * step, elevation[i]));
		if (p && p[0] > -40 && p[0] < cam.w + 40) run.push(p);
		else if (run.length) {
			runs.push(run);
			run = [];
		}
	}
	if (run.length) runs.push(run);
	return runs;
}

export type Obs = { x: number; y: number; w: number };

/** Photo skyline observations in image pixels (confident columns only). */
export function observations(s: Scene): Obs[] {
	const out: Obs[] = [];
	const { step, rows, weight } = s.skyline;
	rows.forEach((r, i) => {
		if (r !== null && weight[i] > 0.05)
			out.push({
				x: (i + 0.5) * step * s.width,
				y: r * s.height,
				w: weight[i],
			});
	});
	return out;
}

/**
 * Signed vertical gap (px) between the photo skyline and the DEM skyline at each observation:
 * positive when the terrain line sits below the photo line. Same residual as solve.ts.
 */
export function residuals(s: Scene, cam: Cam, obs: Obs[]): number[] {
	return obs.map((o) => {
		const [az, el] = azEl(cam, o.x, o.y);
		return (el - horizonAt(s, az)) * DEG * cam.f;
	});
}

/** Robust mismatch: weighted mean |gap| with each column capped (px, at full photo size). */
export function mismatch(res: number[], obs: Obs[], cap = 120): number {
	let sum = 0;
	let wsum = 0;
	res.forEach((r, i) => {
		if (!Number.isFinite(r)) return;
		sum += Math.min(Math.abs(r), cap) * obs[i].w;
		wsum += obs[i].w;
	});
	return wsum ? sum / wsum : cap;
}

/**
 * The coarse stage, as in solve.ts: a wide grid over yaw (the compass is weak) with a narrow one
 * over pitch (gravity is good), truncated loss. Returns, per yaw, the best cost and its pitch.
 */
export function yawSweep(s: Scene, obs: Obs[], half = 30, step = 0.25) {
	const out: { yaw: number; pitch: number; cost: number }[] = [];
	for (let d = -half; d <= half + 1e-9; d += step) {
		const yaw = s.prior.yaw + d;
		let best = { yaw, pitch: s.prior.pitch, cost: Number.POSITIVE_INFINITY };
		for (let dp = -2; dp <= 2 + 1e-9; dp += 0.25) {
			const pitch = s.prior.pitch + dp;
			const cam = camera({ ...s.prior, yaw, pitch }, s.width, s.height);
			const cost = mismatch(residuals(s, cam, obs), obs, 60);
			if (cost < best.cost) best = { yaw, pitch, cost };
		}
		out.push(best);
	}
	return out;
}

export const lerpAngles = (a: Angles, b: Angles, t: number): Angles => ({
	yaw: a.yaw + wrap(b.yaw - a.yaw) * t,
	pitch: a.pitch + (b.pitch - a.pitch) * t,
	roll: a.roll + (b.roll - a.roll) * t,
	vfov: a.vfov + (b.vfov - a.vfov) * t,
});

export const smooth = (t: number) => {
	const x = Math.max(0, Math.min(1, t));
	return x * x * (3 - 2 * x);
};

export const signedDelta = wrap;
