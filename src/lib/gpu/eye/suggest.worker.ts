/// <reference lib="webworker" />
// Worker half of client.ts: one eye search (suggest.ts runEyeSearch) per worker; the main thread
// terminates it afterwards (or on cancel). The page's GPU kill switch is passed in (a worker sees no
// page URL or localStorage).
import type { EyeSearchInWorker, EyeSearchOutWorker } from "./client";
import { runEyeSearch } from "./suggest";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: EyeSearchOutWorker) => scope.postMessage(m);

scope.onmessage = async (ev: MessageEvent<EyeSearchInWorker>) => {
	const { input, gpu } = ev.data;
	if (gpu === "off")
		(globalThis as { __RIGI_GPU__?: "on" | "off" }).__RIGI_GPU__ = "off";
	try {
		const result = await runEyeSearch(input, (progress) =>
			post({ type: "progress", progress }),
		);
		post({ type: "done", result });
	} catch (e) {
		post({ type: "error", error: String((e as Error)?.message ?? e) });
	}
};
