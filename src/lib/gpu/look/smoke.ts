// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hook smoke test for the opt-in GPU look passes (scripts/gpu/look-bench.mjs --fn lookSmoke
// --query "style=…"): waits for the engine's async results to land and summarises them,
// so a run can be compared with one under ?gpu=off (the CPU path).
import { setFlagOverride } from "#/lib/flags";
import { lookGpuOn } from "./opt-in";

type Field = { res: number; field: Uint8Array; ms: number } | null;
type Look = {
	masks: { w: number; h: number; data: Uint8Array; gen: number } | null;
	stats: { valid: boolean; count: Uint32Array; photoMean: Float32Array } | null;
	version: number;
};
type Eng = {
	// ReliefController: `current` may be GPU-resident (deck-webgpu bridge); bytes() reads it lazily
	relief: { field: Field; current?: unknown; bytes(): Promise<Field> };
	look?: Look;
	compLook?: Look;
	hazeFit: { visibility: number; quality: number; betaM: number } | null;
	settings: { mode: string };
	setSettings(s: object): void;
};

const channelMeans = (f: Uint8Array) => {
	const s = [0, 0, 0, 0];
	for (let i = 0; i < f.length; i += 4)
		for (let c = 0; c < 4; c++) s[c] += f[i + c];
	return s.map((v) => +(v / (f.length / 4)).toFixed(3));
};

export async function lookSmoke(
	engine: unknown,
	opts: { label?: string } = {},
) {
	const e = engine as Eng;
	const look = () => e.compLook as Look;
	const t0 = performance.now();
	const wait = async (ok: () => boolean, ms = 25000) => {
		const t = performance.now();
		while (!ok() && performance.now() - t < ms)
			await new Promise((r) => setTimeout(r, 250));
		return ok();
	};
	await wait(
		() =>
			!!(e.relief.current ?? e.relief.field) || !!e.hazeFit || !!look().masks,
		25000,
	);
	// let the rest (stats after the 120 ms timer, other passes) arrive
	await new Promise((r) => setTimeout(r, 3000));
	const f = await e.relief.bytes().catch(() => null);
	const L = look();
	return {
		label: opts.label,
		renderer: "deck",
		lookGpuOn: lookGpuOn(),
		waitedMs: Math.round(performance.now() - t0),
		relief: f
			? { res: f.res, ms: +f.ms.toFixed(1), means: channelMeans(f.field) }
			: null,
		haze: e.hazeFit
			? {
					visibility: +e.hazeFit.visibility.toFixed(0),
					quality: +e.hazeFit.quality.toFixed(4),
					betaM: e.hazeFit.betaM,
				}
			: null,
		masks: L.masks
			? {
					w: L.masks.w,
					h: L.masks.h,
					gen: L.masks.gen,
					means: channelMeans(L.masks.data),
				}
			: null,
		stats: L.stats
			? {
					valid: L.stats.valid,
					count: Array.from(L.stats.count),
					photoMeanL: Array.from(
						L.stats.photoMean.filter((_, i) => i % 3 === 0),
					).map((v) => +v.toFixed(5)),
				}
			: null,
		lookVersion: L.version,
	};
}

type Ctl = { key: string };
type Priv = {
	relief: Ctl & { field: Field; bytes(): Promise<Field> };
	haze: Ctl & { fit: Eng["hazeFit"] };
	fitHaze(): void;
	updateRelief(): void;
	updateLook(): void;
	look?: unknown;
	compLook?: { maskIn: unknown[]; masks: Look["masks"] };
};

/**
 * Same page, same inputs, through the real hooks: each controller is re-run with the opt-in forced
 * off (sync CPU) and then on (async GPU), and the results compared.
 */
export async function hookParity(
	engine: unknown,
	opts: { label?: string } = {},
) {
	const e = engine as Priv;
	const cl = e.compLook as {
		maskIn: unknown[];
		masks: Look["masks"];
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	await sleep(3000);
	const snap = async () => ({
		relief: (await e.relief.bytes().catch(() => null))?.field ?? null,
		fit: e.haze.fit,
		masks: cl.masks?.data ?? null,
	});
	const run = async (flag: string) => {
		setFlagOverride("gpu", flag);
		e.relief.key = "";
		e.haze.key = "";
		cl.maskIn = [];
		e.fitHaze();
		e.updateRelief();
		e.updateLook();
		await sleep(flag === "on" ? 3000 : 200);
		return snap();
	};
	const cpu = await run("off");
	const gpu = await run("on");
	setFlagOverride("gpu", undefined);
	const bytes = (a: Uint8Array | null, b: Uint8Array | null) => {
		if (!a || !b) return { present: [!!a, !!b] };
		let n = 0;
		let max = 0;
		for (let i = 0; i < a.length; i++) {
			const d = Math.abs(a[i] - b[i]);
			if (d) n++;
			if (d > max) max = d;
		}
		return { differing: n, of: a.length, max };
	};
	const rel = (a?: number, b?: number) =>
		a == null || b == null
			? null
			: Math.abs(a - b) / Math.max(1e-12, Math.abs(a));
	return {
		label: opts.label,
		renderer: "deck",
		relief: bytes(cpu.relief, gpu.relief),
		masks: bytes(cpu.masks, gpu.masks),
		haze:
			cpu.fit && gpu.fit
				? {
						visibility: [cpu.fit.visibility, gpu.fit.visibility],
						relVisibility: rel(cpu.fit.visibility, gpu.fit.visibility),
						relBetaM: rel(cpu.fit.betaM, gpu.fit.betaM),
						relQuality: rel(cpu.fit.quality, gpu.fit.quality),
					}
				: { present: [!!cpu.fit, !!gpu.fit] },
	};
}
