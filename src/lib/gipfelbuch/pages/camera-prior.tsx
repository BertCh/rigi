// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	HandScaleBar,
	KrokiTitle,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	SketchRect,
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	AlignmentStoryProvider,
	Callout,
	CodeRef,
	Figure,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	MarginNote,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Stat,
	Steps,
	StoryMap,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Key as ColorKey,
	Details,
	Gallery,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Sym } from "#/components/gipfelbuch/viz/math";
import { PhotoStory } from "#/components/gipfelbuch/viz/PhotoStory";
import { groupColor } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Numbers below are the real defaults from the code:
//  gps     sigmaH = clamp(hAcc ?? 20, 5, 100) m           (geocam/priors/photo-priors.ts sigmaHFromHAcc)
//  gravity sigma 1.5 deg                                  (geocam/map/factors.ts gravityFactor)
//  compass sigmaNoise 5 deg + sigmaBias 5 deg, Student-t nu 3 (COMPASS_DEFAULTS)
//  alt     sigmaA 3 m                                     (concord/priors/altitude.ts EYE_PRIOR_DEFAULTS)
const H_MIN = 5;
const H_MAX = 100;
const NOISE = 5;
const BIAS = 5;
const SIG_YAW = Math.hypot(NOISE, BIAS);
const SIG_G = 1.5;
// What the production skyline solve uses (src/lib/geo/solve.ts DEFAULT_SIGMA.yaw, yawRange).
const SOLVE_SIGMA_YAW = 15;
const SEARCH_YAW = 25;
const TRUE_YAW = 14; // deg east of north, illustrative scene
const rad = (d: number) => (d * Math.PI) / 180;

type Key = "gps" | "compass" | "gravity" | "focal";
const KEYS: { k: Key; label: string; sub: string; params: number }[] = [
	{ k: "gps", label: "GPS fix", sub: "position", params: 3 },
	{ k: "compass", label: "Compass", sub: "yaw", params: 1 },
	{ k: "gravity", label: "Gravity", sub: "pitch + roll", params: 2 },
	{ k: "focal", label: "EXIF focal", sub: "field of view", params: 1 },
];

const wedge = (cx: number, cy: number, r: number, a0: number, a1: number) => {
	const p = (a: number) =>
		`${(cx + r * Math.sin(rad(a))).toFixed(1)} ${(cy - r * Math.cos(rad(a))).toFixed(1)}`;
	return `M${cx} ${cy} L${p(a0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)} Z`;
};

// ---------------------------------------------------------------------------------------------------
// Real data: the sensor prior of the 12 bundled Niederhorn photos against the pose the pipeline solved
// (public/demo/gipfelbuch/*, scripts/gipfelbuch/build-data.ts). "Error" below means solved minus prior: the solved
// pose is the pipeline's own estimate (skyline fit, accepted by the confidence gate in 10 of 12), not a
// hand-registered truth.

/** manifest.json carries the raw EXIF numbers (hAccuracy) the gipfelbuch JSON does not repeat. */
function useHAcc() {
	const [m, setM] = useState<Record<string, number> | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/manifest.json")
			.then((r) => r.json())
			.then((j: { photos: { id: string; hAccuracy: number }[] }) => {
				if (live)
					setM(Object.fromEntries(j.photos.map((p) => [p.id, p.hAccuracy])));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return m;
}

/** A crop over the rows the three skyline curves occupy, so people at the bottom of the frame stay out. */
function skyBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	const all = [d.skyline.rows, d.priorRows, d.solvedRows]
		.flat()
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	const lo = all[Math.floor(all.length * 0.02)];
	const hi = all[Math.floor(all.length * 0.98)];
	const y0 = Math.max(0, Math.floor(lo - 80));
	const y1 = Math.min(d.photo.height, Math.max(Math.ceil(hi + 60), y0 + 280));
	return [0, y0, d.photo.width, y1];
}

const sgn = (v: number, n = 1) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;

function RealPrior({
	id,
	setId,
}: {
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
}) {
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	return (
		<Figure
			ground={d?.id}
			label="Fig. D1"
			bleed
			caption={
				<>
					<Measured data={d} /> Dashed magenta: the horizon predicted from the
					phone&apos;s own compass, gravity and focal length. Cyan: the horizon
					from the solved pose. Amber: the skyline found in the photo. Map: view
					cone at the sensor yaw (dashed) and solved yaw.
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const x = idx?.photos.find((p) => p.id === i);
					return x ? (
						<span
							className={`bg-[var(--gb-paper)] px-1 font-mono ${TYPE.micro} text-[var(--gb-ink)]`}
						>
							{sgn(x.delta.yaw, 0)}°
						</span>
					) : null;
				}}
			/>
			<AlignmentStoryProvider key={id} initial={1}>
				<div className="grid gap-4 lg:grid-cols-[1.55fr_1fr] lg:items-start">
					{/* the spill follows the story map's drag and keeps off it */}
					<div className="min-w-0" data-gb-bleed-bounds="right">
						<RealPhoto
							key={id}
							bleed
							data={d}
							layers={["skyline", "prior", "solved", "priorPeaks", "peaks"]}
							toggles={["skyline", "prior", "solved", "priorPeaks", "peaks"]}
							crop={d ? skyBand(d) : undefined}
							maxLabels={4}
						/>
					</div>
					<StoryMap data={d} crop={d ? skyBand(d) : undefined} maxLabels={4} />
				</div>
			</AlignmentStoryProvider>
			{d && (
				<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat
						value={`${sgn(d.solved.delta.yaw)}°`}
						label={`compass error (heading ${d.sensor.heading.toFixed(1)}°)`}
					/>
					<Stat
						value={`${sgn(d.solved.delta.pitch)}°`}
						label={`gravity pitch error (${d.sensor.pitch.toFixed(1)}°)`}
					/>
					<Stat
						value={`${sgn(d.solved.delta.roll)}°`}
						label={`gravity roll error (${d.sensor.roll.toFixed(1)}°)`}
					/>
					<Stat
						value={`${d.residual.prior.median.toFixed(0)} → ${d.residual.solved.median.toFixed(1)} px`}
						label="median skyline gap, sensors → solved"
					/>
				</div>
			)}
		</Figure>
	);
}

