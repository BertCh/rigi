// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useMemo, useRef } from "react";
import { type Camera, directionENU, project } from "#/lib/geo/camera";
import {
	bucketColor,
	detectedSkylinePath,
	geometricHorizonPath,
	labelText,
	ridgePaths,
	skylinePath,
} from "./projection";
import type {
	BaselinePeakLabel,
	ControlPoint,
	HorizonLite,
	SkylineObservation,
} from "./types";

export interface Layers {
	ridges: boolean;
	peaks: boolean;
	detected: boolean;
}

interface Props {
	cam: Camera;
	horizon: HorizonLite | null;
	labels: BaselinePeakLabel[];
	sky: SkylineObservation | null;
	layers: Layers;
	points: ControlPoint[];
	pendingKey: string | null;
	tapMode: boolean;
	/** Working-image px per screen px. */
	k: number;
	onDrag: (dx: number, dy: number, phase: "start" | "move" | "end") => void;
	onTap: (x: number, y: number) => void;
	onLabel: (label: BaselinePeakLabel) => void;
}

export function Overlay({
	cam,
	horizon,
	labels,
	sky,
	layers,
	points,
	pendingKey,
	tapMode,
	k,
	onDrag,
	onTap,
	onLabel,
}: Props) {
	const svg = useRef<SVGSVGElement>(null);
	const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

	const sk = useMemo(
		() => (horizon ? skylinePath(cam, horizon) : ""),
		[cam, horizon],
	);
	const geo = useMemo(() => geometricHorizonPath(cam), [cam]);
	const ridges = useMemo(
		() => (horizon && layers.ridges ? ridgePaths(cam, horizon) : []),
		[cam, horizon, layers.ridges],
	);
	const detected = useMemo(
		() => (sky && layers.detected ? detectedSkylinePath(sky, cam.width) : ""),
		[sky, layers.detected, cam.width],
	);

	const toImage = (e: React.PointerEvent) => {
		const r = svg.current?.getBoundingClientRect();
		if (!r) return [0, 0] as const;
		return [
			((e.clientX - r.left) / r.width) * cam.width,
			((e.clientY - r.top) / r.height) * cam.height,
		] as const;
	};

	const fontSize = 12 * k;
	const sw = 1; // non-scaling strokes are in screen px

	return (
		<svg
			ref={svg}
			role="application"
			aria-label="Photo overlay: drag to adjust yaw and pitch"
			className={`absolute inset-0 h-full w-full touch-none select-none ${tapMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
			viewBox={`0 0 ${cam.width} ${cam.height}`}
			preserveAspectRatio="none"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				const [x, y] = toImage(e);
				drag.current = { x, y, moved: false };
				e.currentTarget.setPointerCapture(e.pointerId);
				if (!tapMode) onDrag(0, 0, "start");
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				const [x, y] = toImage(e);
				if (Math.hypot(x - d.x, y - d.y) > 4 * k) d.moved = true;
				if (!tapMode) onDrag(x - d.x, y - d.y, "move");
			}}
			onPointerUp={(e) => {
				const d = drag.current;
				drag.current = null;
				if (!d) return;
				const [x, y] = toImage(e);
				if (!tapMode) onDrag(x - d.x, y - d.y, "end");
				else if (!d.moved) onTap(x, y);
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		>
			{layers.ridges &&
				ridges.map((d, b) =>
					d ? (
						<path
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed buckets
							key={b}
							d={d}
							stroke={bucketColor(b)}
							strokeWidth={3}
							strokeLinecap="round"
							vectorEffect="non-scaling-stroke"
							opacity={0.85}
						/>
					) : null,
				)}
			<path
				d={geo}
				fill="none"
				stroke="white"
				strokeOpacity={0.75}
				strokeWidth={sw}
				strokeDasharray="6 5"
				vectorEffect="non-scaling-stroke"
			/>
			{detected && (
				<path
					d={detected}
					fill="none"
					stroke="#22d3ee"
					strokeWidth={2}
					strokeOpacity={0.9}
					vectorEffect="non-scaling-stroke"
				/>
			)}
			{sk && (
				<path
					d={sk}
					fill="none"
					stroke="rgb(255,40,200)"
					strokeOpacity={0.9}
					strokeWidth={2.5}
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
				/>
			)}
			{layers.peaks &&
				labels.map((l) => {
					const pending = l.key === pendingKey;
					const text = labelText(l);
					return (
						<g
							key={l.key}
							className={tapMode ? "cursor-pointer" : undefined}
							onPointerDown={(e) => {
								if (!tapMode) return;
								e.stopPropagation();
								onLabel(l);
							}}
						>
							<line
								x1={l.x}
								y1={l.y}
								x2={l.lx}
								y2={l.ly + 3 * k}
								stroke={pending ? "#facc15" : "white"}
								strokeWidth={1}
								vectorEffect="non-scaling-stroke"
							/>
							<circle
								cx={l.x}
								cy={l.y}
								r={2.5 * k}
								fill={pending ? "#facc15" : "white"}
							/>
							<text
								x={l.lx}
								y={l.ly}
								fontSize={fontSize}
								textAnchor="middle"
								fill={pending ? "#facc15" : "white"}
								stroke="rgba(0,0,0,0.75)"
								strokeWidth={3 * k}
								paintOrder="stroke"
								fontFamily="ui-sans-serif, system-ui, sans-serif"
								fontWeight={600}
							>
								{text}
							</text>
						</g>
					);
				})}
			{points.map((p) => {
				const q = project(cam, directionENU(p.azimuth, p.elevation));
				return (
					<g key={p.id}>
						{q && (
							<line
								x1={p.x}
								y1={p.y}
								x2={q[0]}
								y2={q[1]}
								stroke="#facc15"
								strokeWidth={1.5}
								vectorEffect="non-scaling-stroke"
							/>
						)}
						<circle
							cx={p.x}
							cy={p.y}
							r={5 * k}
							fill="none"
							stroke="#facc15"
							strokeWidth={2}
							vectorEffect="non-scaling-stroke"
						/>
						<text
							x={p.x + 7 * k}
							y={p.y - 7 * k}
							fontSize={fontSize}
							fill="#facc15"
							stroke="rgba(0,0,0,0.75)"
							strokeWidth={3 * k}
							paintOrder="stroke"
							fontFamily="ui-sans-serif, system-ui, sans-serif"
						>
							{p.id}
						</text>
					</g>
				);
			})}
		</svg>
	);
}
