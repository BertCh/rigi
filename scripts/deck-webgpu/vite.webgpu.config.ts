// Dev server for the deck-on-WebGPU work (port 3111 by convention).
//
// It is the app's vite.config.ts with ONE difference: deck.gl resolves to its full build instead
// of the `visgl:webgl-only` export condition. The webgl-only build constant-folds deck's WebGPU
// branches away (layers-pass.ts submitEachRenderPass + WEBGPU_DEFAULT_DRAW_PARAMETERS, layer.ts
// syncModelAttachmentFormats, the project/picking WGSL), so a Deck created with
// deviceProps.type = 'webgpu' cannot draw on it. luma.gl has no such condition.
//
//   npx vite dev --config scripts/deck-webgpu/vite.webgpu.config.ts --port 3111
//
// The spike (/lab/deck-webgpu?spike=1, src/lib/deck-webgpu/spike.ts) and the lab's deck host need
// it; on the app's own servers the lab falls back to the luma-direct host.
import { defaultClientConditions, defaultServerConditions } from "vite";
import base from "../../vite.config";

const cfg = { ...base };
cfg.resolve = { ...base.resolve, conditions: [...defaultClientConditions] };
cfg.ssr = {
	...base.ssr,
	resolve: { ...base.ssr?.resolve, conditions: [...defaultServerConditions] },
};
cfg.server = {
	...base.server,
	watch: {
		ignored: ["**/tools/**", "**/out/**", "**/reports/**", "**/.output/**"],
	},
};

export default cfg;
