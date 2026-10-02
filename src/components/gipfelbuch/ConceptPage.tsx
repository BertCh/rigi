// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import { Suspense } from "react";
import { SiteNav } from "#/components/site/SiteNav";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import {
	backlinks,
	byId,
	GROUP_BY_ID,
	groupByRel,
	groupColor,
	outgoing,
	STATUS_META,
} from "#/lib/gipfelbuch/graph-utils";
import { conceptView, findingsFor } from "#/lib/gipfelbuch/ontology";
import type { GipfelbuchEdge, GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { AutoVisual } from "./AutoVisual";
import { bespokePage, PageBoundary } from "./loadPage";
import { FieldNotes, NotebookTrail } from "./notebook/ConceptNotes";
import { SketchDefs, SketchPath } from "./notebook/Ink";
import { useNotebookPhoto } from "./notebook/useNotebookPhoto";
import { OntologyPanel } from "./OntologyPanel";
import {
	ContourField,
	GB_THEME,
	SheetFrame,
	Signpost,
	useSheet,
	Waymark,
	waymarkForStatus,
} from "./swiss";
import { TYPE } from "./swiss/type";
import { Ledger, PAGE_HERO, SHEETS, SheetColophon, Tafel } from "./tafel";
import { Figure } from "./viz";
import { sheetTransition } from "./viz/hooks";
import { Reveal } from "./viz/Reveal";
import {
	type GipfelbuchPhotoId,
	PhotoPicker,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "./viz/real";

/** Data stand shown in the imprint. Update on each data bake. */
const STAND = "2026-10";

/** Wegweiser rule: every sign states a distance, here in sheets along the book. */
function signpostDistance(fromId: string, toId: string): string {
	const distance = Math.abs(
		GIPFELBUCH_NODES.findIndex((n) => n.id === fromId) -
			GIPFELBUCH_NODES.findIndex((n) => n.id === toId),
	);
	return `${distance || 1} Blatt`;
}

// G5/G6: page grid on named lines (design book). Columns 3-8 carry the text (at most 66 ch); the
// margin (9-12) is MarginNote's lane beside the prose. The peak-notebook shell (reports/
// peak-notebook-plan.md §6) puts the sheet's one big real thing first: name, claim dek and ledger,
// then the full-bleed Tafel; the old rail and Standortfeld moved to the colophon at the foot.
const PAGE_GRID =
	"grid gap-x-6 px-6 pt-12 lg:grid-cols-[[full-start]repeat(2,minmax(0,1fr))[content-start]repeat(6,minmax(0,1fr))[margin-start]repeat(4,minmax(0,1fr))[full-end]]";

/** Reading order: the sheet before and after this one in GIPFELBUCH_NODES. */
function readingNeighbours(id: string) {
	const i = GIPFELBUCH_NODES.findIndex((n) => n.id === id);
	return {
		prev: i > 0 ? GIPFELBUCH_NODES[i - 1] : null,
		next:
			i >= 0 && i < GIPFELBUCH_NODES.length - 1
				? GIPFELBUCH_NODES[i + 1]
				: null,
	};
}

export function ConceptPage({ node }: { node: GipfelbuchNode }) {
	const col = groupColor(node.group);
	const G = GROUP_BY_ID[node.group];
	const { prev, next } = readingNeighbours(node.id);
	const Bespoke = bespokePage(node.id);
	const { sheet } = useSheet();
	const [photoId, setPhotoId] = useNotebookPhoto();
	const data = useGipfelbuchPhoto(photoId);
	const figures = SHEETS[node.id];
	const total = GIPFELBUCH_NODES.length;
	const sheetNo = String(
		Math.max(
			0,
			GIPFELBUCH_NODES.findIndex((n) => n.id === node.id),
		) + 1,
	).padStart(2, "0");
	const corners = sheet
		? {
				east: String(sheet.lv95.sw[0]),
				north: String(sheet.lv95.ne[1]),
			}
		: null;
	const hasPanel =
		!!node.ontologyId ||
		!!node.methodIds?.length ||
		findingsFor(node).length > 0;
	const fallback = (
		<Figure
			label="Constellation"
			caption={<>Generated from the graph. Planned visual: {node.visual}</>}
			pad={false}
		>
			<div className="px-2 py-6">
				<AutoVisual node={node} />
			</div>
		</Figure>
	);

	return (
		<main
			className={`${GB_THEME} relative overflow-x-clip pb-16`}
			style={{ "--accent": col } as React.CSSProperties}
		>
			<SketchDefs />
			<SiteNav active="gipfelbuch" />
			<SheetFrame
				className="mt-4"
				corners={corners}
				imprint={`Rigi Gipfelbuch · Blatt ${sheetNo} · Ausgabe 2026 · Stand ${STAND} · Relief © swisstopo · DEM Mapterhorn`}
			>
				<header className="relative grid gap-x-6 gap-y-12 overflow-hidden px-6 pt-12 pb-12 lg:grid-cols-12 lg:items-start">
					{/* the sheet's own contour lines behind the title: a different crop on every sheet */}
					<ContourField seed={node.id} opacity={0.2} />
					<div className="relative min-w-0 lg:col-span-8">
						<nav
							aria-label="Breadcrumb"
							className={`${TYPE.kicker} flex flex-wrap items-center gap-x-3 gap-y-1.5`}
						>
							<Link
								to="/gipfelbuch"
								viewTransition={sheetTransition()}
								className="gb-num text-[var(--gb-red)] hover:underline"
							>
								Blatt {sheetNo} / {total}
							</Link>
							<Link
								to="/gipfelbuch"
								hash={`chapter-${node.id}`}
								className="hover:underline"
								style={{ color: col }}
							>
								{G.label}
							</Link>
							<Waymark variant={waymarkForStatus(node.status)}>
								{STATUS_META[node.status].label}
							</Waymark>
						</nav>
						<h1 className={`${TYPE.display} mt-6`}>{node.title}</h1>
						<p className="display-title mt-1.5 text-[20px] leading-[24px] font-normal italic sm:text-[24px] sm:leading-[30px]">
							{node.claim ?? node.tagline}
						</p>
						<p className={`${TYPE.lead} gb-secondary mt-6 max-w-[640px]`}>
							{node.lede ?? node.summary}
						</p>
					</div>
					<div className="relative min-w-0 space-y-6 lg:col-span-4">
						{figures && data && (
							<Ledger
								items={figures.ledger(data)}
								note="re-read from this photo's run"
							/>
						)}
						<FieldNotes
							id={node.id}
							strip={false}
							className="min-w-0 bg-[var(--gb-paper-deep)] px-4 py-3"
						/>
					</div>
				</header>
				<div className="relative mx-6 h-1">
					<HandRule seed={`head-${node.id}`} />
				</div>

				{/* one hero per sheet (KR2): the page's own bleed photo, or the shell Tafel */}
				{figures?.tafel !== null && !PAGE_HERO.has(node.id) && (
					<Tafel photo={photoId} layer={figures?.tafel ?? undefined} />
				)}
				<div className="px-6 pt-6">
					<PhotoPicker
						value={photoId}
						onChange={setPhotoId}
						mark={(id) => <PhotoMark id={id} />}
					/>
					<p className={`${TYPE.caption}`}>
						Follow another photo: every number on this sheet is re-read from its
						measured run.
					</p>
				</div>

				<div className={PAGE_GRID}>
					<div className="relative min-w-0 lg:col-[content-start/margin-start]">
						{Bespoke ? (
							<PageBoundary fallback={fallback} resetKey={node.id}>
								<Suspense
									fallback={
										<div className="h-72 animate-pulse bg-[var(--gb-paper-deep)] motion-reduce:animate-none" />
									}
								>
									<Bespoke node={node} />
								</Suspense>
							</PageBoundary>
						) : (
							fallback
						)}
					</div>
					{hasPanel && (
						<div className="mt-[72px] min-w-0 lg:col-[content-start/margin-start]">
							<OntologyPanel node={node} />
						</div>
					)}
				</div>

				<WhereItSits node={node} />

				<SheetColophon
					node={node}
					ontologyLabel={
						hasPanel
							? node.ontologyId
								? conceptView(node.ontologyId).domain
								: "methods"
							: undefined
					}
				/>
			</SheetFrame>

			{(prev || next) && (
				<nav
					aria-label="Previous and next sheet"
					className="mx-auto mt-12 grid max-w-6xl gap-6 px-4 sm:grid-cols-2 sm:px-0"
				>
					{[
						{ n: prev, dir: "prev" as const },
						{ n: next, dir: "next" as const },
					].map(({ n, dir }) =>
						n ? (
							<Link
								key={dir}
								to="/gipfelbuch/$concept"
								params={{ concept: n.id }}
								viewTransition={sheetTransition()}
								className={`block hover:brightness-95 ${dir === "next" ? "sm:col-start-2" : ""}`}
							>
								<Signpost
									direction={dir}
									kicker={`${dir === "prev" ? "Previous" : "Next"} sheet`}
									title={n.title}
									subtitle={signpostDistance(node.id, n.id)}
								/>
							</Link>
						) : null,
					)}
				</nav>
			)}

			<footer className="mx-auto mt-12 max-w-6xl px-4 sm:px-0">
				<div>
					<Link
						to="/gipfelbuch"
						viewTransition={sheetTransition()}
						className={`${TYPE.caption} inline-flex items-center gap-2 text-[var(--gb-ink)] hover:text-[var(--gb-red)]`}
					>
						<ArrowLeft className="size-4" /> Back to the Gipfelbuch
					</Link>
				</div>
			</footer>
		</main>
	);
}

/** ✓ / ✗ on a picker thumb: whether the solve accepted that photo. */
function PhotoMark({ id }: { id: GipfelbuchPhotoId }) {
	const index = useGipfelbuchIndex();
	const row = index?.photos.find((p) => p.id === id);
	if (!row) return null;
	return (
		<span
			className={`${TYPE.micro} px-0.5 ${row.accepted ? "text-[var(--gb-forest)]" : "text-[var(--gb-red)]"} bg-[var(--gb-paper)]`}
		>
			{row.accepted ? "✓" : "✗"}
		</span>
	);
}

/** A rich link card to another sheet. */
export function NodeCard({
	node,
	rel,
	dir,
}: {
	node: GipfelbuchNode;
	rel?: string;
	dir?: "in" | "out";
}) {
	const c = groupColor(node.group);
	const G = GROUP_BY_ID[node.group];
	return (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: node.id }}
			viewTransition={sheetTransition()}
			className="group relative block py-3 pr-2 transition hover:bg-[var(--gb-paper-deep)]"
		>
			<div
				className={`${TYPE.kicker} flex items-center gap-1.5 tracking-[0.14em]`}
				style={{ color: c }}
			>
				<G.icon className="size-3" strokeWidth={1.6} />
				{G.label}
				<span className="ml-auto flex items-center gap-1.5 text-[var(--gb-ink)]">
					<Waymark variant={waymarkForStatus(node.status)}>
						{STATUS_META[node.status].label}
					</Waymark>
				</span>
			</div>
			<div className={`${TYPE.h3} mt-1 flex items-start gap-1`}>
				{node.title}
				<ArrowUpRight className="mt-1 size-3.5 shrink-0 opacity-30 transition group-hover:opacity-80" />
			</div>
			<p className={`${TYPE.caption} mt-0.5`}>{node.claim ?? node.tagline}</p>
			{rel && (
				<p className={`${TYPE.micro} mt-1.5`}>
					{dir === "in" ? "← " : "→ "}
					{rel}
				</p>
			)}
		</Link>
	);
}

