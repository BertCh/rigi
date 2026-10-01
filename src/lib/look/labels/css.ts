// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViewStyle.labels → CSS custom properties for the DOM peak labels (PhotoWorkspace, styling.md
// §2.3 / chunk 4). Set on the label layer; the label elements read them through var(). For classic,
// each value computes to what the old Tailwind classes produced: colours with alpha use the same
// color-mix(in oklab, …) form Tailwind v4 emits for `white/75`, shadows the same rgba() text.
import type { CSSProperties } from "react";
import { hexToRgba01, toCss } from "../../style/color";
import type { Hex, LabelStyle } from "../../style/types";

/** Tailwind-v4-style colour: opaque → rgb(), translucent → color-mix(in oklab, rgb() a%, transparent). */
export function cssMixColor(c: Hex, alphaMul = 1): string {
	const [r, g, b, a0] = hexToRgba01(c);
	const a = a0 * alphaMul;
	const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
	const rgb = `rgb(${q(r)},${q(g)},${q(b)})`;
	return a >= 1
		? rgb
		: `color-mix(in oklab, ${rgb} ${+(Math.max(0, a) * 100).toFixed(2)}%, transparent)`;
}

const px = (v: number) => `${+v.toFixed(3)}px`;

/** The variables for one LabelStyle (spread into a `style` prop). */
export function labelCssVars(st: LabelStyle): CSSProperties {
	const h = st.halo;
	const vars: Record<string, string> = {
		"--lbl-name-px": px(st.name.px),
		"--lbl-name-w": String(st.name.weight),
		"--lbl-name-c": cssMixColor(st.name.color),
		"--lbl-sub-px": px(st.sub.px),
		"--lbl-sub-w": String(st.sub.weight),
		"--lbl-sub-c": cssMixColor(st.sub.color),
		// drop-shadow() filter for 'shadow'; a text stroke painted under the fill for 'stroke'
		"--lbl-halo":
			h.kind === "shadow"
				? `drop-shadow(0 ${px(h.offsetY)} ${px(h.blurPx)} ${toCss(h.color)})`
				: "none",
		"--lbl-stroke":
			h.kind === "stroke" && h.strokePx > 0
				? `${px(h.strokePx)} ${toCss(h.color)}`
				: `0 transparent`,
		"--lbl-lead-len": px(st.leader.lengthPx),
		"--lbl-lead-w": px(st.leader.widthPx),
		"--lbl-lead-from": cssMixColor(st.leader.color),
		"--lbl-lead-to": cssMixColor(st.leader.color, st.leader.fade ? 0 : 1),
		"--lbl-dot": px(st.dot.px),
		"--lbl-dot-c": cssMixColor(st.dot.color),
		"--lbl-dot-shadow": st.dot.glow
			? `0 0 ${px(st.dot.glowPx)} ${toCss(st.dot.glow)}`
			: "none",
	};
	return vars as CSSProperties;
}
