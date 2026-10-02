// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
/**
 * ALIKED + LightGlue off the main thread. The worker owns its nn runtime (its own compute device under
 * WebGPU, like the sky and eye workers) and keeps the weights loaded between requests. Requests run
 * one at a time in arrival order; `abort` cancels one between graph submissions.
 */
import { extractFeatures, featuresAvailable, matchFeatures } from "./index";
import type { FeaturesRequest, FeaturesResponse } from "./protocol";

const controllers = new Map<number, AbortController>();
let queue: Promise<unknown> = Promise.resolve();

const post = (m: FeaturesResponse, transfer: Transferable[] = []) =>
	(self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = (ev: MessageEvent<FeaturesRequest>) => {
	const req = ev.data;
	if (req.op === "abort") {
		controllers.get(req.id)?.abort();
		return;
	}
	const ctl = new AbortController();
	controllers.set(req.id, ctl);
	queue = queue.then(async () => {
		try {
			const signal = ctl.signal;
			if (req.op === "available")
				post({ id: req.id, ok: true, result: await featuresAvailable() });
			else if (req.op === "extract") {
				const f = await extractFeatures(req.image, {
					maxKeypoints: req.maxKeypoints,
					longSide: req.longSide,
					signal,
				});
				post({ id: req.id, ok: true, result: f }, [
					f.keypoints.buffer,
					f.scores.buffer,
					f.descriptors.buffer,
				]);
			} else {
				const m = await matchFeatures(req.a, req.b, {
					minScore: req.minScore,
					signal,
				});
				post({ id: req.id, ok: true, result: m }, [
					m.indices0.buffer,
					m.indices1.buffer,
					m.scores.buffer,
				]);
			}
		} catch (e) {
			post({
				id: req.id,
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				abort: (e as { name?: string })?.name === "AbortError",
			});
		} finally {
			controllers.delete(req.id);
		}
	});
};
