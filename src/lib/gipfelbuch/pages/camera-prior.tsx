// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	Hachure,
	HandDot,
	inkColor,
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
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Flow,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	LAYER_STYLE,
	Measured,
	PhotoPicker,
	PrintLabel,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Key as ColorKey,
	Compare,
	Details,
	Gallery,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Sym } from "#/components/gipfelbuch/viz/math";
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
	{ k: "gps", label: "GPS fix", sub: "position E, N (+ alt)", params: 3 },
	{ k: "compass", label: "Compass", sub: "yaw", params: 1 },
	{ k: "gravity", label: "Gravity", sub: "pitch + roll", params: 2 },
	{ k: "focal", label: "EXIF focal", sub: "vertical FOV", params: 1 },
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

/** Flat tint of an ink on paper, for bands and fills that carry a value (hatch only decorates). */
const tint = (ink: string, pct: number) => ({
	fill: `color-mix(in srgb, var(--gb-${ink}) ${pct}%, var(--gb-paper))`,
});

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
			label="Fig. D1"
			caption={
				<>
					<Measured data={d} /> Dashed magenta: the DEM skyline seen through the
					phone&apos;s own compass, gravity and focal. Cyan: the same DEM
					through the solved pose. Amber: the skyline detected in the photo.
					Map: view cone at the prior (dashed) and solved yaw, hillshade of the
					DEM.
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
			<div className="grid gap-4 lg:grid-cols-[1.55fr_1fr] lg:items-start">
				<RealPhoto
					key={id}
					data={d}
					layers={["skyline", "prior", "solved", "priorPeaks", "peaks"]}
					toggles={["skyline", "prior", "solved", "priorPeaks", "peaks"]}
					crop={d ? skyBand(d) : undefined}
					maxLabels={4}
				/>
				<DemPatch data={d} peaks={false} />
			</div>
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
						label="median skyline error, prior → solved"
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
			<text
				x={x0}
				y={14}
				fontSize={STRIP_LABEL}
				fill={SWISS.ink}
				className="gb-num"
			>
				{title}
			</text>
			{sigma != null && (
				<>
					<rect
						x={X(-2 * sigma)}
						y={22}
						width={X(2 * sigma) - X(-2 * sigma)}
						height={60}
						style={tint("ink", 6)}
					/>
					<rect
						x={X(-sigma)}
						y={22}
						width={X(sigma) - X(-sigma)}
						height={60}
						style={tint("ink", 13)}
					/>
					<text
						x={X(sigma) - 3}
						y={34}
						textAnchor="end"
						fontSize={STRIP_LABEL}
						fill={SWISS.secondary}
						paintOrder="stroke"
						stroke={SWISS.paper}
						strokeWidth={3}
						strokeLinejoin="round"
						className="gb-num"
					>
						±1σ = {sigma.toFixed(1)}
					</text>
				</>
			)}
			{band && (
				<rect
					x={X(band[0])}
					y={22}
					width={X(band[1]) - X(band[0])}
					height={60}
					style={tint("ink", 11)}
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
					<text
						x={X(v)}
						y={y + 48}
						textAnchor="middle"
						className="nb-num"
						fontSize={STRIP_LABEL_SMALL}
						fill={SWISS.secondary}
					>
						{fmt(v)}
					</text>
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
			<text
				x={x1}
				y="14"
				textAnchor="end"
				className="nb-num"
				fontSize={STRIP_LABEL_SMALL}
				fill={SWISS.secondary}
			>
				{unit}
			</text>
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
						<circle
							cx={X(p.v)}
							cy={cy}
							r={on ? 6.8 : 4.6}
							fill={on ? inkColor("red") : SWISS.ink}
							opacity={on ? 1 : 0.85}
						/>
						{on && (
							<text
								x={X(p.v)}
								y={cy - 10}
								textAnchor="middle"
								className="nb-num"
								fontSize={STRIP_LABEL_SMALL}
								fill={inkColor("red")}
							>
								{p.id.slice(-2)} · {fmt(p.v)}
							</text>
						)}
					</g>
				);
			})}
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
					Measured on the 12 demo photos by scripts/gipfelbuch/build-data.ts,
					2026-10-01 (error = solved − prior; click a dot to load it in Fig.
					D1). Shaded bands are the widths the MAP solver assumes: compass √(5²
					+ 5²) = {SIG_YAW.toFixed(1)}° (1σ and 2σ), gravity {SIG_G}°, GPS σH =
					clamp(hAcc, 5, 100) m.
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
				/>
				<Strip
					title="Gravity pitch error"
					unit="degrees"
					vals={pit}
					range={[-4, 4]}
					sigma={SIG_G}
					sel={sel}
					onPick={onPick}
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
						title="GPS hAccuracy (clamp band shaded)"
						unit="metres"
						vals={GIPFELBUCH_PHOTO_IDS.map((id) => ({ id, v: hacc[id] }))}
						range={[0, 140]}
						band={[H_MIN, H_MAX]}
						sel={sel}
						onPick={onPick}
						fmt={(v) => `${v}`}
					/>
				) : (
					<div className="h-24 animate-pulse bg-[var(--gb-paper-deep)]" />
				)}
			</div>
			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat
					value={`${med(yaw.map((p) => p.v)).toFixed(1)}°`}
					label="median |compass error|"
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
					label="worst compass error (demo-10)"
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
		<text
			x={LAB_CX + 8}
			y={24}
			fontSize={13}
			fill={SWISS.secondary}
			paintOrder="stroke"
			stroke={SWISS.paper}
			strokeWidth={3}
			strokeLinejoin="round"
			className="gb-num"
		>
			N
		</text>
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
	const [ref, t] = useTime<HTMLDivElement>();
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
	const SLIDER_W = 240;
	const sliderX = 10 + ((hAcc - 1) / 149) * (SLIDER_W - 20);

	return (
		<Figure
			label="Fig. D3"
			caption="Schematic (synthetic scene, not a photo). A camera prior is a set of Gaussian-ish beliefs, one per evidence family. Toggle each sensor and watch the hypothesis space shrink. Widths use the real defaults: hAcc clamped to [5, 100] m, compass 5 deg noise + 5 deg bias (Student-t, nu 3), gravity 1.5 deg."
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
								<text
									key={r}
									x={cx + 4}
									y={cy - r * pxPerM - 4}
									className="nb-num"
									fontSize="11"
									fill={SWISS.secondary}
								>
									{r} m
								</text>
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
						<PrintLabel x={14} y={368} color="var(--gb-secondary)">
							{on.gps
								? `sigmaH ${sigH.toFixed(0)} m (hAcc ${hAcc})`
								: "position: any (no GPS prior)"}
						</PrintLabel>
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
							<PrintLabel
								x={100}
								y={28}
								anchor="middle"
								color="var(--gb-secondary)"
							>
								{on.gravity
									? `pitch, roll +/- ${SIG_G} deg`
									: "pitch, roll: unconstrained"}
							</PrintLabel>
							<text
								x={100}
								y={184}
								textAnchor="middle"
								fontSize={13}
								fill={SWISS.secondary}
								className="gb-num"
							>
								accelerometer, gravity vector
							</text>
						</svg>

						<div className="bg-[var(--gb-paper-deep)] p-3">
							<label className={`block font-mono ${TYPE.micro} gb-secondary`}>
								EXIF hAccuracy: {hAcc} m{" "}
								{hAcc < H_MIN || hAcc > H_MAX ? `(clamped to ${sigH})` : ""}
								<span className="relative mt-1 block focus-within:outline focus-within:outline-1 focus-within:outline-offset-2">
									<svg
										viewBox={`0 0 ${SLIDER_W} 22`}
										className="block h-auto w-full"
										aria-hidden="true"
									>
										<PenLine
											seed="lab-slider-track"
											from={[10, 11]}
											to={[SLIDER_W - 10, 11]}
											color="pencil"
											width={1.3}
										/>
										<HandDot
											x={sliderX}
											y={11}
											r={6}
											seed="lab-slider-thumb"
											color="ink"
											opacity={1}
										/>
									</svg>
									<input
										type="range"
										min={1}
										max={150}
										value={hAcc}
										onChange={(e) => setHAcc(+e.target.value)}
										className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
									/>
								</span>
							</label>
						</div>
					</div>
				</div>

				<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat
						value={on.gps ? `${sigH.toFixed(0)} m` : "free"}
						label="position sigma H"
					/>
					<Stat
						value={on.compass ? `${SIG_YAW.toFixed(1)} deg` : "360 deg"}
						label="yaw spread"
					/>
					<Stat
						value={on.gravity ? `${SIG_G} deg` : "free"}
						label="pitch / roll sigma"
					/>
					<Stat value={`${nOn} / ${total}`} label="parameters with a prior" />
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
						<rect
							x={0}
							y={2}
							width={(nOn / total) * 600}
							height={8}
							style={tint("ink", 80)}
						/>
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
					Before any matching or solving, the phone has already told us roughly
					where the camera is and where it points: a GPS fix with an accuracy
					radius, a compass heading, an accelerometer gravity vector (hence
					pitch and roll) and an EXIF focal length. Together these form the{" "}
					<strong>camera prior</strong>.
				</p>
				<p>
					It is a <em>role</em>, not a source: the same number can be a prior in
					one solve and a held-fixed value or a result in another. In the
					ontology it is the camera the sensors imply, realised by the pose6dof{" "}
					<code>Priors</code> type and the geocam <code>PriorPhoto</code>{" "}
					adapter. It feeds the {A("pose-estimate", "pose estimate")}, and which
					parts of it are only placeholders is tracked by{" "}
					{A("prior-unknowns", "prior unknowns")}.
				</p>
			</Section>

			<RealPrior id={id} setId={setId} />
			<PriorErrors sel={id} onPick={setId} />

			<PriorLab accent={accent} />

			<Section kicker="Mechanism" title="How it works">
				<p>
					Each sensor becomes one factor with its own width. In{" "}
					<code>pose6dof</code> a prior is a{" "}
					<code>PriorValue = {"{ value, sigma? }"}</code>: sigma undefined or
					Infinity means unknown and solved freely, sigma 0 pins the value
					exactly, anything else is a Gaussian. Position takes separate{" "}
					<code>sigmaH</code> / <code>sigmaV</code> (defaults 15 / 20 m).
				</p>
				<p>
					The geocam adapter <code>mapPriorsFromPhoto</code> builds the same set
					for the {A("map-solver", "MAP solver")} with the numbers shown in Fig.
					3: horizontal sigma is the EXIF hAcc clamped to 5 to 100 m (default
					20), gravity is 1.5 deg, and the compass is a Student-t (nu 3) built
					from 5 deg noise plus 5 deg bias, so one wild reading cannot drag the
					yaw. If the EXIF heading is magnetic it is first made true with the
					WMM2025 declination.
				</p>
				<p>
					Against the real photos (Fig. 2) the compass really is the weak
					sensor. The median absolute heading error on the 12 demo photos is
					7.9°, six of them sit beyond the assumed 1σ of 7.1° and the worst,
					demo-10, is 19.0° off (2.7σ), which is exactly why the tails are
					Student-t rather than Gaussian. Gravity is much tighter: median pitch
					error 0.76° and roll 0.68°, but three photos exceed the 1.5° σ in
					pitch (−2.7° on portrait demo-11, +2.6° on ultra-wide demo-02, −2.2°
					on portrait demo-12).
				</p>
			</Section>
			<Figure
				label="Fig. D4"
				caption="From EXIF to factors. Each family is skipped when its unknown flag is set."
			>
				<div className="p-4">
					<Flow
						nodes={[
							{
								label: "EXIF + sensors",
								sub: "lat, lon, alt, hAcc, heading, gravity",
								color: accent,
							},
							{
								label: "PriorPhoto",
								sub: "local flags: yawUnknown, pitchRollUnknown",
							},
							{
								label: "mapPriorsFromPhoto",
								sub: "gps, alt, ground, gravity, compass, focal",
							},
							{ label: "solve", sub: "whitened factors, LM" },
						]}
					/>
				</div>
			</Figure>
			<div className="mt-6">
				<Steps
					steps={[
						{
							title: "Position",
							body: "GPS fix at sigmaH = clamp(hAcc, 5, 100) m; altitude as its own factor (sigmaA 3 m) unless the position was pinned by hand.",
						},
						{
							title: "Attitude",
							body: "Gravity gives pitch and roll to 1.5 deg; the compass gives yaw, de-biased for declination, with heavy tails.",
						},
						{
							title: "Lens",
							body: "An optional focal prior from the EXIF focal table, scaled to the 1600 px basis.",
						},
					]}
				/>
			</div>

			<Section kicker="Relevance" title="Why it matters in Rigi">
				<p>
					Priors are what make the search finite. Without a compass the yaw is a
					full circle, without GPS the eye is anywhere. With them, the solvers
					start in the right basin and the cascade only has to refine. The MAP
					solver stacks them with skyline and point cues into one posterior with
					a covariance, in the geometry-first phase (
					{A("geo-phase-a", "GEO phase A")}).
				</p>
				<div className="!mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
					<Stat value="5 to 100 m" label="clamped GPS sigma" />
					<Stat value="1.5 deg" label="gravity sigma" />
					<Stat value="nu = 3" label="compass tail" />
				</div>
			</Section>

			<Section kicker="Lessons" title="Gotchas">
				<ul>
					<li>
						<strong>A prior is not evidence to pull on.</strong> In matching v2
						the priors were switched off, and the altitude-contour eye rule was
						worse on holdout (median 12.0 to 13.4 px, p90 18 to 36). Eye priors
						are vetoes and tie-breaks, not pulls. The code stays in{" "}
						<code>concord/priors/altitude.ts</code>.
					</li>
					<li>
						<strong>Missing is not zero.</strong> A photo with no compass or
						lens carries a placeholder; the{" "}
						{A("prior-unknowns", "unknown flags")} exist so the{" "}
						{A("cascade", "cascade")} can raise its accept bar instead of
						trusting it. Note the bench harness uses the opposite polarity,{" "}
						<code>focalKnown</code>.
					</li>
					<li>
						<strong>Over-confidence.</strong> MAP sigma is not calibrated yet:
						rotation (err/sigma)^2 is 6.0 against a target of 0.5 to 2. See{" "}
						{A("map-solver", "the MAP solver")}.
					</li>
					<li>
						<strong>Magnetic versus true.</strong> iPhones store true north;
						others store magnetic. Declination is applied where the heading is{" "}
						<em>used</em>, never where it is stored (flag <code>geoDecl</code>).
					</li>
					<li>
						<strong>Frame.</strong> <code>Priors.position</code> is the absolute
						eye in the correspondences&apos; ENU frame, not [0,0,0], unless the
						frame origin is the eye.
					</li>
				</ul>
				<Callout tone="lesson">
					Treat the prior as a starting basin and a veto, then let image
					evidence decide.
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
				<p className={`!mt-3 font-mono ${TYPE.caption} gb-secondary`}>
					Priors, PriorValue, mapPriorsFromPhoto, sigmaHFromHAcc, priorHeading,
					COMPASS_DEFAULTS, EYE_PRIOR_DEFAULTS
				</p>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front. Everything here is measured (public/demo/gipfelbuch) except the three tiny Trio schematics,
// which are drawn from the real values of the picked photo.
// ======================================================================================
const PRIOR_C = LAYER_STYLE.prior.color;
const SOLVED_C = LAYER_STYLE.solved.color;

function HeroCompare() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const crop = d ? skyBand(d) : undefined;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? `Sensors alone put the skyline ${d.residual.prior.median.toFixed(0)} px off. After solving, the median gap is ${d.residual.solved.median.toFixed(1)} px.`
						: "Sensors alone, then solved."}{" "}
					<ColorKey color={PRIOR_C} dashed>
						sensors only
					</ColorKey>
					{", "}
					<ColorKey color={SOLVED_C}>solved</ColorKey>
					{", "}
					<ColorKey color={LAYER_STYLE.skyline.color}>
						skyline in the photo
					</ColorKey>
					. <Measured data={d} />
				</>
			}
		>
			<Compare
				beforeLabel="sensors only"
				afterLabel="solved"
				start={0.5}
				before={
					<RealPhoto bleed data={d} layers={["skyline", "prior"]} crop={crop} />
				}
				after={
					<RealPhoto
						bleed
						data={d}
						layers={["skyline", "solved"]}
						crop={crop}
					/>
				}
			/>
		</Figure>
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
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The compass is off by up to 19° across twelve photos. Shaded: the ±
					{SOLVE_SIGMA_YAW}° the solver allows for; the search reaches ±
					{SEARCH_YAW}°. Magnetic declination here is only +3.4° and iPhones
					already write true north, so it explains little. Red outline: rejected
					solves. <Measured data={idx} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} 250`}
				className="block h-auto w-full"
				role="img"
				aria-label="Compass error per photo"
			>
				<rect
					x={20}
					y={zero - SOLVE_SIGMA_YAW * k}
					width={W - 40}
					height={2 * SOLVE_SIGMA_YAW * k}
					style={tint("ink", 8)}
				/>
				<line
					x1={20}
					x2={W - 20}
					y1={zero}
					y2={zero}
					stroke={SWISS.ink}
					strokeWidth={1.2}
				/>
				<PrintLabel
					x={24}
					y={zero - SOLVE_SIGMA_YAW * k - 6}
					size={YAWBARS_LABEL}
					color="var(--gb-secondary)"
				>
					solver prior σ = {SOLVE_SIGMA_YAW}°
				</PrintLabel>
				{photos.map((p, i) => {
					const v = p.delta.yaw;
					const x = 20 + step * i + (step - bw) / 2;
					const h = Math.max(Math.abs(v) * k, 1);
					const top = v >= 0 ? zero - h : zero;
					return (
						<g key={p.id}>
							{p.accepted ? (
								<rect
									x={x}
									y={top}
									width={bw}
									height={h}
									style={tint("ink", 85)}
								/>
							) : (
								<rect
									x={x}
									y={top}
									width={bw}
									height={h}
									style={{
										fill: "var(--gb-paper)",
										stroke: "var(--gb-red)",
										strokeWidth: 1.2,
									}}
								/>
							)}
							<PrintLabel
								x={x + bw / 2}
								y={v >= 0 ? top - 6 : top + h + 14}
								anchor="middle"
								size={YAWBARS_LABEL}
								color={SWISS.ink}
							>
								{sgn(v, 1)}
							</PrintLabel>
							<PrintLabel
								x={x + bw / 2}
								y={244}
								anchor="middle"
								size={YAWBARS_LABEL}
								color="var(--gb-secondary)"
							>
								{p.id.slice(-2)}
							</PrintLabel>
						</g>
					);
				})}
			</svg>
		</Figure>
	);
}

function PriorTrio() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const hacc = useHAcc()?.[photoId];
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
							<text
								x={50}
								y={73}
								textAnchor="middle"
								fontSize={4.2}
								fill={SWISS.secondary}
								className="gb-num"
							>
								{hacc ? `±${hacc.toFixed(0)} m` : ""}
							</text>
						</svg>
					),
				},
				{
					title: "The compass points",
					body: "Dashed is what it said. Cyan is where the camera really faced.",
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
							<text
								x={50}
								y={73}
								textAnchor="middle"
								fontSize={4.2}
								fill={SWISS.secondary}
								className="gb-num"
							>
								{d ? `${sgn(d.solved.delta.yaw)}° apart` : ""}
							</text>
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
							<text
								x={50}
								y={73}
								textAnchor="middle"
								fontSize={4.2}
								fill={SWISS.secondary}
								className="gb-num"
							>
								{d
									? `${d.prior.hfov.toFixed(0)}° vs ${d.solved.hfov.toFixed(0)}° wide`
									: ""}
							</text>
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
					label: "worst compass error (demo-10)",
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
			source="Measured on the demo photos accepted by the solve (10 of 12), scripts/gipfelbuch/build-data.ts, 2026-10-01."
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
				<p>Yaw, the way the camera points, is the weakest part.</p>
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
					We tried trusting the phone's altitude more. On held-out photos the
					skyline gap got worse: median 12.0 to 13.4 px. So the prior only seeds
					the search.
				</p>
			</Beat>

			<Figure
				bleed
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
					The figures below use the geometry-first MAP prior (compass 5° noise
					plus 5° bias, 7.1° in all; a flag-off path). The production skyline
					solve is looser: a yaw prior of 15° and a search of ±25° (
					<code>DEFAULT_SIGMA</code>, <code>yawRange</code> in{" "}
					<code>geo/solve.ts</code>). Six of the ten accepted photos miss by
					more than 7.1°. Pitch is only searched within ±3° of gravity, so
					&ldquo;gravity is tight&rdquo; is partly the window. Lens distortion
					is not modelled.
				</Callout>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
