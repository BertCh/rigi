// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Device orientation → SensorSample in the Pose convention (src/lib/camera/index.ts): yaw clockwise from
// true north, pitch up +, roll right side down +, of the REAR camera as it looks at the scene, in the
// screen's current orientation.
//
// Sources, best first: AbsoluteOrientationSensor (Chrome Android, fused quaternion, no accuracy),
// `deviceorientationabsolute` (Android, alpha from magnetic north), iOS `deviceorientation` with
// `webkitCompassHeading` (alpha is relative there, so the heading replaces it), and plain
// `deviceorientation` (relative yaw only: yaw = null, `yawRelative` set). iOS 13+ needs
// DeviceOrientationEvent.requestPermission() from a user gesture (requestMotionPermission).
//
// The math is pure and unit-tested: W3C Z-X'-Y'' Euler (alpha, beta, gamma) or a quaternion gives the
// device → earth (ENU) rotation; the camera looks along device -z, and the screen angle picks which device
// axes are image right and up.

import { DEG, wrap180, wrap360 } from "../geodesy";
import type { SensorSample } from "./contract";
import { magneticDeclination } from "./declination";

/** Row-major 3×3 rotation: columns are the device x, y, z axes in ENU (east, north, up). */
export type RotationMatrix = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/** W3C DeviceOrientation: R = Rz(alpha) · Rx(beta) · Ry(gamma), degrees. */
export function eulerToRotation(
	alpha: number,
	beta: number,
	gamma: number,
): RotationMatrix {
	const a = alpha * DEG;
	const b = beta * DEG;
	const g = gamma * DEG;
	const cA = Math.cos(a);
	const sA = Math.sin(a);
	const cB = Math.cos(b);
	const sB = Math.sin(b);
	const cG = Math.cos(g);
	const sG = Math.sin(g);
	return [
		cA * cG - sA * sB * sG,
		-sA * cB,
		cA * sG + sA * sB * cG,
		sA * cG + cA * sB * sG,
		cA * cB,
		sA * sG - cA * sB * cG,
		-cB * sG,
		sB,
		cB * cG,
	];
}

/** Unit quaternion [x, y, z, w] (the Generic Sensor API order, device → earth) to a rotation. */
export function quaternionToRotation(q: ArrayLike<number>): RotationMatrix {
	const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
	const norm = Math.hypot(x, y, z, w) || 1;
	const [qx, qy, qz, qw] = [x / norm, y / norm, z / norm, w / norm];
	return [
		1 - 2 * (qy * qy + qz * qz),
		2 * (qx * qy - qz * qw),
		2 * (qx * qz + qy * qw),
		2 * (qx * qy + qz * qw),
		1 - 2 * (qx * qx + qz * qz),
		2 * (qy * qz - qx * qw),
		2 * (qx * qz - qy * qw),
		2 * (qy * qz + qx * qw),
		1 - 2 * (qx * qx + qy * qy),
	];
}

/**
 * Camera yaw / pitch / roll (degrees, yaw in [0, 360) in the rotation's own north) from a device → ENU
 * rotation. `screenAngle` is screen.orientation.angle: 0 portrait, 90 landscape with the top of the device
 * turned left, 180, 270.
 */
export function rotationToPose(
	rotation: RotationMatrix,
	screenAngle = 0,
): { yaw: number; pitch: number; roll: number } {
	const r = rotation;
	const s = Math.sin(screenAngle * DEG);
	const c = Math.cos(screenAngle * DEG);
	const column = (i: number): [number, number, number] => [
		r[i],
		r[3 + i],
		r[6 + i],
	];
	const [xAxis, yAxis, zAxis] = [column(0), column(1), column(2)];
	// image up = device (sin, cos, 0), image right = device (cos, -sin, 0), forward = device -z
	const forward = [-zAxis[0], -zAxis[1], -zAxis[2]];
	const right = [0, 1, 2].map((i) => xAxis[i] * c - yAxis[i] * s);
	const yaw = wrap360(Math.atan2(forward[0], forward[1]) / DEG);
	const pitch = Math.asin(Math.max(-1, Math.min(1, forward[2]))) / DEG;
	// level right vector and up vector of the pose basis (camera/index.ts poseBasis)
	const yawRad = yaw * DEG;
	const levelRight = [Math.cos(yawRad), -Math.sin(yawRad), 0];
	const levelUp = [
		levelRight[1] * forward[2] - levelRight[2] * forward[1],
		levelRight[2] * forward[0] - levelRight[0] * forward[2],
		levelRight[0] * forward[1] - levelRight[1] * forward[0],
	];
	const dot = (a: number[], b: number[]) =>
		a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const roll = Math.atan2(-dot(right, levelUp), dot(right, levelRight)) / DEG;
	return { yaw, pitch, roll };
}

