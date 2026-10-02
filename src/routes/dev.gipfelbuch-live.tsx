// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import { GB_THEME } from "#/components/gipfelbuch/swiss";
import {
	LiveCompare,
	LiveDrape,
	LiveHowItWorks,
	LivePanorama,
	LiveReveal,
	LiveStepInside,
	LiveTopoBoard,
	PhotoStory,
} from "#/components/gipfelbuch/viz";
import { SiteNav } from "#/components/site/SiteNav";
// GeoSpill's stroke mask (.tafel-spill); ConceptPage gets it with the Tafel
import "#/components/gipfelbuch/tafel/tafel.css";

// Preview of the Gipfelbuch live plates and the photo story (src/components/gipfelbuch/viz/live.tsx,
// PhotoStory.tsx; see viz/LIVE.md), on ConceptPage's grid so the figures take the same wide track.
export const Route = createFileRoute("/dev/gipfelbuch-live")({
	ssr: false,
	head: () => ({ meta: [{ title: "Gipfelbuch live plates" }] }),
	component: PreviewGate,
});

// ConceptPage's page grid: columns 3-8 are the prose column the figures widen from.
const PAGE_GRID =
	"grid gap-x-6 px-6 pt-12 lg:grid-cols-[[full-start]repeat(2,minmax(0,1fr))[content-start]repeat(6,minmax(0,1fr))[margin-start]repeat(4,minmax(0,1fr))[full-end]]";

// dev-only: the production build shows a stub (same gate as dev.gipfelbuch-sheet)
function PreviewGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return (
		<main className={`${GB_THEME} pb-20`}>
			<SiteNav active="gipfelbuch" />
			<div className="mx-auto max-w-6xl" data-gb-bleed-bounds>
				<div className={PAGE_GRID}>
					<div className="min-w-0 lg:col-[content-start/margin-start]">
						<PhotoStory number="1" date="07.09.2026" />
						<LiveReveal number="2" />
						<LiveCompare number="3" />
						<LiveDrape number="4" />
						<LiveStepInside number="5" />
						<LivePanorama number="6" />
						<LiveTopoBoard number="7" />
						<LiveHowItWorks number="8" />
					</div>
				</div>
			</div>
		</main>
	);
}
