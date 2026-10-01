import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	type AtlasPhotoData,
	CodeRef,
	DemPatch,
	Figure,
	Measured,
	RealPhoto,
	useAtlasIndex,
	useAtlasPhoto,
	useReducedMotion,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Key,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import { HowItWorksScene } from "#/components/site/how/HowItWorksScene";
import { atlasHref, byId, groupColor } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

// Rigi, the whole story on one page: photo in, pose out, what you get.
// Real data: the 12 Niederhorn photos (scripts/atlas/build-data.ts). Numbers quoted without measurement come
// from reports/status.md (eval-app 12/14, 0 false accepts) and reports/test-results.md (17/17 HIGH).
// The synthetic registration figure and the stage map live in Details.

/* ───────── Hero: the registration, made visible ───────── */

const W = 800;
const H = 330;
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

function Registration({ accent }: { accent: string }) {
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
	const tone = ok ? "#8fc08a" : "#e69a8d";

	return (
		<div ref={ref}>
			<div className="relative overflow-hidden rounded-lg bg-[#0b0d0f]">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="A photographed skyline and the DEM horizon being aligned"
				>
					<defs>
						<linearGradient id="rg-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#1c2433" />
							<stop offset="1" stopColor="#4a4a52" />
						</linearGradient>
						<linearGradient id="rg-rock" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#262a2c" />
							<stop offset="1" stopColor="#101214" />
						</linearGradient>
						<pattern
							id="rg-hatch"
							width="6"
							height="6"
							patternUnits="userSpaceOnUse"
							patternTransform="rotate(45)"
						>
							<line x1="0" y1="0" x2="0" y2="6" stroke={tone} strokeWidth="2" />
						</pattern>
						<clipPath id="rg-clip">
							<rect x="0" y="0" width={W} height={BASE} />
						</clipPath>
					</defs>
					<rect width={W} height={BASE} fill="url(#rg-sky)" />
					<path d={path(0, true)} fill="url(#rg-rock)" />
					{/* residual: area between the two skylines */}
					<g clipPath="url(#rg-clip)" opacity={0.55}>
						{Array.from({ length: W / 4 }, (_, i) => {
							const x = i * 4;
							const a = BASE - ridge(x);
							const b = BASE - ridge(x - px);
							return (
								<rect
									key={x}
									x={x}
									y={Math.min(a, b)}
									width={4}
									height={Math.abs(a - b)}
									fill="url(#rg-hatch)"
								/>
							);
						})}
					</g>
					<path
						d={path(0)}
						fill="none"
						stroke="#ece6da"
						strokeOpacity={0.55}
						strokeWidth={1.4}
					/>
					<path
						d={path(px)}
						fill="none"
						stroke={accent}
						strokeWidth={2.4}
						style={{ filter: `drop-shadow(0 0 5px ${accent})` }}
					/>
					{/* ground strip: the DEM-side readout */}
					<rect y={BASE} width={W} height={H - BASE} fill="#0e1012" />
					<line
						x1="0"
						x2={W}
						y1={BASE}
						y2={BASE}
						stroke="#fff"
						strokeOpacity={0.12}
					/>
					{/* degree ruler */}
					{Array.from({ length: 13 }, (_, i) => {
						const x = 40 + i * 60;
						return (
							<g key={x}>
								<line
									x1={x}
									x2={x}
									y1={BASE}
									y2={BASE + (i % 2 ? 5 : 9)}
									stroke="#fff"
									strokeOpacity={0.3}
								/>
								{i % 2 === 0 && (
									<text
										x={x}
										y={BASE + 22}
										textAnchor="middle"
										fontSize="9.5"
										fill="#fff"
										fillOpacity={0.35}
										fontFamily="ui-monospace,monospace"
									>
										{`${((i - 6) * 4.6) | 0}°`}
									</text>
								)}
							</g>
						);
					})}
					{/* legend */}
					<g fontFamily="ui-monospace,monospace" fontSize="10.5">
						<line
							x1="16"
							x2="40"
							y1="22"
							y2="22"
							stroke="#ece6da"
							strokeOpacity={0.6}
							strokeWidth={1.6}
						/>
						<text x="48" y="26" fill="#fff" fillOpacity={0.6}>
							photo skyline (segmented)
						</text>
						<line
							x1="16"
							x2="40"
							y1="42"
							y2="42"
							stroke={accent}
							strokeWidth={2.4}
						/>
						<text x="48" y="46" fill="#fff" fillOpacity={0.6}>
							DEM horizon at the candidate pose
						</text>
					</g>
					{/* verdict */}
					<g
						transform={`translate(${W - 190},14)`}
						fontFamily="ui-monospace,monospace"
					>
						<rect
							width="176"
							height="44"
							rx="8"
							fill="#0e1012"
							fillOpacity={0.85}
							stroke={tone}
							strokeOpacity={0.6}
						/>
						<text
							x="12"
							y="19"
							fontSize="9.5"
							fill="#fff"
							fillOpacity={0.5}
							letterSpacing="1.4"
						>
							VERDICT
						</text>
						<text x="12" y="36" fontSize="14" fontWeight="700" fill={tone}>
							{ok ? "within 1°: show it" : "off: don't claim"}
						</text>
					</g>
					<text
						x="16"
						y={H - 10}
						fontSize="10.5"
						fill="#fff"
						fillOpacity={0.5}
						fontFamily="ui-monospace,monospace"
					>
						yaw error {off.toFixed(2)}° ≈ {resid.toFixed(0)} px at this field of
						view
					</text>
				</svg>
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-[12px] text-white/55">
				<label className="flex min-w-0 flex-1 items-center gap-3">
					<span className="shrink-0">yaw error</span>
					<input
						type="range"
						min={-4}
						max={4}
						step={0.05}
						value={off}
						onChange={(e) => setManual(Number(e.target.value))}
						className="min-w-0 flex-1"
						style={{ accentColor: accent }}
						aria-label="Yaw error in degrees"
					/>
				</label>
				<button
					type="button"
					onClick={() => setManual(null)}
					disabled={manual === null}
					className="rounded-full px-3 py-1 ring-1 ring-white/15 hover:bg-white/8 disabled:opacity-40"
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
						className="rounded-full px-3.5 py-1.5 font-mono text-[12px] ring-1 transition"
						style={
							k === i
								? {
										background: `${accent}26`,
										color: accent,
										boxShadow: `inset 0 0 0 1px ${accent}`,
									}
								: {
										color: "rgba(255,255,255,.6)",
										boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)",
									}
						}
					>
						{s.label}
					</button>
				))}
			</div>
			<p className="mt-4 text-[14px] text-white/60">{st.blurb}</p>
			<ul className="mt-4 grid list-none gap-3 !pl-0 sm:grid-cols-2">
				{st.ids.map((id) => {
					const n = byId.get(id);
					if (!n) return null;
					const c = groupColor(n.group);
					return (
						<li key={id} className="!pl-0">
							<Link
								to={atlasHref(id)}
								className="block h-full rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/8 transition hover:bg-white/[0.08]"
								style={{ borderLeft: `3px solid ${c}` }}
							>
								<span className="font-semibold text-[var(--rigi-paper)]">
									{n.title}
								</span>
								<span className="ml-2 font-mono text-[10px] tracking-wider text-white/35 uppercase">
									{n.status}
								</span>
								<span className="mt-1 block text-[13px] leading-snug text-white/55">
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
	byId.has(id) ? <Link to={atlasHref(id)}>{children}</Link> : children;

/** Hero: one real photo, four stages from the phone's guess to labelled peaks. */
function HeroStages() {
	const d = useAtlasPhoto("demo-01");
	const crop = useMemo(() => (d ? skylineBand(d, 360) : undefined), [d]);
	const yaw = d ? Math.abs(d.solved.delta.yaw).toFixed(1) : null;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{yaw
						? `On this photo the phone's compass was ${yaw}° off, and the search finds it.`
						: "One real photo, four stages."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption:
							"Rigi starts with the photo and what the phone noted down.",
						render: () => <RealPhoto data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Phone's guess",
						caption: (
							<>
								The compass guess draws{" "}
								<Key color="#ff5fa2" dashed>
									the terrain's skyline
								</Key>{" "}
								beside <Key color="#f4d35e">the photo's skyline</Key>. They
								disagree.
							</>
						),
						render: () => (
							<RealPhoto data={d} layers={["skyline", "prior"]} crop={crop} />
						),
					},
					{
						label: "Solved",
						caption: (
							<>
								We turn the camera until{" "}
								<Key color="#5ee0f4">the terrain's skyline</Key> lies on the
								photo's.
							</>
						),
						render: () => (
							<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
						),
					},
					{
						label: "Labels",
						caption: "With the pose known, every peak in view gets its name.",
						render: () => (
							<RealPhoto
								data={d}
								layers={["peaks"]}
								crop={crop}
								maxLabels={12}
							/>
						),
					},
				]}
			/>
		</Figure>
	);
}

/** Wipe between the phone's guess and the solved pose, pixel-aligned. */
function GuessVsSolved() {
	const d = useAtlasPhoto("demo-03");
	const crop = useMemo(() => (d ? skylineBand(d, 360) : undefined), [d]);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					{d
						? `Dragging across, the median gap to the skyline falls from ${d.residual.prior.median.toFixed(0)} to ${d.residual.solved.median.toFixed(0)} pixels.`
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
function tightBand(d: AtlasPhotoData): [number, number, number, number] {
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
	const d = useAtlasPhoto("demo-03");
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
					body: "Start at the camera's eye and look around.",
					visual: <DemPatch data={d} cone={["solved"]} peaks={false} />,
				},
			]}
		/>
	);
}

