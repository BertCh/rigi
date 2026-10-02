// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenCross,
	PenLine,
	SketchPath,
	SketchPolyline,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	Eq,
	Figure,
	Frac,
	type GipfelbuchIndex,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	MarginNote,
	Measured,
	PhotoPicker,
	Plot,
	RealPhoto,
	Section,
	Stat,
	Steps,
	Sym,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Gallery,
	Mark,
	MarkList,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { PhotoStory } from "#/components/gipfelbuch/viz/PhotoStory";
import { gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Accept rule: precision first, fail closed. Every number is from code or reports:
//  - rule ladder counts: reports/bench-wild.md (100 blind-verified Commons photos; cascade re-run on Mapterhorn
//    for rows 2, 3 and the 20/20 product rule; fused rows from the v2 verification)
//  - gates: src/lib/geo/solve.ts (FULL_SEARCH_CONFIDENCE 0.75), src/lib/integration/unknown-pose.worker.ts
//    (YAW/FOCAL_UNKNOWN_MIN_CONFIDENCE 0.75), src/lib/refine/confidence.ts, src/lib/concord/app/confidence.ts,
//    src/lib/integration/second-opinion.ts (AGREE_DEG 1, CASCADE_TIMEOUT_MS 20 000),
//    src/lib/matcher-client.ts (MATCH_AGREE_DEG 0.5, matchAccepted, shouldEscalate), src/lib/picker/candidates.ts.

const BAD = "var(--gb-red)";

// ---------------------------------------------------------------------------------------------
// Fig. 2: twelve real decisions (scripts/gipfelbuch/build-data.ts on the Niederhorn demo photos)
// ---------------------------------------------------------------------------------------------
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** The factors of solvePose's confidence (src/lib/geo/solve.ts fineStage), recomputed from the stored fields. */
function solveFactors(d: GipfelbuchPhotoData) {
	const s = d.solved;
	const tilt =
		Math.abs(s.delta.pitch) > 3 || Math.abs(s.delta.roll) > 3 ? 0 : 1;
	const f = [
		{
			k: "columns that fit",
			v: clamp01((s.inlierFraction - 0.3) / 0.5),
			raw: `${(100 * s.inlierFraction).toFixed(0)}% of columns within 4 px`,
		},
		{
			k: "coverage",
			v: clamp01(s.coverage / 0.4),
			raw: `${(100 * s.coverage).toFixed(0)}% of the frame has a skyline`,
		},
		{
			k: "ambiguity",
			v: clamp01((1 - s.ambiguity) / 0.4 + 0.1),
			raw: `rival ${s.ambiguity.toFixed(2)} (0 = clear winner)`,
		},
		{
			k: "skyline relief",
			v: clamp01(s.horizonRelief / 0.5),
			raw: `skyline varies ${s.horizonRelief.toFixed(2)}° (needs 0.5° to pin yaw)`,
		},
	];
	return { tilt, f, product: tilt * f.reduce((a, b) => a * b.v, 1) };
}

const PEOPLE_FREE = new Set(["demo-01", "demo-02", "demo-03", "demo-06"]);
/** Occlusion is the point on the rejected photos; the others are cropped to the skyline band. */
const FULL_FRAME = new Set(["demo-07", "demo-11", "demo-12"]);
function bandCrop(d: GipfelbuchPhotoData): [number, number, number, number] {
	const ys = d.skyline.rows.filter((v): v is number => v != null);
	const W = d.photo.width;
	const y0 = Math.max(0, Math.min(...ys) - 60);
	const y1 = Math.min(d.photo.height, Math.max(...ys) + 60);
	return [0, y0, W, Math.max(y1, y0 + W * 0.4)];
}

/** Pill-less hand button: selected is a paper tint with a wavy red underline (state only). */
const handButton = (on: boolean) =>
	`nb-hand ${TYPE.body} px-3 py-0.5 transition ${on ? "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)] underline decoration-[var(--gb-red)] decoration-wavy underline-offset-4" : "gb-secondary hover:text-[var(--gb-ink)]"}`;

/** Solid ink fills for value-carrying bars; hatch rides on top as decoration only. */
const INK_FILL = {
	forest: "var(--gb-forest)",
	red: "var(--gb-red)",
	blue: "var(--gb-water)",
	brown: "var(--gb-sign)",
} as const;

/** A solid bar with a light hatch on top. The width is a clip-path transition, so the strokes never re-roll while it animates. */
function HandBar({
	fraction,
	color,
	seed,
	opacity = 0.75,
	className = "h-3",
}: {
	fraction: number;
	color: "forest" | "red" | "blue" | "brown";
	seed: string;
	opacity?: number;
	className?: string;
}) {
	return (
		<div className={`relative ${className}`} aria-hidden>
			<svg
				className="absolute inset-0 block h-full w-full"
				viewBox="0 0 200 12"
				preserveAspectRatio="none"
				aria-hidden="true"
				role="presentation"
			>
				<PenLine
					seed={`${seed}-track`}
					from={[0, 11]}
					to={[200, 11]}
					color="faint"
					width={0.9}
				/>
			</svg>
			<div
				className="absolute inset-0 transition-[clip-path] duration-700 ease-out motion-reduce:transition-none"
				style={{
					clipPath: `inset(0 ${(100 - clamp01(fraction) * 100).toFixed(1)}% 0 0)`,
				}}
			>
				<svg
					className="block h-full w-full"
					viewBox="0 0 200 12"
					preserveAspectRatio="none"
					aria-hidden="true"
					role="presentation"
				>
					<Wash
						d="M0 1H200V10H0Z"
						color={color}
						seed={`${seed}-wash`}
						layers={9}
						opacity={Math.max(0.09, opacity * 0.11)}
						spread={1.2}
						offset={[0, 0]}
					/>
					<Hachure
						d="M0 1H200V10H0Z"
						seed={seed}
						color="ink"
						gap={3.4}
						opacity={0.14}
					/>
				</svg>
			</div>
		</div>
	);
}

function Bar({
	p,
	sel,
	onPick,
}: {
	p: GipfelbuchIndex["photos"][number];
	sel: boolean;
	onPick: () => void;
}) {
	const refine = p.stage === "refine";
	const inkName = !p.accepted ? "red" : refine ? "brown" : "blue";
	const col = INK_FILL[inkName];
	return (
		<button
			type="button"
			onClick={onPick}
			aria-pressed={sel}
			aria-label={`${p.id}: confidence ${p.confidence}`}
			className="group flex min-w-0 flex-col items-stretch gap-1"
		>
			<div className="relative h-[110px]">
				<svg
					className="absolute inset-x-[12%] bottom-0 block w-[76%] transition-opacity"
					style={{ height: `${p.confidence * 100}%`, opacity: sel ? 1 : 0.55 }}
					viewBox="0 0 40 100"
					preserveAspectRatio="none"
					aria-hidden="true"
					role="presentation"
				>
					<Wash
						d="M1 2H39V100H1Z"
						color={inkName}
						seed={`ar-bar-wash-${p.id}`}
						layers={9}
						opacity={0.1}
						spread={1.5}
						offset={[0, 0]}
					/>
					<Hachure
						d="M1 2H39V100H1Z"
						seed={`ar-bar-${p.id}`}
						color="ink"
						gap={4}
						opacity={0.14}
					/>
				</svg>
				<div
					className={`absolute inset-x-0 -top-4 text-center font-mono ${TYPE.micro} gb-secondary`}
				>
					{p.confidence.toFixed(2)}
				</div>
			</div>
			<div
				className="overflow-hidden transition"
				style={{
					boxShadow: sel ? `0 0 0 2px ${col}` : "none",
					opacity: sel ? 1 : 0.7,
				}}
			>
				<img
					src={p.thumb}
					alt=""
					className="block aspect-[4/3] w-full object-cover"
				/>
			</div>
			<div className={`text-center font-mono ${TYPE.micro} gb-secondary`}>
				{p.id.slice(5)}
			</div>
		</button>
	);
}

function RealDecisions() {
	const index = useGipfelbuchIndex();
	const [id, setId] = useState<GipfelbuchPhotoId>("demo-11");
	const d = useGipfelbuchPhoto(id);
	const fx = d ? solveFactors(d) : null;
	const crop =
		d && !PEOPLE_FREE.has(id) && !FULL_FRAME.has(id) ? bandCrop(d) : undefined;
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The accept decision on 12 real photos, bar 0.5. Bars show the
					confidence of the accepted pose (amber: rescued by the second solver)
					or of the rejected one (red). Tap one. Photos 07, 11 and 12 are shown
					whole: the person in the frame is why the skyline fit is weak.{" "}
					<Measured data={d ?? index} />
				</>
			}
			bleed
		>
			<div className="relative mt-5 pl-8">
				<svg
					className="pointer-events-none absolute inset-x-0 z-10 block h-2 w-full"
					style={{ top: `${110 * 0.5 - 4}px` }}
					viewBox="0 0 400 8"
					preserveAspectRatio="none"
					aria-hidden="true"
					role="presentation"
				>
					<PenLine
						seed="ar-bar-line"
						from={[0, 4]}
						to={[400, 4]}
						color="ink"
						width={1.2}
						dash="6 5"
					/>
				</svg>
				<div
					className={`pointer-events-none absolute left-0 z-10 -translate-y-1/2 font-mono ${TYPE.micro} gb-secondary`}
					style={{ top: `${110 * 0.5}px` }}
				>
					0.5
				</div>
				<div className="grid grid-cols-12 gap-1">
					{index?.photos.map((p) => (
						<Bar
							key={p.id}
							p={p}
							sel={p.id === id}
							onPick={() => setId(p.id)}
						/>
					))}
				</div>
			</div>
			<div className="mt-6 grid gap-5 sm:grid-cols-[1.35fr_1fr]">
				{/* the spill keeps off the verdict column on the right */}
				<div className="min-w-0" data-gb-bleed-bounds="right">
					<RealPhoto
						bleed
						data={d}
						layers={["skyline", "solved"]}
						toggles={["skyline", "solved", "prior"]}
						crop={crop}
						className={
							d && d.photo.height > d.photo.width
								? "mx-auto w-full max-w-[300px]"
								: undefined
						}
						key={id}
					/>
				</div>
				{d && fx && (
					<div className={`min-w-0 ${TYPE.caption}`}>
						<div className="flex items-baseline gap-2">
							<span
								className="font-semibold text-2xl"
								style={{ color: d.solved.accepted ? "var(--nb-forest)" : BAD }}
							>
								{d.solved.accepted
									? d.solved.stage === "refine"
										? "accepted by second solver"
										: "accepted"
									: "rejected"}
							</span>
							<span className={`font-mono ${TYPE.micro} gb-secondary`}>
								{d.id}
							</span>
						</div>
						<div className="mt-3 space-y-1.5">
							{fx.f.map((x) => (
								<div key={x.k}>
									<div
										className={`flex justify-between font-mono ${TYPE.micro} gb-secondary`}
									>
										<span>{x.k}</span>
										<span>{x.v.toFixed(2)}</span>
									</div>
									<HandBar
										fraction={x.v}
										color={x.v < 1 ? "red" : "forest"}
										seed={`ar-factor-${x.k}`}
										opacity={x.v < 1 ? 0.85 : 0.55}
										className="h-2"
									/>
								</div>
							))}
						</div>
						<p className={`mt-3 ${TYPE.caption} gb-secondary`}>
							{id === "demo-12" ? (
								<>
									The first solver multiplies these to {fx.product.toFixed(2)}:
									only {(100 * d.solved.inlierFraction).toFixed(0)}% of the
									skyline columns fit, because hair crosses the ridge. It
									rejects. The second solver scores the same skyline{" "}
									{d.solved.confidence.toFixed(3)} and accepts. The verdict
									flips with the weighting, so this evidence alone is not enough
									to call the pose certain.
								</>
							) : d.solved.accepted ? (
								<>
									Score {fx.product.toFixed(2)} clears 0.5. Median skyline gap{" "}
									falls from {d.residual.prior.median.toFixed(1)} px (phone
									sensors) to {d.residual.solved.median.toFixed(1)} px (solved).
								</>
							) : (
								<>
									Score {fx.product.toFixed(2)}, under 0.5. The shortfall is the
									fit: {(100 * d.solved.inlierFraction).toFixed(0)}% of columns
									within 4 px. A head and hair are not terrain. The pose stays
									unconfirmed and the user is asked.
									{d.app && (
										<>
											{" "}
											Rejected is not wrong: the app's saved yaw is{" "}
											{d.app.yaw.toFixed(1)}°, here {d.solved.yaw.toFixed(1)}°.
											The rule only refuses to call it certain.
										</>
									)}
								</>
							)}
						</p>
					</div>
				)}
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Fig. 3: why a bar at all: confidence against the real yaw error on hand-registered photos
// ---------------------------------------------------------------------------------------------
type GtRow = {
	name: string;
	gtQuality: string;
	confidence: number;
	accepted: boolean;
	solvedError?: { yaw: number };
};
function ConfidenceVsError() {
	const index = useGipfelbuchIndex();
	const rows = ((index?.groundTruthEval.cascade ?? []) as GtRow[]).filter(
		(r) => r.solvedError,
	);
	const [hover, setHover] = useState<string | null>(null);
	const hov = rows.find((r) => r.name === hover);
	const costly = rows.find((r) => r.name.includes("7063"));
	const worst = rows
		.filter((r) => !r.accepted)
		.sort(
			(a, b) =>
				Math.abs(b.solvedError?.yaw ?? 0) - Math.abs(a.solvedError?.yaw ?? 0),
		)[0];
	const best = rows
		.filter((r) => r.accepted)
		.sort(
			(a, b) =>
				Math.abs(b.solvedError?.yaw ?? 0) - Math.abs(a.solvedError?.yaw ?? 0),
		)[0];
	return (
		<Figure
			label="Fig. 3"
			caption={
				<>
					{best
						? `No pose the bar accepts is more than ${Math.abs(best.solvedError?.yaw ?? 0).toFixed(1)}° off, which is why the bar sits at 0.5.`
						: "Confidence against yaw error is why the bar sits at 0.5."}
					<MarginNote mark="d">
						{`Solver confidence against yaw error from a hand-fitted pose, ${rows.length} photos with a fit. Filled: accepted. Hollow: rejected, drawn at the pose it would have shown. Every accepted pose is within 0.5°.`}
					</MarginNote>
				</>
			}
		>
			<Plot
				x={[0, 1]}
				y={[0, 20]}
				xLabel="solve confidence"
				yLabel="|yaw error| (°)"
				fmtX={(v) => v.toFixed(1)}
				fmtY={(v) => `${v}`}
			>
				{(s) => (
					<>
						<Wash
							d={`M${s.x(0.5)} ${s.box.y0}H${s.x(1)}V${s.box.y1}H${s.x(0.5)}Z`}
							color="forest"
							seed="ar-accept-wash"
							layers={9}
							opacity={0.08}
						/>
						<Hachure
							d={`M${s.x(0.5)} ${s.box.y0}H${s.x(1)}V${s.box.y1}H${s.x(0.5)}Z`}
							seed="ar-accept-zone"
							color="forest"
							gap={9}
							opacity={0.2}
						/>
						<SketchPath
							d={`M${s.x(0.5)} ${s.box.y0}V${s.box.y1}`}
							seed="ar-accept-line"
							width={1.4}
							dash="5 4"
							passes={1}
						/>
						<HandLabel x={s.x(0.5) + 8} y={s.box.y0 + 16} color={SWISS.forest}>
							accept ≥ 0.5
						</HandLabel>
						{worst && (
							<>
								<HandText
									x={s.x(Math.max(0.04, worst.confidence - 0.34))}
									y={s.y(Math.abs(worst.solvedError?.yaw ?? 0)) + 4}
									size={13}
									color="red"
								>
									{`${rows.filter((r) => !r.accepted).length} refused, the worst ${Math.abs(worst.solvedError?.yaw ?? 0).toFixed(1)}° off`}
								</HandText>
								<PenArrow
									from={[
										s.x(Math.max(0.04, worst.confidence - 0.34)) + 96,
										s.y(Math.abs(worst.solvedError?.yaw ?? 0)),
									]}
									to={[
										s.x(worst.confidence) - 9,
										s.y(Math.abs(worst.solvedError?.yaw ?? 0)),
									]}
									seed="ar-note-worst"
									color="red"
									width={1.3}
								/>
							</>
						)}
						{costly && (
							<>
								<HandText
									x={s.x(0.08)}
									y={s.y(Math.abs(costly.solvedError?.yaw ?? 0)) - 34}
									size={13}
									color="pencil"
								>
									{`${costly.name.replace(".jpg", "")} ${costly.confidence}: right, but refused`}
								</HandText>
								<PenArrow
									from={[
										s.x(0.32),
										s.y(Math.abs(costly.solvedError?.yaw ?? 0)) - 28,
									]}
									to={[
										s.x(costly.confidence) - 3,
										s.y(Math.abs(costly.solvedError?.yaw ?? 0)) - 9,
									]}
									seed="ar-note-costly"
									color="pencil"
									width={1.2}
								/>
							</>
						)}
						{best && (
							<HandText
								x={s.x(1) - 8}
								y={s.y(Math.abs(best.solvedError?.yaw ?? 0)) - 40}
								anchor="end"
								size={13}
								color="forest"
							>
								{`every accepted pose within ${Math.abs(best.solvedError?.yaw ?? 0).toFixed(2)}° on ${rows.filter((r) => r.accepted).length} photos ✓`}
							</HandText>
						)}
						{rows.map((r) => {
							const cx = s.x(r.confidence);
							const cy = s.y(Math.abs(r.solvedError?.yaw ?? 0));
							const rad = hover === r.name ? 6.5 : 4.8;
							return (
								// biome-ignore lint/a11y/useSemanticElements: SVG mark, no semantic equivalent
								<g
									key={r.name}
									role="button"
									tabIndex={0}
									aria-label={r.name}
									onFocus={() => setHover(r.name)}
									onBlur={() => setHover(null)}
									onMouseEnter={() => setHover(r.name)}
									onMouseLeave={() => setHover(null)}
								>
									<circle cx={cx} cy={cy} r={10} fill="transparent" />
									{r.accepted ? (
										<HandDot
											x={cx}
											y={cy}
											r={rad}
											seed={`ar-gt-${r.name}`}
											color="forest"
										/>
									) : (
										<PenCircle
											center={[cx, cy]}
											radiusX={rad}
											seed={`ar-gt-${r.name}`}
											color="red"
											width={1.8}
										/>
									)}
								</g>
							);
						})}
					</>
				)}
			</Plot>
			<div className={`mt-2 h-4 font-mono ${TYPE.micro} gb-secondary`}>
				{hov
					? `${hov.name}: confidence ${hov.confidence}, yaw error ${Math.abs(hov.solvedError?.yaw ?? 0).toFixed(2)}°, ${hov.accepted ? "accepted" : "rejected"} (reference: ${hov.gtQuality})`
					: "hover a point"}
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Fig. 6: the precision ladder
// ---------------------------------------------------------------------------------------------
type Rule = {
	id: string;
	name: string;
	rule: string;
	right: number | null;
	wrong: number;
	unsure?: number;
	precision: string;
	note: string;
};
const RULES: Rule[] = [
	{
		id: "app",
		name: "App aligner",
		rule: "app aligner accepts",
		right: 39,
		wrong: 19,
		unsure: 2,
		precision: "0.64",
		note: "60 accepted poses on 100 photos checked by hand: 39 correct, 19 confidently wrong, 2 unsure (grey). Precision = correct over accepted. The baseline for the later rules.",
	},
	{
		id: "c50",
		name: "Full solve ≥ 0.5",
		rule: "bar with trusted compass",
		right: 25,
		wrong: 2,
		precision: "0.93",
		note: "Fine around a trusted compass; too loose once yaw is unknown.",
	},
	{
		id: "c75",
		name: "Full solve ≥ 0.75",
		rule: "bar when heading unknown",
		right: 22,
		wrong: 0,
		precision: "1.00",
		note: "The two wrong accepts sat between 0.5 and 0.75. Raising the bar removes them and loses 3 correct poses; a second look recovers 2.",
	},
	{
		id: "fused",
		name: "Match HIGH",
		rule: "render-and-match, HIGH",
		right: 30,
		wrong: 1,
		precision: "0.97",
		note: "One gross error in 31 HIGH poses; it had no GPS fix and no second solver agreeing.",
	},
	{
		id: "product",
		name: "Product rule",
		rule: "HIGH and (GPS or full solve within 0.5°)",
		right: 20,
		wrong: 0,
		precision: "1.00",
		note: "20 of 20 correct. The price is recall: HIGH alone had 30 correct and 1 wrong; this rule gives up 10 correct poses to avoid that one. The rest become “please confirm”.",
	},
];

function Dots({ r }: { r: Rule }) {
	const dots: { bad: boolean; grey?: boolean }[] = [
		...Array.from({ length: r.right ?? 0 }, () => ({ bad: false })),
		...Array.from({ length: r.wrong }, () => ({ bad: true })),
		...Array.from({ length: r.unsure ?? 0 }, () => ({
			bad: false,
			grey: true,
		})),
	];
	return (
		<div className="flex flex-wrap gap-[4px]" aria-hidden>
			{dots.map((d, i) => (
				<svg
					// biome-ignore lint/suspicious/noArrayIndexKey: positional dots
					key={`${r.id}${i}`}
					className="atl-dot block size-[18px]"
					viewBox="0 0 18 18"
					aria-hidden="true"
					role="presentation"
					style={{ animationDelay: `${i * 18}ms` }}
				>
					{d.bad ? (
						<PenCross
							center={[9, 9]}
							size={5.5}
							seed={`ar-dot-${r.id}-${i}`}
							color="red"
							width={2}
						/>
					) : d.grey ? (
						<PenCircle
							center={[9, 9]}
							radiusX={5}
							seed={`ar-dot-${r.id}-${i}`}
							color="pencil"
							width={1.8}
						/>
					) : (
						<HandDot
							x={9}
							y={9}
							r={5.6}
							seed={`ar-dot-${r.id}-${i}`}
							color="forest"
						/>
					)}
				</svg>
			))}
		</div>
	);
}

function PrecisionLadder() {
	const [ref, t] = useTime<HTMLDivElement>(0);
	const [manual, setManual] = useState<number | null>(null);
	const idx = manual ?? Math.floor(t / 4.5) % RULES.length;
	const r = RULES[idx];
	const p = Number(r.precision);
	return (
		<Figure
			label="Fig. 6"
			bleed
			caption="Five accept rules on the same 100 checked photos. Each dot is an accepted pose: green correct, red confidently wrong, grey unsure. Tighten the rule and the red disappears; fewer dots remain."
		>
			<div ref={ref}>
				<style>{`
					@keyframes atl-pop { from { transform: scale(0); opacity: 0 } to { transform: scale(1) } }
					.atl-dot { animation: atl-pop .35s cubic-bezier(.2,.9,.3,1.3) both; transform-origin: center }
					@media (prefers-reduced-motion: reduce) { .atl-dot { animation: none } }
				`}</style>
				<div className="flex flex-wrap gap-2">
					{RULES.map((x, i) => (
						<button
							key={x.id}
							type="button"
							onClick={() => setManual(i)}
							aria-pressed={i === idx}
							className={handButton(i === idx)}
						>
							{i + 1}. {x.name}
						</button>
					))}
					{manual !== null && (
						<button
							type="button"
							onClick={() => setManual(null)}
							className={`nb-hand px-2 py-0.5 ${TYPE.body} gb-secondary underline decoration-dotted`}
						>
							auto
						</button>
					)}
				</div>

				<div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-[minmax(0,1fr)_190px]">
					<div className="min-h-[120px]">
						<div
							className={`mb-3 font-mono ${TYPE.micro} uppercase tracking-wider gb-secondary`}
						>
							{r.rule}
						</div>
						<Dots key={r.id} r={r} />
						<p className={`mt-4 ${TYPE.caption} gb-secondary`}>{r.note}</p>
					</div>
					<div className="flex flex-row items-end gap-6 sm:flex-col sm:items-start sm:gap-4">
						<Stat value={r.precision} label="precision" />
						<Stat value={String(r.wrong)} label="wrong accepts" />
						<div className="w-full min-w-[110px]">
							<HandBar
								fraction={p}
								color={p >= 1 ? "forest" : "red"}
								seed="ar-precision"
								className="h-3"
							/>
						</div>
					</div>
				</div>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Fig. D1: the verdict tree of integration/second-opinion.ts, with the matcher's product rule
// ---------------------------------------------------------------------------------------------
type Inp = {
	cascade: boolean; // the unknown-pose cascade accepted (confidence ≥ its gate)
	agree: boolean; // app accepted AND |Δyaw| ≤ 1°
	escalate: boolean; // shouldEscalate(): conf < 0.5, missing, or solvers disagree > 1°
	high: boolean; // matcher confidenceLevel HIGH
	gps: boolean; // positionTrusted (EXIF GPS fix)
	near: boolean; // cascade pose within 0.5° yaw and pitch of the match
};
type Verdict = "verified" | "refined" | "kept" | "unverified" | "matched";

function decide(i: Inp): { path: string[]; verdict: Verdict } {
	if (i.cascade) {
		return i.agree
			? { path: ["q1", "q2", "verified"], verdict: "verified" }
			: { path: ["q1", "q2n", "refined"], verdict: "refined" };
	}
	if (!i.escalate) return { path: ["q1n", "q3n", "kept"], verdict: "kept" };
	if (!i.high)
		return { path: ["q1n", "q3", "q4n", "unverified"], verdict: "unverified" };
	if (i.gps || i.near)
		return { path: ["q1n", "q3", "q4", "q5", "matched"], verdict: "matched" };
	return {
		path: ["q1n", "q3", "q4", "q5n", "unverified"],
		verdict: "unverified",
	};
}

const SCENARIOS: { name: string; inp: Inp }[] = [
	{
		name: "Both agree",
		inp: {
			cascade: true,
			agree: true,
			escalate: false,
			high: false,
			gps: false,
			near: false,
		},
	},
	{
		name: "Cascade overrules",
		inp: {
			cascade: true,
			agree: false,
			escalate: false,
			high: false,
			gps: false,
			near: false,
		},
	},
	{
		name: "Match, GPS fix",
		inp: {
			cascade: false,
			agree: false,
			escalate: true,
			high: true,
			gps: true,
			near: false,
		},
	},
	{
		name: "Match, no GPS, no agreement",
		inp: {
			cascade: false,
			agree: false,
			escalate: true,
			high: true,
			gps: false,
			near: false,
		},
	},
	{
		name: "Match, cascade within 0.5°",
		inp: {
			cascade: false,
			agree: false,
			escalate: true,
			high: true,
			gps: false,
			near: true,
		},
	},
	{
		name: "Matcher not HIGH",
		inp: {
			cascade: false,
			agree: false,
			escalate: true,
			high: false,
			gps: true,
			near: true,
		},
	},
	{
		name: "Skyline fine, cascade quiet",
		inp: {
			cascade: false,
			agree: false,
			escalate: false,
			high: false,
			gps: false,
			near: false,
		},
	},
];

const TOGGLES: { k: keyof Inp; label: string }[] = [
	{ k: "cascade", label: "full solve accepted" },
	{ k: "agree", label: "app accepted, within 1°" },
	{ k: "escalate", label: "skyline weak" },
	{ k: "high", label: "match HIGH" },
	{ k: "gps", label: "GPS trusted" },
	{ k: "near", label: "full solve within 0.5°" },
];

type NodeDef = {
	id: string;
	x: number;
	y: number;
	w: number;
	text: string;
	sub?: string;
};
const QW = 176;
const NODES: NodeDef[] = [
	{
		id: "q1",
		x: 14,
		y: 58,
		w: QW,
		text: "full solve accepted?",
		sub: "re-solve from compass and gravity",
	},
	{ id: "q2", x: 232, y: 58, w: QW, text: "app accepted, within 1°?" },
	{
		id: "q3",
		x: 14,
		y: 150,
		w: QW,
		text: "second look needed?",
		sub: "skyline < 0.5, or solvers differ",
	},
	{ id: "q4", x: 14, y: 232, w: QW, text: "match HIGH?" },
	{
		id: "q5",
		x: 232,
		y: 232,
		w: QW,
		text: "GPS trusted or full solve within 0.5°?",
	},
];
const OUT: {
	id: Verdict | string;
	v: Verdict;
	x: number;
	y: number;
	label: string;
}[] = [
	{ id: "verified", v: "verified", x: 470, y: 22, label: "verified" },
	{
		id: "refined",
		v: "refined",
		x: 470,
		y: 86,
		label: "refined: full-solve pose",
	},
	{ id: "kept", v: "kept", x: 232, y: 150, label: "kept: app pose, no badge" },
	{
		id: "matched",
		v: "matched",
		x: 470,
		y: 232,
		label: "matched: HIGH, applied",
	},
	{
		id: "unverified",
		v: "unverified",
		x: 232,
		y: 304,
		label: "unverified: “please confirm”",
	},
];
// Label size: 11 px rendered at the text column (~720 px) for this 640-wide viewBox.
// 10 units: about 13 px at the wide figure track (viewBox 640 shown at ~860 px).
const LABEL = 10;
const NH = 44;
const OW = 160;

type Edge = {
	id: string;
	pts: [number, number][];
	label?: string;
	lx?: number;
	ly?: number;
};
const EDGES: Edge[] = [
	{
		id: "q1",
		pts: [
			[190, 80],
			[232, 80],
		],
		label: "yes",
		lx: 211,
		ly: 73,
	},
	{
		id: "q2",
		pts: [
			[408, 80],
			[440, 80],
			[440, 44],
			[470, 44],
		],
		label: "yes",
		lx: 424,
		ly: 60,
	},
	{
		id: "q2n",
		pts: [
			[408, 80],
			[440, 80],
			[440, 108],
			[470, 108],
		],
		label: "no",
		lx: 424,
		ly: 100,
	},
	{
		id: "q1n",
		pts: [
			[102, 102],
			[102, 150],
		],
		label: "no",
		lx: 110,
		ly: 130,
	},
	{
		id: "q3n",
		pts: [
			[190, 172],
			[232, 172],
		],
		label: "no",
		lx: 211,
		ly: 165,
	},
	{
		id: "q3",
		pts: [
			[102, 194],
			[102, 232],
		],
		label: "yes",
		lx: 112,
		ly: 216,
	},
	{
		id: "q4",
		pts: [
			[190, 254],
			[232, 254],
		],
		label: "yes",
		lx: 211,
		ly: 247,
	},
	{
		id: "q5",
		pts: [
			[408, 254],
			[470, 254],
		],
		label: "yes",
		lx: 439,
		ly: 247,
	},
	{
		id: "q4n",
		pts: [
			[102, 276],
			[102, 326],
			[232, 326],
		],
		label: "no",
		lx: 112,
		ly: 296,
	},
	{
		id: "q5n",
		pts: [
			[320, 276],
			[320, 304],
		],
		label: "no",
		lx: 330,
		ly: 294,
	},
];

function VerdictTree() {
	const [ref, t] = useTime<HTMLDivElement>(0);
	const [custom, setCustom] = useState<Inp | null>(null);
	const sc = Math.floor(t / 3.6) % SCENARIOS.length;
	const inp = custom ?? SCENARIOS[sc].inp;
	const res = decide(inp);
	const on = new Set(res.path);
	const flip = (k: keyof Inp) => setCustom({ ...inp, [k]: !inp[k] });
	// moving pulse along the active path's final edge
	const pulse = (t * 0.9) % 1;
	return (
		<Figure
			label="Fig. D1"
			bleed
			caption="How a pose gets its verdict. It cycles through typical cases; switch any input to trace your own path. Only matched, verified and refined poses are shown as certain. Every other branch ends in a pose the user is asked to confirm, or the app pose with no badge. (A full solve not done within 20 s also keeps the app pose.)"
		>
			<div ref={ref}>
				<div className="mb-4 flex flex-wrap gap-2">
					{TOGGLES.map((tg) => (
						<button
							key={tg.k}
							type="button"
							onClick={() => flip(tg.k)}
							aria-pressed={inp[tg.k]}
							className={handButton(inp[tg.k])}
						>
							{tg.label}
						</button>
					))}
					{custom && (
						<button
							type="button"
							onClick={() => setCustom(null)}
							className={`nb-hand px-2 py-0.5 ${TYPE.body} gb-secondary underline decoration-dotted`}
						>
							auto
						</button>
					)}
				</div>
				<svg
					viewBox="0 0 640 360"
					className="block h-auto w-full"
					role="img"
					aria-label={`Verdict ${res.verdict}`}
				>
					{EDGES.map((e) => {
						const act = on.has(e.id);
						return (
							<g key={e.id}>
								<SketchPolyline
									points={e.pts}
									seed={`ar-edge-${e.id}`}
									color={act ? "ink" : "faint"}
									width={act ? 2.4 : 1.1}
									passes={act ? 2 : 1}
								/>
								{e.label && (
									<HandLabel
										x={e.lx ?? 0}
										y={e.ly ?? 0}
										anchor="middle"
										size={LABEL}
										color={act ? "var(--gb-ink)" : "var(--gb-secondary)"}
									>
										{e.label}
									</HandLabel>
								)}
							</g>
						);
					})}
					{NODES.map((n) => {
						const act =
							res.path.includes(n.id) || res.path.includes(`${n.id}n`);
						return (
							<g key={n.id}>
								{act ? (
									<Wash
										d={`M${n.x} ${n.y}H${n.x + n.w}V${n.y + NH}H${n.x}Z`}
										color="brown"
										seed={`ar-node-wash-${n.id}`}
										layers={8}
										opacity={0.07}
										spread={2}
									/>
								) : (
									<Hachure
										d={`M${n.x} ${n.y}H${n.x + n.w}V${n.y + NH}H${n.x}Z`}
										seed={`ar-node-hatch-${n.id}`}
										color="faint"
										gap={7}
										opacity={0.4}
									/>
								)}
								<HandLabel
									x={n.x + 4}
									y={n.y + (n.sub ? 18 : 26)}
									size={LABEL}
									mono={false}
									color={act ? "var(--gb-ink)" : "var(--gb-secondary)"}
								>
									{n.text}
								</HandLabel>
								{n.sub && (
									<HandLabel
										x={n.x + 4}
										y={n.y + 33}
										size={LABEL - 1}
										mono={false}
										color="var(--gb-secondary)"
									>
										{n.sub}
									</HandLabel>
								)}
								<PenLine
									seed={`ar-node-${n.id}`}
									from={[n.x, n.y + NH - 2]}
									to={[n.x + n.w, n.y + NH - 2]}
									color={act ? "ink" : "faint"}
									width={act ? 1.6 : 0.9}
								/>
							</g>
						);
					})}
					{OUT.map((o) => {
						const act = res.verdict === o.v && on.has(o.id);
						const good =
							o.v === "verified" || o.v === "refined" || o.v === "matched";
						return (
							<g key={o.id}>
								{act ? (
									<PenCircle
										center={[o.x + OW / 2, o.y + 18]}
										radiusX={OW / 2 + 6}
										radiusY={18}
										seed={`ar-out-${o.id}`}
										color={good ? "forest" : "red"}
										width={2}
									/>
								) : (
									<PenLine
										seed={`ar-out-line-${o.id}`}
										from={[o.x + 6, o.y + 30]}
										to={[o.x + OW - 6, o.y + 30]}
										color="faint"
										width={0.9}
									/>
								)}
								<HandLabel
									x={o.x + OW / 2}
									y={o.y + 22}
									anchor="middle"
									size={LABEL}
									mono={false}
									caps={act}
									weight={act ? 700 : 400}
									color={act ? "var(--gb-ink)" : "var(--gb-secondary)"}
								>
									{o.label}
								</HandLabel>
							</g>
						);
					})}
					{/* travelling pulse along the active edges */}
					{(() => {
						const act = EDGES.filter((e) => on.has(e.id));
						if (!act.length) return null;
						const seg = Math.min(
							act.length - 1,
							Math.floor(pulse * act.length),
						);
						const e = act[seg];
						const f = pulse * act.length - seg;
						const L = e.pts.reduce(
							(s, p, i) =>
								i
									? s +
										Math.hypot(p[0] - e.pts[i - 1][0], p[1] - e.pts[i - 1][1])
									: 0,
							0,
						);
						let d = f * L;
						let pos = e.pts[0];
						for (let i = 1; i < e.pts.length; i++) {
							const a = e.pts[i - 1];
							const b = e.pts[i];
							const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
							if (d <= l) {
								pos = [
									a[0] + ((b[0] - a[0]) * d) / l,
									a[1] + ((b[1] - a[1]) * d) / l,
								];
								break;
							}
							d -= l;
							pos = b;
						}
						return (
							<HandDot
								x={pos[0]}
								y={pos[1]}
								r={4.2}
								seed="ar-pulse"
								color="red"
							/>
						);
					})()}
					<HandText x={14} y={30} color="pencil" size={15}>
						after first draw: second opinion
					</HandText>
					<HandText x={470} y={170} color="forest" size={15}>
						only these three ever show as certain
					</HandText>
					<PenArrow
						from={[560, 176]}
						to={[560, 214]}
						seed="ar-note-certain"
						color="forest"
						width={1.3}
					/>
					<HandText x={232} y={346} color="red" size={15}>
						a lone answer stays “please confirm”
					</HandText>
				</svg>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------

const GATES: [string, string][] = [
	["0.5", "with a trusted compass"],
	["0.75", "when the heading is unknown"],
	["score ≥ 0.5, 30% of columns fit", "second solver"],
	["1°", "app pose against full solve: verified or refined"],
	["0.5°", "match against full solve"],
];

function Legacy() {
	return (
		<>
			<Section title="How it works" kicker="Mechanism">
				<Steps
					steps={[
						{
							title: "Soft evidence, hard gates",
							body: (
								<>
									The second solver’s confidence is six ramps multiplied
									together (yaw peak, runner-up ratio, columns that fit,
									uncertainty, skyline slope, residual). One weak term drags it
									down. Accept needs a score of 0.5, at least 30% of columns
									fitting, and a skyline slope of 0.015.
								</>
							),
						},
						{
							title: "A higher bar when less is known",
							body: (
								<>
									With a trusted compass the search is ±25° and 0.5 suffices.
									With heading or focal unknown the search covers every heading,
									wrong matches are likelier, and the bar becomes 0.75. On 100
									checked photos that took the solver from 25 correct and 2
									wrong accepts to 22 and 0 (Fig. 6).
								</>
							),
						},
						{
							title: "Two solvers must not disagree",
							body: (
								<>
									After first draw, a second solver re-solves on its own.
									Agreement within 1° keeps the pose (“verified”); a confident
									solver that disagrees wins (“refined”). The app aligner alone
									made one confident wrong accept on the reference set; the
									second solver made none.
								</>
							),
						},
						{
							title: "Look again, then demand independent evidence",
							body: (
								<>
									If the skyline is weak, the photo goes to render-and-match.
									Even a HIGH match is applied only with a trusted GPS fix or
									when the full solve lands within 0.5°. A match that stands
									alone is “unverified”, and the user is asked.
								</>
							),
						},
						{
							title: "Suggestions are not accepts",
							body: (
								<>
									The top-3 picker and tapped peaks give candidates, never
									acceptance. Only an automatic, verified accept is HIGH; a pose
									the user picks or pins never is. Re-solving from taps is the{" "}
									<Link
										to={gipfelbuchHref("tap-a-peak")}
										className="underline decoration-[var(--gb-red)]"
									>
										tap-a-peak
									</Link>{" "}
									fallback.
								</>
							),
						},
					]}
				/>
			</Section>

			<VerdictTree />

			<Section title="The bars" kicker="Gates">
				<p>
					About a dozen thresholds, set by hand so that no wrong pose is
					accepted on the 100 photos checked by hand. They are bars, not
					probabilities.
				</p>
				<div className="@container my-6">
					{GATES.map(([gate, what]) => (
						<div
							key={gate}
							className="flex flex-col gap-1 px-4 py-3 odd:bg-[var(--gb-paper-deep)] @[640px]:flex-row @[640px]:items-baseline @[640px]:gap-4"
						>
							<code
								className={`shrink-0 ${TYPE.caption} @[640px]:w-[19rem]`}
								style={{ color: "var(--nb-brown)" }}
							>
								{gate}
							</code>
							<span className={`flex-1 ${TYPE.caption} gb-secondary`}>
								{what}
							</span>
						</div>
					))}
				</div>
				<Callout tone="lesson">
					Precision first costs recall on purpose. The rule leaves 10 correct
					poses on the table to avoid one wrong one; they go to “please
					confirm”.
				</Callout>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front page (the figures above are folded into Details, except the precision ladder)
// ======================================================================================
/** Tone fills for accepted (forest) and rejected (red) chips. */
const ACCEPT_C = "var(--gb-forest)";
const REJECT_C = "var(--gb-red)";

/** One written reason per photo, from the stored solve record. */
function reason(d: GipfelbuchPhotoData): string {
	const s = d.solved;
	const fit = `${(100 * s.inlierFraction).toFixed(0)}% of columns fit`;
	if (s.stage === "refine")
		return `refused by the first solver; accepted by the second at ${s.confidence.toFixed(2)}, ${fit}`;
	if (!s.accepted)
		return `confidence ${s.confidence.toFixed(2)}, under 0.5: only ${fit}`;
	return `confidence ${s.confidence.toFixed(2)}, ${fit}`;
}

/** The alignment story on a photo the rule turned down: the app keeps the phone's pose and asks. */
function RejectedStory() {
	const d = useGipfelbuchPhoto("demo-07");
	return (
		<PhotoStory
			photoId="demo-07"
			number="5"
			title="A solve the rule refuses"
			caption={
				d
					? `Photo 07: the solve turned the view ${Math.abs(d.solved.delta.yaw).toFixed(1)}° and cut the skyline gap from ${d.residual.prior.median.toFixed(1)} to ${d.residual.solved.median.toFixed(1)} px, but ${reason(d)}. Under 0.5 the app keeps the phone’s pose and asks.`
					: "A solve under the bar is not shown as certain."
			}
		/>
	);
}

function Verdicts() {
	const idx = useGipfelbuchIndex();
	const nOk = idx?.photos.filter((p) => p.accepted).length;
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					{nOk == null
						? "Twelve real photos, twelve decisions."
						: `Twelve real photos, twelve decisions: ${nOk} shown as certain, ${12 - nOk} kept as guesses.`}{" "}
					Each tile says why. <Measured data={idx} />
				</>
			}
		>
			<Gallery
				cols={4}
				tile={(d) => (
					<div className="relative">
						<RealPhoto
							data={d}
							layers={["skyline", "solved"]}
							crop={skylineBand(d, 260)}
						/>
						<span
							className={`absolute top-1 left-1 px-1 font-mono ${TYPE.micro} text-[var(--gb-paper)]`}
							style={{
								background: d.solved.accepted ? "var(--gb-ink)" : SWISS.red,
							}}
						>
							{d.id.slice(-2)} · {d.solved.accepted ? "accepted" : "guess"}
						</span>
					</div>
				)}
				tone={(d) => (d.solved.accepted ? "result" : "failure")}
				tag={(d) => (d.solved.accepted ? undefined : "guess")}
				label={(d) => (
					<>
						<span className="font-semibold text-[var(--gb-ink)]">
							{d.solved.accepted ? "accepted" : "rejected"}
						</span>{" "}
						{reason(d)}
					</>
				)}
			/>
		</Figure>
	);
}

/** Step 2 visual: the 12 confidences on a vertical scale with the two bars. */
function BarScale() {
	const idx = useGipfelbuchIndex();
	const Hh = 100;
	const y = (v: number) => 8 + (1 - v) * (Hh - 16);
	return (
		<svg
			viewBox="0 0 160 100"
			className="block aspect-[8/5] w-full bg-[var(--gb-paper-deep)]"
			role="img"
			aria-label="Solve confidence of the 12 demo photos against the 0.5 and 0.75 bars"
		>
			{[0.5, 0.75].map((v) => (
				<g key={v}>
					<SketchPath
						d={`M26 ${y(v)}H156`}
						seed={`ar-scale-${v}`}
						color="pencil"
						width={1}
						dash="4 3"
						passes={1}
					/>
					<HandLabel
						x={4}
						y={y(v) + 3}
						size={9}
						color="var(--gb-secondary)"
						halo={0}
					>
						{v.toFixed(2)}
					</HandLabel>
				</g>
			))}
			{idx?.photos.map((p, i) => (
				<HandDot
					key={p.id}
					x={36 + i * 10.4}
					y={y(p.confidence)}
					r={4}
					seed={`ar-scale-dot-${p.id}`}
					color={p.accepted ? "forest" : "red"}
					opacity={1}
					data
				/>
			))}
		</svg>
	);
}

/** Step 3 visual: two independent solvers on one photo. */
function TwoSolvers() {
	const d = useGipfelbuchPhoto("demo-01");
	return (
		<div
			className={`flex aspect-[8/5] flex-col justify-center gap-1 bg-[var(--gb-paper-deep)] p-4 font-mono ${TYPE.micro} gb-secondary`}
		>
			{d?.app && (
				<>
					<div>
						app aligner <span className="gb-ink">{d.app.yaw.toFixed(1)}°</span>
					</div>
					<div>
						skyline solve{" "}
						<span className="gb-ink">{d.solved.yaw.toFixed(1)}°</span>
					</div>
					<div className="mt-2 pt-1" style={{ color: "var(--gb-water)" }}>
						within 1°: keep it
					</div>
				</>
			)}
		</div>
	);
}

/** Columns whose detected skyline sits more than 4 px from the map's, drawn on the photo as red ticks. */
function ScoreFit() {
	const index = useGipfelbuchIndex();
	const [id, setId] = useState<GipfelbuchPhotoId>("demo-11");
	const d = useGipfelbuchPhoto(id);
	const fx = d ? solveFactors(d) : null;
	const crop = d ? skylineBand(d, 300) : undefined;
	// the confident column where the photo's and the map's skylines are furthest apart, and one where they agree
	const spots = useMemo(() => {
		if (!d) return null;
		const gap = (x: number) => {
			const a = d.skyline.rows[x];
			const b = d.solvedRows[x];
			return a == null || b == null || d.skyline.weight[x] < 0.3
				? null
				: Math.abs(a - b);
		};
		let best = -1;
		let bx = 0;
		for (let x = 0; x < d.skyline.rows.length; x++) {
			const e = gap(x);
			if (e != null && e > best) {
				best = e;
				bx = x;
			}
		}
		let nx = -1;
		let ng = Number.POSITIVE_INFINITY;
		for (
			let x = Math.round(d.photo.width * 0.6);
			x < d.skyline.rows.length;
			x++
		) {
			const e = gap(x);
			if (e != null && e < ng && x !== bx) {
				ng = e;
				nx = x;
			}
		}
		if (best < 0 || nx < 0) return null;
		return {
			far: { x: bx, y: d.skyline.rows[bx] as number, gap: best },
			near: { x: nx, y: d.skyline.rows[nx] as number, gap: ng },
		};
	}, [d]);
	const live = (i: number, name: string) =>
		fx ? (
			<>
				{name}{" "}
				<span style={{ color: fx.f[i].v < 1 ? BAD : undefined }}>
					{fx.f[i].v.toFixed(2)}
				</span>
				<span className="gb-secondary"> · {fx.f[i].raw}</span>
			</>
		) : (
			name
		);
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					Red ticks mark columns where the photo&rsquo;s skyline is over 4 px
					from the modelled horizon. Hair and heads cause them and pull the
					first check below 1. Tap a photo: <CircledNumber value={1} /> drifts
					furthest, <CircledNumber value={2} /> agrees.{" "}
					<Measured data={d ?? index} />
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const x = index?.photos.find((p) => p.id === i);
					return x ? (
						<span
							className={`px-1 font-mono ${TYPE.micro} text-[var(--gb-paper)]`}
							style={{ background: x.accepted ? ACCEPT_C : REJECT_C }}
						>
							{x.accepted ? "ok" : "rej"}
						</span>
					) : null;
				}}
			/>
			<RealPhoto
				bleed
				key={id}
				data={d}
				layers={["skyline", "solved"]}
				crop={crop}
			>
				{(dd) => (
					<g>
						<g
							style={{ stroke: "var(--gb-red)" }}
							strokeWidth={dd.photo.width / 900}
							opacity={0.9}
						>
							{dd.skyline.rows.map((r, x) => {
								const m = dd.solvedRows[x];
								const w = dd.skyline.weight[x];
								return r != null &&
									m != null &&
									w > 0.05 &&
									Math.abs(r - m) > 4 ? (
									<line
										// biome-ignore lint/suspicious/noArrayIndexKey: one tick per column
										key={x}
										x1={x + 0.5}
										x2={x + 0.5}
										y1={r - 4}
										y2={r + 4}
									/>
								) : null;
							})}
						</g>
						{spots && (
							<>
								<Mark
									x={spots.far.x}
									y={Math.max(30, spots.far.y - 36)}
									n={1}
									k={dd.photo.width / 700}
								/>
								<Mark
									x={spots.near.x}
									y={Math.max(30, spots.near.y - 36)}
									n={2}
									k={dd.photo.width / 700}
								/>
							</>
						)}
					</g>
				)}
			</RealPhoto>
			{spots && (
				<MarkList
					items={[
						<>
							Skyline and horizon are up to {spots.far.gap.toFixed(0)} px apart
							here.
						</>,
						<>
							Here they agree within {Math.max(1, Math.ceil(spots.near.gap))}{" "}
							px.
						</>,
					]}
				/>
			)}
			{d && fx && (
				<p className={`mt-3 ${TYPE.caption}`}>
					<span
						className={`font-semibold ${TYPE.lead}`}
						style={{ color: d.solved.accepted ? "var(--nb-forest)" : BAD }}
					>
						{d.solved.accepted
							? d.solved.stage === "refine"
								? "accepted by the second solver"
								: "accepted"
							: "rejected"}
					</span>{" "}
					<span className={`font-mono ${TYPE.micro} gb-secondary`}>
						score {fx.product.toFixed(2)} from the first solver, bar 0.5
					</span>
				</p>
			)}
			<Eq
				where={[
					{
						sym: "f",
						c: "var(--gb-water)",
						text: live(
							0,
							"columns where skyline and horizon agree within 4 px",
						),
					},
					{
						sym: "κ",
						c: "skyline",
						text: live(1, "width that has a skyline"),
					},
					{
						sym: "a",
						text: live(2, "how close the nearest rival yaw came"),
					},
					{
						sym: "σ",
						c: "var(--gb-water)",
						text: live(3, "how much the horizon varies"),
					},
				]}
			>
				<Sym>c</Sym> = <Sym upright>tilt</Sym> · ⟨
				<Frac
					n={
						<>
							<Sym c="var(--gb-water)">f</Sym> − 0.3
						</>
					}
					d="0.5"
				/>
				⟩ · ⟨<Frac n={<Sym c="skyline">κ</Sym>} d="0.4" />⟩ · ⟨
				<Frac
					n={
						<>
							1 − <Sym>a</Sym>
						</>
					}
					d="0.4"
				/>{" "}
				+ 0.1⟩ · ⟨<Frac n={<Sym c="var(--gb-water)">σ</Sym>} d="0.5" />⟩
			</Eq>
			{fx && id === "demo-12" && (
				<p className={`mt-2 ${TYPE.caption} gb-secondary`}>
					The first solver scores this {fx.product.toFixed(2)} and refuses. The
					second solver weighs the same skyline differently, scores it{" "}
					{d?.solved.confidence.toFixed(2)} and accepts. Ticks here are drawn at
					its pose.
				</p>
			)}
		</Figure>
	);
}

function AcceptRule({ node: _node }: { node: GipfelbuchNode }) {
	const idx = useGipfelbuchIndex();
	const acc = idx ? idx.photos.filter((p) => p.accepted).length : null;
	return (
		<>
			<Beat kicker="The idea" title="A wrong pose is worse than no pose.">
				<p>
					<HandMark type="highlight">
						A wrong pose draws confident names on the wrong mountains.
					</HandMark>{" "}
					A missing pose just asks the user to tap a peak.
					<MarginNote mark="a">
						A tap costs a second. A wrong label costs trust: 19 of 60 accepts
						were wrong.
					</MarginNote>
				</p>
				<p>
					So Rigi calls a pose certain only if a solver accepted it and its
					confidence clears a bar. Everything else is a guess, and says so.{" "}
					<HandMark type="wavy" color="red">
						Even a pose that looks right can be refused.
					</HandMark>
				</p>
			</Beat>

			<Beat kicker="How it works" title="Four checks multiply into one score.">
				<p>
					<HandMark type="underline">
						A weak check drags the whole product down.
					</HandMark>{" "}
					Heads and hair count against the fit, so a photo with a person on the
					ridge can be refused.
					<MarginNote mark="b">
						Four factors, each 0 to 1. One zero and the product is zero: I check
						which one fell.
					</MarginNote>
				</p>
			</Beat>

			<ScoreFit />

			<RealDecisions />

			<Beat kicker="Two more checks" title="A bar, then a second opinion.">
				<Trio
					className="sm:grid-cols-2"
					steps={[
						{
							title: "Hold it to a bar",
							body: "0.5 with a trusted compass. 0.75 when the heading is unknown.",
							visual: <BarScale />,
						},
						{
							title: "Ask a second solver",
							body: "Two independent methods must agree. A lone answer is unverified.",
							visual: <TwoSolvers />,
						},
					]}
				/>
			</Beat>

			<ConfidenceVsError />

			<Beat
				kicker="Where it fails"
				title="The price is correct poses we do not show."
			>
				<p>
					<HandMark type="double">
						Tighter rules throw away good answers on purpose.
					</HandMark>{" "}
					Each dot below is one of 100 photos checked by hand.
				</p>
				<p>
					First guess:{" "}
					<HandMark type="strike">0.5 is a high enough bar.</HandMark>{" "}
					<span className="nb-hand" style={{ color: "var(--gb-red)" }}>
						0.75 once the heading is unknown
					</span>
					: the two wrong accepts sat between 0.5 and 0.75, and the new bar
					costs 3 correct poses.
					<MarginNote mark="c">
						Escalation wins back 2 of those 3. Is the third worth a wrong label?
						I say no.
					</MarginNote>
				</p>
			</Beat>

			<Verdicts />

			<RejectedStory />

			<PrecisionLadder />

			<Numbers
				items={[
					{
						value: "19 / 60",
						label: "wrong among the app aligner's accepts, 100 photos",
					},
					{
						value: "0 / 20",
						label: "wrong among accepts under the product rule",
					},
					{
						value: "30 vs 20",
						label: "correct poses kept: HIGH alone vs this rule",
					},
					{
						value: acc == null ? "…" : `${acc} / 12`,
						label: "demo photos accepted by the solver",
					},
				]}
				source="First three: 100 photos checked by hand. Last: the 12 demo photos."
			/>

			<Details>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(AcceptRule);
