// Step Inside P3 (research flag): the short novel-camera path the DEM-conditioned generator renders.
// Pure TS. Cameras are Pose (yaw/pitch/roll/vfov, src/lib/camera) + an ENU eye in the engine's frame, so
// they go straight into pose.ts applyPose() and camera.projectPoint().
import { type Pose, poseBasis } from "../../camera";

export type NovelCamera = {
	/** Label for UI / file names, e.g. "right-10m". */
	name: string;
	pose: Pose;
	/** Camera position (ENU, the engine's frame, metres). */
	eye: [number, number, number];
	/** Offset from the photo eye (ENU, metres). */
	offset: [number, number, number];
};

export type TrajectoryOpts = {
	/**
	 * Moves in the photo's own axes (metres): side (+ = photo right, horizontal), forward (horizontal
	 * projection of the photo forward), up (ENU up). Default: right, left, forward at `step`.
	 */
	moves?: { name?: string; side?: number; forward?: number; up?: number }[];
	/** Default step (m) for the default moves. Default 10. */
	step?: number;
	/** Every camera stays within this distance (m) of the eye (NearFieldScene.confidenceRadius). */
	radius?: number;
	/**
	 * "parallel": keep the photo orientation (pure translation, the GEN3C `no_rotation` mode).
	 * "pivot": re-aim every camera at the point `pivotDist` metres ahead of the photo eye (the GEN3C
	 * `center_facing` mode), so the near field stays in frame. Default "pivot".
	 */
	aim?: "parallel" | "pivot";
	/** Pivot distance (m) for aim "pivot". Default 40. */
	pivotDist?: number;
};

const R2D = 180 / Math.PI;

/**
 * K novel cameras around the photo eye. Offsets longer than `radius` are shortened to it (the design's
 * confidence radius: past it, one photo cannot support the parallax). Deterministic.
 */
export function makeTrajectory(
	photoPose: Pose,
	eye: { x: number; y: number; z: number },
	opts: TrajectoryOpts = {},
): NovelCamera[] {
	const step = opts.step ?? 10;
	const moves = opts.moves ?? [
		{ name: `right-${step}m`, side: step },
		{ name: `left-${step}m`, side: -step },
		{ name: `fwd-${step}m`, forward: step },
	];
	const { forward: F, right: R } = poseBasis(photoPose);
	// horizontal axes (a level step, whatever the photo's pitch / roll)
	const fh = Math.hypot(F[0], F[1]) || 1;
	const fwd = [F[0] / fh, F[1] / fh, 0];
	const rh = Math.hypot(R[0], R[1]) || 1;
	const right = [R[0] / rh, R[1] / rh, 0];
	const pivotDist = opts.pivotDist ?? 40;
	const pivot = [
		eye.x + F[0] * pivotDist,
		eye.y + F[1] * pivotDist,
		eye.z + F[2] * pivotDist,
	];
	return moves.map((m, k) => {
		const s = m.side ?? 0;
		const f = m.forward ?? 0;
		const u = m.up ?? 0;
		let off: [number, number, number] = [
			right[0] * s + fwd[0] * f,
			right[1] * s + fwd[1] * f,
			u,
		];
		const len = Math.hypot(...off);
		if (opts.radius != null && len > opts.radius && len > 0) {
			const c = opts.radius / len;
			off = [off[0] * c, off[1] * c, off[2] * c];
		}
		const e: [number, number, number] = [
			eye.x + off[0],
			eye.y + off[1],
			eye.z + off[2],
		];
		let pose: Pose = { ...photoPose };
		if ((opts.aim ?? "pivot") === "pivot") {
			const d = [pivot[0] - e[0], pivot[1] - e[1], pivot[2] - e[2]];
			const l = Math.hypot(d[0], d[1], d[2]);
			if (l > 1e-6)
				pose = {
					...photoPose,
					yaw: (((Math.atan2(d[0], d[1]) * R2D) % 360) + 360) % 360,
					pitch: Math.asin(d[2] / l) * R2D,
				};
		}
		return { name: m.name ?? `view-${k}`, pose, eye: e, offset: off };
	});
}
