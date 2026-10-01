import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import type { Plugin } from "vite";
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
} from "vite";

// public/photos/photos.json is also fetched at runtime and read by scripts, so it stays in public/.
// Vite refuses JS imports from public/, so expose it to src as `virtual:photos`.
function photosJson(): Plugin {
	const file = fileURLToPath(
		new URL("./public/photos/photos.json", import.meta.url),
	);
	const id = "virtual:photos";
	return {
		name: "photos-json",
		resolveId: (s) => (s === id ? "\0" + id : undefined),
		load(s) {
			if (s !== "\0" + id) return;
			this.addWatchFile(file);
			// A fresh clone has no gitignored photos: fall back to an empty list.
			return `export default ${existsSync(file) ? readFileSync(file, "utf8") : "[]"}`;
		},
	};
}

// Several dev servers run on this tree at once (:3100 plus ad-hoc ones). A shared node_modules/.vite
// makes each one's dep re-optimisation invalidate the others' hashes ("504 Outdated Optimize Dep"),
// so every server gets its own dep cache, keyed by its --port.
const portArg = process.argv.find(
	(a, i, all) => all[i - 1] === "--port" || a.startsWith("--port="),
);
const devPort = portArg?.replace("--port=", "");

// deck.gl 9.4 ships a `visgl:webgl-only` export (dist.webgl-only/: its WebGPU branches and WGSL
// constant-folded out). The app's default renderer is deck on WebGPU (src/lib/deck-webgpu, with the WebGL
// DeckEngine as the automatic fallback: src/lib/renderer-select.ts), which needs deck's FULL build, so the
// condition is no longer taken. The WebGL path runs the same full build (its WebGPU branches are dead code
// on a WebGL device). RIGI_DECK_BUILD=webgl-only restores the old resolution (bundle-size A/B, or a WebGL-
// only deployment: WebGpuEngine then runs on its luma-direct host). Only @deck.gl/* packages declare the
// condition; @luma.gl/* resolve the same either way. Vite 8's resolve.conditions REPLACES the defaults,
// hence the spread; the SSR environment's is ssr.resolve.conditions (deck only runs in the browser).
const WEBGL_ONLY =
	process.env.RIGI_DECK_BUILD === "webgl-only" ? ["visgl:webgl-only"] : [];

const config = defineConfig({
	cacheDir: devPort ? `node_modules/.vite-${devPort}` : "node_modules/.vite",
	resolve: {
		tsconfigPaths: true,
		conditions: [...WEBGL_ONLY, ...defaultClientConditions],
	},
	ssr: { resolve: { conditions: [...WEBGL_ONLY, ...defaultServerConditions] } },
	// gpu-core is imported lazily (src/lib/gpu/**): on a cold cache Vite would re-optimise on first import
	// and load a second @luma.gl/core, which breaks graph destroy.
	optimizeDeps: {
		include: ["@luma.gl/gpgpu/gpu-core"],
	},
	server: {
		// TM research and the test scripts write here constantly: watching it reloaded pages mid-test
		watch: { ignored: ["**/tools/**", "**/out/**"] },
	},
	plugins: [
		photosJson(),
		nitro({ rollupConfig: { external: [/^@sentry\//] } }),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
