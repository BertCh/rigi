import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	type AtlasIndex,
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	Figure,
	Measured,
	Plot,
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
	Details,
	Gallery,
	Mark,
	MarkList,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

// Accept rule: precision first, fail closed. Every number is from code or reports:
//  - rule ladder counts: reports/bench-wild.md (100 blind-verified Commons photos; cascade re-run on Mapterhorn
//    for rows 2, 3 and the 20/20 product rule; fused rows from the v2 verification)
//  - gates: src/lib/geo/solve.ts (FULL_SEARCH_CONFIDENCE 0.75), src/lib/integration/unknown-pose.worker.ts
//    (YAW/FOCAL_UNKNOWN_MIN_CONFIDENCE 0.75), src/lib/refine/confidence.ts, src/lib/concord/app/confidence.ts,
//    src/lib/integration/second-opinion.ts (AGREE_DEG 1, CASCADE_TIMEOUT_MS 20 000),
//    src/lib/matcher-client.ts (MATCH_AGREE_DEG 0.5, matchAccepted, shouldEscalate), src/lib/picker/candidates.ts.

const BAD = "#e5604d";

// ---------------------------------------------------------------------------------------------
// Fig. 1: twelve real decisions (scripts/atlas/build-data.ts on the Niederhorn demo photos)
// ---------------------------------------------------------------------------------------------
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** The factors of solvePose's confidence (src/lib/geo/solve.ts fineStage), recomputed from the stored fields. */
function solveFactors(d: AtlasPhotoData) {
	const s = d.solved;
	const tilt =
		Math.abs(s.delta.pitch) > 3 || Math.abs(s.delta.roll) > 3 ? 0 : 1;
	const f = [
		{
			k: "inlier fraction",
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
			raw: `second-best basin ${s.ambiguity.toFixed(2)}`,
		},
		{
			k: "horizon relief",
			v: clamp01(s.horizonRelief / 0.5),
			raw: `${s.horizonRelief.toFixed(2)}° of relief`,
		},
	];
	return { tilt, f, product: tilt * f.reduce((a, b) => a * b.v, 1) };
}

const PEOPLE_FREE = new Set(["demo-01", "demo-02", "demo-03", "demo-06"]);
/** Occlusion is the point on the rejected photos; the others are cropped to the skyline band. */
const FULL_FRAME = new Set(["demo-07", "demo-11", "demo-12"]);
function bandCrop(d: AtlasPhotoData): [number, number, number, number] {
	const ys = d.skyline.rows.filter((v): v is number => v != null);
	const W = d.photo.width;
	const y0 = Math.max(0, Math.min(...ys) - 60);
	const y1 = Math.min(d.photo.height, Math.max(...ys) + 60);
	return [0, y0, W, Math.max(y1, y0 + W * 0.4)];
}

function Bar({
	p,
	sel,
	onPick,
}: {
	p: AtlasIndex["photos"][number];
	sel: boolean;
	onPick: () => void;
}) {
	const refine = p.stage === "refine";
	const col = !p.accepted ? BAD : refine ? "#e8c06a" : "var(--accent)";
	return (
		<button
			type="button"
			onClick={onPick}
			aria-pressed={sel}
			aria-label={`${p.id}: confidence ${p.confidence}`}
			className="group flex min-w-0 flex-col items-stretch gap-1"
		>
			<div className="relative h-[110px]">
				<div
					className="absolute inset-x-[12%] bottom-0 rounded-t-sm transition-opacity"
					style={{
						height: `${p.confidence * 100}%`,
						background: col,
						opacity: sel ? 1 : 0.55,
					}}
				/>
				<div className="absolute inset-x-0 -top-4 text-center font-mono text-[9px] text-white/60">
					{p.confidence.toFixed(2)}
				</div>
			</div>
			<div
				className="overflow-hidden rounded-[3px] ring-2 transition"
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
			<div className="text-center font-mono text-[9px] text-white/50">
				{p.id.slice(5)}
			</div>
		</button>
	);
}