function Twelve() {
	return (
		<Figure
			label="Fig. 3"
			caption="The same search on all 12 photos. Two heads on the skyline are left for you to confirm."
		>
			<Gallery
				ids={ROLL_IDS}
				cols={4}
				tile={(d: AtlasPhotoData) => (
					<div className="relative">
						<RealPhoto data={d} layers={["solved"]} crop={tightBand(d)} />
						<span
							className="absolute top-1 left-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold"
							style={{
								background: d.solved.accepted ? "var(--accent)" : "#e5604d",
								color: "var(--rigi-ink)",
							}}
						>
							{d.solved.accepted
								? d.solved.stage === "refine"
									? "refined"
									: "ok"
								: "ask"}
						</span>
					</div>
				)}
				label={(d) => (
					<>
						{d.id.slice(-2)} · {d.residual.solved.median.toFixed(1)} px
					</>
				)}
			/>
		</Figure>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	const accent = groupColor(node.group);
	const idx = useAtlasIndex();
	const acc = idx ? idx.photos.filter((p) => p.accepted).length : null;
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="The skyline tells us where the camera stood."
			>
				<p>
					Every mountain photo has a skyline. The terrain model predicts one for
					any camera pose.
				</p>
				<p>
					We search for the pose where the two lines overlap. Yaw, which way the
					camera points, is the part the phone gets wrong.
				</p>
			</Beat>

			<GuessVsSolved />

			<Beat kicker="Watch it solve" title="Guess, measure, correct, snap.">
				<p>
					One real photo, six beats. Drag the terrain line afterwards to feel
					the match.
				</p>
				<div className="mt-6">
					<HowItWorksScene />
				</div>
			</Beat>

			<Beat kicker="What you get" title="One pose unlocks three things.">
				<p>
					Once the camera is known, everything else is drawing from it.{" "}
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
					A head on the skyline fools the match. When the evidence is weak, we
					ask you to confirm, or to tap a peak.
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
						label: "HIGH-confidence wild test photos correct",
					},
				]}
				source={
					<>
						Demo: measured. Eval and wild test: reports/status.md,
						reports/test-results.md.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next, two deep dives: the <A id="camera-roll">camera roll</A> and{" "}
				<A id="step-inside">Step Inside</A>. The match itself is{" "}
				<A id="viewport-inference">viewport inference</A>.
			</p>

			<Details>
				<h3>How the core fits</h3>
				<p>
					The <A id="photo">photo</A> arrives with sensor metadata that becomes
					a <A id="camera-prior">camera prior</A>: a guess, never a fact. That
					prior seeds <A id="viewport-inference">viewport inference</A>, which
					compares the <A id="skyline">skyline</A> found in the image with the{" "}
					<A id="dem-horizon">horizon</A> the DEM predicts, all on the CPU in
					the browser (<A id="baseline-pipeline">baseline pipeline</A>
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
					label="Fig. 4"
					caption="Synthetic ridge (not a photo). The 1° tick is the app's headline accuracy bar."
					bleed
				>
					<Registration accent={accent} />
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