const rectD = (x0: number, y0: number, x1: number, y1: number) =>
	`M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
const circleD = (cx: number, cy: number, r: number) =>
	`M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;

// Label sizes: 11 and 13 px rendered at the text column (~720 px) for this 520-wide viewBox.
const STRIP_W = 520;
const STRIP_LABEL_SMALL = 9;
const STRIP_LABEL = 10.5;

function Strip({
	title,
	unit,
	vals,
	range,
	sigma,
	sel,
	onPick,
	fmt = (v: number) => `${v}`,
	band,
	note,
}: /** One horizontal strip: the 12 photos' errors as dots, with the prior's 1σ and 2σ bands stippled behind. */
{
	title: string;
	unit: string;
	vals: { id: GipfelbuchPhotoId; v: number }[];
	range: [number, number];
	sigma?: number;
	band?: [number, number];
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
	fmt?: (v: number) => string;
	/** A hand note under the strip, from the measured values. */
	note?: ReactNode;
}) {
	const W = STRIP_W;
	const x0 = 14;
	const x1 = W - 14;
	const X = (v: number) =>
		x0 + ((v - range[0]) / (range[1] - range[0])) * (x1 - x0);
	const y = 40;
	const sorted = [...vals].sort((a, b) => a.v - b.v);
	const lane: number[] = [];
	const lastX: number[] = [];
	for (const p of sorted) {
		let k = lastX.findIndex((e) => X(p.v) - e > 15);
		if (k < 0) k = lastX.length;
		lastX[k] = X(p.v);
		lane.push(k);
	}
	const ticks = 4;
	return (
		<svg
			viewBox={`0 0 ${W} 108`}
			className="block h-auto w-full"
			role="img"
			aria-label={`${title}: measured error per photo`}
		>
			<HandLabel x={x0} y={14} size={STRIP_LABEL} color={SWISS.ink}>
				{title}
			</HandLabel>
			{sigma != null && (
				<>
					<Wash
						d={rectD(X(-2 * sigma), 22, X(2 * sigma), 82)}
						color="ink"
						seed={`strip-${title}-2sigma`}
						opacity={0.03}
					/>
					<Wash
						d={rectD(X(-sigma), 22, X(sigma), 82)}
						color="ink"
						seed={`strip-${title}-1sigma`}
						opacity={0.05}
					/>
					<HandLabel
						x={X(sigma) - 3}
						y={34}
						anchor="end"
						size={STRIP_LABEL}
						color={SWISS.secondary}
					>
						±1σ = {sigma.toFixed(1)}
					</HandLabel>
				</>
			)}
			{band && (
				<Wash
					d={rectD(X(band[0]), 22, X(band[1]), 82)}
					color="ink"
					seed={`strip-${title}-band`}
					opacity={0.05}
				/>
			)}
			<PenLine
				seed={`strip-${title}-axis`}
				from={[x0, y + 30]}
				to={[x1, y + 30]}
				color="pencil"
				width={1.1}
			/>
			{Array.from(
				{ length: ticks + 1 },
				(_, i) => range[0] + ((range[1] - range[0]) * i) / ticks,
			).map((v) => (
				<g key={v}>
					<PenLine
						seed={`strip-${title}-tick-${v}`}
						from={[X(v), y + 30]}
						to={[X(v), y + 36]}
						color="pencil"
						width={1}
					/>
					<HandLabel
						x={X(v)}
						y={y + 48}
						anchor="middle"
						size={STRIP_LABEL_SMALL}
						color={SWISS.secondary}
					>
						{fmt(v)}
					</HandLabel>
				</g>
			))}
			{range[0] < 0 && (
				<PenLine
					seed={`strip-${title}-zero`}
					from={[X(0), 22]}
					to={[X(0), y + 30]}
					color="pencil"
					width={0.9}
					dash="2 3"
				/>
			)}
			<HandLabel
				x={x1}
				y={14}
				anchor="end"
				size={STRIP_LABEL_SMALL}
				color={SWISS.secondary}
			>
				{unit}
			</HandLabel>
			{sorted.map((p, i) => {
				const cy = y + 18 - lane[i] * 11;
				const on = p.id === sel;
				return (
					// biome-ignore lint/a11y/useSemanticElements: SVG dot
					<g
						key={p.id}
						role="button"
						tabIndex={0}
						aria-label={p.id}
						onClick={() => onPick(p.id)}
						onKeyDown={(e) => e.key === "Enter" && onPick(p.id)}
						className="cursor-pointer"
					>
						<circle cx={X(p.v)} cy={cy} r={9} fill="transparent" />
						<HandDot
							x={X(p.v)}
							y={cy}
							r={on ? 6.8 : 4.6}
							seed={`strip-${title}-dot-${p.id}`}
							data
							color={on ? "red" : SWISS.ink}
							opacity={on ? 1 : 0.85}
						/>
						{on && (
							<>
								<PenCircle
									seed={`strip-${title}-sel-${p.id}`}
									center={[X(p.v), cy]}
									radiusX={9.5}
									color="red"
									width={1}
								/>
								<HandLabel
									x={X(p.v)}
									y={cy - 13}
									anchor="middle"
									size={STRIP_LABEL_SMALL}
									color="var(--gb-red)"
								>
									{p.id.slice(-2)} · {fmt(p.v)}
								</HandLabel>
							</>
						)}
					</g>
				);
			})}
			{note && (
				<HandText
					x={x1}
					y={104}
					anchor="end"
					size={10.5}
					rotate={-1}
					halo={false}
				>
					{note}
				</HandText>
			)}
		</svg>
	);
}

