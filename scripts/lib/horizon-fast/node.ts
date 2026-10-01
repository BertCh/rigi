// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Node-only: worker_threads ports for HorizonPool (run under tsx). */
import { Worker } from "node:worker_threads";
import type { WorkerPort } from "./pool";

/**
 * Workers register tsx before importing node-worker.ts (node's native type
 * stripping cannot resolve the extensionless imports).
 */
export function nodeWorkers(n: number): WorkerPort[] {
	const url = new URL("./node-worker.ts", import.meta.url);
	const boot = `import("tsx/esm/api").then((t) => { t.register(); return import(${JSON.stringify(url.href)}); });`;
	return Array.from({ length: n }, () => {
		const w = new Worker(boot, { eval: true });
		w.unref();
		return {
			post: (msg, transfer) => w.postMessage(msg, transfer as ArrayBuffer[]),
			onMessage: (cb) => {
				w.on("message", cb);
			},
			terminate: () => {
				void w.terminate();
			},
		};
	});
}
