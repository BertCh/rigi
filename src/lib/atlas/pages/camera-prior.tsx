// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	ATLAS_PHOTO_IDS,
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Flow,
	LAYER_STYLE,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useAtlasIndex,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Key as ColorKey,
	Compare,
	Details,
	Gallery,
	Numbers,
	Trio,
} from "#/components/atlas/viz/explain";
import { groupColor } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

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
// (public/demo/atlas/*, scripts/atlas/build-data.ts). "Error" below means solved minus prior: the solved
// pose is the pipeline's own estimate (skyline fit, accepted by the confidence gate in 10 of 12), not a
// hand-registered truth.

/** manifest.json carries the raw EXIF numbers (hAccuracy) the atlas JSON does not repeat. */
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
function skyBand(d: AtlasPhotoData): [number, number, number, number] {
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
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
}) {
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					<Measured data={d} /> Dashed magenta: the DEM skyline seen through the
					phone&apos;s own compass, gravity and focal. Cyan: the same DEM
					through the solved pose. Yellow: the skyline detected in the photo.
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
						<span className="rounded bg-black/70 px-1 font-mono text-[9px] text-white/90">
							{sgn(x.delta.yaw, 0)}°
						</span>
					) : null;
				}}
			/>
			<div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
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

/** One horizontal strip: the 12 photos' errors as dots, with the prior's 1σ and 2σ bands behind. */
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
}: {
	title: string;
	unit: string;
	vals: { id: AtlasPhotoId; v: number }[];
	range: [number, number];
	sigma?: number;
	band?: [number, number];
	sel: AtlasPhotoId;
	onPick: (i: AtlasPhotoId) => void;
	fmt?: (v: number) => string;
}) {
	const W = 520;
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
				y="13"
				fontSize="11"
				fill="#ece6da"
				fontFamily="ui-monospace, monospace"
			>
				{title}
			</text>
			{sigma != null && (
				<>
					<rect
						x={X(-2 * sigma)}
						y="22"
						width={X(2 * sigma) - X(-2 * sigma)}
						height="60"
						fill="var(--accent)"
						fillOpacity=".07"
					/>
					<rect
						x={X(-sigma)}
						y="22"
						width={X(sigma) - X(-sigma)}
						height="60"
						fill="var(--accent)"
						fillOpacity=".14"
					/>
					<text
						x={X(sigma) - 3}
						y="32"
						textAnchor="end"
						fontSize="9"
						fill="var(--accent)"
						fillOpacity=".9"
						fontFamily="ui-monospace, monospace"
					>
						±1σ = {sigma.toFixed(sigma < 2 ? 1 : 1)}
					</text>
				</>
			)}
			{band && (
				<rect
					x={X(band[0])}
					y="22"
					width={X(band[1]) - X(band[0])}
					height="60"
					fill="var(--accent)"
					fillOpacity=".12"
				/>
			)}
			<line
				x1={x0}
				x2={x1}
				y1={y + 30}
				y2={y + 30}
				stroke="white"
				strokeOpacity=".25"
			/>
			{Array.from(
				{ length: ticks + 1 },
				(_, i) => range[0] + ((range[1] - range[0]) * i) / ticks,
			).map((v) => (
				<g key={v}>
					<line
						x1={X(v)}
						x2={X(v)}
						y1={y + 30}
						y2={y + 35}
						stroke="white"
						strokeOpacity=".4"
					/>
					<text
						x={X(v)}
						y={y + 47}
						textAnchor="middle"
						fontSize="9"
						fill="white"
						fillOpacity=".45"
						fontFamily="ui-monospace, monospace"
					>
						{fmt(v)}
					</text>
				</g>
			))}
			{range[0] < 0 && (
				<line
					x1={X(0)}
					x2={X(0)}
					y1="22"
					y2={y + 30}
					stroke="white"
					strokeOpacity=".3"
					strokeDasharray="2 3"
				/>
			)}
			<text
				x={x1}
				y="13"
				textAnchor="end"
				fontSize="9"
				fill="white"
				fillOpacity=".4"
				fontFamily="ui-monospace, monospace"
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
						<circle
							cx={X(p.v)}
							cy={cy}
							r={on ? 7 : 5.5}
							fill={on ? "var(--accent)" : "#0e1012"}
							stroke="var(--accent)"
							strokeWidth={on ? 2 : 1.4}
						/>
						{on && (
							<text
								x={X(p.v)}
								y={cy + 3}
								textAnchor="middle"
								fontSize="7"
								fontWeight="700"
								fill="#0e1012"
							>
								{p.id.slice(-2)}
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
	sel: AtlasPhotoId;
	onPick: (i: AtlasPhotoId) => void;
}) {
	const idx = useAtlasIndex();
	const hacc = useHAcc();
	if (!idx)
		return <div className="h-64 animate-pulse rounded-xl bg-white/[0.04]" />;
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
			label="Fig. 2"
			caption={
				<>
					Measured on the 12 demo photos by scripts/atlas/build-data.ts,
					2026-10-01 (error = solved − prior; click a dot to load it in Fig. 1).
					Shaded bands are the widths the MAP solver assumes: compass √(5² + 5²)
					= {SIG_YAW.toFixed(1)}° (1σ and 2σ), gravity {SIG_G}°, GPS σH =
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
						vals={ATLAS_PHOTO_IDS.map((id) => ({ id, v: hacc[id] }))}
						range={[0, 140]}
						band={[H_MIN, H_MAX]}
						sel={sel}
						onPick={onPick}
						fmt={(v) => `${v}`}
					/>
				) : (
					<div className="h-24 animate-pulse rounded-xl bg-white/[0.04]" />
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

function PriorLab({ accent }: { accent: string }) {
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
	const cx = 270;
	const cy = 330;
	const R = 280;
	const pxPerM = 1.5;
	const half = on.focal ? 32 : 40;
	const halfFuzz = on.focal ? 2 : 22; // lens unknown: hfov could be anything in a band
	const sy = on.compass ? SIG_YAW : 180;
	const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
	const spin = (t * 40) % 360;

	// plan: yaw wedge layers (1,2,3 sigma)
	const yawLayers = on.compass
		? [3, 2, 1].map((k) => ({ k, a: Math.min(179, k * sy) }))
		: [];

	// gravity inset
	const wob = (s: number) => Math.sin(t * s) * 1;
	const tilt = on.gravity ? 0 : 22 * wob(0.9);
	const lift = on.gravity ? 0 : 18 * wob(1.3);
	const gx = 100;
	const gy = 100;

	return (
		<Figure
			label="Fig. 3"
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
							className="rounded-full px-3.5 py-1.5 text-left font-mono text-[12px] ring-1 transition"
							style={{
								background: on[k.k] ? `${accent}26` : "rgba(255,255,255,.04)",
								color: on[k.k] ? "var(--rigi-paper)" : "rgba(255,255,255,.5)",
								boxShadow: `inset 0 0 0 1px ${on[k.k] ? accent : "rgba(255,255,255,.1)"}`,
							}}
						>
							<span
								className="mr-2 inline-block size-2 rounded-full"
								style={{
									background: on[k.k] ? accent : "rgba(255,255,255,.2)",
								}}
							/>
							{k.label}
							<span className="ml-2 text-white/40">{k.sub}</span>
						</button>
					))}
				</div>

				<div className="mt-4 grid gap-4 md:grid-cols-[1.7fr_1fr]">
					<svg
						viewBox="0 0 540 380"
						className="h-auto w-full rounded-lg bg-black/30 ring-1 ring-white/8"
						role="img"
						aria-label="Plan view of the camera prior: position disc and yaw wedge"
					>
						<defs>
							<radialGradient id="cp-g">
								<stop offset="0" stopColor={accent} stopOpacity=".5" />
								<stop offset="1" stopColor={accent} stopOpacity=".05" />
							</radialGradient>
							<clipPath id="cp-clip">
								<rect x="0" y="0" width="540" height="380" />
							</clipPath>
						</defs>
						<g clipPath="url(#cp-clip)">
							{[100, 200, 300].map((r) => (
								<circle
									key={r}
									cx={cx}
									cy={cy}
									r={r * pxPerM}
									fill="none"
									stroke="white"
									strokeOpacity=".07"
									strokeDasharray="2 5"
								/>
							))}
							{[100, 200].map((r) => (
								<text
									key={r}
									x={cx + 4}
									y={cy - r * pxPerM - 3}
									fontSize="9"
									fill="white"
									fillOpacity=".3"
									fontFamily="monospace"
								>
									{r} m
								</text>
							))}
							{/* yaw wedge */}
							{on.compass ? (
								yawLayers.map((l) => (
									<path
										key={l.k}
										d={wedge(
											cx,
											cy,
											R,
											TRUE_YAW - l.a - half - halfFuzz,
											TRUE_YAW + l.a + half + halfFuzz,
										)}
										fill={accent}
										fillOpacity={0.06 + (3 - l.k) * 0.03}
									/>
								))
							) : (
								<circle
									cx={cx}
									cy={cy}
									r={R}
									fill={accent}
									fillOpacity=".04"
									stroke={accent}
									strokeOpacity=".25"
									strokeDasharray="4 6"
								/>
							)}
							{/* field of view: nominal */}
							<path
								d={wedge(
									cx,
									cy,
									R - 20,
									on.compass ? TRUE_YAW - half : spin - half,
									on.compass ? TRUE_YAW + half : spin + half,
								)}
								fill={accent}
								fillOpacity={on.compass ? 0.28 : 0.1 + 0.05 * pulse}
								stroke={accent}
								strokeOpacity=".8"
							/>
							{!on.focal && (
								<>
									<path
										d={wedge(
											cx,
											cy,
											R - 20,
											(on.compass ? TRUE_YAW : spin) - half - halfFuzz,
											(on.compass ? TRUE_YAW : spin) - half,
										)}
										fill="none"
										stroke={accent}
										strokeOpacity=".5"
										strokeDasharray="3 4"
									/>
									<path
										d={wedge(
											cx,
											cy,
											R - 20,
											(on.compass ? TRUE_YAW : spin) + half,
											(on.compass ? TRUE_YAW : spin) + half + halfFuzz,
										)}
										fill="none"
										stroke={accent}
										strokeOpacity=".5"
										strokeDasharray="3 4"
									/>
								</>
							)}
							{/* compass reading ray */}
							{on.compass && (
								<line
									x1={cx}
									y1={cy}
									x2={cx + (R - 8) * Math.sin(rad(TRUE_YAW))}
									y2={cy - (R - 8) * Math.cos(rad(TRUE_YAW))}
									stroke="var(--rigi-paper)"
									strokeOpacity=".7"
									strokeDasharray="1 5"
									strokeLinecap="round"
								/>
							)}
							{/* north */}
							<g
								fontFamily="monospace"
								fontSize="10"
								fill="white"
								fillOpacity=".4"
							>
								<line
									x1={cx}
									y1={cy}
									x2={cx}
									y2={14}
									stroke="white"
									strokeOpacity=".12"
								/>
								<text x={cx + 6} y="22">
									N
								</text>
							</g>
							{/* position */}
							{on.gps ? (
								<circle
									cx={cx}
									cy={cy}
									r={sigH * pxPerM}
									fill="url(#cp-g)"
									stroke={accent}
									strokeOpacity=".7"
								/>
							) : (
								<rect
									x="0"
									y="0"
									width="540"
									height="380"
									fill="none"
									stroke={accent}
									strokeOpacity=".3"
									strokeDasharray="6 6"
								/>
							)}
							<circle cx={cx} cy={cy} r="4.5" fill="var(--rigi-paper)" />
							<circle
								cx={cx}
								cy={cy}
								r={9 + 3 * pulse}
								fill="none"
								stroke={accent}
								strokeOpacity=".6"
							/>
						</g>
						<text
							x="14"
							y="366"
							fontFamily="monospace"
							fontSize="10"
							fill="white"
							fillOpacity=".45"
						>
							{on.gps
								? `sigmaH ${sigH.toFixed(0)} m (hAcc ${hAcc})`
								: "position: any (no GPS prior)"}
						</text>
					</svg>

					<div className="flex flex-col gap-3">
						<svg
							viewBox="0 0 200 200"
							className="h-auto w-full rounded-lg bg-black/30 ring-1 ring-white/8"
							role="img"
							aria-label="Gravity inset: horizon tilt"
						>
							<defs>
								<clipPath id="cp-frame">
									<rect x="20" y="40" width="160" height="120" rx="6" />
								</clipPath>
							</defs>
							<rect
								x="20"
								y="40"
								width="160"
								height="120"
								rx="6"
								fill="white"
								fillOpacity=".03"
								stroke="white"
								strokeOpacity=".2"
							/>
							<g clipPath="url(#cp-frame)">
								{(on.gravity ? [0] : [-1, -0.5, 0, 0.5, 1]).map((k) => (
									<line
										key={k}
										x1={gx - 160}
										x2={gx + 160}
										y1={gy + lift * (1 + k * 0.5) + (tilt + k * 8) * 2.8}
										y2={gy + lift * (1 + k * 0.5) - (tilt + k * 8) * 2.8}
										stroke={accent}
										strokeOpacity={on.gravity ? 1 : 0.35}
										strokeWidth={on.gravity ? 2 : 1.2}
									/>
								))}
								{on.gravity && (
									<rect
										x="0"
										y={gy - SIG_G * 4}
										width="200"
										height={SIG_G * 8}
										fill={accent}
										fillOpacity=".15"
									/>
								)}
							</g>
							<text
								x="100"
								y="28"
								textAnchor="middle"
								fontFamily="monospace"
								fontSize="10"
								fill="white"
								fillOpacity=".5"
							>
								{on.gravity
									? `pitch, roll +/- ${SIG_G} deg`
									: "pitch, roll: unconstrained"}
							</text>
							<text
								x="100"
								y="184"
								textAnchor="middle"
								fontFamily="monospace"
								fontSize="9"
								fill="white"
								fillOpacity=".3"
							>
								accelerometer, gravity vector
							</text>
						</svg>

						<div className="rounded-lg bg-white/[0.04] p-3 ring-1 ring-white/8">
							<label className="block font-mono text-[11px] text-white/50">
								EXIF hAccuracy: {hAcc} m{" "}
								{hAcc < H_MIN || hAcc > H_MAX ? `(clamped to ${sigH})` : ""}
								<input
									type="range"
									min={1}
									max={150}
									value={hAcc}
									onChange={(e) => setHAcc(+e.target.value)}
									className="mt-1 w-full"
									style={{ accentColor: accent }}
								/>
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
				<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
					<div
						className="h-full rounded-full transition-all duration-500"
						style={{ width: `${(nOn / total) * 100}%`, background: accent }}
					/>
				</div>
			</div>
		</Figure>
	);
}

