// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useRef, useState } from "react";
import type { DemoManifest } from "#/lib/demo";
import { DemoPanorama, useDemoRoll } from "./DemoRollViews";
import { LandscapeView } from "./LandscapeView";
import { useLiveEmbed } from "./liveSlot";
import { TopoBoard } from "./TopoBoard";

// Landing sections that load the sample trip themselves. index.tsx lazy-loads this file when the
// section nears the viewport, so the manifest, the panorama and the topo board stay out of the
// initial bundle and start no work at page mount.

const PANO_BOX = "h-[380px] rounded-md bg-white/[0.03]";
const TOPO_BOX = "h-[min(640px,75vh)] rounded-md bg-white/[0.03]";

export function PanoramaSection() {
	const roll = useDemoRoll();
	// the strip owns a WebGL context: it is mounted only while live (near the viewport, and not
	// evicted by another live embed on screen); off it, a box of the strip's last height stands in
	// (the roll data stays loaded, so coming back is one mount)
	const box = useRef<HTMLDivElement>(null);
	const { live } = useLiveEmbed("pano", 200, { ref: box });
	const lastHeight = useRef(0);
	useEffect(() => {
		const el = box.current;
		if (!el || !live || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			lastHeight.current = el.offsetHeight;
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [live]);
	return (
		<LandscapeView>
			<div ref={box}>
				{roll && live ? (
					<DemoPanorama roll={roll} />
				) : (
					<div
						className={PANO_BOX}
						style={
							lastHeight.current ? { height: lastHeight.current } : undefined
						}
					/>
				)}
			</div>
		</LandscapeView>
	);
}

export function TopoSection({
	onPan,
}: {
	onPan?: (p: { x: number; y: number }) => void;
}) {
	const [demo, setDemo] = useState<DemoManifest | null>(null);
	useEffect(() => {
		let live = true;
		import("#/lib/demo")
			// the board draws photos and poses only: no trails
			.then((d) => d.loadDemoCore())
			.then((x) => live && setDemo(x))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return demo ? (
		<TopoBoard
			demo={demo}
			onPan={onPan}
			className="h-[min(640px,75vh)] rounded-md"
		/>
	) : (
		<div className={TOPO_BOX} />
	);
}
