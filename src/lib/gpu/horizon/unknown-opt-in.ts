// Opt-in for the unknown-pose worker's GPU 360° horizon (./scene-profile.ts). Off by default.
//
// Separate from gpuHorizonOptIn (./opt-in.ts, the app's skyline march for autoAlign): the two feed
// different solvers, each with its own acceptance evidence (the unknown-pose cascade has a hard
// 0-false-accept rule), so turning one on must not turn on the other.
//
// On with ?unknownGpu=1 in the page URL or localStorage "rigi.unknownGpu" = "1", and never when the GPU
// kill switch (?gpu=off, rigi.gpu=off; see ../device.ts) is set. Call it in the page, not in the worker
// (a worker has no page URL or localStorage): UnknownPoseSolver sends the answer with its messages.
import { gpuEnabled } from "../device";

export function unknownGpuOptIn(): boolean {
	let on = false;
	try {
		const q = new URLSearchParams(globalThis.location?.search ?? "").get(
			"unknownGpu",
		);
		if (q !== null) on = q === "1" || q === "on";
		else {
			const s = globalThis.localStorage?.getItem("rigi.unknownGpu");
			on = s === "1" || s === "on";
		}
	} catch {}
	return on && gpuEnabled();
}
