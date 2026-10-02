// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef } from "react";
import { legendItemsFor } from "#/components/gipfelbuch/legendItems";
import { NotebookMap } from "#/components/gipfelbuch/notebook";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	Cartouche,
	GB_THEME,
	Legend,
	SheetFrame,
	SheetMap,
	SheetScaleBar,
	useSheet,
} from "#/components/gipfelbuch/swiss";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import { Blattuebersicht } from "#/components/gipfelbuch/tafel";
import { sheetTransition } from "#/components/gipfelbuch/viz/hooks";
import { SiteNav } from "#/components/site/SiteNav";

// The Rigi Gipfelbuch: the Niederhorn sheet map, then the sheet index (Blattübersicht) of the 19
// sheets in reading order, every band re-drawn from the photo the reader follows
// (reports/peak-notebook-plan.md §0 D-PN4, §11).
export const Route = createFileRoute("/gipfelbuch/")({
	ssr: false,
	head: () => ({ meta: [{ title: "The Rigi Gipfelbuch" }] }),
	component: GipfelbuchIndex,
});

const LEGEND_ITEMS = legendItemsFor(["contour", "water", "peak", "viewpoint"]);

function GipfelbuchIndex() {
	const { sheet } = useSheet();
	const mapRef = useRef<HTMLDivElement>(null);
	// the photo the reader follows; shared with every concept sheet
	const [photoId, setPhotoId] = useNotebookPhoto();
	return (
		<main className={`${GB_THEME} pb-16`}>
			<SiteNav active="gipfelbuch" />
			<SheetFrame
				className="mt-4"
				sheet="00"
				total="19"
				title="Übersicht"
				imprint="Rigi Gipfelbuch · Blatt 00 · Relief © swisstopo · DEM Mapterhorn"
				stand="2026-10"
				edition="2026"
			>
				<header className="px-6 pt-12 pb-6">
					<Cartouche
						kicker="Gipfelbuch · Band 1 · 2026–"
						title="The Rigi Gipfelbuch"
						subtitle="How a photograph of a mountain finds its place on the earth: two ideas carry it, inferring the viewport and snapping to the terrain."
						edition="Blatt 1208 Beatenberg · Niederhorn 1963 m · Ausgabe 2026"
					/>
					<p className={`${TYPE.body} gb-secondary mt-6 max-w-[66ch]`}>
						A Gipfelbuch is the logbook kept in a tin on a Swiss summit. This
						one records the ideas each photo passes on its way up. New here?
						Start with{" "}
						<Link
							to="/gipfelbuch/$concept"
							params={{ concept: "rigi" }}
							viewTransition={sheetTransition()}
							className="text-[var(--gb-ink)] underline decoration-[var(--gb-red)] underline-offset-2 hover:text-[var(--gb-red)]"
						>
							Rigi in one sheet
						</Link>
						.
					</p>
				</header>

				<div className="px-6">
					<div ref={mapRef}>
						<SheetMap className="w-full" />
					</div>
					<div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
						<p className={`${TYPE.micro} max-w-[66ch]`}>
							The 12 demo photos were taken here: each red cone is one camera,
							solved from the photo alone.
						</p>
						<SheetScaleBar sheet={sheet} targetRef={mapRef} />
					</div>
				</div>

				<section aria-label="Sheet index" className="mt-12 px-6">
					<Blattuebersicht followed={photoId} onFollow={setPhotoId} />
				</section>

				{/* C1: the sheet index stays the index; the field notebook follows as the Feldbuch, on the same photo */}
				<section aria-label="Feldbuch" className="mt-16">
					<p
						className={`${TYPE.kicker} px-6 tracking-[0.18em] text-[var(--gb-red)]`}
					>
						Feldbuch
					</p>
					<NotebookMap />
				</section>

				<footer className="mt-12 px-6 pb-6">
					<Legend items={LEGEND_ITEMS} />
					<p
						className={`${TYPE.kicker} mt-6 flex flex-wrap gap-x-6 gap-y-1.5 tracking-[0.14em]`}
					>
						<Link to="/gipfelbuch/print" className="hover:text-[var(--gb-red)]">
							Printed edition →
						</Link>
						<Link
							to="/gipfelbuch/print"
							hash="colophon-title"
							className="hover:text-[var(--gb-red)]"
						>
							Colophon
						</Link>
					</p>
				</footer>
			</SheetFrame>
		</main>
	);
}
