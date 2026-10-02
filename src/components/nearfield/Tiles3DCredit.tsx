// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside 3D Tiles credit line (src/lib/tiles3d): bottom-right on the stage while stepping with
// ?tiles3d= on. Google's Map Tiles policies require the per-tile copyrights on screen, never obscured,
// and a UI note of which surfaces are Google's; swisstopo requires its credit. Renders nothing when the
// engine shows no tiles (the default), so the classic view is untouched.
// Google's policies also require the Google Maps logo next to the copyrights. Google's logo files are
// theirs to supply and are not in the repository: drop the official white-on-dark wordmark at
// public/tiles3d/google-maps-logo.png (see its README) and it is shown automatically; until then the
// line carries a plain "Google Maps" text label, which is not the logo (reports/licences.md, NOTICE.md).
import { type RefObject, useEffect, useState } from "react";
import type { Renderer } from "#/lib/renderer";

export function Tiles3DCredit({
	engineRef,
	stepping,
}: {
	engineRef: RefObject<Renderer | null>;
	stepping: boolean;
}) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		if (!stepping) {
			setText(null);
			return;
		}
		const read = () => setText(engineRef.current?.tiles3dAttribution() ?? null);
		read();
		const t = window.setInterval(read, 1000);
		return () => window.clearInterval(t);
	}, [engineRef, stepping]);
	const [logoMissing, setLogoMissing] = useState(false);
	if (!text) return null;
	const google = text.startsWith("Google");
	return (
		<div
			className="pointer-events-none absolute right-2 bottom-2 z-30 max-w-[60%] rounded bg-black/55 px-2 py-0.5 text-right text-[10px] leading-snug text-white/85 backdrop-blur"
			data-tiles3d-credit=""
		>
			{google &&
				(logoMissing ? (
					<span className="mr-1 font-semibold text-white/90">Google Maps</span>
				) : (
					<img
						src="/tiles3d/google-maps-logo.png"
						alt="Google Maps"
						className="mr-1.5 inline-block h-3.5 align-middle"
						data-tiles3d-google-logo=""
						onError={() => setLogoMissing(true)}
					/>
				))}
			{text}
			{google && (
				<div className="text-white/60">
					3D surfaces outside the photo: Google Maps (visual only, not measured)
				</div>
			)}
		</div>
	);
}
