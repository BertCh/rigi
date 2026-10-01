// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Mount for the roll 3D map's terroir layers (RollMap.tsx renders one of these): feeds the engine
// the halo / prior-uncertainty / names layers (roll-map-extras.ts, loaded on demand so deck stays
// out of the mosaic bundle) and draws the map's furniture: an attribution line and a north arrow
// that turns with the camera bearing.
import { useEffect, useRef, useState } from "react";
import { attributionLine } from "../../licences/attribution";
import { basemapSource, type RollBasemap } from "../../roll/map/basemap";
import type { RollMapEngine } from "../../roll/map/roll-map";
import type { Roll } from "../../roll/types";
import type { RollMapExtras } from "./roll-map-extras";

type Props = {
	engine: RollMapEngine | null;
	roll: Roll;
	basemap: RollBasemap;
	/** Names layer on/off (the control bar's "Names" toggle). */
	names: boolean;
	/** The camera is inside a photographer's viewpoint. */
	inView: boolean;
	visibleIds?: ReadonlySet<string>;
};

export function RollMapTerroir({
	engine,
	roll,
	basemap,
	names,
	inView,
	visibleIds,
}: Props) {
	const [bearing, setBearing] = useState(0);
	const [packCredit, setPackCredit] = useState<string | null>(null);
	const extras = useRef<RollMapExtras | null>(null);
	const latest = useRef({ names, inView, visibleIds });
	latest.current = { names, inView, visibleIds };

	// biome-ignore lint/correctness/useExhaustiveDependencies: one set of layers per engine and roll
	useEffect(() => {
		if (!engine) return;
		let live = true;
		let ex: RollMapExtras | null = null;
		void import("./roll-map-extras").then(({ RollMapExtras }) => {
			if (!live) return;
			const l = latest.current;
			ex = new RollMapExtras(engine, engine.roll, {
				names: l.names,
				inView: l.inView,
				visibleIds: l.visibleIds ?? null,
				onBearing: (b) => live && setBearing(b),
				onCredit: (c) => live && setPackCredit(c),
			});
			extras.current = ex;
		});
		return () => {
			live = false;
			ex?.dispose();
			extras.current = null;
		};
	}, [engine, roll.id]);

	useEffect(() => {
		extras.current?.setOptions({
			names,
			inView,
			visibleIds: visibleIds ?? null,
		});
	}, [names, inView, visibleIds]);

	const credit = attributionLine(
		{
			lat: roll.center.lat,
			lon: roll.center.lon,
			radiusKm: 30,
			imagery: basemapSource(basemap) ?? "none",
		},
		{ compact: true },
	);
	const full = `${credit}${names && packCredit ? ` · Names: ${[...new Set(packCredit.split(" · "))].join(" · ")}` : ""}`;
	return (
		<>
			<div
				className="pointer-events-none absolute right-3 top-3 flex size-9 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/15 backdrop-blur"
				title={`North (camera bearing ${Math.round(bearing)}°)`}
				data-testid="roll-map-north"
			>
				<svg
					viewBox="-10 -10 20 20"
					className="size-6"
					role="img"
					aria-label="North arrow"
				>
					<title>North</title>
					<g transform={`rotate(${-bearing})`}>
						<path d="M0,-9 L3.6,3 L0,1 L-3.6,3 Z" fill="#fff" />
						<path d="M0,9 L3.6,-3 L0,-1 L-3.6,-3 Z" fill="#ffffff55" />
					</g>
				</svg>
			</div>
			<div
				className="absolute top-0 left-0 max-w-[calc(100%-3.5rem)] truncate bg-white/80 px-1.5 py-0.5 text-[10px] leading-tight text-black/80"
				title={full}
				data-testid="roll-map-credit"
			>
				{full}
			</div>
		</>
	);
}
