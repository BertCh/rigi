// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Vitest setup for every project. Keep it tiny: anything here runs before every spec file.

import { afterEach } from "vitest";

// Specs may set per-realm flag overrides (src/lib/flags); never let one leak into the next spec.
afterEach(() => {
	delete (globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__;
});
