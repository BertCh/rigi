// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Drives a reveal on any Renderer that implements setReveal (both engines): measures the view's
// distance / elevation windows from the CPU geometry buffer, then animates the front with rAF and
// hands the shader its per-frame uniforms. Engine-agnostic: only the Renderer interface.
import { poseBasis } from "../camera";
import { DEG as D } from "../geodesy";
import type { Renderer } from "../renderer";
import {
	EASE,
	equalise,
	fieldAt,
	frontAt,
	hexToLinear,
	presetById,
	REVEAL_MODE,
	type RevealConfig,
	type RevealUniforms,
} from "./config";

/** What labels need each frame: the front and a way to place any point on the field. */
export type RevealFrame = {
	/** front position in field units */
	p: number;
	soft: number;
	/** field value for an image point (u right, v down), its range (m) and elevation (m) */
	fieldOf: (
		u: number,
		v: number,
		rangeM: number,
		eleM: number | null,
	) => number;
};

function percentile(sorted: number[], q: number) {
	if (!sorted.length) return 0;
	const i = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round(q * (sorted.length - 1))),
	);
	return sorted[i];
}

export class RevealController {
	private raf = 0;
	private run = 0;
	private base: Omit<RevealUniforms, "a"> | null = null;

	constructor(
		private engine: Renderer,
		private onFrame?: (f: RevealFrame | null) => void,
	) {}

	get supported() {
		return !!this.engine.setReveal;
	}

	/** Hide the overlay until play() (terrain may render while the pose is still being solved). */
	hold(cfg: RevealConfig) {
		cancelAnimationFrame(this.raf);
		this.run++;
		this.applyHold(cfg);
	}

	private applyHold(cfg: RevealConfig) {
		if (!this.engine.setReveal) return;
		const u = this.uniforms(cfg, this.base ?? this.fallbackBase(cfg));
		this.engine.setReveal({ ...u, a: [0, u.a[1], u.a[2], u.a[3]] });
		// labels wait for the front too
		this.onFrame?.({ p: -Infinity, soft: u.shape[0], fieldOf: () => 0 });
	}

	stop() {
		cancelAnimationFrame(this.raf);
		this.run++;
		this.engine.setReveal(null);
		this.onFrame?.(null);
	}

	/** Measure the view, then animate. Resolves when done (or superseded). */
	async play(cfg: RevealConfig) {
		const engine = this.engine;
		if (!engine.setReveal) return;
		const run = ++this.run;
		cancelAnimationFrame(this.raf);
		this.applyHold(cfg);
		if (!(await engine.readback()) || run !== this.run) return;
		this.base = this.measure(cfg);
		const preset = presetById(cfg.preset);
		const dur = (cfg.duration ?? preset.duration) * 1000;
		const t0 = performance.now();
		await new Promise<void>((done) => {
			const tick = () => {
				if (run !== this.run) return done();
				const k = Math.min(1, (performance.now() - t0) / Math.max(dur, 1));
				if (k < 1) {
					this.show(cfg, k);
					this.raf = requestAnimationFrame(tick);
				} else {
					engine.setReveal(null);
					this.onFrame?.(null);
					done();
				}
			};
			this.raf = requestAnimationFrame(tick);
		});
	}

	/**
	 * Freeze the reveal at linear progress k (0..1) for scrubbing; null ends it. Reuses the last
	 * measurement (play() refreshes it) unless `remeasure`.
	 */
	async seek(cfg: RevealConfig, k: number | null, remeasure = false) {
		const engine = this.engine;
		if (!engine.setReveal) return;
		const run = ++this.run;
		cancelAnimationFrame(this.raf);
		if (k == null || k >= 1) {
			engine.setReveal(null);
			this.onFrame?.(null);
			return;
		}
		if (!this.base || remeasure) {
			if (!(await engine.readback()) || run !== this.run) return;
			this.base = this.measure(cfg);
		}
		this.show(cfg, k);
	}

	/** One frame at linear progress k: shader uniforms + the labels' field. */
	private show(cfg: RevealConfig, k: number) {
		const engine = this.engine;
		const u = this.uniforms(cfg, this.base ?? this.fallbackBase(cfg));
		const t = EASE[presetById(cfg.preset).easing](Math.min(1, Math.max(0, k)));
		const [soft, , grain] = u.shape;
		const mode = u.a[1];
		const win = u.win;
		const aspect = engine.aspect;
		const fieldOf = (
			uu: number,
			v: number,
			rangeM: number,
			ele: number | null,
		) =>
			fieldAt(
				mode,
				uu,
				1 - v,
				equalise(Math.log(Math.max(rangeM, 1)), win[0], u.qD, win[1]),
				ele == null ? 1 : equalise(ele, win[2], u.qE, win[3]),
				u.focus,
				aspect,
				cfg.reverse,
			);
		// uniforms() takes the ray basis from the current pose, so a drag mid-reveal stays consistent
		engine.setReveal({ ...u, a: [t, u.a[1], u.a[2], u.a[3]] });
		this.onFrame?.({ p: frontAt(t, soft, grain), soft, fieldOf });
	}