function Deep({ accent }: { accent: string }) {
	const [id, setId] = useState<AtlasPhotoId>("demo-09");
	const A = (id: string, label: string) => (
		<Link
			to="/atlas/$concept"
			params={{ concept: id }}
			className="underline decoration-white/30 underline-offset-2 hover:decoration-current"
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
				label="Fig. 4"
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
				<p className="!mt-3 font-mono text-[12.5px] text-white/55">
					Priors, PriorValue, mapPriorsFromPhoto, sigmaHFromHAcc, priorHeading,
					COMPASS_DEFAULTS, EYE_PRIOR_DEFAULTS
				</p>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front. Everything here is measured (public/demo/atlas) except the three tiny Trio schematics,
// which are drawn from the real values of demo-06.
// ======================================================================================
const PRIOR_C = LAYER_STYLE.prior.color;
const SOLVED_C = LAYER_STYLE.solved.color;

function HeroCompare() {
	const d = useAtlasPhoto("demo-06");
	const crop = d ? skyBand(d) : undefined;
	return (
		<Figure
			label="Fig. 1"
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
					<RealPhoto data={d} layers={["skyline", "prior"]} crop={crop} />
				}
				after={
					<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
				}
			/>
		</Figure>
	);
}

/** Twelve compass errors as one diverging bar each. Hollow = the solve was rejected, so the error is not trusted. */
function YawBars() {
	const idx = useAtlasIndex();
	if (!idx)
		return <div className="h-48 animate-pulse rounded-xl bg-white/[0.04]" />;
	const W = 520;
	const zero = 100;
	const k = 80 / 20; // px per degree
	const bw = 26;
	const step = (W - 40) / 12;
	const photos = idx.photos;
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The compass is off by up to 19° across twelve photos. Shaded: the{" "}
					{SIG_YAW.toFixed(1)}° we expect. Hollow bars were rejected.{" "}
					<Measured data={idx} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} 200`}
				className="block h-auto w-full"
				role="img"
				aria-label="Compass error per photo"
			>
				<rect
					x="20"
					y={zero - SIG_YAW * k}
					width={W - 40}
					height={2 * SIG_YAW * k}
					fill="var(--accent)"
					fillOpacity=".1"
				/>
				<line
					x1="20"
					x2={W - 20}
					y1={zero}
					y2={zero}
					stroke="white"
					strokeOpacity=".35"
				/>
				<text
					x="22"
					y={zero - SIG_YAW * k - 3}
					fontSize="9"
					fill="var(--accent)"
					fontFamily="ui-monospace, monospace"
				>
					expected ±{SIG_YAW.toFixed(1)}°
				</text>
				{photos.map((p, i) => {
					const v = p.delta.yaw;
					const x = 20 + step * i + (step - bw) / 2;
					const h = Math.abs(v) * k;
					const top = v >= 0 ? zero - h : zero;
					const hollow = !p.accepted;
					return (
						<g key={p.id}>
							<rect
								x={x}
								y={top}
								width={bw}
								height={Math.max(h, 1)}
								rx="2"
								fill={hollow ? "none" : "var(--accent)"}
								fillOpacity={hollow ? 0 : 0.85}
								stroke="var(--accent)"
								strokeDasharray={hollow ? "3 2" : undefined}
							/>
							<text
								x={x + bw / 2}
								y={v >= 0 ? top - 4 : top + h + 11}
								textAnchor="middle"
								fontSize="12"
								fill="white"
								fillOpacity=".8"
								fontFamily="ui-monospace, monospace"
							>
								{sgn(v, 1)}
							</text>
							<text
								x={x + bw / 2}
								y="194"
								textAnchor="middle"
								fontSize="12"
								fill="white"
								fillOpacity=".45"
								fontFamily="ui-monospace, monospace"
							>
								{p.id.slice(-2)}
							</text>
						</g>
					);
				})}
			</svg>
		</Figure>
	);
}

function PriorTrio() {
	const d = useAtlasPhoto("demo-06");
	const hacc = useHAcc()?.["demo-06"];
	const ang = (deg: number, r: number) => [
		50 + r * Math.sin(rad(deg)),
		50 - r * Math.cos(rad(deg)),
	];
	const box = "block h-auto w-full";
	const txt = "ui-monospace, monospace";
	return (
		<Trio
			steps={[
				{
					title: "GPS draws a circle",
					body: "We are somewhere inside it. This fix is the loosest in the set.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="GPS error disc"
						>
							<circle
								cx="50"
								cy="37"
								r="30"
								fill="var(--accent)"
								fillOpacity=".15"
								stroke="var(--accent)"
							/>
							<circle cx="50" cy="37" r="2.5" fill="var(--rigi-paper)" />
							<text
								x="50"
								y="72"
								textAnchor="middle"
								fontSize="6.5"
								fill="white"
								fillOpacity=".7"
								fontFamily={txt}
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
									{ a: d.prior.yaw, c: PRIOR_C, dash: "3 2" },
									{ a: d.solved.yaw, c: SOLVED_C, dash: undefined },
								].map((r) => {
									const [x, y] = ang(r.a - d.prior.yaw, 38);
									return (
										<line
											key={r.c}
											x1="50"
											y1="62"
											x2={x}
											y2={y + 12}
											stroke={r.c}
											strokeWidth="2"
											strokeDasharray={r.dash}
											strokeLinecap="round"
										/>
									);
								})}
							<text
								x="50"
								y="73"
								textAnchor="middle"
								fontSize="6.5"
								fill="white"
								fillOpacity=".7"
								fontFamily={txt}
							>
								{d ? `${sgn(d.solved.delta.yaw)}° apart` : ""}
							</text>
						</svg>
					),
				},
				{
					title: "Gravity and lens are tight",
					body: "Tilt and view width land within a degree or two.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="Field of view prior against solved"
						>
							{d &&
								[
									{ h: d.prior.hfov, c: PRIOR_C, dash: "3 2" },
									{ h: d.solved.hfov, c: SOLVED_C, dash: undefined },
								].map((w) => {
									const [x1, y1] = ang(-w.h / 2, 55);
									const [x2, y2] = ang(w.h / 2, 55);
									return (
										<path
											key={w.c}
											d={`M${x1} ${y1 + 12} L50 62 L${x2} ${y2 + 12}`}
											fill="none"
											stroke={w.c}
											strokeWidth="1.6"
											strokeDasharray={w.dash}
										/>
									);
								})}
							<text
								x="50"
								y="73"
								textAnchor="middle"
								fontSize="6.5"
								fill="white"
								fillOpacity=".7"
								fontFamily={txt}
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
	const idx = useAtlasIndex();
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
			source="Measured on the demo photos accepted by the solve (10 of 12), scripts/atlas/build-data.ts, 2026-10-01."
		/>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	const accent = groupColor(node.group);
	const A = (id: string, label: string) => (
		<Link
			to="/atlas/$concept"
			params={{ concept: id }}
			className="underline decoration-white/30 underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<HeroCompare />

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
					We tried pulling answers toward the prior. On held-out photos it got
					worse: median 12.0 to 13.4 px. So we use it to start and to veto.
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
					cols={2}
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

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {A("pose-estimate", "pose estimate")} slides the DEM skyline
				onto the photo to fix the compass. Reports: reports/negative-results.md.
			</p>

			<Details>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
