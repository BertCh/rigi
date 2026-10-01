// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FingerprintRing } from "#/components/site/meta/FingerprintRing";
import { PixelToPlace } from "#/components/site/meta/PixelToPlace";
import { RollCompasses } from "#/components/site/meta/RollCompasses";
import { SideSection } from "#/components/site/meta/SideSection";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";

// Preview of the "under the hood" visuals (src/components/site/meta), each built from real
// pipeline output on the demo roll (scripts/meta/bake.ts). Each figure works without interaction;
// dragging or hovering is a bonus.
export const Route = createFileRoute("/dev/meta")({
	ssr: false,
	head: () => ({ meta: [{ title: "Under the hood · Rigi" }] }),
	component: Preview,
});

function Preview() {
	return (
		<main className={`${SITE_THEME} pb-24`}>
			<SiteNav />
			<header className="mx-auto max-w-6xl px-4 pt-12 pb-6 sm:px-8">
				<p className="mb-3 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
					Under the hood
				</p>
				<h1 className="max-w-3xl text-[2rem] leading-[1.08] font-semibold tracking-[-0.02em] sm:text-[2.6rem]">
					Why a skyline is enough.
				</h1>
			</header>
			<Part
				eyebrow="01 · Fingerprint"
				title="Where does this skyline fit?"
				body="The elevation model gives the skyline in every direction from where you stood. Slide the photo's skyline along it: for this photo the mismatch drops to 6 px at one heading, and the next-best fit is nearly three times worse."
			>
				<FingerprintRing />
			</Part>
			<Part
				eyebrow="02 · Depth"
				title="The skyline is the farthest thing you can see."
				body="Every bearing is a cross-section through the terrain. The line of sight grazes ridge after ridge; the last one it touches, often 20 to 30 km out, is the skyline the photo shows."
			>
				<SideSection />
			</Part>
			<Part
				eyebrow="03 · Place"
				title="Every pixel is a place."
				body="With the pose solved, each pixel is a ray from the camera. Follow it until it meets the ground and you know what you are looking at, and how far away it is."
			>
				<PixelToPlace />
			</Part>
			<Part
				eyebrow="04 · The roll"
				title="Where the compass put them, and where they belong."
				body="Each photo of the day carries its own compass error, from 19° one way to 11° the other. The skyline corrects each photo on its own, and the solver rejects two rather than guess."
			>
				<RollCompasses />
			</Part>
		</main>
	);
}

function Part({
	eyebrow,
	title,
	body,
	children,
}: {
	eyebrow: string;
	title: string;
	body: string;
	children: ReactNode;
}) {
	return (
		<section className="mx-auto max-w-6xl px-4 pt-16 sm:px-8">
			<p className="mb-3 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
				{eyebrow}
			</p>
			<h2 className="text-3xl leading-tight font-semibold tracking-[-0.02em] sm:text-4xl">
				{title}
			</h2>
			<p className="mt-3 mb-8 max-w-2xl text-[15px] leading-relaxed text-white/55">
				{body}
			</p>
			{children}
		</section>
	);
}
