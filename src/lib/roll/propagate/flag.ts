// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ?propagate=on (suggestions from saved/solved anchors to prior-only photos) | ?propagate=dev (also ground-
// truth anchors and every photo as a target, with Δ to the current pose) | off (default). Read through
// src/lib/flags; the root route keeps the param across navigation.
import { getFlag } from "#/lib/flags";
import type { PropagateMode } from "./plan";

export function propagateMode(): PropagateMode {
	return getFlag("propagate");
}