function PriorErrors({
	sel,
	onPick,
}: {
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
}) {
	const idx = useGipfelbuchIndex();
	const hacc = useHAcc();
	if (!idx)
		return <div className="h-64 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const photos = idx.photos;
	const by = (f: (p: (typeof photos)[number]) => number) =>
		photos.map((p) => ({ id: p.id, v: f(p) }));
	const med = (a: number[]) => {
		const s = [...a].map(Math.abs).sort((x, y) => x - y);
		return (s[5] + s[6]) / 2;
	};
	const yaw = by((p) => p.delta.yaw);
	const pit = by((p) => p.delta.pitch);
	const rol = by((p) => p.delta.roll);
	return (
		<Figure
			label="Fig. D2"
			caption={
				<>
					Measured on the 12 demo photos (error = solved − sensors; click a dot
					to load it in Fig. D1). Shaded bands are the assumed widths: compass{" "}
					{SIG_YAW.toFixed(1)}° (1σ and 2σ), gravity {SIG_G}°, GPS 5 to 100 m.
				</>
			}
		>
			<div className="grid gap-3">
				<Strip
					title="Compass heading error"
					unit="degrees"
					vals={yaw}
					range={[-20, 20]}
					sigma={SIG_YAW}
					sel={sel}
					onPick={onPick}
					fmt={(v) => sgn(v, 1)}
					note={`${yaw.filter((p) => Math.abs(p.v) > SIG_YAW).length} of 12 outside 1σ. Is the compass lying?`}
				/>
				<Strip
					title="Gravity pitch error"
					unit="degrees"
					vals={pit}
					range={[-4, 4]}
					sigma={SIG_G}
					sel={sel}
					onPick={onPick}
					note={`${pit.filter((p) => Math.abs(p.v) > SIG_G).length} photos beyond ${SIG_G}°: gravity is tighter`}
				/>
				<Strip
					title="Gravity roll error"
					unit="degrees"
					vals={rol}
					range={[-4, 4]}
					sigma={SIG_G}
					sel={sel}
					onPick={onPick}
				/>
				{hacc ? (
					<Strip
						title="GPS accuracy (clamp band shaded)"
						unit="metres"
						vals={GIPFELBUCH_PHOTO_IDS.map((id) => ({ id, v: hacc[id] }))}
						range={[0, 140]}
						band={[H_MIN, H_MAX]}
						note="clamped to 5–100 m before use"
						sel={sel}
						onPick={onPick}
						fmt={(v) => v.toFixed(0)}
					/>
				) : (
					<div className="h-24 animate-pulse bg-[var(--gb-paper-deep)]" />
				)}
			</div>
			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat
					value={`${med(yaw.map((p) => p.v)).toFixed(1)}°`}
					label="median |compass error|, all 12 photos"
				/>
				<Stat
					value={`${yaw.filter((p) => Math.abs(p.v) > SIG_YAW).length} / 12`}
					label={`beyond the assumed 1σ (${SIG_YAW.toFixed(1)}°)`}
				/>
				<Stat
					value={`${med(pit.map((p) => p.v)).toFixed(2)}° / ${med(rol.map((p) => p.v)).toFixed(2)}°`}
					label="median |pitch| / |roll| error"
				/>
				<Stat
					value={`${Math.max(...yaw.map((p) => Math.abs(p.v))).toFixed(1)}°`}
					label="worst compass error (photo 10)"
				/>
			</div>
		</Figure>
	);
}

// Static pen furniture for PriorLab, built once (the lab re-renders every frame).
const LAB_CX = 270;
const LAB_CY = 330;
const LAB_R = 280;
const LAB_PX_PER_M = 1.5;
const LAB_HALF_FUZZ_OFF = 22;
const LAB_RINGS = [100, 200, 300].map((r) => (
	<SketchPath
		key={r}
		d={circleD(LAB_CX, LAB_CY, r * LAB_PX_PER_M)}
		seed={`lab-ring-${r}`}
		color="faint"
		width={0.6}
		dash="2 5"
		passes={1}
	/>
));
const LAB_NORTH = (
	<g>
		<PenLine
			seed="lab-north"
			from={[LAB_CX, LAB_CY]}
			to={[LAB_CX, 14]}
			color="faint"
			width={0.8}
		/>
		<HandLabel x={LAB_CX + 8} y={24} size={13} color={SWISS.secondary}>
			N
		</HandLabel>
	</g>
);
const LAB_PIVOT = (
	<PenCircle
		seed="lab-pulse"
		center={[0, 0]}
		radiusX={10}
		color="pencil"
		width={1.2}
	/>
);
const LAB_CAMERA = (
	<HandDot
		x={LAB_CX}
		y={LAB_CY}
		r={4.8}
		seed="lab-camera"
		color="red"
		opacity={1}
	/>
);
const HORIZON_K = [-1, -0.5, 0, 0.5, 1];
const HORIZON_LINES = HORIZON_K.map((k) => (
	<PenLine
		key={k}
		seed={`lab-horizon-${k}`}
		from={[-160, 0]}
		to={[160, 0]}
		color="pencil"
		width={1.2}
	/>
));
const HORIZON_LEVEL = (
	<PenLine
		seed="lab-level"
		from={[-160, 0]}
		to={[160, 0]}
		color="ink"
		width={2}
	/>
);

