// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Temporal filter on the three angles. Each axis is one of two scalar Kalman filters:
//  - with a sensor reading: the state is the sensor's OFFSET (true angle minus reading), a slow
//    random walk. The pose is reading + offset, so the sensor's high-rate motion passes straight
//    through and the skyline only has to estimate bias and drift.
//  - without one (no compass heading, no sensor at all): constant velocity on the angle, with the
//    skyline measurement as the only evidence (alpha-beta behaviour from the Kalman gain).
// Measurements arrive late (the readback), so `update` takes the frame time and `valueAt` can
// evaluate the state at an earlier frame.

/** Wrap a difference of angles to [-180, 180). */
export const wrapDelta = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export interface AxisConfig {
	/** Offset random-walk σ, deg per sqrt(s) (sensor mode). */
	offsetNoise: number;
	/** Acceleration σ, deg/s^2 (constant-velocity mode). */
	acceleration: number;
	/** Wrap the angle at 360 (yaw). */
	wrap: boolean;
	/** Initial σ, degrees. */
	initialSigma: number;
}

export class AxisFilter {
	private mode: "offset" | "velocity" = "velocity";
	/** offset mode: x = offset; velocity mode: x = angle. */
	private x = 0;
	private v = 0;
	/** Covariance: offset mode uses pxx only; velocity mode the 2x2 [pxx pxv; pxv pvv]. */
	private pxx: number;
	private pxv = 0;
	private pvv = 100;
	private t = Number.NaN;
	initialised = false;

	constructor(private readonly config: AxisConfig) {
		this.pxx = config.initialSigma ** 2;
	}

	/** Start (or restart) from a known angle at time t. `sensor` non-null selects offset mode. */
	init(angle: number, sensor: number | null, t: number, sigma?: number) {
		this.t = t;
		this.pxx = (sigma ?? this.config.initialSigma) ** 2;
		this.pxv = 0;
		this.pvv = 100;
		this.v = 0;
		if (sensor !== null) {
			this.mode = "offset";
			this.x = this.config.wrap ? wrapDelta(angle - sensor) : angle - sensor;
		} else {
			this.mode = "velocity";
			this.x = angle;
		}
		this.initialised = true;
	}

	get sigma() {
		return Math.sqrt(this.pxx);
	}

	get usesSensor() {
		return this.mode === "offset";
	}

	/** Angle at time `t` given the sensor reading at that time (null without one). */
	valueAt(t: number, sensor: number | null): number {
		const a =
			this.mode === "offset" && sensor !== null
				? sensor + this.x
				: this.x + this.v * (t - this.t);
		return this.config.wrap ? ((a % 360) + 360) % 360 : a;
	}

	/** Advance the covariance (and a velocity-mode state) to time t. */
	predict(t: number) {
		const dt = t - this.t;
		// a late measurement (dt < 0) leaves the state alone; update() extrapolates back instead
		if (!Number.isFinite(dt) || dt <= 0) return;
		const a = dt;
		if (this.mode === "offset") {
			this.pxx += this.config.offsetNoise ** 2 * a;
		} else {
			const q = this.config.acceleration ** 2;
			this.x += this.v * dt;
			const pxx = this.pxx + 2 * dt * this.pxv + dt * dt * this.pvv;
			this.pxv += dt * this.pvv;
			this.pxx = pxx + (q * a ** 4) / 4;
			this.pxv += (q * a ** 3) / 2;
			this.pvv += q * a * a;
		}
		this.t = t;
	}

	/**
	 * Fuse a skyline measurement `z` (degrees) of variance `r` taken at time `t`, with the sensor
	 * reading at that time. Returns the innovation in degrees.
	 */
	update(z: number, sensor: number | null, r: number, t: number): number {
		this.predict(t);
		if (this.mode === "offset" && sensor === null) {
			// sensor dropped out: continue as a velocity filter from the current angle
			this.init(z, null, t);
			return 0;
		}
		if (this.mode === "velocity" && sensor !== null) {
			// a sensor appeared: switch to offset mode, keeping the variance
			this.init(z, sensor, t, Math.sqrt(r));
			return 0;
		}
		if (this.mode === "offset") {
			const innovation = this.config.wrap
				? wrapDelta(z - (sensor as number) - this.x)
				: z - (sensor as number) - this.x;
			const gain = this.pxx / (this.pxx + r);
			this.x += gain * innovation;
			this.pxx *= 1 - gain;
			return innovation;
		}
		const predicted = this.x + this.v * (t - this.t);
		const innovation = this.config.wrap
			? wrapDelta(z - predicted)
			: z - predicted;
		const s = this.pxx + r;
		const kx = this.pxx / s;
		const kv = this.pxv / s;
		this.x += kx * innovation;
		this.v += kv * innovation;
		const pxx = (1 - kx) * this.pxx;
		const pxv = (1 - kx) * this.pxv;
		const pvv = this.pvv - kv * this.pxv;
		this.pxx = pxx;
		this.pxv = pxv;
		this.pvv = pvv;
		return innovation;
	}
}
