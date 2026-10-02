// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The per-frame pose tracker (INIT -> TRACK -> LOST), implementing the live contract `Tracker`.
//
//   pushFrame(frame): never awaits. Starts one column scan of the frame (GPU: copyExternalImage +
//     one dispatch + one ring readback; the scanner owns that) and returns. If no scan can start
//     (the budget is full, the frame size is changing) the pose of that frame is emitted at once
//     from the filter and the sensor.
//   scan resolved (1-2 frames later): prior = filter + sensor at the frame's time, robust solve of
//     yaw/pitch/roll against the resident horizon, fuse the result into the filters, emit with
//     source "skyline". A run of failed solves moves to LOST; LOST and INIT run `relocalise`
//     asynchronously on the keyframe's skyline.
//   Every ~2 s an optional heavy skyline (sky segmentation, async, one in flight) is solved too and
//     applied when it lands (dropped if older than 1 s): it enters the filters with extra weight and
//     teaches the tracker the cheap scan's bias.
// Everything is a suggestion (`suggestion: true`) until the tracker gate in reports/ passes.
import type { Pose } from "../camera";
import type { HorizonProfile } from "../geo/horizon";
import type {
	SensorSample,
	TrackedPose,
	Tracker,
	TrackerPhase,
	TrackFrame,
} from "../live/contract";
import {
	type Column,
	columnsFromSkyline,
	DEG,
	type Geometry,
	type HorizonTable,
	horizonTable,
} from "../refine/model";
import { AxisFilter, wrapDelta } from "./filter";
import { TrackStateMachine } from "./machine";
import { createSkylineRelocaliser } from "./search";
import type { ScanResult } from "./skyline-cpu";
import { type Angles, solvePose } from "./solve";
import type {
	ColumnScanner,
	Relocaliser,
	TrackerOptions,
	TrackerTuning,
} from "./types";

export const DEFAULT_TUNING: TrackerTuning = {
	lostAfterFailures: 8,
	minInlierFraction: 0.4,
	maxResidualDeg: 2,
	minColumns: 24,
	priorSigmaDeg: { yaw: 3, pitch: 2, roll: 2 },
	sigmaPx: 1.2,
	effectiveColumns: 60,
	offsetNoiseDeg: { yaw: 0.5, pitch: 0.15, roll: 0.15 },
	accelerationDeg: 30,
	measurementFloorDeg: 0.12,
	relocaliseMinConfidence: 0.45,
	relocaliseRetrySeconds: 1,
	maxSensorAgeSeconds: 0.5,
};

/** Share of the heavy-versus-filter offset moved into the cheap-scan bias per heavy observation. */
const BIAS_GAIN = 0.6;
/** The cheap-scan bias estimate is clamped to this, degrees (a bigger one is more likely a bad heavy solve). */
const MAX_CHEAP_BIAS_DEG = 4;

type AxisName = keyof Angles;
const AXES: AxisName[] = ["yaw", "pitch", "roll"];

/** Sensor angles of a frame (nulls where the reading has none). */
const sensorAngles = (s: SensorSample | undefined) => ({
	yaw: s ? s.yaw : null,
	pitch: s ? s.pitch : null,
	roll: s ? s.roll : null,
});

export interface TrackerCoreOptions extends Omit<TrackerOptions, "horizon"> {
	horizon: HorizonProfile;
	scanner: ColumnScanner;
}

