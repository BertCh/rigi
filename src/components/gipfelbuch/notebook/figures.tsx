// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import {
	type GipfelbuchIndex,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	rowsPath,
} from "#/components/gipfelbuch/viz/real";
import {
	Hachure,
	HandDot,
	HandText,
	inkColor,
	PenArrow,
	PenCircle,
	PenCross,
	PenDimension,
	PenLine,
	SketchPath,
} from "./Ink";
import { hachureLines, hashSeed } from "./sketch";

// Notebook figures. Rule: anything that encodes a measurement (skylines, horizons, view cones,
// terrain profiles, dot positions) is drawn exactly from the data; only the pen furniture around
// it (arrows, circles, dimension ticks, hachures) wobbles.

const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, value));
const signed = (value: number, digits = 1) =>
	`${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toFixed(digits)}`;

/** A print set into the notebook: square to the page, on a thin white mat (no tape, no tilt). */
export function PastedPrint({
	caption,
	children,
	className,
}: {
	/** Kept for call-site stability; the print no longer tilts. */
	seed?: string;
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<figure className={`nb-print relative ${className ?? ""}`}>
			{children}
			{caption ? (
				<figcaption className="nb-hand absolute right-3 bottom-0.5 left-3 truncate text-[13px] text-[var(--nb-pencil)]">
					{caption}
				</figcaption>
			) : null}
		</figure>
	);
}

/** Skyline band of a real photo: pencil = detected, blue dashes = DEM at the sensor prior, red = DEM at the solved pose. */
export function SkylineSketch({ data }: { data: GipfelbuchPhotoData }) {
	const { width, height } = data.photo;
	const rows = [
		...data.skyline.rows,
		...data.priorRows,
		...data.solvedRows,
	].filter((value): value is number => value != null);
	let top = clamp(Math.min(...rows) - 90, 0, height);
	let bottom = clamp(Math.max(...rows) + 55, 0, height);
	if (bottom - top < 300) {
		const grow = (300 - (bottom - top)) / 2;
		top = clamp(top - grow, 0, height - 300);
		bottom = clamp(top + 300, 0, height);
	}
	const viewHeight = bottom - top;

	// Where the sensor guess misses the photo most visibly (away from the frame edges).
	let gapColumn = -1;
	let gap = 0;
	for (let x = 120; x < width - 120; x++) {
		const prior = data.priorRows[x];
		const solved = data.solvedRows[x];
		if (prior == null || solved == null) continue;
		if (Math.abs(prior - solved) > gap) {
			gap = Math.abs(prior - solved);
			gapColumn = x;
		}
	}
	const prior = gapColumn >= 0 ? (data.priorRows[gapColumn] ?? 0) : 0;
	const solved = gapColumn >= 0 ? (data.solvedRows[gapColumn] ?? 0) : 0;
	const noteOnLeft = gapColumn > width * 0.5;
	// The note sits in the sky above the lines, never on them.
	const noteY = Math.max(top + 34, Math.min(prior, solved) - 58);

	const peak = data.peaks.find(
		(candidate) =>
			candidate.labelled &&
			candidate.solved &&
			candidate.solved[0] > 140 &&
			candidate.solved[0] < width - 140 &&
			candidate.solved[1] > top + 80 &&
			Math.abs(candidate.solved[0] - gapColumn) > 120,
	);

	// Peak names go below the skyline (in the land), gap notes above it (in the sky).
	const peakLabelY = peak?.solved
		? Math.min(bottom - 14, peak.solved[1] + 78)
		: 0;
	const casing = {
		fill: "none",
		stroke: "var(--nb-paper)",
		strokeOpacity: 0.85,
		strokeLinejoin: "round" as const,
		strokeLinecap: "round" as const,
	};
	const detected = rowsPath(data.skyline.rows);
	const priorPath = rowsPath(data.priorRows);
	const solvedPath = rowsPath(data.solvedRows);
	return (
		<svg
			viewBox={`0 ${top} ${width} ${viewHeight}`}
			className="block w-full"
			role="img"
			aria-label={`Photo ${data.id} with three skylines: the one traced in the photo, the terrain's at the compass guess, and the terrain's at the solved pose.`}
		>
			<image href={data.photo.src} x={0} y={0} width={width} height={height} />
			<path d={priorPath} {...casing} strokeWidth={5} />
			<SketchPath
				d={priorPath}
				seed={`${data.id}-prior`}
				color="blue"
				width={2.2}
				dash="7 5"
				passes={1}
				tolerance={0.7}
			/>
			<path d={detected} {...casing} strokeWidth={5.5} />
			<SketchPath
				d={detected}
				seed={`${data.id}-detected`}
				color="pencil"
				width={2.4}
				opacity={0.9}
				tolerance={0.7}
			/>
			<path d={solvedPath} {...casing} strokeWidth={4.5} />
			<SketchPath
				d={solvedPath}
				seed={`${data.id}-solved`}
				color="red"
				width={1.8}
				tolerance={0.7}
			/>
			{gapColumn >= 0 && gap > 4 ? (
				<g>
					<PenDimension
						seed={`${data.id}-gap`}
						from={[gapColumn, prior]}
						to={[gapColumn, solved]}
						color="ink"
						width={1.3}
						delay={300}
					/>
					<PenArrow
						seed={`${data.id}-gap-arrow`}
						from={[gapColumn + (noteOnLeft ? -70 : 70), noteY + 8]}
						to={[
							gapColumn + (noteOnLeft ? -6 : 6),
							Math.min(prior, solved) - 6,
						]}
						bend={noteOnLeft ? 0.25 : -0.25}
						width={1.4}
						delay={450}
					/>
					<HandText
						x={gapColumn + (noteOnLeft ? -76 : 76)}
						y={noteY}
						anchor={noteOnLeft ? "end" : "start"}
						size={30}
					>
						{gap.toFixed(0)} px off at the compass guess
					</HandText>
				</g>
			) : null}
			{peak?.solved ? (
				<g>
					<SketchPath
						d={`M${peak.solved[0]} ${peak.solved[1] - 2}l-5 -9h10z`}
						seed={`${data.id}-peak-mark`}
						width={1.6}
					/>
					<PenArrow
						seed={`${data.id}-peak`}
						from={[peak.solved[0] + 50, peakLabelY - 22]}
						to={[peak.solved[0] + 4, peak.solved[1] + 8]}
						bend={0.25}
						width={1.2}
						delay={500}
					/>
					<HandText x={peak.solved[0] + 56} y={peakLabelY} size={28}>
						{peak.name}, {(peak.distance / 1000).toFixed(0)} km
					</HandText>
				</g>
			) : null}
		</svg>
	);
}

