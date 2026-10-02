// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { bespokePage, PageBoundary } from "#/components/gipfelbuch/loadPage";
import { SketchDefs } from "#/components/gipfelbuch/notebook/Ink";
import {
	Cartouche,
	Colophon,
	GB_THEME,
	SheetFrame,
	SheetMap,
	SheetStamp,
	useSheet,
} from "#/components/gipfelbuch/swiss";
import { MarkerUnderline } from "#/components/gipfelbuch/swiss/hand";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { GROUP_BY_ID } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// The printed edition (design book A5/P6): cover, index sheet, every concept sheet in order, then
// the colophon. One long scroll on screen; Print / Save as PDF gives A4 pages (swiss/print.css).
export const Route = createFileRoute("/gipfelbuch/print")({
	ssr: false,
	head: () => ({ meta: [{ title: "Gipfelbuch, printed edition" }] }),
	component: GipfelbuchPrint,
});

const STAND = "2026-10";
const TOTAL = String(GIPFELBUCH_NODES.length);

// Static segment /gipfelbuch/print wins over /gipfelbuch/$concept; no concept id may be "print".

function SheetBody({ node, number }: { node: GipfelbuchNode; number: string }) {
	const Bespoke = bespokePage(node.id);
	const group = GROUP_BY_ID[node.group];
	return (
		<section className="break-before-page" aria-labelledby={`sheet-${node.id}`}>
			<SheetFrame
				className="mt-4 print:mt-0"
				sheet={number}
				total={TOTAL}
				title={node.title}
				imprint={`Rigi Gipfelbuch · Blatt ${number} · Ausgabe 2026 · Stand ${STAND} · Grundlage © swisstopo (OGD) · DEM Mapterhorn`}
			>
				<header className="relative px-6 pt-12 pb-6">
					<div className="absolute top-10 right-6">
						<SheetStamp
							sheet={number}
							status={node.status}
							date={STAND.split("-").reverse().join(".")}
							seed={node.id}
							size={80}
						/>
					</div>
					<p className="nb-hand m-0 text-[20px] leading-[24px] text-[var(--gb-contour)]">
						{group.label}
					</p>
					<div className="relative mt-2 inline-block max-w-[calc(100%-96px)]">
						<h2 id={`sheet-${node.id}`} className={`${TYPE.h1} m-0`}>
							{node.title}
						</h2>
						<MarkerUnderline seed={`print-${node.id}`} />
					</div>
					<p className="nb-hand mt-2 text-[22px] leading-[26px] text-[var(--gb-water)]">
						{node.claim ?? node.tagline}
					</p>
					<p className={`${TYPE.lead} mt-6 max-w-[66ch]`}>
						{node.lede ?? node.summary}
					</p>
				</header>
				<div className="px-6 pb-12">
					{Bespoke ? (
						<PageBoundary
							fallback={<p className={TYPE.caption}>{node.tagline}</p>}
							resetKey={node.id}
						>
							<Suspense
								fallback={
									<div className="h-72 animate-pulse bg-[var(--gb-paper-deep)] motion-reduce:animate-none" />
								}
							>
								<Bespoke node={node} />
							</Suspense>
						</PageBoundary>
					) : (
						<p className={TYPE.caption}>{node.tagline}</p>
					)}
				</div>
			</SheetFrame>
		</section>
	);
}

function GipfelbuchPrint() {
	useSheet();
	return (
		<main className={`${GB_THEME} pb-16`}>
			<SketchDefs />
			<nav
				data-site-nav
				className={`${TYPE.kicker} mx-auto flex max-w-6xl items-center justify-between px-6 pt-6 tracking-[0.14em] print:hidden`}
			>
				<Link to="/gipfelbuch" className="hover:text-[var(--gb-red)]">
					← Gipfelbuch
				</Link>
				<button
					type="button"
					onClick={() => window.print()}
					className="hover:text-[var(--gb-red)]"
				>
					Print or save as PDF
				</button>
			</nav>

			<section className="mx-auto max-w-6xl px-6 pt-12">
				<Cartouche
					kicker="Gipfelbuch · Band 1 · 2026–"
					title="Gipfelbuch, printed edition"
					subtitle="Nineteen sheets on how a photograph of a mountain finds its place on the earth."
					edition={`Blatt 1208 Beatenberg · Niederhorn 1963 m · Ausgabe 2026 · Stand ${STAND}`}
				/>
			</section>

			<section className="mx-auto mt-12 max-w-6xl break-before-page px-6">
				<SheetFrame
					sheet="00"
					total={TOTAL}
					title="Übersicht"
					imprint="Rigi Gipfelbuch · Blatt 00 · Relief © swisstopo · DEM Mapterhorn"
					stand={STAND}
					edition="2026"
				>
					<div className="px-6 py-12">
						<SheetMap className="w-full" />
					</div>
				</SheetFrame>
			</section>

			<div className="mx-auto max-w-6xl">
				{GIPFELBUCH_NODES.map((node, index) => (
					<SheetBody
						key={node.id}
						node={node}
						number={String(index + 1).padStart(2, "0")}
					/>
				))}
			</div>

			<section className="mx-auto mt-12 max-w-6xl break-before-page px-6">
				<Colophon />
			</section>
		</main>
	);
}