/** The tracker over an explicit scanner (index.ts picks GPU or CPU; tests inject). */
export function createTrackerCore(options: TrackerCoreOptions): Tracker {
	const tuning: TrackerTuning = { ...DEFAULT_TUNING, ...options.tuning };
	const scanner = options.scanner;
	const maxInFlight = options.maxInFlight ?? 2;
	const heavyEveryMs = options.heavySkylineEveryMs ?? 2000;
	const heavyMaxAgeMs = options.heavySkylineMaxAgeMs ?? 1000;
	const heavyWeight = Math.max(1, options.heavySkylineWeight ?? 4);
	const table: HorizonTable = horizonTable(options.horizon, 0);
	const relocalise: Relocaliser =
		options.relocalise ?? createSkylineRelocaliser(tuning);
	const machine = new TrackStateMachine({
		lostAfterFailures: tuning.lostAfterFailures,
		relocaliseRetrySeconds: tuning.relocaliseRetrySeconds,
	});
	const filters: Record<AxisName, AxisFilter> = {
		yaw: new AxisFilter({
			offsetNoise: tuning.offsetNoiseDeg.yaw,
			acceleration: tuning.accelerationDeg,
			wrap: true,
			initialSigma: 5,
		}),
		pitch: new AxisFilter({
			offsetNoise: tuning.offsetNoiseDeg.pitch,
			acceleration: tuning.accelerationDeg,
			wrap: false,
			initialSigma: 3,
		}),
		roll: new AxisFilter({
			offsetNoise: tuning.offsetNoiseDeg.roll,
			acceleration: tuning.accelerationDeg,
			wrap: false,
			initialSigma: 3,
		}),
	};
	const listeners = new Set<(p: TrackedPose) => void>();
	let epoch = 0;
	let disposed = false;
	let heavyBusy = false;
	let heavyStartedAt = Number.NEGATIVE_INFINITY;
	/** Estimated bias of the cheap scan per axis (degrees), learned from heavy observations. */
	const cheapBias: Record<AxisName, number> = { yaw: 0, pitch: 0, roll: 0 };
	let lastSensor: Record<AxisName, number | null> = {
		yaw: null,
		pitch: null,
		roll: null,
	};
	let lastFrameTime = 0;
	let lastColumns: { columns: Column[]; geom: Geometry; time: number } | null =
		null;
	let resetPrior: Partial<Pose> | undefined;

	const emit = (p: TrackedPose) => {
		for (const cb of listeners) cb(p);
	};

	/** Sensor angle to use for an axis at a frame: the frame's own, else the last known. */
	const sensorFor = (
		axis: AxisName,
		sensor: ReturnType<typeof sensorAngles>,
	): number | null => sensor[axis] ?? lastSensor[axis];

	const poseAt = (
		t: number,
		sensor: ReturnType<typeof sensorAngles>,
	): Pose | null => {
		if (!AXES.every((a) => filters[a].initialised)) return null;
		const seconds = t / 1000;
		return {
			yaw: filters.yaw.valueAt(seconds, sensorFor("yaw", sensor)),
			pitch: filters.pitch.valueAt(seconds, sensorFor("pitch", sensor)),
			roll: filters.roll.valueAt(seconds, sensorFor("roll", sensor)),
			vfov: options.vfov,
		};
	};

	const initFilters = (
		pose: Pose,
		t: number,
		sensor: ReturnType<typeof sensorAngles>,
		sigma = 1,
	) => {
		for (const a of AXES)
			filters[a].init(pose[a], sensorFor(a, sensor), t / 1000, sigma);
	};

	const geometryOf = (scan: ScanResult): Geometry => ({
		width: scan.width,
		height: scan.height,
		cx: scan.width / 2,
		cy: scan.height / 2,
		f0: scan.height / 2 / Math.tan((options.vfov * DEG) / 2),
	});

	const emitPose = (
		time: number,
		pose: Pose,
		residualDeg: number,
		source: TrackedPose["source"],
	) =>
		emit({
			time,
			pose,
			phase: machine.phase,
			residualDeg,
			source,
			suggestion: true,
		});

	/** Emit the filter/sensor pose of a frame with no image solve. */
	const emitPropagated = (frame: TrackFrame) => {
		const sensor = sensorAngles(frame.sensor);
		const pose = poseAt(frame.time, sensor);
		if (pose) {
			emitPose(frame.time, pose, Number.NaN, "sensor");
			return;
		}
		// INIT with a compass heading: show the raw sensor pose until the first solve
		if (machine.phase === "init" && frame.sensor && frame.sensor.yaw !== null)
			emitPose(
				frame.time,
				{
					yaw: frame.sensor.yaw,
					pitch: frame.sensor.pitch,
					roll: frame.sensor.roll,
					vfov: options.vfov,
				},
				Number.NaN,
				"sensor",
			);
	};

	const startRelocalise = (
		time: number,
		sensor: ReturnType<typeof sensorAngles>,
	) => {
		if (!lastColumns || !machine.shouldRelocalise(time / 1000)) return;
		machine.beginRelocalise(time / 1000);
		const myEpoch = epoch;
		const key = lastColumns;
		const prior: Partial<Pose> = {
			yaw: sensor.yaw ?? resetPrior?.yaw ?? undefined,
			pitch: sensor.pitch ?? resetPrior?.pitch,
			roll: sensor.roll ?? resetPrior?.roll,
			...(poseAt(time, sensor) ?? {}),
		};
		const finish = (result: Awaited<ReturnType<Relocaliser>> | null) => {
			if (disposed || myEpoch !== epoch) return;
			const accepted =
				!!result && result.confidence >= tuning.relocaliseMinConfidence;
			machine.endRelocalise(accepted);
			if (!accepted || !result) return;
			const keySensor = sensorAngles(lastSensorSampleAt(key.time));
			initFilters(result.pose, key.time, keySensor);
			const now = poseAt(lastFrameTime, lastSensorForNow()) ?? result.pose;
			resetPrior = undefined;
			emitPose(lastFrameTime, now, Number.NaN, "relocalise");
		};
		let keyframe: Promise<ImageBitmap | undefined> = Promise.resolve(undefined);
		if (options.keyframeBitmap && keyframeSource)
			keyframe = createImageBitmap(keyframeSource as ImageBitmapSource).catch(
				() => undefined,
			);
		keyframe
			.then((bitmap) =>
				relocalise({
					time: key.time,
					columns: key.columns,
					geom: key.geom,
					prior,
					horizon: options.horizon,
					vfov: options.vfov,
					cancelled: () => disposed || myEpoch !== epoch,
					keyframe: bitmap,
				}),
			)
			.then(finish, () => finish(null));
	};

	// the latest frame source (only used to make a keyframe bitmap at request time, then dropped)
	let keyframeSource: TrackFrame["source"] | null = null;
	let sensorHistory: SensorSample[] = [];
	const lastSensorSampleAt = (time: number): SensorSample | undefined => {
		let found: SensorSample | undefined;
		for (const s of sensorHistory) if (s.time <= time) found = s;
		return found ?? sensorHistory[0];
	};
	const lastSensorForNow = () =>
		sensorAngles(sensorHistory[sensorHistory.length - 1]);

	/** A scan of a frame came back: solve, fuse, emit. */
	const processScan = (
		frame: { time: number; sensor?: SensorSample },
		scan: ScanResult,
	) => {
		const geom = geometryOf(scan);
		const columns = columnsFromSkyline({
			rows: scan.rows,
			weight: scan.weights,
			width: scan.width,
		});
		lastColumns = { columns, geom, time: frame.time };
		const sensor = sensorAngles(frame.sensor);
		if (machine.phase !== "track") {
			startRelocalise(frame.time, sensor);
			const pose = poseAt(frame.time, sensor);
			if (pose) emitPose(frame.time, pose, Number.NaN, "sensor");
			else emitPropagated(frame as TrackFrame);
			return;
		}
		const prior = poseAt(frame.time, sensor);
		if (!prior) return;
		const observed = columns.filter((c) => c.w > 0.15).length;
		if (observed < tuning.minColumns) {
			machine.observe("skip");
			emitPose(frame.time, prior, Number.NaN, "sensor");
			return;
		}
		const solved = solvePose(table, geom, columns, {
			prior,
			priorSigmaDeg: tuning.priorSigmaDeg,
			sigmaPx: tuning.sigmaPx,
			effectiveColumns: tuning.effectiveColumns,
		});
		const good =
			!!solved &&
			solved.inlierFraction >= tuning.minInlierFraction &&
			solved.residualDeg <= tuning.maxResidualDeg;
		const phase = machine.observe(good ? "good" : "bad");
		if (!solved || !good) {
			emitPose(
				frame.time,
				prior,
				solved ? solved.residualDeg : Number.NaN,
				"sensor",
			);
			if (phase === "lost") startRelocalise(frame.time, sensor);
			return;
		}
		const t = frame.time / 1000;
		for (const a of AXES) {
			const sigma = Math.hypot(solved.sigmaDeg[a], tuning.measurementFloorDeg);
			filters[a].update(
				solved.angles[a] - cheapBias[a],
				sensorFor(a, sensor),
				sigma * sigma,
				t,
			);
		}
		const fused = poseAt(frame.time, sensor) ?? prior;
		emitPose(frame.time, fused, solved.residualDeg, "skyline");
	};

	/**
	 * A heavy (sky-model) skyline landed. It is the better observation, so it enters the filters with
	 * `heavyWeight` times the information, and the offset between it and the filter (which has been
	 * following the cheap scan) is taken as the cheap scan's bias and removed from later cheap solves.
	 */
	const applyHeavy = (
		job: { time: number; sensor?: SensorSample },
		scan: ScanResult,
	) => {
		if (machine.phase !== "track") return;
		if (lastFrameTime - job.time > heavyMaxAgeMs) return;
		const sensor = sensorAngles(job.sensor);
		const prior = poseAt(job.time, sensor);
		if (!prior) return;
		const geom = geometryOf(scan);
		const columns = columnsFromSkyline({
			rows: scan.rows,
			weight: scan.weights,
			width: scan.width,
		});
		if (columns.filter((c) => c.w > 0.15).length < tuning.minColumns) return;
		const solved = solvePose(table, geom, columns, {
			prior,
			priorSigmaDeg: tuning.priorSigmaDeg,
			sigmaPx: tuning.sigmaPx,
			effectiveColumns: tuning.effectiveColumns,
		});
		if (
			!solved ||
			solved.inlierFraction < tuning.minInlierFraction ||
			solved.residualDeg > tuning.maxResidualDeg
		)
			return;
		const t = job.time / 1000;
		for (const a of AXES) {
			const delta = wrapDelta(prior[a] - solved.angles[a]);
			cheapBias[a] = Math.max(
				-MAX_CHEAP_BIAS_DEG,
				Math.min(MAX_CHEAP_BIAS_DEG, cheapBias[a] + BIAS_GAIN * delta),
			);
			const sigma = Math.hypot(solved.sigmaDeg[a], tuning.measurementFloorDeg);
			filters[a].update(
				solved.angles[a],
				sensorFor(a, sensor),
				(sigma * sigma) / heavyWeight,
				t,
			);
		}
		const fused = poseAt(lastFrameTime, lastSensorForNow());
		if (fused) emitPose(lastFrameTime, fused, solved.residualDeg, "skyline");
	};

	const api: Tracker = {
		get phase(): TrackerPhase {
			return machine.phase;
		},
		pushFrame(frame: TrackFrame) {
			if (disposed) return;
			lastFrameTime = frame.time;
			if (frame.sensor) {
				if (
					!sensorHistory.length ||
					sensorHistory[sensorHistory.length - 1].time !== frame.sensor.time
				) {
					sensorHistory.push(frame.sensor);
					if (sensorHistory.length > 240)
						sensorHistory = sensorHistory.slice(-120);
				}
				const fresh =
					frame.time - frame.sensor.time <= tuning.maxSensorAgeSeconds * 1000;
				if (fresh) {
					lastSensor = {
						yaw: frame.sensor.yaw,
						pitch: frame.sensor.pitch,
						roll: frame.sensor.roll,
					};
				}
			}
			if (options.keyframeBitmap) keyframeSource = frame.source;
			const myEpoch = epoch;
			const job = { time: frame.time, sensor: frame.sensor };
			const settle = (scan: ScanResult | null) => {
				if (disposed || myEpoch !== epoch) return;
				if (scan) processScan(job, scan);
				else emitPropagated(frame);
			};
			if (
				options.heavySkyline &&
				heavyEveryMs > 0 &&
				!heavyBusy &&
				machine.phase === "track" &&
				frame.time - heavyStartedAt >= heavyEveryMs
			) {
				heavyBusy = true;
				heavyStartedAt = frame.time;
				const done = () => {
					heavyBusy = false;
				};
				options.heavySkyline(frame).then((scan) => {
					done();
					if (scan && !disposed && myEpoch === epoch) applyHeavy(job, scan);
				}, done);
			}
			if (scanner.inFlight >= maxInFlight) {
				emitPropagated(frame);
				return;
			}
			scanner.scan(frame).then(settle, () => settle(null));
		},
		onPose(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		reset(prior) {
			epoch++;
			machine.reset();
			for (const a of AXES) filters[a].initialised = false;
			lastColumns = null;
			resetPrior = prior;
			for (const a of AXES) cheapBias[a] = 0;
			heavyBusy = false;
		},
		dispose() {
			disposed = true;
			epoch++;
			listeners.clear();
			scanner.dispose();
		},
	};
	return api;
}