/** Median miss per sky column, before and after the solve, on a pencil axis. */
export function MissSketch({ data }: { data: GipfelbuchPhotoData }) {
	const before = data.residual.prior.median;
	const after = data.residual.solved.median;
	const max = Math.max(10, Math.ceil((Math.max(before, after) * 1.15) / 5) * 5);
	const x = (value: number) => 24 + (value / max) * 330;
	const ticks = Array.from({ length: max / 5 + 1 }, (_, i) => i * 5);
	const far = Math.abs(x(before) - x(after)) > 26;
	return (
		<svg
			viewBox="0 0 380 82"
			className="block w-full max-w-[380px]"
			role="img"
			aria-label={`Median miss per sky column: ${before.toFixed(1)} px at the compass guess, ${after.toFixed(1)} px after the solve.`}
		>
			<PenLine
				seed={`${data.id}-axis`}
				from={[20, 58]}
				to={[360, 58]}
				color="pencil"
				width={1.1}
			/>
			{ticks.map((tick) => (
				<g key={tick}>
					<PenLine
						seed={`miss-tick-${tick}`}
						from={[x(tick), 55]}
						to={[x(tick), 61]}
						color="pencil"
						width={1}
					/>
					<text
						x={x(tick)}
						y={76}
						textAnchor="middle"
						className="nb-num"
						fontSize={10}
						fill={inkColor("faint")}
					>
						{tick}
					</text>
				</g>
			))}
			{far ? (
				<PenArrow
					seed={`${data.id}-miss`}
					from={[x(before) + (before > after ? -8 : 8), 46]}
					to={[x(after) + (before > after ? 9 : -9), 50]}
					bend={0.22}
					width={1.2}
					color="ink"
					delay={400}
				/>
			) : null}
			<PenCircle
				seed={`${data.id}-before`}
				center={[x(before), 58]}
				radiusX={4.5}
				color="blue"
				width={1.8}
			/>
			<HandDot
				x={x(after)}
				y={58}
				r={4.6}
				seed={`${data.id}-after`}
				color="red"
			/>
			<HandText
				x={x(before)}
				y={far ? 22 : 18}
				anchor="middle"
				color="blue"
				size={18}
			>
				{before.toFixed(1)} px
			</HandText>
			<HandText
				x={x(after)}
				y={far ? 22 : 38}
				anchor="middle"
				color="red"
				size={18}
			>
				{after.toFixed(1)} px
			</HandText>
		</svg>
	);
}

