// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Synthetic evidence for the live pose tracker (src/lib/track): known trajectories over a ridge
// profile, rendered frames with clouds / occluders / noise, a biased and drifting sensor, and
// scenarios (nominal, no sensor, compass jump + blackout = LOST then recovery). Measures tracking
// error against truth (median / p90 of the camera-basis rotation error), drift between the start and
// end of the clip, LOST recovery time and per-frame cost. Node only, no browser.
//
//   npx tsx scripts/track/synthetic.eval.ts [--seconds 60] [--fps 30] [--only nominal,kidnap]
//   DAWN_DIR=/tmp/dawn npx tsx scripts/track/synthetic.eval.ts --gpu   (GPU scanner over Dawn: parity + timing)
//
// Sim time is synthetic; the async relocalise runs in real time, so a LOST recovery spans a few
// dozen simulated frames (stated in the output).

import type { Pose } from "../../src/lib/camera";
import type { TrackedPose, TrackFrame } from "../../src/lib/live/contract";
import {
	createCpuScanner,
	createTrackerCore,
	type RgbaImage,
	scanColumnsCpu,
} from "../../src/lib/track";
import {
	type FrameStyle,
	makeRidgeProfile,
	makeSensor,
	makeTrajectory,
	renderFrame,
	rng,
	rotationErrorDeg,
	type SensorModel,
	type TrajectoryOptions,
} from "../../src/lib/track/synthetic";

export interface Scenario {
	name: string;
	sensor: SensorModel | null;
	style: FrameStyle;
	/** [start, end] seconds the lens is covered. */
	blackouts?: [number, number][];
	trajectory?: TrajectoryOptions;
}

export const SCENARIOS: Scenario[] = [
	{
		name: "nominal",
		sensor: { yawBias: 10, yawWalk: 0.3 },
		style: { clouds: true, occluders: true },
	},
	{
		name: "no-compass",
		sensor: { noCompass: true },
		style: { clouds: true, occluders: true },
	},
	{
		name: "no-sensor",
		sensor: null,
		style: { clouds: true, occluders: true },
	},
	{
		name: "kidnap",
		sensor: { yawBias: 10, yawJumps: [[25, 1e9, 40]] },
		style: { clouds: true, occluders: true },
		blackouts: [[25, 28]],
	},
	{
		name: "fast-noisy",
		sensor: { yawBias: 10, yawWalk: 0.5, noise: 0.4 },
		style: { clouds: true, occluders: true, noise: 0.07 },
		trajectory: { panDeg: 70, panPeriod: 8, shakeDeg: 1 },
	},
];

export interface EvalOptions {
	seconds: number;
	fps: number;
	width?: number;
	height?: number;
	seed?: number;
	/** Replace the CPU scanner (GPU over Dawn). */
	makeScanner?: (
		read: (f: TrackFrame) => RgbaImage | null,
	) => ReturnType<typeof createCpuScanner>;
}

export interface EvalResult {
	scenario: string;
	frames: number;
	posesTracked: number;
	medianErrDeg: number;
	p90ErrDeg: number;
	p99ErrDeg: number;
	/** Median error in the first and last 10 s of the track phase. */
	startMedianDeg: number;
	endMedianDeg: number;
	sensorMedianDeg: number;
	sensorEndMedianDeg: number;
	timeToFirstTrackS: number;
	lostEvents: number;
	/** Seconds (sim) from the end of the disturbance to the first accurate (< 1.5 deg) TRACK pose; NaN when none. */
	recoverySeconds: number;
	pushFrameMsMedian: number;
	settleMsMedian: number;
	settleMsP90: number;
}

