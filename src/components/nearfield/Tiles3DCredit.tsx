// Step Inside 3D Tiles credit line (src/lib/tiles3d): bottom-right on the stage while stepping with
// ?tiles3d= on. Google's Map Tiles policies require the per-tile copyrights on screen, never obscured,
// and a UI note of which surfaces are Google's; swisstopo requires its credit. Renders nothing when the
// engine shows no tiles (the default), so the classic view is untouched.
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
	if (!text) return null;
	const google = text.startsWith("Google");
	return (
		<div
			className="pointer-events-none absolute right-2 bottom-2 z-30 max-w-[60%] rounded bg-black/55 px-2 py-0.5 text-right text-[10px] leading-snug text-white/85 backdrop-blur"
			data-tiles3d-credit=""
		>
			{text}
			{google && (
				<div className="text-white/60">
					3D surfaces outside the photo: Google Maps (visual only, not measured)
				</div>
			)}
		</div>
	);
}
