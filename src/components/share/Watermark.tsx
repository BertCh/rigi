// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Display-only mark on a shared render (src/lib/share). Bottom-left of the stage, so it never covers
// the data credits (bottom-right). A label, not a security feature; PNG exports from a shared view
// burn the same text in through composeAnnotatedPng's `watermark` option.
import { SHARE_WATERMARK } from "#/lib/share";

export function Watermark({ text = SHARE_WATERMARK }: { text?: string }) {
	return (
		<div
			className="pointer-events-none absolute bottom-2 left-3 z-30 text-[11px] font-semibold tracking-wide text-[var(--rigi-paper)]/55 uppercase select-none"
			data-share-watermark=""
			aria-hidden
		>
			{text}
		</div>
	);
}