function PriorLab(_props: { accent: string }) {
	const [on, setOn] = useState<Record<Key, boolean>>({
		gps: true,
		compass: false,
		gravity: false,
		focal: false,
	});
	const [hAcc, setHAcc] = useState(20);
	const [ref, t] = useTime<HTMLDivElement>(0);
	const sigH = Math.min(H_MAX, Math.max(H_MIN, hAcc));
	const nOn = KEYS.filter((k) => on[k.k]).reduce((a, k) => a + k.params, 0);
	const total = 7;

	// plan view
	const cx = LAB_CX;
	const cy = LAB_CY;
	const R = LAB_R;
	const pxPerM = LAB_PX_PER_M;
	const half = on.focal ? 32 : 40;
	const halfFuzz = on.focal ? 2 : LAB_HALF_FUZZ_OFF; // lens unknown: hfov could be anything in a band
	const sy = on.compass ? SIG_YAW : 180;
	const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
	const spin = (t * 40) % 360;

	// plan: yaw wedge layers (1,2,3 sigma)
	const yawLayers = on.compass
		? [3, 2, 1].map((k) => ({ k, a: Math.min(179, k * sy) }))
		: [];
	// The nominal view wedge is drawn once, pointing north, and turned with a transform: no re-sketching per frame.
	const fovAngle = on.compass ? TRUE_YAW : spin;
	const fovD = wedge(cx, cy, R - 20, -half, half);
	const fuzzLeftD = wedge(cx, cy, R - 20, -half - halfFuzz, -half);
	const fuzzRightD = wedge(cx, cy, R - 20, half, half + halfFuzz);
	const gpsSpacing = Math.max(5, (sigH * pxPerM) / 16);

	// gravity inset
	const wob = (s: number) => Math.sin(t * s) * 1;
	const tilt = on.gravity ? 0 : 22 * wob(0.9);
	const lift = on.gravity ? 0 : 18 * wob(1.3);
	const gx = 100;
	const gy = 100;
	const horizonAt = (k: number) => {
		const yc = gy + lift * (1 + k * 0.5);
		const dy = (tilt + k * 8) * 2.8;
		return `translate(${gx} ${yc.toFixed(2)}) rotate(${((-Math.atan2(dy, 160) * 180) / Math.PI).toFixed(2)})`;
	};

	return (
		<Figure
			label="Fig. D3"
			source="Skizze"
			caption="Not a photo. A camera prior is one belief per sensor. Toggle each sensor and watch the possibilities shrink. Widths use the real defaults: GPS 5 to 100 m, compass 5° noise + 5° bias, gravity 1.5°."
		>
			<div ref={ref} className="p-3 sm:p-5">
				<div className="flex flex-wrap gap-2">
					{KEYS.map((k) => (
						<button
							key={k.k}
							type="button"
							aria-pressed={on[k.k]}
							onClick={() => setOn({ ...on, [k.k]: !on[k.k] })}
							className={`border-b-2 bg-[var(--gb-paper-deep)] px-3.5 py-1.5 text-left font-mono ${TYPE.caption} transition`}
							style={{
								borderColor: on[k.k] ? "var(--gb-ink)" : "transparent",
								color: on[k.k] ? "var(--gb-ink)" : "var(--gb-secondary)",
							}}
						>
							<svg
								width={10}
								height={10}
								viewBox="0 0 10 10"
								className="mr-2 inline-block"
								aria-hidden="true"
							>
								<HandDot
									x={5}
									y={5}
									r={3.4}
									seed={`lab-key-${k.k}`}
									color={on[k.k] ? "ink" : "faint"}
									opacity={1}
								/>
							</svg>
							{k.label}
							<span className="ml-2 gb-secondary">{k.sub}</span>
						</button>
					))}
				</div>

				<div className="mt-4 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
					<svg
						viewBox="0 0 540 380"
						className="h-auto w-full bg-[var(--gb-paper-deep)]"
						role="img"
						aria-label="Plan view of the camera prior: position disc and yaw wedge"
					>
						<defs>
							<clipPath id="cp-clip">
								<rect x="0" y="0" width="540" height="380" />
							</clipPath>
						</defs>
						<g clipPath="url(#cp-clip)">
							{LAB_RINGS}
							{[100, 200].map((r) => (
								<HandLabel
									key={r}
									x={cx + 4}
									y={cy - r * pxPerM - 4}
									size={11}
									color={SWISS.secondary}
								>
									{r} m
								</HandLabel>
							))}
							{/* yaw wedge: stipple, denser toward the centre of belief */}
							{on.compass ? (
								yawLayers.map((l) => (
									<Stipple
										key={l.k}
										d={wedge(
											cx,
											cy,
											R,
											TRUE_YAW - l.a - half - halfFuzz,
											TRUE_YAW + l.a + half + halfFuzz,
										)}
										seed={`lab-yaw-${l.k}`}
										color="pencil"
										spacing={5 + l.k * 3.5}
										size={1.4}
										opacity={0.7}
									/>
								))
							) : (
								<Stipple
									d={circleD(cx, cy, R)}
									seed="lab-yaw-any"
									color="pencil"
									spacing={13}
									size={1.3}
									opacity={0.55}
								/>
							)}
							{/* field of view: nominal wedge, turned by a transform */}
							<g transform={`rotate(${fovAngle.toFixed(2)} ${cx} ${cy})`}>
								{on.compass ? (
									<Hachure
										d={fovD}
										seed="lab-fov"
										color="ink"
										gap={6}
										angle={-45 - TRUE_YAW}
										opacity={0.5}
									/>
								) : (
									<Stipple
										d={fovD}
										seed="lab-fov-spin"
										color="ink"
										spacing={9}
										size={1.4}
										opacity={0.5}
									/>
								)}
								<SketchPath
									d={fovD}
									seed="lab-fov-edge"
									color="ink"
									width={1.4}
									passes={1}
								/>
								{!on.focal && (
									<>
										<SketchPath
											d={fuzzLeftD}
											seed="lab-fuzz-l"
											color="pencil"
											width={1}
											dash="3 4"
											passes={1}
										/>
										<SketchPath
											d={fuzzRightD}
											seed="lab-fuzz-r"
											color="pencil"
											width={1}
											dash="3 4"
											passes={1}
										/>
									</>
								)}
							</g>
							{/* compass reading ray */}
							{on.compass && (
								<PenLine
									seed="lab-ray"
									from={[cx, cy]}
									to={[
										cx + (R - 8) * Math.sin(rad(TRUE_YAW)),
										cy - (R - 8) * Math.cos(rad(TRUE_YAW)),
									]}
									color="ink"
									width={1.2}
									dash="1 5"
								/>
							)}
							{LAB_NORTH}
							{/* position */}
							{on.gps ? (
								<>
									<Stipple
										d={circleD(cx, cy, sigH * pxPerM)}
										seed="lab-gps"
										color="pencil"
										spacing={gpsSpacing}
										size={1.6}
										opacity={0.85}
									/>
									<SketchPath
										d={circleD(cx, cy, sigH * pxPerM)}
										seed="lab-gps-edge"
										color="pencil"
										width={1}
										passes={1}
										opacity={0.8}
									/>
								</>
							) : (
								<Stipple
									d={rectD(6, 6, 534, 374)}
									seed="lab-gps-any"
									color="pencil"
									spacing={20}
									size={1.2}
									opacity={0.4}
								/>
							)}
							{LAB_CAMERA}
							<g
								transform={`translate(${cx} ${cy}) scale(${(1 + 0.3 * pulse).toFixed(3)})`}
							>
								{LAB_PIVOT}
							</g>
						</g>
						<KrokiTitle
							x={14}
							y={26}
							title="Plan: where the prior says I stand"
							author=""
							seed="lab-title"
							size={16}
						/>
						<HandScaleBar
							x={400}
							y={356}
							metersPerPixel={1 / pxPerM}
							meters={100}
							segments={2}
							seed="lab-scale"
						/>
						<HandText x={cx + 16} y={cy + 34} size={15} rotate={-3}>
							{on.gps
								? "I am somewhere in this disc"
								: "no GPS: I could be anywhere"}
						</HandText>
						<PenArrow
							seed="lab-camera-arrow"
							from={[cx + 24, cy + 20]}
							to={[cx + 7, cy + 7]}
							color="ink"
							width={1.1}
							head={5}
						/>
						<HandLabel x={14} y={368} color="var(--gb-secondary)">
							{on.gps
								? `GPS width ${sigH.toFixed(0)} m`
								: "position: any (no GPS)"}
						</HandLabel>
					</svg>

					<div className="flex flex-col gap-3">
						<svg
							viewBox="0 0 200 200"
							className="h-auto w-full bg-[var(--gb-paper-deep)]"
							role="img"
							aria-label="Gravity inset: horizon tilt"
						>
							<defs>
								<clipPath id="cp-frame">
									<rect x="20" y="40" width="160" height="120" />
								</clipPath>
							</defs>
							<SketchRect
								x={20}
								y={40}
								width={160}
								height={120}
								seed="lab-frame"
								color="pencil"
							/>
							<g clipPath="url(#cp-frame)">
								{on.gravity ? (
									<g transform={horizonAt(0)}>{HORIZON_LEVEL}</g>
								) : (
									HORIZON_K.map((k, i) => (
										<g key={k} transform={horizonAt(k)}>
											{HORIZON_LINES[i]}
										</g>
									))
								)}
								{on.gravity && (
									<Hachure
										d={rectD(0, gy - SIG_G * 4, 200, gy + SIG_G * 4)}
										seed="lab-gravity-band"
										color="pencil"
										gap={2.5}
										opacity={0.8}
									/>
								)}
							</g>
							<HandLabel
								x={100}
								y={28}
								anchor="middle"
								color="var(--gb-secondary)"
							>
								{on.gravity
									? `pitch, roll ±${SIG_G}°`
									: "pitch, roll: unconstrained"}
							</HandLabel>
							<HandLabel
								x={100}
								y={184}
								anchor="middle"
								size={13}
								color={SWISS.secondary}
							>
								accelerometer, gravity vector
							</HandLabel>
						</svg>

						<div className="bg-[var(--gb-paper-deep)] p-3">
							<div className={`block font-mono ${TYPE.micro} gb-secondary`}>
								GPS accuracy
								{hAcc < H_MIN || hAcc > H_MAX ? ` (clamped to ${sigH})` : ""}
								<HandRange
									value={hAcc}
									min={1}
									max={150}
									step={1}
									label="GPS accuracy"
									onChange={setHAcc}
									readout={`${hAcc} m`}
								/>
							</div>
						</div>
					</div>
				</div>

				<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat
						value={on.gps ? `${sigH.toFixed(0)} m` : "free"}
						label="GPS width"
					/>
					<Stat
						value={on.compass ? `${SIG_YAW.toFixed(1)}°` : "360°"}
						label="yaw spread"
					/>
					<Stat
						value={on.gravity ? `${SIG_G}°` : "free"}
						label="pitch / roll width"
					/>
					<Stat value={`${nOn} / ${total}`} label="unknowns pinned" />
				</div>
				<svg
					viewBox="0 0 600 14"
					className="mt-3 block h-auto w-full"
					role="img"
					aria-label={`${nOn} of ${total} parameters have a prior`}
				>
					<PenLine
						seed="lab-progress-track"
						from={[0, 12]}
						to={[600, 12]}
						color="faint"
						width={0.9}
					/>
					{nOn > 0 && (
						<>
							<Hachure
								d={rectD(0, 2, (nOn / total) * 600, 10)}
								seed="lab-progress-hatch"
								color="ink"
								gap={2.4}
								width={1.1}
								opacity={0.9}
							/>
							<SketchPath
								d={rectD(0, 2, (nOn / total) * 600, 10)}
								seed="lab-progress-bar"
								data
								color="ink"
								width={1.2}
							/>
						</>
					)}
				</svg>
			</div>
		</Figure>
	);
}

