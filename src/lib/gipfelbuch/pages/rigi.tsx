// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CircledKey } from "#/components/gipfelbuch/notebook/carto";
import {
	Hachure,
	HandText,
	type InkColor,
	inkColor,
	PenArrow,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	HandMark,
	PencilLayer,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	CodeRef,
	Figure,
	type GipfelbuchPhotoData,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	LiveHowItWorks,
	MarginNote,
	Measured,
	PhotoStory,
	RealPhoto,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { byId, gipfelbuchHref, groupColor } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Rigi, the whole story on one page: photo in, pose out, what you get.
// Real data: the 12 Niederhorn photos (scripts/gipfelbuch/build-data.ts). Numbers quoted without measurement come
// from reports/status.md (eval-app 12/14, 0 false accepts) and reports/test-results.md (17/17 HIGH).
// The synthetic registration figure and the stage map live in Details.

/* ───────── Hero: the registration, made visible ───────── */

const W = 800;
const H = 330;
// SVG labels land on the type scale at ~720 px rendered width (viewBox W units per rendered px).
const LABEL_SMALL = (11 * W) / 720;
const LABEL = (13 * W) / 720;

const BASE = 262;
const PX_PER_DEG = 13;

/** A deterministic ridgeline, in px above BASE, as a function of horizontal px. */
function ridge(x: number): number {
	return (
		92 +
		46 * Math.sin(x / 71 + 0.6) +
		30 * Math.sin(x / 33 + 2.1) +
		16 * Math.sin(x / 15.5 + 0.3) +
		7 * Math.sin(x / 7.3 + 1.4)
	);
}

function path(offsetPx: number, close = false): string {
	let d = "";
	for (let x = 0; x <= W; x += 4) {
		const y = BASE - ridge(x - offsetPx);
		d += `${x === 0 ? "M" : "L"}${x},${y.toFixed(1)}`;
	}
	return close ? `${d}L${W},${BASE}L0,${BASE}Z` : d;
}

const smooth = (u: number) => u * u * (3 - 2 * u);

function Registration() {
	const [ref, t] = useTime<HTMLDivElement>();
	const reduced = useReducedMotion();
	const [manual, setManual] = useState<number | null>(null);

	// Auto cycle: start 3.4 deg off, converge, hold, then drift away again.
	const ph = (t % 9) / 9;
	const auto = reduced
		? 0.4
		: ph < 0.5
			? 3.4 * (1 - smooth(ph / 0.5))
			: ph < 0.75
				? 0.05 * Math.sin(t * 6)
				: 3.4 * smooth((ph - 0.75) / 0.25);
	const off = manual ?? auto;
	const px = off * PX_PER_DEG;
	const ok = Math.abs(off) <= 1;
	const resid = Math.abs(off) * PX_PER_DEG;
	const tone: InkColor = ok ? "forest" : "red";
	const photoPath = useMemo(() => path(0), []);
	const rockPath = useMemo(() => path(0, true), []);
	const candidatePath = path(px);
	// Residual: the band between the two skylines, as a filled translucent area.
	let residual = "";
	for (let x = 0; x <= W; x += 4)
		residual += `${x === 0 ? "M" : "L"}${x},${(BASE - ridge(x)).toFixed(1)}`;
	for (let x = W; x >= 0; x -= 4)
		residual += `L${x},${(BASE - ridge(x - px)).toFixed(1)}`;
	residual += "Z";

	return (
		<div ref={ref}>
			<div className="relative overflow-hidden">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="A photographed skyline and the DEM horizon being aligned"
				>
					{/* pencil construction: the guide lines the ridge was laid out on */}
					<PencilLayer>
						<PenLine
							seed="rigi-guide-top"
							from={[0, BASE - 150]}
							to={[W, BASE - 150]}
							color="pencil"
							width={0.8}
						/>
						<PenLine
							seed="rigi-guide-mid"
							from={[0, BASE - 92]}
							to={[W, BASE - 92]}
							color="pencil"
							width={0.8}
						/>
						{[1, 3, 5, 7, 9, 11].map((i) => (
							<PenLine
								key={`guide-${i}`}
								seed={`rigi-guide-v${i}`}
								from={[40 + i * 60, BASE - 150]}
								to={[40 + i * 60, BASE]}
								color="pencil"
								width={0.7}
							/>
						))}
					</PencilLayer>
					<Hachure
						d={rockPath}
						seed="rigi-rock"
						color="pencil"
						angle={-45}
						gap={7}
						opacity={0.3}
						width={0.7}
					/>
					{/* the residual band: a wash, red when off, forest when within 1 degree */}
					<Wash d={residual} seed="rigi-residual" color={tone} opacity={0.12} />
					{/* measured lines stay on their pixels: one pen pass each */}
					<SketchPath
						d={photoPath}
						seed="rigi-photo-skyline"
						data
						color="ink"
						width={2.2}
					/>
					<SketchPath
						d={candidatePath}
						seed="rigi-candidate"
						data
						color={LAYER_STYLE.solved.color}
						width={2.8}
					/>
					{/* ground strip: the DEM-side readout */}
					<PenLine
						seed="rigi-base"
						from={[0, BASE]}
						to={[W, BASE]}
						color="pencil"
						width={1.2}
					/>
					{/* degree ruler */}
					{Array.from({ length: 13 }, (_, i) => {
						const x = 40 + i * 60;
						return (
							<g key={x}>
								<PenLine
									seed={`rigi-tick-${i}`}
									from={[x, BASE]}
									to={[x, BASE + (i % 2 ? 5 : 9)]}
									color="pencil"
									width={1}
								/>
								{i % 2 === 0 && (
									<HandLabel
										x={x}
										y={BASE + 22}
										anchor="middle"
										size={LABEL_SMALL}
										color={inkColor("faint")}
									>
										{`${(((i - 6) * 60) / PX_PER_DEG).toFixed(0)}°`}
									</HandLabel>
								)}
							</g>
						);
					})}
					{/* legend */}
					<PenLine
						seed="rigi-key-photo"
						from={[16, 22]}
						to={[40, 22]}
						color="ink"
						width={2.2}
					/>
					<HandLabel x={48} y={27} size={LABEL} color="var(--gb-secondary)">
						photo skyline (segmented)
					</HandLabel>
					<PenLine
						seed="rigi-key-dem"
						from={[16, 42]}
						to={[40, 42]}
						color={LAYER_STYLE.solved.color}
						width={2.8}
					/>
					<HandLabel x={48} y={47} size={LABEL} color="var(--gb-secondary)">
						DEM horizon at the candidate pose
					</HandLabel>
					{/* verdict */}
					<HandLabel
						x={W - 16}
						y={27}
						size={LABEL}
						anchor="end"
						color={tone === "forest" ? "var(--gb-forest)" : "var(--gb-red)"}
					>
						{ok ? "within 1°: show it" : "off: don't claim"}
					</HandLabel>
					<HandLabel x={16} y={H - 10} size={LABEL} color="var(--gb-secondary)">
						yaw error {off.toFixed(2)}° ≈ {resid.toFixed(0)} px at this field of
						view
					</HandLabel>
					{/* hand notes with leaders */}
					<HandText x={470} y={92} size={19} color="pencil" rotate={-2}>
						the band between the lines is the error
					</HandText>
					<PenArrow
						seed="rigi-note-band"
						from={[560, 100]}
						to={[600, BASE - ridge(600) - 6]}
						color="pencil"
						width={1.1}
					/>
					<HandText x={300} y={H - 12} size={19} color="pencil" rotate={1.5}>
						{ok ? "lines coincide: accepted ✓" : "why does 3° look so big?"}
					</HandText>
					<CircledKey x={W - 30} y={62} value={1} seed="rigi-key-1" />
				</svg>
			</div>
			<div className="mt-4 flex min-w-0 max-w-full flex-wrap items-center gap-3 font-mono text-[13px] gb-secondary">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<span className="shrink-0">yaw error</span>
					<HandRange
						value={off}
						min={-4}
						max={4}
						step={0.05}
						label="Yaw error in degrees"
						onChange={setManual}
					/>
				</div>
				<button
					type="button"
					onClick={() => setManual(null)}
					disabled={manual === null}
					className="bg-[var(--gb-paper-deep)] px-3 py-1 text-[var(--gb-ink)] hover:brightness-95 disabled:opacity-60"
				>
					{manual === null ? "auto-solving" : "resume solve"}
				</button>
			</div>
		</div>
	);
}
/* ───────── Constellation: the subsystems, by stage ───────── */

interface Stage {
	key: string;
	label: string;
	blurb: string;
	ids: string[];
}
const STAGES: Stage[] = [
	{
		key: "capture",
		label: "1 · Capture",
		blurb: "A photo, and what the phone recorded about it.",
		ids: ["photo", "camera-prior", "dem-source", "terrain-sampler"],
	},
	{
		key: "solve",
		label: "2 · Solve",
		blurb: "Match the photographed skyline to the DEM horizon.",
		ids: [
			"viewport-inference",
			"skyline",
			"dem-horizon",
			"baseline-pipeline",
			"pose-estimate",
		],
	},
	{
		key: "judge",
		label: "3 · Snap and judge",
		blurb: "Pin everything to the ground, and decide what is safe to show.",
		ids: ["terrain-snapping", "eye-rule", "peak", "accept-rule", "tap-a-peak"],
	},
	{
		key: "show",
		label: "4 · Look through it",
		blurb: "Use the pose: labels, drape, roll, near field.",
		ids: ["photo-workspace", "camera-roll", "step-inside", "dem-anchoring"],
	},
];

function Constellation({ accent }: { accent: string }) {
	const [i, setI] = useState(1);
	const st = STAGES[i];
	return (
		<div>
			<div role="tablist" className="flex flex-wrap gap-2">
				{STAGES.map((s, k) => (
					<button
						key={s.key}
						type="button"
						role="tab"
						aria-selected={k === i}
						onClick={() => setI(k)}
						className="px-3.5 py-1.5 font-mono text-[13px] transition"
						style={
							k === i
								? {
										background: `${accent}26`,
										color: accent,
										boxShadow: `inset 0 -2px 0 ${accent}`,
									}
								: {
										color: "var(--gb-ink)",
										background: "var(--gb-paper-deep)",
									}
						}
					>
						{s.label}
					</button>
				))}
			</div>
			<p className="mt-4 text-[13px] gb-secondary">{st.blurb}</p>
			<ul className="mt-4 grid list-none gap-3 !pl-0 sm:grid-cols-2">
				{st.ids.map((id) => {
					const n = byId.get(id);
					if (!n) return null;
					return (
						<li key={id} className="!pl-0">
							<Link
								to={gipfelbuchHref(id)}
								className="block h-full bg-[var(--gb-paper-deep)] px-4 py-3 transition hover:brightness-95"
							>
								<span className="font-semibold text-[var(--gb-ink)]">
									{n.title}
								</span>
								<span className="ml-2 font-mono text-[11px] tracking-wider gb-secondary uppercase">
									{n.status}
								</span>
								<span className="mt-1 block text-[13px] leading-snug gb-secondary">
									{n.tagline}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

const A = ({ id, children }: { id: string; children: React.ReactNode }) =>
	byId.has(id) ? <Link to={gipfelbuchHref(id)}>{children}</Link> : children;

/** Hero: one real photo, the alignment written on it in four steps (guess, measure, correct, snap). */
function HeroStages() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const crop = useMemo(() => (d ? skylineBand(d, 360) : undefined), [d]);
	const yaw = d ? Math.abs(d.solved.delta.yaw).toFixed(1) : null;
	return (
		<PhotoStory
			number="Fig. 1"
			crop={crop}
			caption={
				<>
					{d
						? `On this photo the phone's compass was ${yaw}° off; the median gap to the skyline falls from ${d.residual.prior.median.toFixed(1)} to ${d.residual.solved.median.toFixed(1)} px.`
						: "One real photo, four steps."}{" "}
					<Measured data={d} />
				</>
			}
		/>
	);
}

/** Wipe between the phone's guess and the solved pose, pixel-aligned. */
function GuessVsSolved() {
	const d = useGipfelbuchPhoto("demo-03");
	const crop = useMemo(() => (d ? skylineBand(d, 360) : undefined), [d]);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					{d
						? `Dragging across, the median gap to the skyline falls from ${d.residual.prior.median.toFixed(1)} to ${d.residual.solved.median.toFixed(1)} pixels.`
						: "Drag to compare."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Compare
				beforeLabel="phone's guess"
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

/** Crop to the ridge itself so foreground people stay out, except where a head on the skyline is the point. */
function tightBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	if (["demo-07", "demo-11", "demo-12"].includes(d.id))
		return skylineBand(d, 280);
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return skylineBand(d, 280);
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const y0 = Math.max(0, lo - 70);
	const y1 = Math.min(d.photo.height, Math.max(hi + 40, y0 + 200));
	return [0, Math.round(y0), d.photo.width, Math.round(y1)];
}

const ROLL_IDS = [
	"demo-01",
	"demo-02",
	"demo-03",
	"demo-04",
	"demo-05",
	"demo-06",
	"demo-07",
	"demo-08",
	"demo-09",
	"demo-10",
	"demo-11",
	"demo-12",
] as const;

function Outcomes() {
	const d = useGipfelbuchPhoto("demo-03");
	const crop = useMemo(() => (d ? skylineBand(d, 300) : undefined), [d]);
	return (
		<Trio
			steps={[
				{
					title: "Named peaks",
					body: "Labels sit on the photo, on the right summits.",
					visual: (
						<RealPhoto data={d} layers={["peaks"]} crop={crop} maxLabels={6} />
					),
				},
				{
					title: "A day on a map",
					body: "Twelve photos land on the terrain they saw.",
					visual: (
						<img
							src="/demo/shots/drape.jpg"
							alt="Twelve photos draped on the 3D terrain of the Niederhorn"
							className="block h-auto w-full"
						/>
					),
				},
				{
					title: "Step inside",
					body: "Step inside: near ground lifted to 3D, seen from the camera's own eye.",
					visual: (
						<div className="relative">
							<img
								src="/demo/step/photo.jpg"
								alt="A hiker on the ridge, the near ground lifted into 3D"
								className="block h-auto w-full"
							/>
							<img
								src="/demo/gipfelbuch/step-inside/split.png"
								alt=""
								className="absolute inset-0 size-full"
							/>
						</div>
					),
				},
			]}
		/>
	);
}

function Twelve() {
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption="The same search on all 12 photos, solved skyline drawn on each. Two with a person in frame are marked ask."
		>
			<Gallery
				ids={ROLL_IDS}
				cols={4}
				tile={(d: GipfelbuchPhotoData) => (
					<RealPhoto data={d} layers={["solved"]} crop={tightBand(d)} />
				)}
				tone={(d) => (d.solved.accepted ? "result" : "failure")}
				label={(d) => (
					<span className="gb-num">
						{d.id.slice(-2)} · {d.residual.solved.median.toFixed(1)} px ·{" "}
						{d.solved.accepted
							? d.solved.stage === "refine"
								? "refined"
								: "ok"
							: "ask"}
					</span>
				)}
			/>
		</Figure>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	const accent = groupColor(node.group);
	const idx = useGipfelbuchIndex();
	const acc = idx ? idx.photos.filter((p) => p.accepted).length : null;
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="The skyline tells us where the camera stood."
			>
				<p>
					Every mountain photo has a{" "}
					<HandMark type="underline">skyline</HandMark>. The terrain model
					predicts one for any camera pose.
					<MarginNote mark="a">
						I notice the skyline is the only line both sides can draw.
					</MarginNote>
				</p>
				<p>
					<HandMark type="highlight">
						We search for the pose where the two lines overlap.
					</HandMark>{" "}
					Yaw, which way the camera points, is the part the phone gets wrong.
					<MarginNote mark="b">
						Yaw is what the compass gets wrong; the rest of the pose holds.
					</MarginNote>
				</p>
			</Beat>

			<GuessVsSolved />

			<Beat kicker="Watch it solve" title="Guess, measure, correct, snap.">
				<p>
					One real photo, six beats. Drag the terrain line afterwards to feel
					the match.
				</p>
			</Beat>

			<LiveHowItWorks
				number="Fig. 3"
				caption="The site's baked demo scene: the six beats of one real solve, on the dark plate. The terrain line is draggable."
			/>

			<Beat kicker="What you get" title="One pose unlocks three things.">
				<p>
					Once the camera is known,{" "}
					<HandMark type="double">everything else is drawing from it</HandMark>.{" "}
					<A id="photo-workspace">Labels</A>, a{" "}
					<A id="camera-roll">camera roll</A> on a map, and{" "}
					<A id="step-inside">stepping inside</A> the scene.
				</p>
			</Beat>

			<Outcomes />

			<Beat
				kicker="Where it fails"
				title="Rigi would rather say nothing than show a wrong pose."
			>
				<p>
					A person in the frame can break the match.{" "}
					<HandMark type="wavy">
						Two photos here were rejected as low confidence
					</HandMark>
					, and we ask you to confirm or to tap a peak.
					<MarginNote mark="c">
						Better a question than a wrong label: accepted only when sure.
					</MarginNote>
				</p>
			</Beat>

			<Twelve />

			<Numbers
				items={[
					{
						value: acc == null ? "…" : `${acc} / 12`,
						label: "demo photos accepted automatically",
					},
					{
						value: "12 / 14",
						label: "eval-app photos within 1° of the true heading",
					},
					{ value: "0", label: "false accepts in that eval" },
					{
						value: "17 / 17",
						label: "HIGH-confidence wild test photos correct (matcher service)",
					},
				]}
				source={
					<>
						Demo: measured. Eval and wild test: reports/status.md,
						reports/test-results.md.
					</>
				}
			/>

			<Details>
				<h3>How the core fits</h3>
				<p>
					The <A id="photo">photo</A> arrives with sensor metadata that becomes
					a <A id="camera-prior">camera prior</A>: a guess, never a fact. That
					prior seeds <A id="viewport-inference">viewport inference</A>, which
					compares the <A id="skyline">skyline</A> found in the image with the{" "}
					<A id="dem-horizon">horizon</A> the DEM predicts, in the browser, on
					the GPU where it is available (
					<A id="baseline-pipeline">baseline pipeline</A>
					). Around the solve, <A id="terrain-snapping">terrain snapping</A>{" "}
					pins the eye (<A id="eye-rule">eye rule</A>), summits (
					<A id="peak">peaks</A>) and depth (
					<A id="dem-anchoring">DEM anchoring</A>) to the ground. The{" "}
					<A id="accept-rule">accept rule</A> is frozen against a blind-verified
					benchmark; about a fifth of wild photos auto-accept
					(reports/status.md). <A id="tap-a-peak">Tapping a peak</A> is the
					manual route to a pose.
				</p>
				<h3>Schematic: the registration</h3>
				<Figure
					label="Fig. D1"
					caption="Synthetic ridge (not a photo). The 1° tick is the app's headline accuracy bar."
					bleed
				>
					<Registration />
				</Figure>
				<h3>The core nodes, by stage</h3>
				<Constellation accent={accent} />
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					{node.modules.map((m) => (
						<CodeRef key={m} path={m} />
					))}
					<CodeRef path="reports/status.md" />
					<CodeRef path="reports/test-results.md" />
				</div>
			</Details>
		</>
	);
}