/** Euler angles to a camera pose (convenience over eulerToRotation + rotationToPose). */
export function poseFromEuler(
	alpha: number,
	beta: number,
	gamma: number,
	screenAngle = 0,
) {
	return rotationToPose(eulerToRotation(alpha, beta, gamma), screenAngle);
}

export type OrientationReading = {
	alpha: number | null;
	beta: number | null;
	gamma: number | null;
	/** true: alpha is from magnetic north (deviceorientationabsolute). */
	absolute?: boolean;
	/** iOS: degrees clockwise from magnetic north, consistent with alpha = 360 - heading. */
	webkitCompassHeading?: number | null;
	/** iOS: degrees of compass error (negative = invalid). */
	webkitCompassAccuracy?: number | null;
};

/**
 * One event reading to a sample. `declination` (degrees east) converts magnetic to true north and is applied
 * only when the heading is magnetic. Returns null for an incomplete event (all-null desktop events).
 */
export function sampleFromOrientation(
	reading: OrientationReading,
	options: { time: number; screenAngle: number; declination: number },
): SensorSample | null {
	const { beta, gamma } = reading;
	if (beta == null || gamma == null) return null;
	const compass = reading.webkitCompassHeading;
	const hasCompass = compass != null && Number.isFinite(compass);
	const absolute = reading.absolute === true || hasCompass;
	let alpha = reading.alpha;
	if (hasCompass) alpha = 360 - (compass as number);
	if (alpha == null) alpha = 0;
	const pose = poseFromEuler(alpha, beta, gamma, options.screenAngle);
	const sample: SensorSample = {
		time: options.time,
		yaw: absolute ? wrap360(pose.yaw + options.declination) : null,
		pitch: pose.pitch,
		roll: pose.roll,
	};
	if (!absolute) sample.yawRelative = pose.yaw;
	const accuracy = reading.webkitCompassAccuracy;
	if (hasCompass && accuracy != null && accuracy >= 0)
		sample.yawAccuracy = accuracy;
	return sample;
}

/** Sample from an AbsoluteOrientationSensor quaternion. */
export function sampleFromQuaternion(
	quaternion: ArrayLike<number>,
	options: { time: number; screenAngle: number; declination: number },
): SensorSample {
	const pose = rotationToPose(
		quaternionToRotation(quaternion),
		options.screenAngle,
	);
	return {
		time: options.time,
		yaw: wrap360(pose.yaw + options.declination),
		pitch: pose.pitch,
		roll: pose.roll,
	};
}

/** Smallest signed difference a - b in degrees, for yaw comparisons. */
export const yawDifference = (a: number, b: number) => wrap180(a - b);

/** Current screen angle in degrees (0 when unknown). */
export function currentScreenAngle(): number {
	if (typeof screen !== "undefined" && screen.orientation?.angle != null)
		return screen.orientation.angle;
	const legacy = (globalThis as { orientation?: number }).orientation;
	return typeof legacy === "number" ? legacy : 0;
}

export type MotionPermission = "granted" | "denied" | "unsupported";

/** iOS 13+: must be called from a user gesture. Elsewhere resolves "granted" when events exist. */
export async function requestMotionPermission(): Promise<MotionPermission> {
	if (typeof DeviceOrientationEvent === "undefined") return "unsupported";
	const ctor = DeviceOrientationEvent as unknown as {
		requestPermission?: () => Promise<"granted" | "denied">;
	};
	if (typeof ctor.requestPermission !== "function") return "granted";
	try {
		return (await ctor.requestPermission()) === "granted"
			? "granted"
			: "denied";
	} catch {
		return "denied";
	}
}

