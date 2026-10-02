// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef } from "react";
import { legendItemsFor } from "#/components/gipfelbuch/legendItems";
import { NotebookMap } from "#/components/gipfelbuch/notebook";
import { SketchDefs } from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	Cartouche,
	GB_THEME,
	Legend,
	SheetFrame,
	SheetMap,
	SheetScaleBar,
	useSheet,
	Waymark,
	waymarkForStatus,
} from "#/components/gipfelbuch/swiss";
import { ListArrow, MarkerUnderline } from "#/components/gipfelbuch/swiss/hand";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import { Blattuebersicht, CHAPTERS } from "#/components/gipfelbuch/tafel";
import { sheetTransition } from "#/components/gipfelbuch/viz/hooks";
import { SiteNav } from "#/components/site/SiteNav";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { STATUS_META } from "#/lib/gipfelbuch/graph-utils";

// The Rigi Gipfelbuch: the title block, a hand-written table of contents, the Niederhorn sheet map,
// then the sheet index (Blattübersicht) of the 19 sheets in reading order, every band re-drawn from
// the photo the reader follows (reports/peak-notebook-plan.md §0 D-PN4, §11; hand pass K-C).
export const Route = createFileRoute("/gipfelbuch/")({
	ssr: false,
	head: () => ({ meta: [{ title: "The Rigi Gipfelbuch" }] }),
	component: GipfelbuchIndex,
});

const LEGEND_ITEMS = legendItemsFor(["contour", "water", "peak", "viewpoint"]);

const NODE_BY_ID = new Map(GIPFELBUCH_NODES.map((n) => [n.id, n]));
const BLATT = new Map(
	GIPFELBUCH_NODES.map((n, i) => [n.id, String(i + 1).padStart(2, "0")]),
);

/**
 * The book's contents written by hand (sketch-style §7 move 24): chapters as lettered heads, each
 * sheet a hand-lettered title with its status blaze, a dotted hand leader and the Blatt number.
 */
function HandContents() {
	return (
		<nav aria-labelledby="contents-title" className="px-6 pt-6 pb-6">
			<div className="relative inline-block">
				<h2 id="contents-title" className={`${TYPE.h2} m-0`}>
					Inhalt · Contents
				</h2>
				<MarkerUnderline seed="index-contents" />
			</div>
			<div className="mt-6 grid gap-x-12 gap-y-8 lg:grid-cols-3">
				{CHAPTERS.map((chapter) => (
					<section key={chapter.numeral} aria-label={chapter.title}>
						<p className="nb-hand m-0 text-[20px] leading-[24px] text-[var(--gb-contour)]">
							Kapitel {chapter.numeral} · {chapter.title}
						</p>
						<ol className="m-0 mt-2 list-none p-0">
							{chapter.ids.map((id) => {
								const node = NODE_BY_ID.get(id);
								if (!node) return null;
								return (
									<li key={id}>
										<Link
											to="/gipfelbuch/$concept"
											params={{ concept: id }}
											viewTransition={sheetTransition()}
											className="group flex items-baseline gap-2 py-0.5 text-[var(--gb-ink)] hover:text-[var(--gb-red)]"
										>
											<Waymark variant={waymarkForStatus(node.status)}>
												<span className="sr-only">
													{STATUS_META[node.status].label}
												</span>
											</Waymark>
											<span className="nb-hand text-[22px] leading-[26px] group-hover:underline group-hover:decoration-[var(--gb-red)] group-hover:underline-offset-4">
												{node.title}
											</span>
											<span className="gb-leader" aria-hidden="true" />
											<span className="nb-num text-[14px] italic">
												{BLATT.get(id)}
											</span>
										</Link>
									</li>
								);
							})}
						</ol>
					</section>
				))}
			</div>
		</nav>
	);
}

function GipfelbuchIndex() {
	const { sheet } = useSheet();
	const mapRef = useRef<HTMLDivElement>(null);
	// the photo the reader follows; shared with every concept sheet
	const [photoId, setPhotoId] = useNotebookPhoto();
	return (
		<main className={`${GB_THEME} pb-16`}>
			<SketchDefs />
			<SiteNav active="gipfelbuch" />
			<SheetFrame
				className="mt-4"
				sheet="00"
				total="19"
				title="Übersicht"
				imprint="Rigi Gipfelbuch · Blatt 00 · Grundlage © swisstopo (OGD) · DEM Mapterhorn"
				stand="2026-10"
				edition="2026"
				corners={
					sheet
						? {
								east: String(sheet.lv95.sw[0]),
								north: String(sheet.lv95.ne[1]),
							}
						: null
				}
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

				<HandContents />

				<div className="px-6 pt-6">
					<div ref={mapRef}>
						<SheetMap className="w-full" />
					</div>
					<div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
						<p className={`${TYPE.hand} gb-secondary max-w-[66ch]`}>
							The 12 demo photos were taken here: each red cone is one camera,
							solved from the photo alone.
						</p>
						<SheetScaleBar sheet={sheet} targetRef={mapRef} />
					</div>
				</div>

				<section aria-labelledby="sheets-title" className="mt-12 px-6">
					<div className="relative inline-block">
						<h2 id="sheets-title" className={`${TYPE.h2} m-0`}>
							Blattübersicht · Sheet index
						</h2>
						<MarkerUnderline seed="index-sheets" />
					</div>
					<Blattuebersicht followed={photoId} onFollow={setPhotoId} />
				</section>

				{/* C1: the sheet index stays the index; the field notebook follows as the Feldbuch, on the same photo */}
				<section aria-labelledby="feldbuch-title" className="mt-16">
					<div className="relative mx-6 inline-block">
						<h2 id="feldbuch-title" className={`${TYPE.h2} m-0`}>
							Feldbuch
						</h2>
						<MarkerUnderline seed="index-feldbuch" />
					</div>
					<NotebookMap />
				</section>

				<footer className="mt-12 px-6 pb-6">
					<Legend items={LEGEND_ITEMS} />
					<p className="nb-hand mt-6 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[20px] leading-[24px]">
						<Link
							to="/gipfelbuch/print"
							className="inline-flex items-center gap-1.5 hover:text-[var(--gb-red)]"
						>
							Printed edition <ListArrow seed="index-print" />
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
