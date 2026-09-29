#!/usr/bin/env node
// Look-kernel warm-up check: on a fresh page, how long compiling every look kernel takes (the cost
// the first GPU look pass used to pay), and that a second warm is ~free. Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/look-warm-check.mjs [--url http://localhost:3110]
import { chromium } from "playwright";

const i = process.argv.indexOf("--url");
const URL0 = i >= 0 ? process.argv[i + 1] : "http://localhost:3110";
const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu", "--enable-unsafe-webgpu"],
});
try {
	// the first real pass (a 1024×768 guided filter, 3 masks, as CompositeLook.updateMasks runs it)
	// on a fresh page: without and with the warm-up (+ 300 ms for the GPU process to compile)
	for (const warmFirst of [false, true, false, true]) {
		const page = await browser.newPage();
		await page.goto(`${URL0}/`, { waitUntil: "load" });
		const r = await page.evaluate(async (warmFirst) => {
			const hooks = await import("/src/lib/gpu/look/hooks.ts");
			const { getComputeDevice } = await import("/src/lib/gpu/device.ts");
			const { guidedFiltersGpu } = await import("/src/lib/gpu/look/guided-filter.ts");
			const d = await getComputeDevice();
			if (!d) return { webgpu: false };
			let warm = null;
			if (warmFirst) {
				warm = await hooks.warmLook();
				await new Promise((r) => setTimeout(r, 300));
			}
			const w = 1024, h = 768, n = w * h;
			const I = Float32Array.from({ length: n }, (_, i) => ((i * 2654435761) % 1000) / 1000);
			const jobs = [8, 16, 4].map((r) => ({ p: I.map((v) => 1 - v), r, eps: 1e-3 }));
			const t0 = performance.now();
			await guidedFiltersGpu(d, I, w, h, jobs);
			const first = performance.now() - t0;
			const t1 = performance.now();
			await guidedFiltersGpu(d, I, w, h, jobs);
			return { warmFirst, warm, first, second: performance.now() - t1 };
		}, warmFirst);
		console.log(JSON.stringify(r));
		await page.close();
	}
} finally {
	await browser.close();
}
