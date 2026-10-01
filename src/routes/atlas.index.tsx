// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { NodeCard } from "#/components/atlas/ConceptPage";
import { CoreMap } from "#/components/atlas/CoreMap";
import { useInView } from "#/components/atlas/viz/hooks";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";
import { byId, groupColor } from "#/lib/atlas/graph-utils";

// The Rigi Atlas: a small, curated map of the core of Rigi, each concept with a deep page.
export const Route = createFileRoute("/atlas/")({
	ssr: false,
	head: () => ({ meta: [{ title: "The Rigi Atlas" }] }),
	component: AtlasIndex,
});

const DEEP = [
	{
		id: "viewport-inference",
		kicker: "Deep dive · 1",
		line: "How the skyline in a photo and the horizon of the terrain are slid together until the camera's yaw, pitch, roll and focal length fall out, and when the answer is refused.",
	},
	{
		id: "terrain-snapping",
		kicker: "Deep dive · 2",
		line: "Where the eye stands, where the summits really are, and how far away the near ground is: every coordinate reconciled with the DEM, as a snap, a bound or a prior.",
	},
];

const SECTIONS: { title: string; blurb: string; ids: string[] }[] = [
	{
		title: "Viewport inference",
		blurb:
			"From a photo and a rough sensor guess to a pose we are willing to show.",
		ids: [
			"photo",
			"camera-prior",
			"skyline",
			"baseline-pipeline",
			"accept-rule",
			"pose-estimate",
			"tap-a-peak",
		],
	},
	{
		title: "Terrain & snapping",
		blurb: "The elevation model, and the things we pin to it.",
		ids: [
			"dem-source",
			"terrain-sampler",
			"dem-horizon",
			"eye-rule",
			"peak",
			"dem-anchoring",
		],
	},
	{
		title: "The app",
		blurb: "What a solved pose makes possible.",
		ids: ["rigi", "photo-workspace", "camera-roll", "step-inside"],
	},
];

function AtlasIndex() {
	return (
		<main className={`${SITE_THEME} pb-20`}>
			<SiteNav active="atlas" />
			<header className="mx-auto max-w-6xl px-4 pt-9 pb-7 sm:px-8">
				<p className="mb-3 font-mono text-[11px] tracking-[0.22em] text-[var(--rigi-glow)] uppercase">
					A map of the core
				</p>
				<h1 className="display-title max-w-3xl text-[2.8rem] leading-[1.02] font-bold tracking-[-0.025em] sm:text-[3.8rem]">
					The Rigi Atlas
				</h1>
				<p className="display-title mt-3 max-w-2xl text-[1.2rem] leading-snug font-medium text-white/58 italic sm:text-[1.4rem]">
					How a photograph of a mountain finds its place on the earth: two ideas
					carry it, inferring the viewport and snapping to the terrain.
				</p>
			</header>

			<section
				aria-label="Core map"
				className="border-y border-white/8 bg-[radial-gradient(ellipse_at_50%_40%,color-mix(in_oklab,var(--rigi-slate)_45%,var(--rigi-ink))_0%,var(--rigi-ink)_70%)] py-6"
			>
				<CoreMap className="mx-auto max-w-[1240px] px-2 sm:px-4" />
			</section>

			<div className="mx-auto mt-14 grid max-w-6xl gap-4 px-4 sm:px-8 md:grid-cols-2">
				{DEEP.map((d) => {
					const n = byId.get(d.id);
					if (!n) return null;
					const c = groupColor(n.group);
					return (
						<Link
							key={d.id}
							to="/atlas/$concept"
							params={{ concept: d.id }}
							className="group relative overflow-hidden rounded-2xl p-6 ring-1 ring-white/10 transition hover:ring-white/25 sm:p-8"
							style={{
								background: `linear-gradient(140deg, color-mix(in oklab, ${c} 16%, transparent), transparent 65%)`,
							}}
						>
							<p
								className="font-mono text-[10.5px] tracking-[0.2em] uppercase"
								style={{ color: c }}
							>
								{d.kicker}
							</p>
							<h2 className="display-title mt-2 text-[2rem] leading-tight font-bold">
								{n.title}
								<span className="ml-2 inline-block transition group-hover:translate-x-1">
									→
								</span>
							</h2>
							<p className="mt-1 text-[14px] text-white/60 italic">
								{n.tagline}
							</p>
							<p className="mt-4 max-w-prose text-[14.5px] leading-relaxed text-white/72">
								{d.line}
							</p>
						</Link>
					);
				})}
			</div>

			<div className="mx-auto mt-16 max-w-6xl space-y-14 px-4 sm:px-8">
				{SECTIONS.map((s) => (
					<Region key={s.title}>
						<div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-1 border-b border-white/10 pb-3">
							<h2 className="display-title text-3xl font-bold tracking-[-0.01em]">
								{s.title}
							</h2>
							<p className="mb-1 text-[13px] text-white/45 italic">{s.blurb}</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{s.ids.map((id) => {
								const n = byId.get(id);
								return n ? <NodeCard key={id} node={n} /> : null;
							})}
						</div>
					</Region>
				))}
			</div>
		</main>
	);
}

function Region({ children }: { children: React.ReactNode }) {
	const [ref, on] = useInView();
	return (
		<section
			ref={ref}
			className={`transition duration-1000 ease-out motion-reduce:transition-none ${on ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"}`}
		>
			{children}
		</section>
	);
}
