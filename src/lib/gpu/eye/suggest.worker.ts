/// <reference lib="webworker" />
// Worker half of client.ts: one eye search (suggest.ts runEyeSearch) per worker; the main thread
// terminates it afterwards (or on cancel). The page's GPU kill switch is passed in (a worker sees no
// page URL or localStorage).
import { setFlagOverride } from "#/lib/flags";
import { applyRealmGpuOptions, takeGpuProfile } from "../core/realm";
import type { EyeSearchInWorker, EyeSearchOutWorker } from "./client";
import { runEyeSearch } from "./suggest";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: EyeSearchOutWorker) => scope.postMessage(m);

scope.onmessage = async (ev: MessageEvent<EyeSearchInWorker>) => {
	const { input, gpu, gpuOpts } = ev.data;
	if (gpu === "off") setFlagOverride("gpu", "off");
	applyRealmGpuOptions(gpuOpts);
	let out: EyeSearchOutWorker;
	try {
		const result = await runEyeSearch(input, (progress) =>
			post({ type: "progress", progress }),
		);
		out = { type: "done", result };
	} catch (e) {
		out = { type: "error", error: String((e as Error)?.message ?? e) };
	}
	// profiling only (undefined, nothing awaited, when the page does not profile)
	const prof = takeGpuProfile();
	if (prof) out = { ...out, gpuProfile: await prof };
	post(out);
};
