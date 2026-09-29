// Switch for the app's GPU skyline march (horizon-fast-app worker). ON by default since 2026-09-28
// where WebGPU exists: the profile matches the CPU to ~1e-4° (p99) at 5–100× the speed. It is not bit
// for bit, so autoAlign can move by last-bit amounts (IMG_6958: 0.01°); the user accepted that drift.
//
// Off with ?gpuHorizon=0 in the page URL or localStorage "rigi.gpuHorizon" = "0", or the global kill
// switch (../device.ts). Without WebGPU the CPU march runs as before.
import { gpuEnabled } from "../device";

export function gpuHorizonOptIn(): boolean {
	let on = true;
	try {
		const q = new URLSearchParams(globalThis.location?.search ?? "").get(
			"gpuHorizon",
		);
		if (q !== null) on = q !== "0" && q !== "off";
		else {
			const s = globalThis.localStorage?.getItem("rigi.gpuHorizon");
			if (s !== null) on = s !== "0" && s !== "off";
		}
	} catch {}
	return on && gpuEnabled();
}
