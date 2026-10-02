import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

// public/photos/photos.json is also fetched at runtime and read by scripts, so it stays in public/.
// Vite refuses JS imports from public/, so expose it to src as `virtual:photos`.
function photosJson(): Plugin {
	const file = fileURLToPath(
		new URL("./public/photos/photos.json", import.meta.url),
	);
	const id = "virtual:photos";
	const resolvedId = `\0${id}`;
	return {
		name: "photos-json",
		resolveId: (s) => (s === id ? resolvedId : undefined),
		load(s) {
			if (s !== resolvedId) return;
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

// Production builds ship neither the /dev/* (harness and preview pages) nor the /lab/* (experiments) routes.
// The router generator ignores those route files and writes its tree to a separate, gitignored file, which
// the build aliases over `./routeTree.gen` (src/router.tsx), so the committed src/routeTree.gen.ts that
// `vite dev` and tsc use is never rewritten and the dev experience is unchanged. RIGI_ROUTES=all keeps
// every route in a build (for a staging or harness build).
const GATED_ROUTE_FILES = "^(dev|lab)\\.";

// Other configs (scripts/**/vite.*.config.ts) import this one as a plain object, so the build is detected
// from argv (`vite build`) rather than through the config function form.
const PROD_ROUTE_TREE = fileURLToPath(
	new URL("./src/routeTree.prod.gen.ts", import.meta.url),
);
const gateRoutes =
	process.argv[2] === "build" && process.env.RIGI_ROUTES !== "all";

// The app loads only the *.safetensors rows of scripts/models/manifest.json. The .onnx / .tflite files in
// public/models are the producers' parity references (scripts u2netp-parity, people-parity): they stay
// in public/ for dev and scripts but are not copied into the build output (nitro's public asset ignore
// patterns; a leading "**" keeps them relative to public/).
const PARITY_ONLY_MODELS = ["**/models/*.onnx", "**/models/*.tflite"];

// GitHub Pages (.github/workflows/pages.yml): RIGI_PAGES=1 builds a static SPA served under /rigi/. Vite's
// base becomes the router basepath (TanStack Start derives it), public/ files resolve through
// src/lib/public-url.ts, and the client build lands in .output/public. The SPA
// shell is prerendered at /index.html; scripts/pages/finalize.mjs copies it to 404.html for deep links.
const pages = process.env.RIGI_PAGES === "1";
const PAGES_BASE = process.env.RIGI_PAGES_BASE ?? "/rigi/";

const config = defineConfig({
	base: pages ? PAGES_BASE : "/",
	cacheDir: devPort ? `node_modules/.vite-${devPort}` : "node_modules/.vite",
	resolve: {
		tsconfigPaths: true,
		alias: gateRoutes
			? [
					{
						find: /^\.\/routeTree\.gen$/,
						replacement: PROD_ROUTE_TREE,
					},
				]
			: [],
	},
	// gpu-core is imported lazily (src/lib/gpu/**): on a cold cache Vite would re-optimise on first import
	// and load a second @luma.gl/core, which breaks graph destroy.
	optimizeDeps: {
		include: ["@luma.gl/gpgpu/gpu-core"],
	},
	server: {
		// TM research and the test scripts write here constantly: watching it reloaded pages mid-test
		watch: {
			ignored: ["**/tools/**", "**/out/**", "**/reports/**", "**/.output/**"],
		},
	},
	plugins: [
		photosJson(),
		nitro({ ignore: PARITY_ONLY_MODELS }),
		tailwindcss(),
		tanstackStart({
			...(gateRoutes
				? {
						router: {
							routeFileIgnorePattern: GATED_ROUTE_FILES,
							generatedRouteTree: PROD_ROUTE_TREE,
						},
					}
				: {}),
			...(pages
				? { spa: { enabled: true, prerender: { outputPath: "/index.html" } } }
				: {}),
		}),
		viteReact(),
	],
});

export default config;
