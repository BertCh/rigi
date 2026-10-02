// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PanoramaStrip } from "#/lib/roll/mosaic/PanoramaStrip";
import type { Roll } from "#/lib/roll/types";

// The roll page's own panorama strip, on the sample trip, for the landing page.
// Selecting a photo opens it in the roll view.

export function useDemoRoll() {
	const [roll, setRoll] = useState<Roll | null>(null);
	useEffect(() => {
		let live = true;
		import("#/lib/demo")
			// no trails; a photo's 1024 px copy wherever it is as sharp as the full size at the strip's
			// widest (the screen's long side: the strip is full-bleed, and full screen on a phone)
			.then((m) =>
				m.loadDemoRoll({
					core: true,
					smallPhotos: (r) =>
						m.panoramaPxPerDeg(
							r,
							Math.max(window.screen.width, window.screen.height) *
								(window.devicePixelRatio || 1),
						),
				}),
			)
			.then((r) => live && setRoll(r))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return roll;
}

function useOpen() {
	const navigate = useNavigate();
	return (id: string | null) =>
		id &&
		navigate({
			to: "/roll/$id",
			params: { id: "demo" },
			search: { photo: id },
		});
}

export function DemoPanorama({ roll }: { roll: Roll }) {
	const [sel, setSel] = useState<string | null>(null);
	const open = useOpen();
	return (
		<PanoramaStrip
			roll={roll}
			photos={roll.photos}
			selectedId={sel}
			onSelect={(id) => (id && id === sel ? open(id) : setSel(id))}
			height={380}
			fitHeight
			zoom={false}
			// the other landing embeds cap at 1.5 too
			maxPixelRatio={1.5}
		/>
	);
}
