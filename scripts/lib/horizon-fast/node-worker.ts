// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Node worker_threads entry (see nodeWorkers in node.ts). */
import { parentPort } from "node:worker_threads";
import { runSector, type SectorJob } from "./worker-core";

parentPort?.on("message", (job: SectorJob) => {
	const { result, transfer } = runSector(job);
	parentPort?.postMessage(result, transfer);
});