/** Hillshade around the camera with the solved view cone (exact), the compass heading and named peaks. */
export function DemSketch({ data }: { data: GipfelbuchPhotoData }) {
	const size = data.demPatch.px;
	const center = size / 2;
	const pxPerKm = center / data.demPatch.halfKm;
	const toXY = (azimuthDeg: number, metres: number): [number, number] => {
		const angle = (azimuthDeg * Math.PI) / 180;
		const radius = (metres / 1000) * pxPerKm;
		return [
			center + Math.sin(angle) * radius,
			center - Math.cos(angle) * radius,
		];
	};
	const reach = data.demPatch.halfKm * 1000 * 0.94;
	const left = toXY(data.solved.yaw - data.solved.hfov / 2, reach);
	const right = toXY(data.solved.yaw + data.solved.hfov / 2, reach);
	const heading = toXY(data.prior.yaw, reach);
	const yawTip = toXY(data.solved.yaw, reach * 0.62);
	const headingTip = toXY(data.prior.yaw, reach * 1.02);
	const peaks = data.peaks
		.filter((peak) => peak.labelled && peak.distance < reach * 0.92)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 3);
	const tenKm = 10 * pxPerKm;
	const cone = `M${center} ${center}L${left[0]} ${left[1]}L${right[0]} ${right[1]}Z`;
	return (
		<svg
			viewBox={`0 0 ${size} ${size}`}
			className="block w-full"
			role="img"
			aria-label={`Terrain within ${data.demPatch.halfKm} km of the camera, north up, with the solved view cone at ${data.solved.yaw.toFixed(1)}° and the compass heading at ${data.prior.yaw.toFixed(1)}°.`}
		>
			<image href={data.demPatch.src} x={0} y={0} width={size} height={size} />
			<Hachure
				d={cone}
				seed={`${data.id}-cone-fill`}
				color="red"
				opacity={0.55}
				width={1}
				gap={7}
			/>
			<SketchPath
				d={`M${left[0]} ${left[1]}L${center} ${center}L${right[0]} ${right[1]}`}
				seed={`${data.id}-cone`}
				color="red"
				width={1.8}
			/>
			<line
				x1={center}
				y1={center}
				x2={heading[0]}
				y2={heading[1]}
				stroke="var(--nb-paper)"
				strokeWidth={4}
				strokeOpacity={0.8}
			/>
			<SketchPath
				d={`M${center} ${center}L${heading[0]} ${heading[1]}`}
				seed={`${data.id}-heading`}
				color="blue"
				width={2}
				dash="7 5"
				passes={1}
			/>
			<HandText
				x={headingTip[0]}
				y={headingTip[1]}
				anchor={headingTip[0] < center ? "start" : "end"}
				color="blue"
				size={26}
			>
				compass {data.prior.yaw.toFixed(0)}°
			</HandText>
			{peaks.map((peak, index) => {
				const [px, py] = toXY(peak.az, peak.distance);
				return (
					<g key={peak.name}>
						<SketchPath
							d={`M${px} ${py - 8}l-7 12h14z`}
							seed={`${data.id}-${peak.name}`}
							color="ink"
							width={1.8}
						/>
						<HandText
							x={px + (index % 2 ? -11 : 11)}
							y={py + 4}
							anchor={index % 2 ? "end" : "start"}
							size={26}
						>
							{peak.name}
						</HandText>
					</g>
				);
			})}
			<PenCircle
				seed={`${data.id}-eye`}
				center={[center, center]}
				radiusX={9}
				color="ink"
				width={1.6}
			/>
			<HandText
				x={yawTip[0]}
				y={yawTip[1]}
				anchor="middle"
				color="red"
				size={30}
			>
				{data.solved.yaw.toFixed(1)}°
			</HandText>
			<HandText x={18} y={40} size={32}>
				N ↑
			</HandText>
			<PenDimension
				seed={`${data.id}-scale`}
				from={[size - 24 - tenKm, size - 24]}
				to={[size - 24, size - 24]}
				tick={4}
				width={1.5}
			/>
			<HandText
				x={size - 24 - tenKm / 2}
				y={size - 36}
				anchor="middle"
				size={26}
			>
				10 km
			</HandText>
		</svg>
	);
}

