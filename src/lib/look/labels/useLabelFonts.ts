// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// React side of the label web-font state (layout.ts canvasMeasure): a counter that changes when a
// font load finishes. Put it in the deps of any memo that lays labels out with canvasMeasure, so a
// layout measured with the fallback font is redone once Manrope arrives.
import { useSyncExternalStore } from "react";
import { labelFontEpoch, subscribeLabelFonts } from "./layout";

export function useLabelFontEpoch() {
	return useSyncExternalStore(subscribeLabelFonts, labelFontEpoch, () => 0);
}
