// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Gipfelbuch map-sheet palette: Landeskarte-style separations (black, brown, blue, red)
// on warm paper. Every ink is a Brezine chart swatch named by its Ascher code; keep in step
// with the --gb-* tokens in ./theme.css. See reports/gipfelbuch-swiss-aesthetic.md.

import "./theme.css";

export { SWISS } from "./inks";

/** Page root class: pulls in the scoped theme and sets the paper ground. */
export const GB_THEME =
	"gb-swiss min-h-dvh bg-[var(--gb-paper)] text-[var(--gb-ink)]";