function Deep({ accent }: { accent: string }) {
	const [id, setId] = useNotebookPhoto();
	const A = (id: string, label: string) => (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="underline decoration-[var(--gb-red)] underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<Section kicker="Capture" title="What it is">
				<p>
					The phone already tells us roughly where the camera is and where it
					points: a GPS fix with an accuracy radius, a compass heading, a
					gravity vector (giving pitch and roll) and an EXIF focal length.
					Together these are the <strong>camera prior</strong>. It feeds the{" "}
					{A("pose-estimate", "pose estimate")};{" "}
					{A("prior-unknowns", "prior unknowns")} tracks which parts are
					placeholders.
				</p>
			</Section>

			<RealPrior id={id} setId={setId} />
			<PriorErrors sel={id} onPick={setId} />

			<PriorLab accent={accent} />

			<Section kicker="Mechanism" title="How it works">
				<p>
					Each sensor gets its own width: GPS accuracy clamped to 5 to 100 m
					(default 20), gravity 1.5°, and a compass built from 5° noise plus 5°
					bias with heavy tails, so one wild reading cannot drag the yaw. A
					magnetic heading is first corrected to true north.
				</p>
				<p>
					On the real photos (Fig. D2) the compass is the weak sensor. Median
					heading error is <HandMark type="underline">7.9°</HandMark> on all 12
					(9.6° on the ten accepted); six sit beyond the assumed 7.1° and the
					worst, photo 10, is{" "}
					<HandMark type="double">19.0° off (2.7σ)</HandMark>, hence the heavy
					tails. Gravity is tighter: median pitch error 0.76°, roll 0.68°,
					though three photos exceed 1.5° in pitch (−2.7° photo 11, +2.6° photo
					02, −2.2° photo 12).
				</p>
			</Section>
			<div className="mt-6">
				<Steps
					steps={[
						{
							title: "Position",
							body: "GPS fix, width set by the phone’s accuracy (5 to 100 m); altitude is a separate hint (±3 m) unless the position was pinned by hand.",
						},
						{
							title: "Attitude",
							body: "Gravity gives pitch and roll to 1.5°; the compass gives yaw, corrected for declination, with heavy tails.",
						},
						{
							title: "Lens",
							body: "An optional focal length from the EXIF table.",
						},
					]}
				/>
			</div>

			<Section kicker="Relevance" title="Why it matters in Rigi">
				<p>
					Priors make the search finite. Without a compass, yaw is a full
					circle; without GPS the camera could be anywhere. With them the
					solvers start near the answer and only have to refine.
				</p>
				<div className="!mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
					<Stat value="5 to 100 m" label="GPS width" />
					<Stat value="1.5°" label="gravity width" />
				</div>
			</Section>

			<Section kicker="Lessons" title="Gotchas">
				<ul>
					<li>
						<strong>A prior is not evidence to pull on.</strong> Switching the
						priors off helped, and an altitude rule was worse on held-out photos
						(median 12.0 to 13.4 px). Priors are vetoes and tie-breaks, not
						pulls.
					</li>
					<li>
						<strong>Missing is not zero.</strong> A photo with no compass or
						lens carries a placeholder; unknown flags let the solver raise its
						accept bar instead of trusting it. See{" "}
						{A("prior-unknowns", "prior unknowns")}.
					</li>
					<li>
						<strong>Magnetic versus true.</strong> iPhones store true north;
						others store magnetic. Declination is applied where the heading is{" "}
						<em>used</em>, never where it is stored.
					</li>
				</ul>
				<Callout tone="lesson">
					Treat the prior as a starting point and a veto; let the image decide.
				</Callout>
			</Section>

			<Section kicker="In the code" title="Where to look">
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/pose6dof/types.ts" />
					<CodeRef path="src/lib/geocam/priors/photo-priors.ts" />
					<CodeRef path="src/lib/geocam/priors/heading.ts" />
					<CodeRef path="src/lib/geocam/map/factors.ts" />
					<CodeRef path="src/lib/concord/priors/altitude.ts" />
				</div>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front. Everything here is measured (public/demo/gipfelbuch) except the three tiny Trio schematics,
// which are drawn from the real values of the picked photo.
// ======================================================================================

function HeroCompare() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	return (
		<PhotoStory
			photoId={photoId}
			focus="prior"
			number="1"
			title="The phone's guess, struck through"
			caption={
				<>
					{d
						? `Sensors alone put the skyline ${d.residual.prior.median.toFixed(0)} px off (yaw ${sgn(d.solved.delta.yaw)}°). After solving, the median gap is ${d.residual.solved.median.toFixed(1)} px.`
						: "Sensors alone, then solved."}{" "}
					<ColorKey layer="prior">sensors only</ColorKey>
					{", "}
					<ColorKey layer="solved">solved</ColorKey>
					{", "}
					<ColorKey layer="skyline">skyline in the photo</ColorKey>.{" "}
					{d ? <Measured data={d} /> : null}
				</>
			}
		/>
	);
}

/** One worked example of what a yaw error does to the picture: the whole skyline slides sideways by f·tan(Δψ). */
function YawShift() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	if (!d) return null;
	const dyaw = d.solved.delta.yaw;
	const shift = d.prior.f * Math.tan(rad(Math.abs(dyaw)));
	return (
		<>
			<Eq
				label="What a compass error does to the picture"
				where={[
					{ sym: "Δx", text: "how far the skyline slides sideways, in pixels" },
					{ sym: "f", text: "focal length in pixels, from the lens tag" },
					{ sym: "ψ", c: "prior", text: "yaw the compass reported" },
					{ sym: "ψ", c: "solved", text: "yaw the skyline fit found" },
				]}
			>
				<Sym>Δx</Sym> ≈ <Sym>f</Sym> · tan(<Sym c="solved">ψ</Sym> −{" "}
				<Sym c="prior">ψ</Sym>)
			</Eq>
			<p className={`-mt-3 mb-6 ${TYPE.caption} gb-secondary`}>
				Photo above: f = {d.prior.f.toFixed(0)} px, Δψ = {sgn(dyaw)}°, so Δx ={" "}
				{shift.toFixed(0)} px of an {d.photo.width} px frame. The ridge&rsquo;s
				slope turns that slide into the {d.residual.prior.median.toFixed(0)} px
				vertical gap.
			</p>
		</>
	);
}