	dispose() {
		cancelAnimationFrame(this.raf);
		this.run++;
	}

	private uniforms(
		cfg: RevealConfig,
		base: Omit<RevealUniforms, "a">,
	): RevealUniforms {
		const preset = presetById(cfg.preset);
		const [r, g, b] = hexToLinear(cfg.color ?? preset.color);
		return {
			...base,
			...rayBasis(this.engine),
			a: [0, REVEAL_MODE[cfg.preset], this.engine.eyeAlt, cfg.reverse ? 2 : 1],
			shape: [
				preset.soft * cfg.soft,
				preset.glowWidth * Math.max(0.5, cfg.soft),
				preset.grain * cfg.grain,
				cfg.dim,
			],
			glow: [r, g, b, cfg.glow * 1.1],
		};
	}

	private fallbackBase(cfg: RevealConfig): Omit<RevealUniforms, "a"> {
		const h = this.engine.eyeAlt;
		return {
			...rayBasis(this.engine),
			win: [Math.log(300), Math.log(60000), h - 1500, h + 1500],
			qD: evenKnots(Math.log(300), Math.log(60000)),
			qE: evenKnots(h - 1500, h + 1500),
			shape: [0.1, 0.05, 0, cfg.dim],
			focus: [0.5, 0.6, 0.5, 1],
			glow: [1, 1, 1, 0],
		};
	}

	/**
	 * Distance / elevation windows and area quantiles from a grid of geometry samples, over the terrain
	 * the overlay actually shows (not the near-faded ground at your feet, not people); the focus is
	 * the top-ranked peak.
	 */
	private measure(cfg: RevealConfig): Omit<RevealUniforms, "a"> {
		const e = this.engine;
		const near = e.settings.mode === "overlay" ? e.settings.nearFade : 0;
		const lr: number[] = [];
		const hs: number[] = [];
		let top: { u: number; v: number; h: number; r: number } | null = null;
		const NX = 64;
		const NY = 48;
		for (let j = 0; j < NY; j++)
			for (let i = 0; i < NX; i++) {
				const u = (i + 0.5) / NX;
				const v = (j + 0.5) / NY;
				const s = e.sampleAt(u, v);
				if (!s || !(s.range > near) || e.isForeground(u, v)) continue;
				lr.push(Math.log(s.range));
				hs.push(s.h);
				if (!top || s.h > top.h) top = { u, v, h: s.h, r: s.range };
			}
		const fb = this.fallbackBase(cfg);
		if (lr.length < 24) return fb;
		lr.sort((a, b) => a - b);
		hs.sort((a, b) => a - b);
		const q = (a: number[], lo: number, hi: number, min: number) => {
			const l = percentile(a, lo);
			const h = Math.max(percentile(a, hi), l + min);
			const k = [0.2, 0.4, 0.6, 0.8].map((x) =>
				Math.min(h, Math.max(l, percentile(a, x))),
			);
			return { l, h, k: k as [number, number, number, number] };
		};
		const d = q(lr, 0.02, 0.98, 0.5);
		const el = q(hs, 0.01, 0.995, 50);
		const win: RevealUniforms["win"] = [d.l, d.h, el.l, el.h];
		const peak = e
			.peakLabels(8)
			.find((l) => l.visible && l.u > 0 && l.u < 1 && l.v > 0 && l.v < 1);
		const fu = peak?.u ?? top?.u ?? 0.5;
		const fv = peak?.v ?? top?.v ?? 0.4;
		const fr = peak ? peak.distKm * 1000 : (top?.r ?? 5000);
		const fh = peak?.ele ?? top?.h ?? win[3];
		return {
			...fb,
			win,
			qD: d.k,
			qE: el.k,
			focus: [
				fu,
				1 - fv,
				equalise(Math.log(fr), d.l, d.k, d.h),
				equalise(fh, el.l, el.k, el.h),
			],
		};
	}
}

const evenKnots = (
	lo: number,
	hi: number,
): [number, number, number, number] => [
	lo + (hi - lo) * 0.2,
	lo + (hi - lo) * 0.4,
	lo + (hi - lo) * 0.6,
	lo + (hi - lo) * 0.8,
];

/** dir = F + R·(2u−1) + U·(2v−1) (v up): camera.unprojectDir's basis, pre-scaled by the FOV. */
function rayBasis(e: Renderer): Pick<RevealUniforms, "F" | "R" | "U"> {
	const { forward, right, up } = poseBasis(e.pose);
	const t = Math.tan((e.pose.vfov * D) / 2);
	const ta = t * e.aspect;
	return {
		F: [forward[0], forward[1], forward[2]],
		R: [right[0] * ta, right[1] * ta, right[2] * ta],
		U: [up[0] * t, up[1] * t, up[2] * t],
	};
}