/** Ground along the solved view axis: the eye, the sight line to the skyline ridge, and ridge crests. */
export function SectionSketch({ data }: { data: GipfelbuchPhotoData }) {
	const points = data.terrainProfile.points;
	const widthPx = 520;
	const heightPx = 252;
	const left = 44;
	const right = widthPx - 16;
	const base = heightPx - 50;
	const plotTop = 40;
	const lastDistance = points[points.length - 1]?.[0] ?? 1;
	const heights = points.map((point) => point[1]);
	const low = Math.floor((Math.min(...heights) - 120) / 100) * 100;
	const high = Math.max(...heights, data.gps.eye) + 120;
	const x = (metres: number) => left + (metres / lastDistance) * (right - left);
	const y = (metres: number) =>
		base - ((metres - low) / (high - low)) * (base - plotTop);
	const heightAt = (metres: number) => {
		for (let i = 1; i < points.length; i++) {
			if (points[i][0] >= metres) {
				const [d0, h0] = points[i - 1];
				const [d1, h1] = points[i];
				return h0 + ((h1 - h0) * (metres - d0)) / (d1 - d0 || 1);
			}
		}
		return heights[heights.length - 1];
	};
	const exaggeration = Math.round(
		lastDistance / (right - left) / ((high - low) / (base - plotTop)),
	);
	const line = points
		.map(([d, h], i) => `${i ? "L" : "M"}${x(d).toFixed(1)} ${y(h).toFixed(1)}`)
		.join("");
	const area = `${line}L${x(lastDistance)} ${base}L${x(0)} ${base}Z`;
	// The horizon sample nearest the solved yaw says which ridge forms the skyline, and how far away.
	const yaw = ((data.solved.yaw % 360) + 360) % 360;
	const horizon = data.horizon.profile.reduce((best, sample) =>
		Math.abs(sample.az - yaw) < Math.abs(best.az - yaw) ? sample : best,
	);
	const skyDistance = Math.min(horizon.d, lastDistance);
	const skyPoint: [number, number] = [x(skyDistance), y(heightAt(skyDistance))];
	const eyePoint: [number, number] = [x(0), y(data.gps.eye)];
	const crests = horizon.ridges.filter(
		([, distance]) => distance > 1500 && distance < lastDistance * 0.97,
	);
	const clipId = `nb-section-${data.id}`;
	const ticks = Array.from(
		{ length: Math.floor(lastDistance / 10000) + 1 },
		(_, i) => i * 10000,
	);
	return (
		<svg
			viewBox={`0 0 ${widthPx} ${heightPx}`}
			className="block w-full"
			role="img"
			aria-label={`Terrain profile along the view axis to ${(lastDistance / 1000).toFixed(0)} km. The eye is at ${data.gps.eye.toFixed(0)} m over ground at ${data.gps.ground.toFixed(0)} m; the skyline is a ridge ${(horizon.d / 1000).toFixed(1)} km away.`}
		>
			<defs>
				<clipPath id={clipId}>
					<path d={area} />
				</clipPath>
			</defs>
			<path
				d={hachureLines(left, right, plotTop, base, 7, hashSeed(clipId))}
				clipPath={`url(#${clipId})`}
				stroke={inkColor("brown")}
				strokeOpacity={0.45}
				strokeWidth={0.9}
			/>
			<SketchPath d={line} seed={`${clipId}-line`} width={1.7} />
			<PenLine
				seed={`${clipId}-base`}
				from={[left - 6, base]}
				to={[right + 4, base]}
				color="pencil"
				width={1}
			/>
			{ticks.map((tick) => (
				<text
					key={tick}
					x={x(tick)}
					y={base + 16}
					textAnchor="middle"
					className="nb-num"
					fontSize={10}
					fill={inkColor("faint")}
				>
					{tick / 1000} km
				</text>
			))}
			{crests.map(([, distance]) => (
				<PenLine
					key={distance}
					seed={`${clipId}-crest-${distance}`}
					from={[x(distance), y(heightAt(distance)) - 4]}
					to={[x(distance), y(heightAt(distance)) - 11]}
					color="brown"
					width={1.4}
				/>
			))}
			<SketchPath
				d={`M${eyePoint[0]} ${eyePoint[1]}L${skyPoint[0]} ${skyPoint[1]}`}
				seed={`${clipId}-ray`}
				color="red"
				width={1.4}
				dash="5 4"
				passes={1}
			/>
			<HandDot x={eyePoint[0]} y={eyePoint[1]} r={3.5} seed={`${clipId}-eye`} />
			<PenCircle
				seed={`${clipId}-sky`}
				center={skyPoint}
				radiusX={10}
				radiusY={8}
				color="red"
				width={1.5}
				delay={400}
			/>
			<HandText
				x={skyPoint[0]}
				y={skyPoint[1] - 18}
				anchor="end"
				color="red"
				size={20}
			>
				skyline ridge, {(horizon.d / 1000).toFixed(1)} km
			</HandText>
			<HandText x={eyePoint[0] + 8} y={eyePoint[1] - 12} size={19}>
				eye {data.gps.eye.toFixed(0)} m
			</HandText>
			<HandText x={right} y={heightPx - 4} anchor="end" color="faint" size={17}>
				heights ×{exaggeration}, looking {yaw.toFixed(0)}°
			</HandText>
		</svg>
	);
}