// Label sizes: viewBox 720 drawn at ~880 px (wide track) is ~1.22x, so 10 -> ~12 px rendered.
const YAWBARS_W = 720;
const YAWBARS_LABEL = 10;

/** Twelve compass errors as one diverging bar each. Solid = accepted; red outline = the solve was rejected, so the error is not trusted. */
function YawBars() {
	const idx = useGipfelbuchIndex();
	if (!idx)
		return <div className="h-48 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const W = YAWBARS_W;
	const zero = 120;
	const k = 5; // px per degree
	const bw = 38;
	const step = (W - 40) / 12;
	const photos = idx.photos;
	const worstAt = photos.reduce(
		(best, p, i) =>
			Math.abs(p.delta.yaw) > Math.abs(photos[best].delta.yaw) ? i : best,
		0,
	);
	const worstYaw = photos[worstAt];
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The compass is off by up to 19° across twelve photos. Shaded: the ±
					{SOLVE_SIGMA_YAW}° the solver allows for; the search reaches ±
					{SEARCH_YAW}°. Magnetic declination here is only +3.4° and iPhones
					already write true north. Red outline: rejected solves.{" "}
					<Measured data={idx} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} 250`}
				className="block h-auto w-full"
				role="img"
				aria-label="Compass error per photo"
			>
				<Wash
					d={rectD(
						20,
						zero - SOLVE_SIGMA_YAW * k,
						W - 20,
						zero + SOLVE_SIGMA_YAW * k,
					)}
					color="ink"
					seed="yawbars-sigma"
					opacity={0.04}
				/>
				<PenLine
					seed="yawbars-zero"
					data
					from={[20, zero]}
					to={[W - 20, zero]}
					color="ink"
					width={1.2}
				/>
				<HandLabel
					x={24}
					y={zero - SOLVE_SIGMA_YAW * k - 6}
					size={YAWBARS_LABEL}
					color="var(--gb-secondary)"
				>
					solver allows ±{SOLVE_SIGMA_YAW}°
				</HandLabel>
				{photos.map((p, i) => {
					const v = p.delta.yaw;
					const x = 20 + step * i + (step - bw) / 2;
					const h = Math.max(Math.abs(v) * k, 1);
					const top = v >= 0 ? zero - h : zero;
					return (
						<g key={p.id}>
							{p.accepted ? (
								<Hachure
									d={rectD(x, top, x + bw, top + h)}
									seed={`yawbars-hatch-${p.id}`}
									color="ink"
									gap={2.6}
									width={1.2}
									opacity={0.85}
								/>
							) : null}
							<SketchPath
								d={rectD(x, top, x + bw, top + h)}
								seed={`yawbars-bar-${p.id}`}
								data
								color={p.accepted ? "ink" : "red"}
								width={p.accepted ? 1.2 : 1.5}
							/>
							<HandLabel
								x={x + bw / 2}
								y={v >= 0 ? top - 6 : top + h + 14}
								anchor="middle"
								size={YAWBARS_LABEL}
								color={SWISS.ink}
							>
								{sgn(v, 1)}
							</HandLabel>
							<HandLabel
								x={x + bw / 2}
								y={244}
								anchor="middle"
								size={YAWBARS_LABEL}
								color="var(--gb-secondary)"
							>
								{p.id.slice(-2)}
							</HandLabel>
						</g>
					);
				})}
				<CircledKey x={W - 48} y={34} value={1} seed="yawbars-key" />
				<HandText x={W - 62} y={60} anchor="end" size={14} rotate={-2}>
					worst: {worstYaw.id.slice(-2)}, {sgn(worstYaw.delta.yaw, 1)}°
				</HandText>
				<PenArrow
					seed="yawbars-worst-arrow"
					from={[W - 130, 66]}
					to={[
						20 + step * worstAt + step / 2,
						zero + Math.abs(worstYaw.delta.yaw) * k + 22,
					]}
					color="ink"
					width={1.1}
				/>
			</svg>
		</Figure>
	);
}

function PriorTrio() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const haccAll = useHAcc();
	const hacc = haccAll?.[photoId];
	// rank among the bundled photos by reported horizontal accuracy: 1 = loosest fix
	const haccValues = haccAll ? Object.values(haccAll) : [];
	const looseRank =
		hacc != null ? haccValues.filter((v) => v > hacc).length + 1 : null;
	const haccRankNote =
		looseRank == null || haccValues.length === 0
			? ""
			: looseRank === 1
				? `loosest of ${haccValues.length}`
				: looseRank === haccValues.length
					? `tightest of ${haccValues.length}`
					: `${looseRank}${looseRank === 2 ? "nd" : looseRank === 3 ? "rd" : "th"} loosest of ${haccValues.length}`;
	const ang = (deg: number, r: number) => [
		50 + r * Math.sin(rad(deg)),
		50 - r * Math.cos(rad(deg)),
	];
	const box = "block h-auto w-full";
	return (
		<Trio
			steps={[
				{
					title: "GPS draws a circle",
					body: "We are somewhere inside it. The phone reports how wide.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="GPS error disc"
						>
							<Stipple
								d={circleD(50, 37, 30)}
								seed="trio-gps"
								color="pencil"
								spacing={4}
								size={1.1}
								opacity={0.8}
							/>
							<SketchPath
								d={circleD(50, 37, 30)}
								seed="trio-gps-edge"
								color="pencil"
								width={0.9}
								passes={1}
							/>
							<HandDot
								x={50}
								y={37}
								r={2.6}
								seed="trio-gps-fix"
								color="red"
								opacity={1}
							/>
							<HandText x={52} y={46} size={5} halo={false}>
								fix
							</HandText>
							{haccRankNote && (
								<HandText x={4} y={9} size={5} rotate={-2} halo={false}>
									{haccRankNote}
								</HandText>
							)}
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{hacc ? `±${hacc.toFixed(0)} m` : ""}
							</HandLabel>
						</svg>
					),
				},
				{
					title: "The compass points",
					body: "Dashed: the compass. Blue: where the camera faced.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="Compass heading against solved heading"
						>
							{d &&
								[
									{ a: d.prior.yaw, key: "prior", c: "pencil", dash: "3 2" },
									{
										a: d.solved.yaw,
										key: "solved",
										c: "blue",
										dash: undefined,
									},
								].map((r) => {
									const [x, y] = ang(r.a - d.prior.yaw, 38);
									return (
										<PenLine
											key={r.key}
											seed={`trio-compass-${r.key}`}
											from={[50, 62]}
											to={[x, y + 12]}
											color={r.c as "pencil" | "blue"}
											width={r.key === "solved" ? 1.8 : 1.4}
											dash={r.dash}
										/>
									);
								})}
							<HandText x={4} y={10} size={5.5} rotate={-2} halo={false}>
								{d ? "what it said vs what was true" : ""}
							</HandText>
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{d ? `${sgn(d.solved.delta.yaw)}° apart` : ""}
							</HandLabel>
						</svg>
					),
				},
				{
					title: "Gravity and lens are tight",
					body: "Tilt lands within 3° and view width within 5% of the solve.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="Field of view prior against solved"
						>
							{d &&
								[
									{ h: d.prior.hfov, key: "prior", c: "pencil", dash: "3 2" },
									{
										h: d.solved.hfov,
										key: "solved",
										c: "blue",
										dash: undefined,
									},
								].map((w) => {
									const [x1, y1] = ang(-w.h / 2, 55);
									const [x2, y2] = ang(w.h / 2, 55);
									return (
										<SketchPath
											key={w.key}
											d={`M${x1} ${y1 + 12} L50 62 L${x2} ${y2 + 12}`}
											seed={`trio-fov-${w.key}`}
											color={w.c as "pencil" | "blue"}
											width={w.key === "solved" ? 1.7 : 1.3}
											dash={w.dash}
											passes={1}
										/>
									);
								})}
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{d
									? `${d.prior.hfov.toFixed(0)}° vs ${d.solved.hfov.toFixed(0)}° wide`
									: ""}
							</HandLabel>
						</svg>
					),
				},
			]}
		/>
	);
}

function PriorNumbers() {
	const idx = useGipfelbuchIndex();
	if (!idx) return null;
	const acc = idx.photos.filter((p) => p.accepted);
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return s.length % 2
			? s[s.length >> 1]
			: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	};
	const yaw = acc.map((p) => Math.abs(p.delta.yaw));
	const pit = acc.map((p) => Math.abs(p.delta.pitch));
	return (
		<Numbers
			items={[
				{
					value: `${med(yaw).toFixed(1)}°`,
					label: `median compass error, ${acc.length} accepted photos`,
				},
				{
					value: `${Math.max(...yaw).toFixed(1)}°`,
					label: "worst compass error (photo 10)",
				},
				{
					value: `${med(pit).toFixed(1)}°`,
					label: "median tilt error from gravity",
				},
				{
					value: `${med(acc.map((p) => p.residual.prior.median)).toFixed(0)} → ${med(acc.map((p) => p.residual.solved.median)).toFixed(1)} px`,
					label: "median skyline gap, sensors → solved",
				},
			]}
			source="Measured on the 10 of 12 demo photos the solve accepted."
		/>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	const accent = groupColor(node.group);
	return (
		<>
			<HeroCompare />

			<YawShift />

			<Beat
				kicker="The idea"
				title="The sensors get close. The compass drifts."
			>
				<p>
					Before we look at pixels, the phone has told us roughly where the
					camera is and where it points. That first guess is the{" "}
					<strong>camera prior</strong>.
				</p>
				<p>
					<HandMark type="highlight">
						Yaw, the way the camera points, is the weakest part.
					</HandMark>{" "}
					The worst photo is marked <CircledNumber value={1} /> in Fig. 2.
					<MarginNote mark="a">
						Why is one phone 19° off while another is within 2°?
					</MarginNote>
				</p>
			</Beat>

			<YawBars />

			<Beat
				kicker="How it works"
				title="Each sensor gives one guess with a width."
			>
				<PriorTrio />
			</Beat>

			<Beat
				kicker="Where it fails"
				title="A prior is a place to start, never proof."
			>
				<p>
					We tried{" "}
					<HandMark type="strike">
						trusting the phone&rsquo;s altitude more
					</HandMark>
					<MarginNote mark="b">
						Scratch that: altitude hints are vetoes, not pulls.
					</MarginNote>
					. On held-out photos the skyline gap got worse:{" "}
					<HandMark type="double">median 12.0 to 13.4 px</HandMark>. So the
					prior only seeds the search.
				</p>
			</Beat>

			<Figure
				label="Fig. 3"
				caption={
					<>The same miss on four more photos, compass up to 18.6° off.</>
				}
			>
				<Gallery
					ids={["demo-09", "demo-03", "demo-06", "demo-02"]}
					cols={4}
					tile={(d) => (
						<RealPhoto
							data={d}
							layers={["skyline", "prior"]}
							crop={skyBand(d)}
						/>
					)}
					label={(d) => (
						<>
							compass {sgn(d.solved.delta.yaw)}° · gap{" "}
							{d.residual.prior.median.toFixed(0)} px
						</>
					)}
				/>
			</Figure>

			<PriorNumbers />

			<Details>
				<Callout tone="note" title="Two different compass widths">
					The figures below assume a compass width of 7.1° (5° noise plus 5°
					bias). The app&rsquo;s own solve is looser: it allows 15° and searches
					±25°. Six of the ten accepted photos miss by more than 7.1°. Pitch is
					searched only within ±3° of gravity, so &ldquo;gravity is tight&rdquo;
					is partly that window. Lens distortion is not modelled.
				</Callout>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
