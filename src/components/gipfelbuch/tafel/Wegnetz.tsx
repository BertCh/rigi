// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { gipfelbuchHref, STATUS_META } from "#/lib/gipfelbuch/graph-utils";
import { Blaze, ContourScribble } from "../notebook/carto";
import { HandText, type InkColor, PenArrow, PenLine } from "../notebook/Ink";
import { waymarkForStatus } from "../swiss/Waymark";
import { sheetTransition } from "../viz/hooks";
import { type GipfelbuchPhotoId, useGipfelbuchPhoto } from "../viz/real";
import {
	photoRoute,
	type TrailKind,
	trailEnds,
	trailKey,
	trailLineage,
	WEGNETZ_HEIGHT,
	WEGNETZ_STATIONS,
	WEGNETZ_TRAILS,
	WEGNETZ_VALLEYS,
	WEGNETZ_WIDTH,
} from "./wegnetz-layout";

// The concept graph as a hand-drawn trail map (wegnetz.ts has the layout). The one red route is the
// followed photo's path through the solve (via Tap a peak when the gate refused it); pointing at a
// station swaps it for that station's lineage.

const NODE_BY_ID = new Map(GIPFELBUCH_NODES.map((n) => [n.id, n]));
const BLATT = new Map(
	GIPFELBUCH_NODES.map((n, i) => [n.id, String(i + 1).padStart(2, "0")]),
);
const STATION_BY_ID = new Map(WEGNETZ_STATIONS.map((s) => [s.id, s]));

const TRAIL_INK: Record<
	TrailKind,
	{ color: InkColor; width: number; opacity: number; dash?: string }
> = {
	flow: { color: "ink", width: 1.3, opacity: 0.6 },
	cross: { color: "forest", width: 1.3, opacity: 0.7 },
	snap: { color: "brown", width: 1.4, opacity: 0.85, dash: "6 3" },
	fallback: { color: "pencil", width: 1.3, opacity: 0.8, dash: "1 4" },
};

