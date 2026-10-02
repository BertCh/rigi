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
	component: PreviewGate,
});

// dev-only: the production build shows a stub (same gate as dev.how-scene); the figures live on the
// Gipfelbuch sheets (dem-horizon, viewport-inference, camera-roll)
function PreviewGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return <Preview />;
}

function Preview() {
	return (
		<main className={`${SITE_THEME} pb-24`}>
			<SiteNav />
			<header className="mx-auto max-w-6xl px-4 pt-12 pb-6 sm:px-8">
				<p className="mb-3 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
					Under the hood
				</p>
				<h1 className="max-w-3xl text-[2rem] leading-[1.08] font-semibold tracking-[-0.02em] sm:text-[2.6rem]">
					Why the skyline is enough to find the pose.
				</h1>
			</header>
			<Part
				eyebrow="01 · Fingerprint"
				title="Matching the skyline to the terrain."
				body="The elevation model gives the skyline in every direction from where you stood. Slide the photo's skyline along it and measure the mismatch. For this photo the mismatch is 6 px at one heading, and the next-best heading is nearly three times worse."
			>
				<FingerprintRing />
			</Part>
			<Part
				eyebrow="02 · Depth"
				title="The skyline is the farthest visible terrain."
				body="Every bearing is a cross-section through the terrain. The line of sight passes over one ridge after another. The last ridge it touches, often 20 to 30 km away, is the skyline in the photo."
			>
				<SideSection />
			</Part>
			<Part
				eyebrow="03 · Place"
				title="Each pixel maps to a place."
				body="With the pose solved, each pixel is a ray from the camera. Following the ray until it meets the ground gives the location it shows and its distance."
			>
				<PixelToPlace />
			</Part>
			<Part
				eyebrow="04 · The roll"
				title="Compass directions before and after correction."
				body="Each photo of the day carries its own compass error, from 19° one way to 11° the other. The skyline corrects each photo separately, and the solver rejects two photos instead of guessing."
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
			<div data-theme="dark">{children}</div>
		</section>
	);
}
