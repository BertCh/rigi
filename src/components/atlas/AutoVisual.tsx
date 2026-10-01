// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useMemo } from "react";
import { BRAND } from "#/brand/khipu";
import {
	byId,
	GROUP_BY_ID,
	groupColor,
	neighbourhood,
} from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";
import { useTime } from "./viz/hooks";

function h32(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++)
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/**
 * Fallback visual generated from node data: topographic contour rings (seeded by the id, so each concept
 * gets its own little hill) with the concept's neighbours in slow orbit, coloured by group.
 */
export function AutoVisual({
	node,
	className,
}: {
	node: AtlasNode;
	className?: string;
}) {
	const [ref, t] = useTime<SVGSVGElement>(1);
	const col = groupColor(node.group);
	const rings = useMemo(() => {
		const seed = h32(node.id);
		const ph = Array.from(
			{ length: 5 },
			(_, i) => (((seed >>> (i * 5)) & 31) / 31) * 6.28,
		);
		const amp = 0.05 + (((seed >>> 3) & 7) / 7) * 0.06;
		return Array.from({ length: 8 }, (_, i) => {
			const base = 18 + i * 10.5;
			const pts: string[] = [];
			for (let a = 0; a <= 64; a++) {
				const th = (a / 64) * Math.PI * 2;
				const w =
					1 +
					amp *
						(Math.sin(th * 2 + ph[0] + i * 0.35) +
							0.6 * Math.sin(th * 3 + ph[1]) +
							0.4 * Math.sin(th * 5 + ph[2] - i * 0.2));
				pts.push(
					`${(Math.cos(th) * base * w * 1.55).toFixed(1)} ${(Math.sin(th) * base * w).toFixed(1)}`,
				);
			}
			return `M${pts.join("L")}Z`;
		});
	}, [node.id]);
	const hood = useMemo(
		() =>
			[...neighbourhood(node.id, 1).entries()]
				.filter(([id]) => id !== node.id)
				.map(([id]) => byId.get(id))
				.filter((n): n is AtlasNode => !!n)
				.slice(0, 14),
		[node.id],
	);
	const Icon = GROUP_BY_ID[node.group].icon;
	return (
		<svg
			ref={ref}
			viewBox="-300 -100 600 200"
			className={`block h-auto w-full ${className ?? ""}`}
			role="img"
			aria-label={`${node.title} constellation`}
		>
			<defs>
				<radialGradient id={`ag-${node.id}`}>
					<stop offset="0" stopColor={col} stopOpacity="0.28" />
					<stop offset="1" stopColor={col} stopOpacity="0" />
				</radialGradient>
			</defs>
			<ellipse rx="260" ry="100" fill={`url(#ag-${node.id})`} />
			{rings.map((d, i) => (
				<path
					key={d}
					d={d}
					fill="none"
					stroke={col}
					strokeOpacity={i % 5 === 0 ? 0.5 : 0.2}
					strokeWidth={i % 5 === 0 ? 1.1 : 0.7}
				/>
			))}
			{hood.map((n, i) => {
				const ang =
					(i / hood.length) * Math.PI * 2 +
					t * 0.07 * (i % 2 ? 1 : -1) * 0.6 +
					0.3;
				const rad = 70 + (i % 3) * 12;
				const x = Math.cos(ang) * rad * 1.55;
				const y = Math.sin(ang) * rad * 0.62;
				const c = groupColor(n.group);
				return (
					<g key={n.id}>
						<line
							x1="0"
							y1="0"
							x2={x}
							y2={y}
							stroke={c}
							strokeOpacity="0.28"
							strokeDasharray="2 3"
						/>
						<circle
							cx={x}
							cy={y}
							r="4.2"
							fill={n.status === "live" ? c : "none"}
							fillOpacity="0.9"
							stroke={c}
							strokeWidth="1.2"
							strokeDasharray={n.status === "killed" ? "1.6 1.8" : undefined}
						/>
						<text
							x={x + 8}
							y={y + 3.5}
							fontSize="9"
							className="fill-white/60"
							style={{ paintOrder: "stroke" }}
							stroke={BRAND.ink}
							strokeWidth="3"
						>
							{n.title}
						</text>
					</g>
				);
			})}
			<circle r="22" fill={BRAND.ink} stroke={col} strokeWidth="1.4" />
			<foreignObject x="-11" y="-11" width="22" height="22">
				<div
					className="grid size-[22px] place-items-center"
					style={{ color: col }}
				>
					<Icon className="size-[14px]" strokeWidth={1.5} />
				</div>
			</foreignObject>
		</svg>
	);
}