type IndexPhoto = GipfelbuchIndex["photos"][number];

/** All twelve photos on one axis: how wrong the compass was, and whether the pose was shown. */
export function TallySketch({
	photos,
	selected,
	onSelect,
}: {
	photos: IndexPhoto[];
	selected: GipfelbuchPhotoId;
	onSelect: (id: GipfelbuchPhotoId) => void;
}) {
	const widthPx = 600;
	const axisY = 128;
	const values = photos.map((photo) => photo.delta.yaw);
	const low = Math.floor((Math.min(...values) - 2) / 5) * 5;
	const high = Math.ceil((Math.max(...values) + 2) / 5) * 5;
	const x = (value: number) =>
		30 + ((value - low) / (high - low)) * (widthPx - 60);
	// Stack dots that would touch, lowest first.
	const placed: { photo: IndexPhoto; cx: number; cy: number }[] = [];
	for (const photo of [...photos].sort((a, b) => a.delta.yaw - b.delta.yaw)) {
		const cx = x(photo.delta.yaw);
		let cy = axisY - 16;
		while (
			placed.some(
				(dot) => Math.abs(dot.cx - cx) < 15 && Math.abs(dot.cy - cy) < 15,
			)
		)
			cy -= 16;
		placed.push({ photo, cx, cy });
	}
	const ticks = Array.from(
		{ length: (high - low) / 5 + 1 },
		(_, i) => low + i * 5,
	);
	const stackTop = (cx: number) =>
		Math.min(
			...placed
				.filter((dot) => Math.abs(dot.cx - cx) < 15)
				.map((dot) => dot.cy),
		);
	const lowest = placed[0];
	const highest = placed[placed.length - 1];
	return (
		<svg
			viewBox={`0 0 ${widthPx} 160`}
			className="block w-full"
			aria-label="Compass correction for each of the twelve demo photos"
		>
			<PenLine
				seed="tally-axis"
				from={[24, axisY]}
				to={[widthPx - 24, axisY]}
				color="pencil"
				width={1.1}
			/>
			<SketchPath
				d={`M${x(0)} 20L${x(0)} ${axisY + 5}`}
				seed="tally-zero"
				color="faint"
				width={1}
				dash="3 4"
				passes={1}
			/>
			<HandText x={x(0) + 6} y={30} color="faint" size={17}>
				compass was right
			</HandText>
			{ticks.map((tick) => (
				<text
					key={tick}
					x={x(tick)}
					y={axisY + 18}
					textAnchor="middle"
					className="nb-num"
					fontSize={10}
					fill={inkColor("faint")}
				>
					{signed(tick, 0)}°
				</text>
			))}
			{placed.map(({ photo, cx, cy }) => {
				const isSelected = photo.id === selected;
				const refused = !photo.accepted;
				const refined = photo.accepted && photo.stage !== "solve";
				return (
					// biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
					<g
						key={photo.id}
						role="button"
						tabIndex={0}
						aria-label={`${photo.id}: compass off by ${signed(photo.delta.yaw)}°, ${refused ? "refused" : refined ? "accepted after refine" : "accepted"}`}
						aria-pressed={isSelected}
						className="cursor-pointer"
						onClick={() => onSelect(photo.id)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onSelect(photo.id);
							}
						}}
					>
						<circle cx={cx} cy={cy} r={11} fill="transparent" />
						{refused ? (
							<PenCircle
								seed={`tally-open-${photo.id}`}
								center={[cx, cy]}
								radiusX={5}
								color="ink"
								width={1.3}
							/>
						) : (
							<HandDot
								x={cx}
								y={cy}
								r={5.2}
								seed={`tally-dot-${photo.id}`}
								color={refined ? "brown" : "ink"}
							/>
						)}
						{refused ? (
							<PenCross
								seed={`tally-${photo.id}`}
								center={[cx, cy]}
								size={6}
								color="red"
								width={1.3}
							/>
						) : null}
						{isSelected ? (
							<PenCircle
								seed={`tally-sel-${photo.id}`}
								center={[cx, cy]}
								radiusX={12}
								color="red"
								width={1.6}
							/>
						) : null}
					</g>
				);
			})}
			{lowest && highest ? (
				<>
					<HandText
						x={lowest.cx - 8}
						y={stackTop(lowest.cx) - 15}
						anchor="start"
						size={18}
					>
						{signed(lowest.photo.delta.yaw)}°
					</HandText>
					<HandText
						x={highest.cx + 8}
						y={stackTop(highest.cx) - 15}
						anchor="end"
						size={18}
					>
						{signed(highest.photo.delta.yaw)}°
					</HandText>
				</>
			) : null}
		</svg>
	);
}

/** Tally marks in groups of five, as counted on paper. */
export function TallyMarks({ count, seed }: { count: number; seed: string }) {
	const groups = Math.ceil(count / 5);
	const widthPx = groups * 34 + 4;
	return (
		<svg
			viewBox={`0 0 ${widthPx} 30`}
			width={widthPx}
			height={30}
			className="inline-block align-middle"
			aria-hidden="true"
		>
			{Array.from({ length: count }, (_, i) => `${seed}-${i}`).map((key, i) => {
				const group = Math.floor(i / 5);
				const within = i % 5;
				const gx = 4 + group * 34;
				return within < 4 ? (
					<PenLine
						key={key}
						seed={key}
						from={[gx + within * 6, 4]}
						to={[gx + within * 6 + 1, 26]}
						width={1.5}
						delay={i * 60}
					/>
				) : (
					<PenLine
						key={key}
						seed={key}
						from={[gx - 3, 22]}
						to={[gx + 23, 8]}
						width={1.5}
						color="red"
						delay={i * 60}
					/>
				);
			})}
		</svg>
	);
}
