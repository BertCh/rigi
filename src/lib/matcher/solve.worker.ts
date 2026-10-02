// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
// The matcher's numeric solves off the main thread: one stage-2 assemble (legacy rotation RANSAC on the
// worker's compute graph when the page allows the GPU, the fused skyline + match LM, the HIGH/LOW rule)
// or one legacy render-match solve. The page keeps rendering and keypoint matching (they need the engine).

import { applyRealmGpuOptions } from "#/lib/gpu/core/realm";
import { assemble } from "./assemble";
import { legacySolve } from "./core";
import type { SolveJob, SolveReply } from "./solve-offthread";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<SolveJob>) => {
	const job = ev.data;
	applyRealmGpuOptions(job.gpuOpts);
	// ?gpu=off on the page: this realm stays on the CPU too
	if (!job.gpu)
		(globalThis as { __RIGI_FLAGS__?: Record<string, string> }).__RIGI_FLAGS__ =
			{
				gpu: "off",
			};
	let reply: SolveReply;
	try {
		const result =
			job.kind === "assemble"
				? await assemble(
						job.corr,
						job.views,
						job.eye,
						job.prior,
						job.sk,
						job.opts,
					)
				: await legacySolve(job.corr, job.views, job.eye, job.prior, job.opts);
		reply = { id: job.id, ok: true, result };
	} catch (e) {
		reply = {
			id: job.id,
			ok: false,
			error: String((e as Error)?.message ?? e),
			name: (e as Error)?.name,
		};
	}
	ctx.postMessage(reply);
};