const percentile = (v: number[], q: number) => {
	if (!v.length) return Number.NaN;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const flush = () => new Promise<void>((r) => setImmediate(r));

export async function runScenario(
	sc: Scenario,
	o: EvalOptions,
): Promise<EvalResult> {
	const width = o.width ?? 320;
	const height = o.height ?? 180;
	const profile = makeRidgeProfile(o.seed ?? 1);
	const truth = makeTrajectory({ seed: (o.seed ?? 1) + 6, ...sc.trajectory });
	const sensorOf = sc.sensor ? makeSensor(sc.sensor) : null;
	const rand = rng(1234 + (o.seed ?? 1));
	const vfov = truth(0).vfov;
	const frameBuffer = { current: null as RgbaImage | null };
	const read = (_f: TrackFrame) => frameBuffer.current;
	const baseScanner = createCpuScanner(width, read);
	const scanner = o.makeScanner?.(read) ?? baseScanner;
	const tracker = createTrackerCore({ horizon: profile, vfov, scanner });
	const poses: TrackedPose[] = [];
	tracker.onPose((p) => poses.push(p));
	const pushMs: number[] = [];
	const settleMs: number[] = [];
	const sensorErr: { t: number; e: number }[] = [];
	let lostEvents = 0;
	let lastPhase = tracker.phase;
	const total = Math.round(o.seconds * o.fps);
	for (let k = 0; k < total; k++) {
		const t = k / o.fps;
		const pose = truth(t);
		const blackout = sc.blackouts?.some(([a, b]) => t >= a && t < b) ?? false;
		const img = renderFrame(
			profile,
			pose,
			width,
			height,
			{ ...sc.style, blackout },
			rand,
			t,
		);
		frameBuffer.current = img;
		const sensor = sensorOf?.(pose, t);
		if (sensor)
			sensorErr.push({
				t,
				e: rotationErrorDeg(
					{
						yaw: sensor.yaw ?? pose.yaw,
						pitch: sensor.pitch,
						roll: sensor.roll,
						vfov,
					},
					pose,
				),
			});
		const frame: TrackFrame = {
			time: t * 1000,
			width,
			height,
			source: {} as TrackFrame["source"],
			sensor,
		};
		const a = performance.now();
		tracker.pushFrame(frame);
		const b = performance.now();
		await flush();
		const c = performance.now();
		pushMs.push(b - a);
		settleMs.push(c - b);
		if (tracker.phase === "lost" && lastPhase !== "lost") lostEvents++;
		lastPhase = tracker.phase;
	}
	await flush();
	tracker.dispose();

	const err = (p: TrackedPose) =>
		rotationErrorDeg(p.pose, truth(p.time / 1000));
	const tracked = poses.filter((p) => p.phase === "track");
	const errs = tracked.map(err);
	const firstTrack = tracked.length ? tracked[0].time / 1000 : Number.NaN;
	const window = (a: number, b: number) =>
		tracked.filter((p) => p.time / 1000 >= a && p.time / 1000 < b).map(err);
	const sw = (a: number, b: number) =>
		sensorErr.filter((s) => s.t >= a && s.t < b).map((s) => s.e);
	let recovery = Number.NaN;
	if (sc.blackouts?.length) {
		const end = sc.blackouts[sc.blackouts.length - 1][1];
		const good = tracked.find((p) => p.time / 1000 >= end && err(p) < 1.5);
		if (good) recovery = good.time / 1000 - end;
	}
	return {
		scenario: sc.name,
		frames: total,
		posesTracked: tracked.length,
		medianErrDeg: percentile(errs, 0.5),
		p90ErrDeg: percentile(errs, 0.9),
		p99ErrDeg: percentile(errs, 0.99),
		startMedianDeg: percentile(window(firstTrack, firstTrack + 10), 0.5),
		endMedianDeg: percentile(window(o.seconds - 10, o.seconds), 0.5),
		sensorMedianDeg: percentile(
			sensorErr.map((s) => s.e),
			0.5,
		),
		sensorEndMedianDeg: percentile(sw(o.seconds - 10, o.seconds), 0.5),
		timeToFirstTrackS: firstTrack,
		lostEvents,
		recoverySeconds: recovery,
		pushFrameMsMedian: percentile(pushMs, 0.5),
		settleMsMedian: percentile(settleMs, 0.5),
		settleMsP90: percentile(settleMs, 0.9),
	};
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

export function formatResult(
	r: EvalResult,
	scannerLabel = "CPU scanner",
): string {
	return [
		`${r.scenario.padEnd(11)} frames ${r.frames}, tracked ${r.posesTracked}`,
		`  error deg  median ${fmt(r.medianErrDeg)}  p90 ${fmt(r.p90ErrDeg)}  p99 ${fmt(r.p99ErrDeg)}`,
		`  drift      first10s ${fmt(r.startMedianDeg)} -> last10s ${fmt(r.endMedianDeg)}   (raw sensor median ${fmt(r.sensorMedianDeg)}, last10s ${fmt(r.sensorEndMedianDeg)})`,
		`  first track at ${fmt(r.timeToFirstTrackS)} s, LOST events ${r.lostEvents}, recovery ${fmt(r.recoverySeconds)} s (sim)`,
		`  cost ms    pushFrame median ${fmt(r.pushFrameMsMedian)}  scan+solve median ${fmt(r.settleMsMedian)} p90 ${fmt(r.settleMsP90)}  (${scannerLabel}, node)`,
	].join("\n");
}

async function gpuSection(seconds: number, fps: number) {
	const { dawnDevice } = await import("../nn/dawn");
	const device = await dawnDevice("track-eval");
	if (!device) {
		console.log("SKIP gpu: DAWN_DIR not set or no adapter");
		return;
	}
	const { GpuColumnScanner } = await import("../../src/lib/track/skyline-gpu");
	const width = 320;
	const height = 180;
	const profile = makeRidgeProfile(1);
	const truth = makeTrajectory({ seed: 7 });
	const rand = rng(77);
	const current = { img: null as RgbaImage | null };
	const gpu = new GpuColumnScanner(device, width, (texture) => {
		const img = current.img as RgbaImage;
		texture.writeData(img.data, {
			x: 0,
			y: 0,
			width: img.width,
			height: img.height,
			bytesPerRow: img.width * 4,
			rowsPerImage: img.height,
		});
	});
	await gpu.prepare(width, height);
	const rowDiff: number[] = [];
	const wDiff: number[] = [];
	const scanMs: number[] = [];
	const issueMs: number[] = [];
	const frames = Math.min(150, Math.round(seconds * fps));
	for (let k = 0; k < frames; k++) {
		const t = k / fps;
		current.img = renderFrame(
			profile,
			truth(t),
			width,
			height,
			{ clouds: true, occluders: true },
			rand,
			t,
		);
		const frame = { time: t * 1000, width, height, source: {} } as TrackFrame;
		const a = performance.now();
		const p = gpu.scan(frame);
		issueMs.push(performance.now() - a);
		const g = await p;
		scanMs.push(performance.now() - a);
		const c = scanColumnsCpu(current.img, width);
		if (!g) continue;
		for (let x = 0; x < width; x++) {
			if (Number.isFinite(g.rows[x]) && Number.isFinite(c.rows[x])) {
				rowDiff.push(Math.abs(g.rows[x] - c.rows[x]));
				wDiff.push(Math.abs(g.weights[x] - c.weights[x]));
			}
		}
	}
	console.log("GPU column scan over Dawn (noisy, shared GPU):");
	console.log(
		`  parity vs CPU twin: row |diff| median ${percentile(rowDiff, 0.5).toExponential(1)} p99 ${percentile(rowDiff, 0.99).toExponential(1)} max ${Math.max(...rowDiff).toExponential(1)} px (${rowDiff.length} columns); weight |diff| p99 ${percentile(wDiff, 0.99).toExponential(1)}`,
	);
	console.log(
		`  issue (sync part of scan()) median ${fmt(percentile(issueMs, 0.5))} ms; scan latency to result median ${fmt(percentile(scanMs, 0.5))} p90 ${fmt(percentile(scanMs, 0.9))} ms`,
	);
	// full tracker on the GPU scanner
	const r = await runScenario(SCENARIOS[0], {
		seconds: Math.min(seconds, 20),
		fps,
		makeScanner: (read) => {
			const s = new GpuColumnScanner(device, width, (texture, f) => {
				const img = read(f) as RgbaImage;
				texture.writeData(img.data, {
					x: 0,
					y: 0,
					width: img.width,
					height: img.height,
					bytesPerRow: img.width * 4,
					rowsPerImage: img.height,
				});
			});
			void s.prepare(width, height);
			return s;
		},
	});
	console.log("full tracker on the GPU scanner, nominal:");
	console.log(formatResult(r, "GPU scanner over Dawn"));
	gpu.dispose();
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const arg = (k: string, d: string) =>
		argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
	const seconds = Number(arg("--seconds", "60"));
	const fps = Number(arg("--fps", "30"));
	const only = argv.includes("--only") ? arg("--only", "").split(",") : null;
	if (argv.includes("--gpu")) await gpuSection(seconds, fps);
	else {
		console.log(
			`synthetic tracker evidence: ${seconds} s at ${fps} fps, 320x180 frames`,
		);
		for (const sc of SCENARIOS) {
			if (only && !only.includes(sc.name)) continue;
			const r = await runScenario(sc, { seconds, fps });
			console.log(formatResult(r));
		}
	}
}

export type { Pose };