export function Wegnetz({ followed }: { followed: GipfelbuchPhotoId }) {
	const navigate = useNavigate();
	const d = useGipfelbuchPhoto(followed);
	const [active, setActive] = useState<string | null>(null);
	const route = useMemo(
		() =>
			active
				? trailLineage(active)
				: d
					? photoRoute(d.solved.accepted)
					: new Set<string>(),
		[active, d],
	);
	const onRoute = useMemo(() => {
		const ids = new Set<string>(active ? [active] : []);
		for (const t of WEGNETZ_TRAILS)
			if (route.has(trailKey(t))) ids.add(t.from).add(t.to);
		return ids;
	}, [route, active]);
	const open = (id: string) =>
		navigate({
			to: "/gipfelbuch/$concept",
			params: { concept: id },
			viewTransition: sheetTransition(),
		});
	const activeNode = active ? NODE_BY_ID.get(active) : undefined;

	return (
		<figure className="m-0">
			<div className="overflow-x-auto">
				<svg
					viewBox={`0 0 ${WEGNETZ_WIDTH} ${WEGNETZ_HEIGHT}`}
					className="block w-full min-w-[720px]"
				>
					<title>
						Trail map of the sheets: each station is a sheet, each trail the
						data that flows between them
					</title>
					{WEGNETZ_VALLEYS.map((valley, i) => (
						<g key={valley.numeral}>
							{i > 0 ? (
								<PenLine
									from={[20, valley.y0]}
									to={[WEGNETZ_WIDTH - 20, valley.y0]}
									seed={`wegnetz-valley-${valley.numeral}`}
									color="faint"
									width={0.8}
									dash="2 6"
								/>
							) : null}
							<a
								href={gipfelbuchHref(valley.hub)}
								aria-label={`Chapter ${valley.numeral}: ${valley.name}. Open ${NODE_BY_ID.get(valley.hub)?.title ?? valley.hub}`}
								className="cursor-pointer outline-none [&:focus-visible_text]:underline"
								onClick={(event) => {
									event.preventDefault();
									open(valley.hub);
								}}
								onMouseEnter={() => setActive(valley.hub)}
								onMouseLeave={() => setActive(null)}
								onFocus={() => setActive(valley.hub)}
								onBlur={() => setActive(null)}
							>
								<HandText x={24} y={valley.y0 + 30} size={20} color="pencil">
									{`${valley.numeral} · ${valley.name}`}
								</HandText>
							</a>
						</g>
					))}

					{WEGNETZ_STATIONS.map((station) => (
						<ContourScribble
							key={`contour-${station.id}`}
							center={station.at}
							seed={`wegnetz-contour-${station.id}`}
							count={3}
							radius={30}
							squash={0.7}
							opacity={0.22}
						/>
					))}

					{WEGNETZ_TRAILS.map((trail) => {
						const a = STATION_BY_ID.get(trail.from);
						const b = STATION_BY_ID.get(trail.to);
						if (!a || !b) return null;
						const [from, to] = trailEnds(a.at, b.at);
						const red = route.has(trailKey(trail));
						const ink = TRAIL_INK[trail.kind];
						return (
							<PenArrow
								key={trailKey(trail)}
								from={from}
								to={to}
								bend={trail.bend ?? 0}
								head={6}
								seed={`wegnetz-${trailKey(trail)}`}
								color={red ? "red" : ink.color}
								width={red ? 2.2 : ink.width}
								opacity={red ? 1 : active ? ink.opacity * 0.5 : ink.opacity}
								dash={ink.dash}
							/>
						);
					})}

					{WEGNETZ_TRAILS.map((trail) => {
						const a = STATION_BY_ID.get(trail.from);
						const b = STATION_BY_ID.get(trail.to);
						if (!a || !b || !trail.label) return null;
						return (
							<HandText
								key={`label-${trailKey(trail)}`}
								x={(a.at[0] + b.at[0]) / 2}
								y={(a.at[1] + b.at[1]) / 2 - 6}
								size={13}
								anchor="middle"
								color="pencil"
							>
								{trail.label}
							</HandText>
						);
					})}

					{WEGNETZ_STATIONS.map((station) => {
						const node = NODE_BY_ID.get(station.id);
						if (!node) return null;
						const variant = waymarkForStatus(node.status);
						const [x, y] = station.at;
						const below = station.labelSide === "below";
						const dim = active !== null && !onRoute.has(station.id);
						return (
							<a
								key={station.id}
								href={gipfelbuchHref(station.id)}
								aria-label={`Blatt ${BLATT.get(station.id)}: ${node.title} (${STATUS_META[node.status].label})`}
								className="cursor-pointer outline-none [&:focus-visible_text]:underline"
								style={{ opacity: dim ? 0.4 : 1 }}
								onClick={(event) => {
									event.preventDefault();
									open(station.id);
								}}
								onMouseEnter={() => setActive(station.id)}
								onMouseLeave={() => setActive(null)}
								onFocus={() => setActive(station.id)}
								onBlur={() => setActive(null)}
							>
								{/* a generous hit area: the blaze alone is 8 px */}
								<rect
									x={x - 60}
									y={y - 34}
									width={120}
									height={68}
									fill="transparent"
								/>
								<Blaze
									kind={variant === "closed" ? "alpine" : variant}
									x={x}
									y={y}
									seed={`wegnetz-blaze-${station.id}`}
								/>
								<HandText
									x={x}
									y={below ? y + 26 : y - 14}
									size={18}
									anchor="middle"
									color={onRoute.has(station.id) ? "red" : "ink"}
								>
									{station.label}
								</HandText>
								<text
									x={x + 10}
									y={y + 4}
									className="nb-num"
									fontSize={11}
									fontStyle="italic"
									fill="var(--nb-pencil)"
								>
									{BLATT.get(station.id)}
								</text>
							</a>
						);
					})}
				</svg>
			</div>
			<figcaption
				aria-live="polite"
				className="nb-hand mt-3 min-h-[48px] max-w-[66ch] text-[18px] leading-[24px] text-[var(--gb-secondary)]"
			>
				{activeNode
					? `${activeNode.title}: ${activeNode.claim ?? activeNode.tagline}. The red trails feed it or follow from it.`
					: d
						? `In red, the route ${followed} took: ${d.solved.accepted ? "accepted at the gate, straight to the pose" : "refused at the gate, so its trail detours by Tap a peak"}. Point at a station to see what feeds it.`
						: "Each station is a sheet; each trail is data flowing between them."}
			</figcaption>
		</figure>
	);
}