function RealDecisions() {
	const index = useAtlasIndex();
	const [id, setId] = useState<AtlasPhotoId>("demo-11");
	const d = useAtlasPhoto(id);
	const fx = d ? solveFactors(d) : null;
	const crop =
		d && !PEOPLE_FREE.has(id) && !FULL_FRAME.has(id) ? bandCrop(d) : undefined;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					The accept decision on 12 real photos: the CPU solve at the app's
					local bar of 0.5 (src/lib/geo/solve.ts, acceptConfidence ). Bars are
					the confidence of the accepted pose (amber: rejected by solvePose,
					rescued by refinePose) or of the rejected one (red). Tap one. Photos
					07, 11 and 12 are shown whole because the person in the frame is the
					reason the skyline fit is weak. <Measured data={d ?? index} />
				</>
			}
			bleed
		>
			<div className="relative mt-5 pl-8">
				<div
					className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-white/40"
					style={{ top: `${110 * 0.5}px` }}
				/>
				<div
					className="pointer-events-none absolute left-0 z-10 -translate-y-1/2 font-mono text-[9px] text-white/70"
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
				<RealPhoto
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
				{d && fx && (
					<div className="min-w-0 text-sm">
						<div className="flex items-baseline gap-2">
							<span
								className="display-title text-2xl"
								style={{ color: d.solved.accepted ? "var(--accent)" : BAD }}
							>
								{d.solved.accepted
									? d.solved.stage === "refine"
										? "accepted by refine"
										: "accepted"
									: "rejected"}
							</span>
							<span className="font-mono text-[11px] text-white/50">
								{d.id}
							</span>
						</div>
						<div className="mt-3 space-y-1.5">
							{fx.f.map((x) => (
								<div key={x.k}>
									<div className="flex justify-between font-mono text-[10px] text-white/55">
										<span>{x.k}</span>
										<span>{x.v.toFixed(2)}</span>
									</div>
									<div className="h-1.5 overflow-hidden rounded-full bg-white/10">
										<div
											className="h-full rounded-full"
											style={{
												width: `${x.v * 100}%`,
												background: x.v < 1 ? BAD : "var(--accent)",
												opacity: x.v < 1 ? 1 : 0.5,
											}}
										/>
									</div>
								</div>
							))}
						</div>
						<p className="mt-3 text-[13px] leading-relaxed text-white/65">
							{id === "demo-12" ? (
								<>
									solvePose multiplies these to {fx.product.toFixed(2)}: only{" "}
									{(100 * d.solved.inlierFraction).toFixed(0)}% of the skyline
									columns fit, because hair crosses the ridge. So it rejects.
									The fallback refinePose scores the same skyline{" "}
									{d.solved.confidence.toFixed(3)} (bar 0.5, inlier floor 0.3)
									and accepts. Two solvers, one photo, a verdict that flips on a
									different weighting: that is why the pose is not shown as
									certain on this evidence alone.
								</>
							) : d.solved.accepted ? (
								<>
									Product {fx.product.toFixed(2)} clears 0.5. Skyline residual{" "}
									falls from {d.residual.prior.median.toFixed(1)} px at the
									sensor prior to {d.residual.solved.median.toFixed(1)} px
									(median) at the solved pose.
								</>
							) : (
								<>
									Product {fx.product.toFixed(2)} &lt; 0.5, and the whole gap is
									the inlier fraction:{" "}
									{(100 * d.solved.inlierFraction).toFixed(0)}% of columns
									within 4 px. A head and hair are not terrain. The pose stays
									unconfirmed and the user is asked.
									{d.app && (
										<>
											{" "}
											Rejected is not the same as wrong: the live app's saved
											pose for this photo has yaw {d.app.yaw.toFixed(1)}°
											against {d.solved.yaw.toFixed(1)}° here. The rule only
											refuses to call it certain.
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
// Fig. 2: why a bar at all: confidence against the real yaw error on hand-registered photos
// ---------------------------------------------------------------------------------------------
type GtRow = {
	name: string;
	gtQuality: string;
	confidence: number;
	accepted: boolean;
	solvedError?: { yaw: number };
};
function ConfidenceVsError() {
	const index = useAtlasIndex();
	const rows = ((index?.groundTruthEval.cascade ?? []) as GtRow[]).filter(
		(r) => r.solvedError,
	);
	const [hover, setHover] = useState<string | null>(null);
	const hov = rows.find((r) => r.name === hover);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Why the bar sits at 0.5: confidence of the CPU cascade against its yaw
					error from a hand-registered pose, {rows.length} photos of the 19 in
					data/ground-truth.json that have a registration
					(out/eval-classic-cascade/report.json, via
					scripts/atlas/build-data.ts). Filled: accepted. Hollow: rejected,
					plotted at the pose the solver would have shown. Every accepted pose
					is within 0.5°; the rejected ones include 6.8° and 19.8° errors, and
					one correct pose (IMG_7063, 0.48) that the bar costs.
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
						<rect
							x={s.x(0.5)}
							y={s.box.y0}
							width={s.x(1) - s.x(0.5)}
							height={s.box.y1 - s.box.y0}
							fill="var(--accent)"
							opacity={0.06}
						/>
						<line
							x1={s.x(0.5)}
							x2={s.x(0.5)}
							y1={s.box.y0}
							y2={s.box.y1}
							stroke="var(--accent)"
							strokeDasharray="4 4"
						/>
						<text
							x={s.x(0.5) + 6}
							y={s.box.y0 + 12}
							fontSize="10"
							fill="var(--accent)"
							fontFamily="ui-monospace,monospace"
						>
							accept ≥ 0.5
						</text>
						{rows.map((r) => (
							// biome-ignore lint/a11y/useSemanticElements: SVG mark, no semantic equivalent
							<circle
								key={r.name}
								cx={s.x(r.confidence)}
								cy={s.y(Math.abs(r.solvedError?.yaw ?? 0))}
								r={hover === r.name ? 6 : 4.5}
								fill={r.accepted ? "var(--accent)" : "none"}
								stroke={r.accepted ? "var(--accent)" : BAD}
								strokeWidth={1.8}
								role="button"
								tabIndex={0}
								aria-label={r.name}
								onFocus={() => setHover(r.name)}
								onBlur={() => setHover(null)}
								onMouseEnter={() => setHover(r.name)}
								onMouseLeave={() => setHover(null)}
							/>
						))}
					</>
				)}
			</Plot>
			<div className="mt-2 h-4 font-mono text-[10.5px] text-white/55">
				{hov
					? `${hov.name}: confidence ${hov.confidence}, yaw error ${Math.abs(hov.solvedError?.yaw ?? 0).toFixed(2)}°, ${hov.accepted ? "accepted" : "rejected"} (ground truth: ${hov.gtQuality})`
					: "hover a point"}
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Fig. 3: the precision ladder
// ---------------------------------------------------------------------------------------------
type Rule = {
	id: string;
	name: string;
	rule: string;
	right: number | null;
	wrong: number;
	precision: string;
	note: string;
};
const RULES: Rule[] = [
	{
		id: "app",
		name: "App aligner",
		rule: "autoAlign accepts",
		right: 39,
		wrong: 19,
		precision: "0.64",
		note: "60 accepted poses on the 100-photo wild set: 39 correct, 19 confidently wrong. This is the baseline the later rules are measured against.",
	},
	{
		id: "c50",
		name: "Cascade ≥ 0.5",
		rule: "local-search bar",
		right: 25,
		wrong: 2,
		precision: "0.93",
		note: "Fine around a trusted compass; too loose once yaw is unknown.",
	},
	{
		id: "c75",
		name: "Cascade ≥ 0.75",
		rule: "yaw-unknown gate",
		right: 22,
		wrong: 0,
		precision: "1.00",
		note: "The two wrong accepts sat in the 0.5 to 0.75 band. Raising the bar removes them and costs 3 correct poses; escalation recovers 2 of those 3.",
	},
	{
		id: "fused",
		name: "Fused HIGH",
		rule: "render-and-match, HIGH",
		right: 30,
		wrong: 1,
		precision: "0.97",
		note: "One gross error in 31 HIGH poses, and it had no GPS fix and no independent agreement.",
	},
	{
		id: "product",
		name: "Product rule",
		rule: "HIGH and (GPS or cascade within 0.5°)",
		right: 20,
		wrong: 0,
		precision: "1.00",
		note: "20 of 20 correct (16 of 16 before the cascade re-run on Mapterhorn). Recall is the price: fused HIGH alone had 30 correct against 1 wrong, and in the v2 run the rule gave up 14 of those correct accepts to avoid the one wrong one. Everything else becomes “please confirm”.",
	},
];

function Dots({ r, t0 }: { r: Rule; t0: number }) {
	const dots: { bad: boolean }[] = [
		...Array.from({ length: r.right ?? 0 }, () => ({ bad: false })),
		...Array.from({ length: r.wrong }, () => ({ bad: true })),
	];
	return (
		<div className="flex flex-wrap gap-[6px]" aria-hidden>
			{dots.map((d, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: positional dots
					key={`${r.id}${i}`}
					className="atl-dot block h-[14px] w-[14px] rounded-full"
					style={{
						background: d.bad ? BAD : "var(--accent)",
						opacity: d.bad ? 1 : 0.8,
						boxShadow: d.bad
							? `0 0 0 ${2 + 2 * Math.sin(t0 * 4 + i)}px ${BAD}44`
							: undefined,
						animationDelay: `${i * 18}ms`,
					}}
				/>
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
			label="Fig. 3"
			bleed
			caption="Five accept rules on the same 100 blind-verified photos (reports/bench-wild.md; rows come from the v2 verification and the Mapterhorn cascade re-run, so each is a count of accepted poses under that rule). Accent dots are correct accepts, red are confident wrong ones. Tighten the rule and the red disappears; the cost is how many dots remain."
		>
			<div ref={ref}>
				<style>{`
					@keyframes atl-pop { from { transform: scale(0); opacity: 0 } to { transform: scale(1) } }
					.atl-dot { animation: atl-pop .35s cubic-bezier(.2,.9,.3,1.3) both }
					@media (prefers-reduced-motion: reduce) { .atl-dot { animation: none } }
				`}</style>
				<div className="flex flex-wrap gap-2">
					{RULES.map((x, i) => (
						<button
							key={x.id}
							type="button"
							onClick={() => setManual(i)}
							aria-pressed={i === idx}
							className="rounded-full px-3 py-1.5 text-xs transition"
							style={{
								background:
									i === idx ? "var(--accent)" : "rgba(255,255,255,.06)",
								color: i === idx ? "var(--rigi-ink)" : "rgba(236,230,218,.75)",
								fontWeight: i === idx ? 600 : 400,
							}}
						>
							{i + 1}. {x.name}
						</button>
					))}
					{manual !== null && (
						<button
							type="button"
							onClick={() => setManual(null)}
							className="px-2 py-1.5 text-xs text-white/50 underline"
						>
							autoplay
						</button>
					)}
				</div>

				<div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-[minmax(0,1fr)_190px]">
					<div className="min-h-[120px]">
						<div className="mb-3 font-mono text-[11px] uppercase tracking-wider text-white/45">
							{r.rule}
						</div>
						<Dots key={r.id} r={r} t0={t} />
						<p className="mt-4 text-sm leading-relaxed text-white/70">
							{r.note}
						</p>
					</div>
					<div className="flex flex-row items-end gap-6 sm:flex-col sm:items-start sm:gap-4">
						<Stat value={r.precision} label="precision" />
						<Stat value={String(r.wrong)} label="wrong accepts" />
						<div className="w-full min-w-[110px]" aria-hidden>
							<div className="h-2 overflow-hidden rounded-full bg-white/10">
								<div
									className="h-full rounded-full transition-all duration-700 motion-reduce:transition-none"
									style={{
										width: `${p * 100}%`,
										background: p >= 1 ? "var(--accent)" : BAD,
									}}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Fig. 2: the verdict tree of integration/second-opinion.ts, with the matcher's product rule
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
	{ k: "cascade", label: "cascade accepted" },
	{ k: "agree", label: "app accepted, Δyaw ≤ 1°" },
	{ k: "escalate", label: "shouldEscalate" },
	{ k: "high", label: "matcher HIGH" },
	{ k: "gps", label: "EXIF GPS trusted" },
	{ k: "near", label: "cascade within 0.5°" },
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
		text: "cascade accepted?",
		sub: "re-solve from compass + gravity",
	},
	{ id: "q2", x: 232, y: 58, w: QW, text: "app accepted and |Δyaw| ≤ 1°?" },
	{
		id: "q3",
		x: 14,
		y: 150,
		w: QW,
		text: "shouldEscalate?",
		sub: "skyline < 0.5, or solvers differ > 1°",
	},
	{ id: "q4", x: 14, y: 232, w: QW, text: "matcher confidence HIGH?" },
	{
		id: "q5",
		x: 232,
		y: 232,
		w: QW,
		text: "GPS trusted or cascade within 0.5°?",
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
		label: "refined: cascade pose",
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
			label="Fig. 4"
			bleed
			caption="The verdict table at the top of src/lib/integration/second-opinion.ts, with the matcher branch from matchAccepted() in src/lib/matcher-client.ts. It cycles through typical cases; switch any input to trace your own path. Only matched and verified poses are shown as certain: every other branch ends in a pose the user is asked to confirm, or the app pose with no badge. (A cascade that has not finished within 20 s also keeps the app pose, with no badge.)"
		>
			<div ref={ref}>
				<div className="mb-4 flex flex-wrap gap-2">
					{TOGGLES.map((tg) => (
						<button
							key={tg.k}
							type="button"
							onClick={() => flip(tg.k)}
							aria-pressed={inp[tg.k]}
							className="rounded-full px-3 py-1.5 text-xs transition"
							style={{
								background: inp[tg.k]
									? "var(--accent)"
									: "rgba(255,255,255,.06)",
								color: inp[tg.k] ? "var(--rigi-ink)" : "rgba(236,230,218,.65)",
								fontWeight: inp[tg.k] ? 600 : 400,
							}}
						>
							{tg.label}
						</button>
					))}
					{custom && (
						<button
							type="button"
							onClick={() => setCustom(null)}
							className="px-2 py-1.5 text-xs text-white/50 underline"
						>
							autoplay
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
								<polyline
									points={e.pts.map((p) => p.join(",")).join(" ")}
									fill="none"
									stroke={act ? "var(--accent)" : "rgba(236,230,218,.18)"}
									strokeWidth={act ? 2.4 : 1.2}
									strokeLinejoin="round"
								/>
								{e.label && (
									<text
										x={e.lx}
										y={e.ly}
										fontSize="10"
										textAnchor="middle"
										fill={act ? "var(--accent)" : "rgba(236,230,218,.35)"}
										fontFamily="ui-monospace, monospace"
									>
										{e.label}
									</text>
								)}
							</g>
						);
					})}
					{NODES.map((n) => {
						const act =
							res.path.includes(n.id) || res.path.includes(`${n.id}n`);
						return (
							<g key={n.id}>
								<rect
									x={n.x}
									y={n.y}
									width={n.w}
									height={NH}
									rx="10"
									fill={act ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.03)"}
									stroke={act ? "var(--accent)" : "rgba(236,230,218,.18)"}
								/>
								<text
									x={n.x + 10}
									y={n.y + (n.sub ? 18 : 26)}
									fontSize="11.5"
									fill="var(--rigi-paper)"
									fillOpacity={act ? 1 : 0.6}
								>
									{n.text}
								</text>
								{n.sub && (
									<text
										x={n.x + 10}
										y={n.y + 33}
										fontSize="9"
										fill="var(--rigi-paper)"
										fillOpacity={act ? 0.6 : 0.3}
									>
										{n.sub}
									</text>
								)}
							</g>
						);
					})}
					{OUT.map((o) => {
						const act = res.verdict === o.v && on.has(o.id);
						const good = o.v === "verified" || o.v === "matched";
						const col = act
							? good
								? "var(--accent)"
								: BAD
							: "rgba(236,230,218,.18)";
						return (
							<g key={o.id}>
								<rect
									x={o.x}
									y={o.y}
									width={OW}
									height={NH - 8}
									rx={(NH - 8) / 2}
									fill={
										act
											? good
												? "var(--accent)"
												: `${BAD}33`
											: "rgba(255,255,255,.02)"
									}
									stroke={col}
								/>
								<text
									x={o.x + OW / 2}
									y={o.y + 22}
									textAnchor="middle"
									fontSize="10.5"
									fontWeight={act ? 600 : 400}
									fill={act && good ? "var(--rigi-ink)" : "var(--rigi-paper)"}
									fillOpacity={act ? 1 : 0.45}
								>
									{o.label}
								</text>
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
							<circle cx={pos[0]} cy={pos[1]} r="4" fill="var(--rigi-paper)" />
						);
					})()}
					<text
						x="14"
						y="30"
						fontSize="10"
						fill="var(--rigi-paper)"
						fillOpacity=".4"
						fontFamily="ui-monospace, monospace"
					>
						AFTER FIRST PAINT: SECOND OPINION
					</text>
				</svg>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------

const GATES: [string, string, string][] = [
	["acceptConfidence 0.5", "src/lib/geo/solve.ts", "local ±yaw search"],
	["FULL_SEARCH_CONFIDENCE 0.75", "src/lib/geo/solve.ts", "360° retry bar"],
	[
		"YAW_UNKNOWN / FOCAL_UNKNOWN 0.75",
		"src/lib/integration/unknown-pose.worker.ts",
		"cascade when heading or focal unknown",
	],
	[
		"score ≥ 0.5, inlier ≥ 0.3, slope ≥ 0.015",
		"src/lib/refine/confidence.ts",
		"product of six ramps, two hard gates",
	],
	[
		"MIN_CONFIDENCE 0.5",
		"src/lib/concord/app/confidence.ts",
		"LOW unless explicitly accepted",
	],
	[
		"AGREE_DEG 1°, MATCH_AGREE_DEG 0.5°",
		"src/lib/integration/second-opinion.ts",
		"verified vs refined; match vs cascade",
	],
	[
		"isAutoHigh()",
		"src/lib/picker/candidates.ts",
		"user picks and pins are never HIGH",
	],
	[
		"TAP_MAX_PX 12, DEDUPE_DEG 0.5°",
		"src/lib/picker/candidates.ts",
		"tap-consistent ranking, same-basin merge",
	],
];

function Legacy() {
	return (
		<>
			<Section title="Fail closed" kicker="The rule">
				<p>
					A pose that is wrong and shown as certain is worse than no pose at
					all: it draws a confident overlay on the wrong mountains. So the
					product has one policy, applied at every layer: a pose is HIGH only if
					something <em>explicitly</em> accepted it and its confidence clears a
					bar, and every other state (missing, rejected, suggested, picked by
					hand) falls to LOW. The solver’s own gating is on{" "}
					<Link
						to={atlasHref("viewport-inference")}
						className="underline decoration-white/25"
					>
						Viewport Inference
					</Link>
					; this page is the layer above it, which decides what the user is
					allowed to see as certain.
				</p>
			</Section>

			<RealDecisions />

			<Section
				title="Why 0.5, and why more when less is known"
				kicker="Measured"
			>
				<p>
					The bar is not a taste. On the 14 photos with a hand registration,
					every pose the cascade accepted is within half a degree of the truth,
					and the rejected side holds the real failures. The price is visible
					too: a correct pose just under the line is thrown away.
				</p>
			</Section>

			<ConfidenceVsError />

			<Section title="How it works" kicker="Mechanism">
				<Steps
					steps={[
						{
							title: "Soft evidence, hard gates",
							body: (
								<>
									The refine confidence is six smoothstep ramps (yaw-correlation
									peak, runner-up mode ratio, inlier fraction,
									correlation-inflated σ, skyline slope, RMS residual)
									multiplied together. One weak term drags the product down;
									accept needs <code>score ≥ 0.5</code> and two hard floors
									(inlier ≥ 0.3, slope ≥ 0.015). Each rejection carries a human
									reason string.
								</>
							),
						},
						{
							title: "A higher bar when less is known",
							body: (
								<>
									With a trusted compass the search is ±25° and 0.5 suffices.
									When yaw or focal is unknown, the search is over every
									heading, wrong basins are far likelier, and the bar becomes
									0.75. On the wild set that single change took the cascade from
									25 correct and 2 wrong accepts to 22 and 0 (Fig. 3).
								</>
							),
						},
						{
							title: "Two solvers must not disagree",
							body: (
								<>
									After first paint, the CPU cascade re-solves independently of
									the GPU aligner. Agreement within 1° keeps the pose
									(“verified”); a confident cascade that disagrees wins
									(“refined”). The aligner alone made one confident wrong accept
									on the ground-truth set; the cascade made none.
								</>
							),
						},
						{
							title: "Escalate, then demand independent evidence",
							body: (
								<>
									If the skyline is weak, <code>shouldEscalate()</code> sends
									the photo to render-and-match. Even a HIGH match is applied
									only when the position is a trusted EXIF GPS fix or the
									cascade lands within 0.5° (<code>matchAccepted</code>). A
									match that stands alone becomes “unverified”, and the user is
									asked.
								</>
							),
						},
						{
							title: "Suggestions are not accepts",
							body: (
								<>
									The top-3 picker and tapped peaks produce candidates, never
									acceptance: <code>isAutoHigh</code> is true only for an
									automatic, verified accept. A pose the user picks (“manual”)
									or pins is never HIGH, and re-solving from taps is the{" "}
									<Link
										to={atlasHref("tap-a-peak")}
										className="underline decoration-white/25"
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

			<Section title="In the code" kicker="Gates">
				<p>
					About a dozen thresholds, each set by hand against a benchmark and
					none a likelihood: they are bars chosen so that the measured
					wrong-accept count on blind-verified photos is zero, not
					probabilities.
				</p>
				<div className="my-6 overflow-hidden rounded-2xl ring-1 ring-white/10">
					{GATES.map(([gate, path, what]) => (
						<div
							key={gate}
							className="flex flex-col gap-1 border-b border-white/10 px-4 py-3 last:border-0 sm:flex-row sm:items-baseline sm:gap-4"
						>
							<code
								className="shrink-0 text-[13px] sm:w-[19rem]"
								style={{ color: "var(--accent)" }}
							>
								{gate}
							</code>
							<span className="flex-1 text-sm text-white/65">{what}</span>
							<CodeRef path={path} />
						</div>
					))}
				</div>
				<Callout tone="lesson">
					Precision first costs recall on purpose. The product rule leaves 14
					correct poses on the table in the v2 run to avoid one wrong one; they
					go to “please confirm” rather than being lost.
				</Callout>
			</Section>

			<Section title="Where it fits" kicker="Neighbourhood">
				<p>
					The accept rule constrains{" "}
					<Link
						to={atlasHref("pose-estimate")}
						className="underline decoration-white/25"
					>
						Pose Estimate
					</Link>{" "}
					and gates{" "}
					<Link
						to={atlasHref("viewport-inference")}
						className="underline decoration-white/25"
					>
						Viewport Inference
					</Link>
					; a rejected solve hands over to{" "}
					<Link
						to={atlasHref("tap-a-peak")}
						className="underline decoration-white/25"
					>
						Tap a Peak
					</Link>
					.
				</p>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front page (the figures above are folded into Details, except the precision ladder)
// ======================================================================================
const SOLVED_C = "#5ee0f4";
const WEAK = "#ff7a66";

/** One written reason per photo, from the stored solve record. */
function reason(d: AtlasPhotoData): string {
	const s = d.solved;
	const fit = `${(100 * s.inlierFraction).toFixed(0)}% of columns fit`;
	if (s.stage === "refine")
		return `solve refused it; the second solver took it at ${s.confidence.toFixed(2)}, ${fit}`;
	if (!s.accepted)
		return `confidence ${s.confidence.toFixed(2)}, under 0.5: only ${fit}`;
	return `confidence ${s.confidence.toFixed(2)}, ${fit}`;
}

/** Hero: a rejected photo up close, where the fit looks close but is not proven. */
function HeroReject() {
	const d = useAtlasPhoto("demo-11");
	const spots = useMemo(() => {
		if (!d) return null;
		const gap = (x: number) => {
			const a = d.skyline.rows[x];
			const b = d.solvedRows[x];
			return a == null || b == null || d.skyline.weight[x] < 0.3
				? null
				: Math.abs(a - b);
		};
		// the confident column where the two lines are furthest apart
		let best = -1;
		let bx = 0;
		for (let x = 0; x < d.skyline.rows.length; x++) {
			const e = gap(x);
			if (e != null && e > best) {
				best = e;
				bx = x;
			}
		}
		const rx = Math.round(d.photo.width * 0.82);
		return {
			far: { x: bx, y: d.skyline.rows[bx] as number, gap: best },
			near: { x: rx, y: d.skyline.rows[rx] as number, gap: gap(rx) ?? 0 },
		};
	}, [d]);
	return (
		<Figure
			caption={
				<>
					{d
						? `Rejected: confidence ${d.solved.confidence.toFixed(2)} against a bar of 0.5. Only ${(100 * d.solved.inlierFraction).toFixed(0)}% of columns land within 4 px.`
						: "Rejected: the fit is too weak to call certain."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<div>
				<RealPhoto
					data={d}
					layers={["skyline", "solved"]}
					crop={d ? skylineBand(d, 280) : undefined}
					className="w-full"
				>
					{() =>
						spots ? (
							<g>
								<Mark
									x={spots.far.x}
									y={spots.far.y - 30}
									n={1}
									k={1.3}
									color="#f4d35e"
								/>
								<Mark
									x={spots.near.x}
									y={spots.near.y - 30}
									n={2}
									k={1.3}
									color={SOLVED_C}
								/>
							</g>
						) : null
					}
				</RealPhoto>
			</div>
			{spots && (
				<MarkList
					items={[
						<>
							<span style={{ color: "#f4d35e" }}>Photo's skyline</span> and{" "}
							<span style={{ color: SOLVED_C }}>map's skyline</span> drift up to{" "}
							{spots.far.gap.toFixed(0)} px apart here.
						</>,
						<>
							Here they agree within {Math.max(1, Math.ceil(spots.near.gap))}{" "}
							px, even though hair reaches the ridge.
						</>,
					]}
				/>
			)}
		</Figure>
	);
}

function Verdicts() {
	return (
		<Figure
			label="Fig. 1"
			caption="Twelve real photos, twelve decisions: 10 shown as certain, 2 kept as guesses. Each tile says why."
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
							className="absolute top-1 left-1 rounded px-1 font-mono text-[9.5px] text-black"
							style={{ background: d.solved.accepted ? SOLVED_C : WEAK }}
						>
							{d.id.slice(-2)} · {d.solved.accepted ? "accepted" : "guess"}
						</span>
					</div>
				)}
				label={(d) => reason(d)}
			/>
			<p className="mt-2 font-mono text-[10.5px] text-white/40">
				Measured on the 12 demo photos by scripts/atlas/build-data.ts,
				2026-10-01.
			</p>
		</Figure>
	);
}

/** Step 1 visual: the confidence factors of the rejected photo. */
function FactorBars() {
	const d = useAtlasPhoto("demo-11");
	const fx = d ? solveFactors(d) : null;
	return (
		<div className="aspect-[4/3] space-y-2 bg-black/30 p-4">
			{fx?.f.map((x) => (
				<div key={x.k}>
					<div className="flex justify-between font-mono text-[10px] text-white/60">
						<span>{x.k}</span>
						<span>{x.v.toFixed(2)}</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-white/10">
						<div
							className="h-full rounded-full"
							style={{
								width: `${x.v * 100}%`,
								background: x.v < 1 ? WEAK : "var(--accent)",
							}}
						/>
					</div>
				</div>
			))}
			<div className="pt-1 font-mono text-[10px] text-white/50">
				demo-11: one weak check lowers the product
			</div>
		</div>
	);
}

/** Step 2 visual: the 12 confidences on a vertical scale with the two bars. */
function BarScale() {
	const idx = useAtlasIndex();
	const Hh = 100;
	const y = (v: number) => 8 + (1 - v) * (Hh - 16);
	return (
		<svg
			viewBox="0 0 160 100"
			className="block aspect-[4/3] w-full bg-black/30"
			role="img"
			aria-label="Solve confidence of the 12 demo photos against the 0.5 and 0.75 bars"
		>
			{[0.5, 0.75].map((v) => (
				<g key={v}>
					<line
						x1={26}
						x2={156}
						y1={y(v)}
						y2={y(v)}
						stroke="#ece6da"
						strokeOpacity={0.6}
						strokeDasharray="4 3"
					/>
					<text
						x={4}
						y={y(v) + 3}
						fontSize={9}
						fill="#ece6da"
						fillOpacity={0.7}
						fontFamily="ui-monospace, monospace"
					>
						{v.toFixed(2)}
					</text>
				</g>
			))}
			{idx?.photos.map((p, i) => (
				<circle
					key={p.id}
					cx={36 + i * 10.4}
					cy={y(p.confidence)}
					r={3.4}
					fill={p.accepted ? SOLVED_C : WEAK}
				/>
			))}
		</svg>
	);
}

/** Step 3 visual: two independent solvers on one photo. */
function TwoSolvers() {
	const d = useAtlasPhoto("demo-01");
	return (
		<div className="flex aspect-[4/3] flex-col justify-center gap-1 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed text-white/70">
			{d?.app && (
				<>
					<div>
						app aligner{" "}
						<span className="text-white">{d.app.yaw.toFixed(1)}°</span>
					</div>
					<div>
						skyline solve{" "}
						<span className="text-white">{d.solved.yaw.toFixed(1)}°</span>
					</div>
					<div
						className="mt-1 border-t border-white/15 pt-1"
						style={{ color: SOLVED_C }}
					>
						within 1°: keep it
					</div>
				</>
			)}
		</div>
	);
}

function AcceptRule({ node: _node }: { node: AtlasNode }) {
	const idx = useAtlasIndex();
	const acc = idx ? idx.photos.filter((p) => p.accepted).length : null;
	const A = (id: string, label: string) => (
		<Link
			to={atlasHref(id)}
			className="underline decoration-white/30 underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<Verdicts />

			<Beat kicker="The idea" title="A wrong pose is worse than no pose.">
				<p>
					A wrong pose draws confident names on the wrong mountains. A missing
					pose just asks the user to tap a peak.
				</p>
				<p>
					So Rigi calls a pose certain only if a solver accepted it and its
					confidence clears a bar. Everything else is a guess, and says so. Even
					a pose that looks right can be refused.
				</p>
			</Beat>

			<HeroReject />

			<Beat
				kicker="How it works"
				title="Several checks, one bar, a second opinion."
			>
				<Trio
					steps={[
						{
							title: "Score the fit",
							body: "Four checks multiply into one number. One weak check sinks it.",
							visual: <FactorBars />,
						},
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

			<Beat
				kicker="Where it fails"
				title="The price is correct poses we do not show."
			>
				<p>
					Tighter rules throw away good answers on purpose. Each dot below is
					one of 100 photos with a known right answer.
				</p>
			</Beat>

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
						label: "correct poses kept: fused HIGH alone vs product rule",
					},
					{
						value: acc == null ? "…" : `${acc} / 12`,
						label: "demo photos accepted by the solve cascade",
					},
				]}
				source="First three: reports/bench-wild.md (100 blind-verified photos, 2026-09-25 re-run). Last: measured on the 12 demo photos."
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {A("viewport-inference", "viewport inference")} makes the fit this
				rule judges. A refused pose hands over to{" "}
				{A("tap-a-peak", "tap a peak")}.
			</p>

			<Details>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(AcceptRule);
