// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page side of ./solve.worker.ts: assemble / legacySolve in one shared module worker, with the
// in-thread functions as the fallback (no Worker, as in node and the unit specs, or a worker error).

import type { Pose } from "#/lib/camera";
import { type RealmGpuOptions, realmGpuOptions } from "#/lib/gpu/core/realm";
import { gpuEnabled } from "#/lib/gpu/device";
import { assemble, Deadline, type StageResult } from "./assemble";
import type { BasinGap } from "./basin";
import type { BasinJob } from "./basin-run";
import { type Correspondences, type LegacySolve, legacySolve } from "./core";
import type { SkylineCue } from "./fusion";

type ViewPoses = { pose: Pose }[];
type AssembleOpts = Parameters<typeof assemble>[5];

export type SolveJob = {
	id: number;
	gpu: boolean;
	gpuOpts?: RealmGpuOptions;
} & (
	| {
			kind: "assemble";
			corr: Correspondences;
			views: ViewPoses;
			eye: number[];
			prior: Pose;
			sk: SkylineCue | null;
			opts: AssembleOpts;
	  }
	| {
			kind: "legacy";
			corr: Correspondences;
			views: ViewPoses;
			eye: number[];
			prior: Pose;
			opts: { freeFocal?: boolean };
	  }
	| { kind: "basin"; basin: BasinJob }
);
export type SolveReply =
	| { id: number; ok: true; result: StageResult | LegacySolve | BasinGap }
	| { id: number; ok: false; error: string; name?: string };

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<
	number,
	{
		resolve: (r: StageResult | LegacySolve | BasinGap) => void;
		reject: (e: Error) => void;
	}
>();

function getWorker(): Worker | null {
	if (broken || typeof Worker === "undefined" || typeof window === "undefined")
		return null;
	if (worker) return worker;
	try {
		worker = new Worker(new URL("./solve.worker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		broken = true;
		return null;
	}
	worker.onmessage = (ev: MessageEvent<SolveReply>) => {
		const p = pending.get(ev.data.id);
		if (!p) return;
		pending.delete(ev.data.id);
		if (ev.data.ok) p.resolve(ev.data.result);
		else {
			const e = new Error(ev.data.error);
			if (ev.data.name === "Deadline") p.reject(new Deadline());
			else {
				e.name = ev.data.name ?? "Error";
				p.reject(e);
			}
		}
	};
	worker.onerror = (e) => {
		broken = true;
		const err = new Error(e.message || "matcher solve worker failed");
		for (const p of pending.values()) p.reject(err);
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	return worker;
}

type JobBody = SolveJob extends infer J
	? J extends SolveJob
		? Omit<J, "id" | "gpu" | "gpuOpts">
		: never
	: never;

function post<T extends StageResult | LegacySolve | BasinGap>(
	body: JobBody,
): Promise<T> | null {
	const w = getWorker();
	if (!w) return null;
	const id = ++seq;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, {
			resolve: resolve as (r: StageResult | LegacySolve | BasinGap) => void,
			reject,
		});
		w.postMessage({
			...body,
			id,
			gpu: gpuEnabled(),
			gpuOpts: realmGpuOptions(),
		} as SolveJob);
	});
}

/** assemble() in the solve worker (in-thread without one). */
export function assembleOffThread(
	corr: Correspondences,
	views: ViewPoses,
	eye: ArrayLike<number>,
	prior: Pose,
	sk: SkylineCue | null,
	opts: AssembleOpts,
): Promise<StageResult> {
	const v = views.map((x) => ({ pose: x.pose }));
	const e = Array.from(eye);
	return (
		post<StageResult>({
			kind: "assemble",
			corr,
			views: v,
			eye: e,
			prior,
			sk,
			opts,
		}) ?? assemble(corr, v, e, prior, sk, opts)
	);
}

/** legacySolve() in the solve worker (in-thread without one). */
export function legacySolveOffThread(
	corr: Correspondences,
	views: ViewPoses,
	eye: ArrayLike<number>,
	prior: Pose,
	opts: { freeFocal?: boolean } = {},
): Promise<LegacySolve> {
	const v = views.map((x) => ({ pose: x.pose }));
	const e = Array.from(eye);
	return (
		post<LegacySolve>({
			kind: "legacy",
			corr,
			views: v,
			eye: e,
			prior,
			opts,
		}) ?? legacySolve(corr, v, e, prior, opts)
	);
}

/** The position-grid basin gap in the solve worker (in-thread without one). */
export async function basinGapOffThread(job: BasinJob): Promise<BasinGap> {
	return (
		post<BasinGap>({ kind: "basin", basin: job }) ??
		(await import("./basin-run")).runBasinGap(job)
	);
}