export type SensorSourceKind =
	| "absolute-sensor"
	| "orientation-absolute"
	| "orientation"
	| "none";

export interface SensorFeed {
	readonly kind: SensorSourceKind;
	/** Latest sample, or null before the first event. */
	latest(): SensorSample | null;
	/** Degrees east added to magnetic headings (from the eye position once known; 0 until then). */
	setDeclination(degrees: number): void;
	/** Declination for a position, via the compact model; updates the feed too. */
	setPosition(lat: number, lon: number): number;
	dispose(): void;
}

type SensorOptions = {
	/** Prefer the Generic Sensor API when present (default true). */
	preferSensor?: boolean;
	/** Fixed declination override in degrees; the position-derived value is ignored. */
	declinationOverride?: number | null;
	now?: () => number;
	onSample?: (s: SensorSample) => void;
};

/** Start listening. Never throws; `kind` is "none" when nothing delivers. Call after requestMotionPermission. */
export function startSensors(options: SensorOptions = {}): SensorFeed {
	const now = options.now ?? (() => performance.now());
	let declination = options.declinationOverride ?? 0;
	let latest: SensorSample | null = null;
	let kind: SensorSourceKind = "none";
	let sensor: {
		start(): void;
		stop(): void;
		addEventListener: (t: string, f: () => void) => void;
		quaternion?: number[];
	} | null = null;
	const cleanups: (() => void)[] = [];

	const publish = (sample: SensorSample | null) => {
		if (!sample) return;
		latest = sample;
		options.onSample?.(sample);
	};

	const listen = (
		name: "deviceorientation" | "deviceorientationabsolute",
		absolute: boolean,
	) => {
		const handler = (event: Event) => {
			const e = event as DeviceOrientationEvent & {
				webkitCompassHeading?: number;
				webkitCompassAccuracy?: number;
			};
			if (kind === "absolute-sensor") return;
			// once an absolute stream exists, ignore the relative one
			if (name === "deviceorientation" && kind === "orientation-absolute")
				return;
			if (name === "deviceorientationabsolute") kind = "orientation-absolute";
			else if (kind === "none") kind = "orientation";
			publish(
				sampleFromOrientation(
					{
						alpha: e.alpha,
						beta: e.beta,
						gamma: e.gamma,
						absolute: absolute || e.absolute === true,
						webkitCompassHeading: e.webkitCompassHeading,
						webkitCompassAccuracy: e.webkitCompassAccuracy,
					},
					{ time: now(), screenAngle: currentScreenAngle(), declination },
				),
			);
		};
		window.addEventListener(name, handler as EventListener);
		cleanups.push(() =>
			window.removeEventListener(name, handler as EventListener),
		);
	};

	const SensorCtor = (
		globalThis as {
			AbsoluteOrientationSensor?: new (o: object) => NonNullable<typeof sensor>;
		}
	).AbsoluteOrientationSensor;
	if (options.preferSensor !== false && SensorCtor) {
		try {
			const s = new SensorCtor({ frequency: 60, referenceFrame: "screen" });
			// referenceFrame "screen" already folds the screen rotation in: pass angle 0
			s.addEventListener("reading", () => {
				if (!s.quaternion) return;
				kind = "absolute-sensor";
				publish(
					sampleFromQuaternion(s.quaternion, {
						time: now(),
						screenAngle: 0,
						declination,
					}),
				);
			});
			s.addEventListener("error", () => {
				if (kind === "absolute-sensor") kind = "none";
			});
			s.start();
			sensor = s;
		} catch {
			sensor = null;
		}
	}
	if (typeof window !== "undefined") {
		listen("deviceorientationabsolute", true);
		listen("deviceorientation", false);
	}

	return {
		get kind() {
			return kind;
		},
		latest: () => latest,
		setDeclination(degrees) {
			if (options.declinationOverride == null) declination = degrees;
		},
		setPosition(lat, lon) {
			const value =
				options.declinationOverride ?? magneticDeclination(lat, lon);
			declination = value;
			return value;
		},
		dispose() {
			sensor?.stop();
			for (const c of cleanups) c();
		},
	};
}
