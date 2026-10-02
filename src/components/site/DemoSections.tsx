// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useState } from "react";
import type { DemoManifest } from "#/lib/demo";
import { DemoPanorama, useDemoRoll } from "./DemoRollViews";
import { LandscapeView } from "./LandscapeView";
import { TopoBoard } from "./TopoBoard";

// Landing sections that load the sample trip themselves. index.tsx lazy-loads this file when the
// section nears the viewport, so the manifest, the panorama and the topo board stay out of the
// initial bundle and start no work at page mount.

const PANO_BOX = "h-[380px] rounded-xl bg-white/[0.03] ring-1 ring-white/10";
const TOPO_BOX =
	"h-[min(640px,75vh)] rounded-2xl bg-white/[0.03] ring-1 ring-white/10";

export function PanoramaSection() {
	const roll = useDemoRoll();
	return (
		<LandscapeView>
			{roll ? <DemoPanorama roll={roll} /> : <div className={PANO_BOX} />}
		</LandscapeView>
	);
}

export function TopoSection() {
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
			className="h-[min(640px,75vh)] rounded-2xl ring-1 ring-white/10"
		/>
	) : (
		<div className={TOPO_BOX} />
	);
}
