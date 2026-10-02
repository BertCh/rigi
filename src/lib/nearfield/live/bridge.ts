// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hands a LiveNearField's splats to a renderer.
//   WebGPU engine (setNearFieldLive): the GPU buffer is drawn directly; nothing is read back.
//   WebGL2 engine (no setNearFieldLive): a low-rate readback (≤ 2 Hz) of the lift records into a
//   NearFieldScene for the existing setNearField path. The session must be created with `writeCloud`.
// The live session runs on the compute device; the WebGL2 engine's context is another device, which is why
// the fallback goes through a CPU cloud.
import type {
	AnchorFit,
	NearFieldScene,
	NearFieldViewOpts,
	SplitResult,
} from "../types";
import type { LiveNearField } from "./session";
import type { LiveSplatSource } from "./types";

/** The renderer members the bridge uses (both engines satisfy it structurally). */
export type LiveSplatHost = {
	setNearFieldLive?(
		source: LiveSplatSource | null,
		opts?: NearFieldViewOpts,
	): void;
	setNearField?(scene: NearFieldScene | null, opts?: NearFieldViewOpts): void;
};

/** The fallback never reads back faster than this (Hz). */
export const FALLBACK_MAX_HZ = 2;

const IDENTITY_ANCHOR: AnchorFit = {
	scale: 1,
	shift: 0,
	residualLog: 0,
	inlierFrac: 1,
	n: 0,
	quality: 1,
	maxRange: 3000,
};

/** Fallback poll interval in ms for a requested rate (clamped to at most FALLBACK_MAX_HZ). */
export function fallbackIntervalMs(hz: number | undefined): number {
	const rate = Math.min(FALLBACK_MAX_HZ, Math.max(0.05, hz ?? FALLBACK_MAX_HZ));
	return 1000 / rate;
}

export class LiveSplatBridge {
	readonly mode: "gpu" | "readback";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private stopped = false;
	private lastVersion = -1;
	private readonly split: SplitResult;

	constructor(
		private readonly host: LiveSplatHost,
		private readonly live: LiveNearField,
		private readonly opts: {
			photoId?: string;
			view?: NearFieldViewOpts;
			/** Fallback rate in Hz (clamped to 2). */
			hz?: number;
			confidenceRadius?: number;
		} = {},
	) {
		this.mode = host.setNearFieldLive ? "gpu" : "readback";
		const n = live.width * live.height;
		// every pixel Sky (class 0): no Object pixels, so the fallback scene masks nothing in the drape
		this.split = {
			width: live.width,
			height: live.height,
			cls: new Uint8Array(n),
			counts: [n, 0, 0, 0, 0],
		};
	}

	start() {
		this.stopped = false;
		if (this.host.setNearFieldLive) {
			this.host.setNearFieldLive(this.live.source, this.opts.view);
			return;
		}
		this.schedule(0);
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.host.setNearFieldLive) this.host.setNearFieldLive(null);
		else this.host.setNearField?.(null);
	}

	private schedule(ms: number) {
		if (this.stopped) return;
		this.timer = setTimeout(() => void this.tick(), ms);
	}

	private async tick() {
		const wait = fallbackIntervalMs(this.opts.hz);
		if (this.stopped) return;
		const version = this.live.source.getVersion();
		if (this.inFlight || version === this.lastVersion) {
			this.schedule(wait);
			return;
		}
		this.inFlight = true;
		try {
			const cloud = await this.live.readCloud();
			if (this.stopped) return;
			this.lastVersion = version;
			const scene: NearFieldScene = {
				photoId: this.opts.photoId ?? "live",
				anchor: this.live.calibration?.anchor ?? IDENTITY_ANCHOR,
				split: this.split,
				splats: cloud,
				confidenceRadius: this.opts.confidenceRadius ?? 30,
				model: "live-lift",
			};
			this.host.setNearField?.(
				scene.splats.count ? scene : null,
				this.opts.view,
			);
		} catch (e) {
			console.warn("[live nearfield] fallback readback failed", e);
		} finally {
			this.inFlight = false;
			this.schedule(wait);
		}
	}
}