function ConnectionGroup({
	title,
	edges,
	dir,
}: {
	title: string;
	edges: GipfelbuchEdge[];
	dir: "in" | "out";
}) {
	if (!edges.length) return null;
	return (
		<div>
			<h3
				className={`${TYPE.kicker} relative mb-4 flex items-center gap-2 pb-2 tracking-[0.16em]`}
			>
				{dir === "out" ? (
					<ArrowRight className="size-3.5 text-[var(--accent)]" />
				) : (
					<ArrowLeft className="size-3.5 text-[var(--accent)]" />
				)}
				{title}
				<span className="gb-coord">{edges.length}</span>
			</h3>
			<div className="space-y-5">
				{groupByRel(edges).map(([rel, es]) => (
					<div key={rel}>
						<p className={`${TYPE.caption} mb-1 italic`}>
							{dir === "out" ? `this ${rel}` : `${rel} this`}
						</p>
						<div className="grid sm:grid-cols-2 sm:gap-x-6">
							{es.map((e) => {
								const n = byId.get(e.id);
								return n ? (
									<NodeCard
										key={e.id}
										node={n}
										rel={
											e.origin === "ontology" ? `${rel} · from ontology` : rel
										}
										dir={dir}
									/>
								) : null;
							})}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** "Where it sits": the notebook trail around this sheet, then its curated links in and out. */
function WhereItSits({ node }: { node: GipfelbuchNode }) {
	const out = outgoing(node.id);
	const back = backlinks(node.id);
	return (
		<section className="px-6 pt-8 pb-10" aria-labelledby="connections">
			<Reveal>
				<p
					className={`${TYPE.kicker} mb-2 tracking-[0.18em] text-[var(--gb-red)]`}
				>
					Where it sits
				</p>
				<h2 id="connections" className={TYPE.h2}>
					Connections
				</h2>
			</Reveal>
			<Reveal className="mt-6">
				<NotebookTrail id={node.id} />
			</Reveal>
			{out.length + back.length > 0 && (
				<div className="mt-10 grid gap-12 lg:grid-cols-2">
					<ConnectionGroup title="Leads to" edges={out} dir="out" />
					<ConnectionGroup title="Referenced by" edges={back} dir="in" />
				</div>
			)}
		</section>
	);
}

/** A pen-ruled underline across its (relative) parent, in place of a crisp border. */
function HandRule({
	seed,
	color = "ink",
}: {
	seed: string;
	color?: "ink" | "brown";
}) {
	return (
		<svg
			className="pointer-events-none absolute inset-x-0 bottom-0 h-[4px] w-full overflow-visible"
			viewBox="0 0 400 4"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<SketchPath
				d="M0 2L400 2"
				seed={seed}
				color={color}
				width={1}
				opacity={0.7}
				passes={1}
			/>
		</svg>
	);
}
