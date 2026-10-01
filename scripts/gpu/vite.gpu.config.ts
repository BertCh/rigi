// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Private dev server for the GPU workstreams (port 3110). It is the same app as vite.config.ts,
// but it doesn't watch tools/** or out/**: the TM research writes there constantly, which made
// :3100 fully reload pages mid-test. Start with:
//   npx vite dev --config scripts/gpu/vite.gpu.config.ts --port 3110
import { mergeConfig } from "vite";
import base from "../../vite.config";

export default mergeConfig(base, {
	server: {
		watch: {
			ignored: ["**/tools/**", "**/out/**", "**/reports/**", "**/.output/**"],
		},
	},
});
