import { readFileSync } from "node:fs";
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
			return `export default ${readFileSync(file, "utf8")}`;
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
// constant-folded out). The renderers are WebGL2-only, so take it. Only @deck.gl/* packages declare
// the condition; @luma.gl/* have no such key, so the WebGPU compute device (src/lib/gpu/device.ts,
// @luma.gl/core + @luma.gl/webgpu) resolves exactly as before. Vite 8's resolve.conditions REPLACES
// the defaults, hence the spread. Top-level resolve.conditions is the client environment's; the SSR
// environment's is ssr.resolve.conditions (deck only runs in the browser, set for consistency).
// Workers don't import deck.
const WEBGL_ONLY = "visgl:webgl-only";

const config = defineConfig({
	cacheDir: devPort ? `node_modules/.vite-${devPort}` : "node_modules/.vite",
	resolve: {
		tsconfigPaths: true,
		conditions: [WEBGL_ONLY, ...defaultClientConditions],
	},
	ssr: { resolve: { conditions: [WEBGL_ONLY, ...defaultServerConditions] } },
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
