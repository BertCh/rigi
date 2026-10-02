// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { HandMark } from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	CodeRef,
	Figure,
	type GipfelbuchPhotoData,
	LiveHowItWorks,
	MarginNote,
	Measured,
	PhotoStory,
	RealPhoto,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
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
// The stage map lives in Details.

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
		blurb: "The photo and the sensor data the phone recorded with it.",
		ids: ["photo", "dem-source"],
	},
	{
		key: "solve",
		label: "2 · Solve",
		blurb: "Match the skyline in the photo to the horizon from terrain.",
		ids: ["viewport-inference", "skyline", "dem-horizon", "pose-estimate"],
	},
	{
		key: "judge",
		label: "3 · Snap and judge",
		blurb:
			"Fix the camera position, summits and depth to the terrain, and decide which poses to show.",
		ids: ["terrain-snapping", "eye-rule", "peak", "accept-rule", "tap-a-peak"],
	},
	{
		key: "show",
		label: "4 · Look through it",
		blurb:
			"Use the pose for labels, draping photos on terrain, the camera roll and Step Inside.",
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
						: "One real photo, shown in four steps."}{" "}
					<Measured data={d} />
				</>
			}
		/>
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
					body: "Labels are placed on the matching summits in the photo.",
					visual: (
						<RealPhoto data={d} layers={["peaks"]} crop={crop} maxLabels={6} />
					),
				},
				{
					title: "A day on a map",
					body: "Twelve photos are placed on the terrain they show.",
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
					body: "The nearby ground is rebuilt in 3D and viewed from the camera position.",
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
			label="Fig. 3"
			bleed
			caption="The same search on all 12 photos, solved horizon drawn on each. The two with a person in frame are marked ask."
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

			<Beat kicker="The idea" title="The skyline shows where the camera stood.">
				<p>
					Every mountain photo has a{" "}
					<HandMark type="underline">skyline</HandMark>. The terrain model
					predicts a horizon for any camera pose.
					<MarginNote mark="a">
						Both the photo and the terrain model give a skyline, so the two can
						be compared.
					</MarginNote>
				</p>
				<p>
					<HandMark type="highlight">
						We search for the pose where the two lines overlap.
					</HandMark>{" "}
					Yaw, which way the camera points, is the part the phone gets wrong.
					<MarginNote mark="b">
						The compass is the main source of error; the rest of the pose is
						reliable.
					</MarginNote>
				</p>
			</Beat>

			<LiveHowItWorks
				number="Fig. 2"
				caption="The six steps of one real solve. Drag the terrain line."
			/>

			<Beat kicker="What you get" title="The pose is used in three ways.">
				<p>
					Once the camera pose is known,{" "}
					<HandMark type="double">the rest is drawn from it</HandMark>.{" "}
					<A id="photo-workspace">Labels</A>, a{" "}
					<A id="camera-roll">camera roll</A> on a map, and{" "}
					<A id="step-inside">stepping inside</A> the scene.
				</p>
			</Beat>

			<Outcomes />

			<Beat
				kicker="Where it fails"
				title="Rigi shows no pose when it is not confident."
			>
				<p>
					A person in the frame can break the match.{" "}
					<HandMark type="wavy">
						Two photos here were rejected as low confidence
					</HandMark>
					, and we ask you to confirm or to tap a peak.
					<MarginNote mark="c">
						Asking is better than showing a wrong label.
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
						label: "test photos within 1° of the true heading",
					},
					{ value: "0", label: "false accepts in that test" },
					{
						value: "17 / 17",
						label: "HIGH-confidence photos correct in a blind test",
					},
				]}
				source={
					<>First: measured on the 12 demo photos. Others: Rigi’s own tests.</>
				}
			/>

			<Details>
				<h3>How it fits</h3>
				<p>
					The <A id="photo">photo</A> arrives with sensor metadata that becomes
					a camera prior: an estimate that the solve then corrects. That prior
					seeds <A id="viewport-inference">viewport inference</A>, which
					compares the <A id="skyline">skyline</A> found in the photo with the{" "}
					<A id="dem-horizon">horizon</A> predicted from the{" "}
					<A id="dem-source">terrain model</A>, in the browser, on the GPU where
					available. Around the solve,{" "}
					<A id="terrain-snapping">terrain snapping</A> pins the camera position
					(<A id="eye-rule">eye rule</A>), summits (<A id="peak">peaks</A>) and
					depth (<A id="dem-anchoring">DEM anchoring</A>) to the ground. The{" "}
					<A id="accept-rule">accept rule</A> decides what is safe to show;
					about a fifth of tested photos are accepted automatically.{" "}
					<A id="tap-a-peak">Tapping a peak</A> is the manual way to set a pose.
				</p>
				<h3>Parts, by stage</h3>
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
