// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The src/lib/features interface backed by a dedicated worker (one per page, created on first use,
 * weights loaded once there). Same signatures as ./index; falls back to this thread when workers are
 * unavailable. FeatureSets passed to `matchFeatures` are copied (structured clone), not transferred,
 * so callers can reuse them.
 */
import type {
	extractFeatures as ExtractFn,
	FeatureMatches,
	FeatureSet,
	ImageInput,
	matchFeatures as MatchFn,
} from "./index";
import type { FeaturesRequest, FeaturesResponse } from "./protocol";

type Pending = {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
};

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		worker = new Worker(new URL("./features.worker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		worker = null;
		return null;
	}
	worker.onmessage = (ev: MessageEvent<FeaturesResponse>) => {
		const m = ev.data;
		const p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		if (m.ok) p.resolve(m.result);
		else
			p.reject(
				m.abort ? new DOMException(m.error, "AbortError") : new Error(m.error),
			);
	};
	worker.onerror = (e) => {
		for (const p of pending.values())
			p.reject(new Error(e.message || "features worker failed"));
		pending.clear();
		worker?.terminate();
		worker = undefined;
	};
	return worker;
}

function call<T>(
	req: FeaturesRequest extends infer R
		? R extends FeaturesRequest
			? Omit<R, "id">
			: never
		: never,
	signal?: AbortSignal,
	transfer: Transferable[] = [],
): Promise<T> | null {
	const w = getWorker();
	if (!w) return null;
	if (signal?.aborted)
		return Promise.reject(
			signal.reason ?? new DOMException("Aborted", "AbortError"),
		);
	const id = nextId++;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => w.postMessage({ id, op: "abort" } as FeaturesRequest);
		signal?.addEventListener("abort", onAbort, { once: true });
		pending.set(id, {
			resolve: (v) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(v as T);
			},
			reject: (e) => {
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			},
		});
		w.postMessage({ ...req, id } as FeaturesRequest, transfer);
	});
}

const local = () => import("./index");

export async function featuresAvailable(): Promise<boolean> {
	return (
		(await call<boolean>({ op: "available" })) ??
		(await local()).featuresAvailable()
	);
}

export const extractFeatures: typeof ExtractFn = async (
	image: ImageInput,
	opts = {},
): Promise<FeatureSet> => {
	const { signal, ...rest } = opts;
	return (
		(await call<FeatureSet>({ op: "extract", image, ...rest }, signal)) ??
		(await local()).extractFeatures(image, opts)
	);
};

export const matchFeatures: typeof MatchFn = async (
	a: FeatureSet,
	b: FeatureSet,
	opts = {},
): Promise<FeatureMatches> => {
	const { signal, ...rest } = opts;
	return (
		(await call<FeatureMatches>({ op: "match", a, b, ...rest }, signal)) ??
		(await local()).matchFeatures(a, b, opts)
	);
};
