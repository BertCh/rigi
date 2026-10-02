// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
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
	signpostKicker,
} from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchEdge, GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { AutoVisual } from "./AutoVisual";
import { bespokePage, PageBoundary } from "./loadPage";
import {
	FieldNotes,
	NotebookTrail,
	placeConcept,
} from "./notebook/ConceptNotes";
import { STEP_NUMBER } from "./notebook/entries";
import { SketchDefs } from "./notebook/Ink";
import { useNotebookPhoto } from "./notebook/useNotebookPhoto";
import { OntologyPanel } from "./OntologyPanel";
import {
	ContourField,
	GB_THEME,
	RegisterEntry,
	SheetFrame,
	SheetStamp,
	Signpost,
	useSheet,
	Waymark,
	waymarkForStatus,
} from "./swiss";
import { HandRule, ListArrow, MarkerUnderline } from "./swiss/hand";
import { TYPE } from "./swiss/type";
import {
	DevFold,
	Ledger,
	PAGE_HERO,
	SHEETS,
	SheetColophon,
	stepOf,
	Tafel,
} from "./tafel";
import { Figure } from "./viz";
import { sheetTransition } from "./viz/hooks";
import { Reveal } from "./viz/Reveal";
import {
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	PhotoPicker,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "./viz/real";

/** Data stand shown in the imprint. Update on each data bake. */
const STAND = "2026-10";

/** The register initials of whoever took the demo photographs and keeps the book. */
const REGISTER_INITIALS = "R. C.";

// G5/G6: page grid on named lines (design book). Columns 3-8 carry the text (at most 66 ch); the
// margin (9-12) is MarginNote's lane beside the prose. The hand pass (reports/gipfelbuch.md, Canon:
// Layout) opens every sheet as a summit-register entry: the register line, the lettered
// name with a marker underline, the claim as a hand note and the sheet's one stamp, then the
// full-bleed Tafel.
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

/** ① .. ⑳: the notebook's circled step numbers, as written in the margin. */
const circled = (n: number) =>
	n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;

/** "Route:" of the register entry: the notebook entry and the pipeline step this sheet records. */
function registerRoute(id: string): string | undefined {
	const placement = placeConcept(id);
	if (!placement) return undefined;
	const { entry, step } = placement;
	if (!step) return entry.title;
	const number = STEP_NUMBER.get(step.id);
	return `${entry.title} ${number ? `${circled(number)} ` : ""}${step.label}`;
}

const SWISS_DATE = new Intl.DateTimeFormat("de-CH", {
	timeZone: "Europe/Zurich",
	day: "numeric",
	month: "numeric",
	year: "numeric",
});
const SWISS_TIME = new Intl.DateTimeFormat("de-CH", {
	timeZone: "Europe/Zurich",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

/** A register date ("7.9.2026") from an ISO string; undefined when it does not parse. */
function registerDate(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
	return Number.isNaN(date.getTime()) ? undefined : SWISS_DATE.format(date);
}

/**
 * The register line from the photo the reader follows: when it was taken (local Swiss time),
 * where (the demo place and the measured ground altitude at the camera) and by whom. No weather was
 * recorded with the demo photos, so none is written.
 */
function useRegister(data: GipfelbuchPhotoData | null) {
	const index = useGipfelbuchIndex();
	const place = index?.place.split(" · ")[0]?.replace(/ above .*$/, "");
	const taken = data?.photo.takenAt ? new Date(data.photo.takenAt) : null;
	const valid = taken && !Number.isNaN(taken.getTime());
	return {
		date: valid ? SWISS_DATE.format(taken) : undefined,
		time: valid ? SWISS_TIME.format(taken) : undefined,
		place,
		altitude: data?.gps.ground,
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
	const register = useRegister(data);
	const figures = SHEETS[node.id];
	const step = stepOf(node.id);
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
	const hasPanel = !!node.ontologyId || !!node.methodIds?.length;
	const fallback = (
		<Figure
			label="Constellation"
			caption={<>Drawn from this sheet's links.</>}
			pad={false}
		>
			<div className="px-2 py-6">
				<AutoVisual node={node} />
			</div>
		</Figure>
	);
	// the stamp dates the sheet by its data stand: the day the measured run was baked
	const stampDate =
		registerDate(data?.generated) ?? STAND.split("-").reverse().join(".");
	const here = {
		name: node.title,
		detail: `Blatt ${sheetNo} / ${total}`,
	};

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
				imprint={`Rigi Gipfelbuch · Blatt ${sheetNo} · Stand ${STAND} · Grundlage © swisstopo · Höhen Mapterhorn`}
			>
				<header className="relative grid gap-x-6 gap-y-10 overflow-hidden px-6 pt-10 pb-12 lg:grid-cols-12 lg:items-start">
					{/* the sheet's own pencil contours behind the title: a different crop on every sheet */}
					<ContourField seed={node.id} opacity={0.22} />
					<div className="relative min-w-0 lg:col-span-12">
						{/* the summit-register entry that opens the sheet */}
						<RegisterEntry
							date={register.date}
							time={register.time}
							place={register.place}
							altitude={register.altitude}
							initials={REGISTER_INITIALS}
							route={registerRoute(node.id)}
						/>
					</div>
					<div className="relative min-w-0 lg:col-span-8">
						<nav
							aria-label="Breadcrumb"
							className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
						>
							<Link
								to="/gipfelbuch"
								viewTransition={sheetTransition()}
								className="nb-label text-[13px] tracking-[0.1em] hover:underline"
							>
								Gipfelbuch
							</Link>
							<span
								className="nb-hand text-[var(--gb-secondary)]"
								aria-hidden="true"
							>
								›
							</span>
							<Link
								to="/gipfelbuch"
								hash={step ? `chapter-${step.chapter.ids[0]}` : undefined}
								className="nb-label text-[13px] tracking-[0.1em] hover:underline"
								style={{ color: col }}
							>
								{step
									? `Kapitel ${step.chapter.numeral} · ${step.chapter.title}`
									: G.label}
							</Link>
							{step && (
								<>
									<span
										className="nb-hand text-[var(--gb-secondary)]"
										aria-hidden="true"
									>
										›
									</span>
									<span
										aria-current="page"
										className="nb-num text-[15px] text-[var(--gb-red)]"
									>
										{step.label}
									</span>
								</>
							)}
						</nav>
						<p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
							<Waymark variant={waymarkForStatus(node.status)}>
								{STATUS_META[node.status].label}
							</Waymark>
							{hasPanel && (
								<a
									href="#ontology"
									className={`${TYPE.handLabel} underline decoration-[var(--gb-red)] underline-offset-4 hover:text-[var(--gb-red)]`}
								>
									Glossar
								</a>
							)}
						</p>
						<div className="relative mt-4 inline-block max-w-full">
							<h1
								className={`${TYPE.display} m-0 sm:text-[72px] sm:leading-[72px]`}
							>
								{node.title}
							</h1>
							<MarkerUnderline seed={`title-${node.id}`} />
						</div>
						<p className="nb-hand mt-3 max-w-[40ch] origin-left -rotate-1 text-[24px] leading-[28px] text-[var(--gb-water)] sm:text-[28px] sm:leading-[32px]">
							{node.claim ?? node.tagline}
						</p>
						<p className={`${TYPE.lead} mt-6 max-w-[640px]`}>
							{node.lede ?? node.summary}
						</p>
					</div>
					<div className="relative min-w-0 space-y-6 lg:col-span-4">
						<div className="flex justify-end">
							<SheetStamp
								sheet={sheetNo}
								status={node.status}
								date={stampDate}
								seed={node.id}
							/>
						</div>
						{figures && data && (
							<Ledger
								items={figures.ledger(data)}
								note="from this photo's run"
							/>
						)}
						<FieldNotes
							id={node.id}
							strip={false}
							className="relative min-w-0 py-3"
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
					<p className={`${TYPE.hand} gb-secondary mt-1`}>
						Pick a photo: every number here comes from its run.
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

				<SheetColophon node={node} hasGlossary={hasPanel} />
				<DevFold node={node} />
			</SheetFrame>

			{(prev || next) && (
				<nav
					aria-label="Previous and next sheet"
					className="mx-auto mt-12 grid max-w-6xl gap-6 px-4 sm:grid-cols-2 sm:px-6 xl:px-0"
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
									kicker={signpostKicker(
										dir,
										step?.chapter.numeral,
										stepOf(n.id)?.chapter.numeral,
									)}
									title={n.title}
									subtitle={stepOf(n.id)?.label}
									// one Standortfeld under the post: on the next sign, or on the last sheet's back sign
									here={dir === "next" || !next ? here : undefined}
								>
									<span className={`${TYPE.caption} block max-w-[28ch]`}>
										{n.claim ?? n.tagline}
									</span>
								</Signpost>
							</Link>
						) : null,
					)}
				</nav>
			)}

			<footer className="mx-auto mt-12 max-w-6xl px-4 sm:px-6 xl:px-0">
				<Link
					to="/gipfelbuch"
					viewTransition={sheetTransition()}
					className="nb-hand inline-flex items-center gap-2 text-[20px] text-[var(--gb-ink)] hover:text-[var(--gb-red)]"
				>
					<ListArrow seed="back-to-book" dir="in" color="ink" /> Zurück zum
					Gipfelbuch
				</Link>
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
			className={`nb-hand px-0.5 text-[16px] leading-none ${row.accepted ? "text-[var(--gb-forest)]" : "text-[var(--gb-red)]"} bg-[var(--gb-paper)]`}
		>
			{row.accepted ? "✓" : "✗"}
		</span>
	);
}

/** A link to another sheet, written as a line in a hand list: pen arrow, lettered title, the claim as a note. */
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
	const blatt = GIPFELBUCH_NODES.findIndex((n) => n.id === node.id) + 1;
	return (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: node.id }}
			viewTransition={sheetTransition()}
			className="group relative flex items-start gap-2 py-2 pr-2"
		>
			<span className="mt-1.5">
				<ListArrow
					seed={`link-${dir ?? "out"}-${node.id}`}
					dir={dir === "in" ? "in" : "out"}
				/>
			</span>
			<span className="min-w-0">
				<span className="flex flex-wrap items-baseline gap-x-3">
					<span className="nb-hand text-[24px] leading-[28px] text-[var(--gb-ink)] group-hover:text-[var(--gb-red)] group-hover:underline group-hover:decoration-[var(--gb-red)] group-hover:underline-offset-4">
						{node.title}
					</span>
					<span className="nb-num text-[12px] italic text-[var(--gb-secondary)]">
						Blatt {String(blatt).padStart(2, "0")}
					</span>
					<span
						className="nb-label text-[12px] tracking-[0.08em]"
						style={{ color: c }}
					>
						{G.label}
					</span>
					<Waymark variant={waymarkForStatus(node.status)}>
						<span className="sr-only">{STATUS_META[node.status].label}</span>
					</Waymark>
				</span>
				<span className={`${TYPE.caption} block`}>
					{node.claim ?? node.tagline}
				</span>
				{rel && (
					<span className="nb-hand block text-[17px] leading-[20px] text-[var(--gb-pencil)]">
						{dir === "in" ? "← " : "→ "}
						{rel}
					</span>
				)}
			</span>
		</Link>
	);
}

/** A relation slug written with spaces ("seeded-by" becomes "seeded by"). */
const spaced = (rel: string) => rel.replace(/[-_]/g, " ");

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
			<div className="relative mb-3 inline-block pr-6">
				<h3 className={`${TYPE.h3} m-0 text-[24px] leading-[28px]`}>
					{title}{" "}
					<span className="nb-num text-[14px] font-normal italic text-[var(--gb-secondary)]">
						({edges.length})
					</span>
				</h3>
				<MarkerUnderline seed={`where-${dir}`} color="var(--gb-contour)" />
			</div>
			<div className="space-y-4">
				{groupByRel(edges).map(([rel, es]) => (
					<div key={rel}>
						<p className="nb-hand m-0 text-[18px] leading-[22px] text-[var(--gb-secondary)]">
							{dir === "out"
								? `this ${spaced(rel)} …`
								: `… ${spaced(rel)} this`}
						</p>
						<ul className="m-0 list-none p-0">
							{es.map((e) => {
								const n = byId.get(e.id);
								return n ? (
									<li key={e.id}>
										<NodeCard node={n} rel={spaced(rel)} dir={dir} />
									</li>
								) : null;
							})}
						</ul>
					</div>
				))}
			</div>
		</div>
	);
}

/** "Where it sits": the notebook trail around this sheet, then its curated links in and out, as hand lists. */
function WhereItSits({ node }: { node: GipfelbuchNode }) {
	const out = outgoing(node.id);
	const back = backlinks(node.id);
	return (
		<section className="px-6 pt-8 pb-10" aria-labelledby="connections">
			<Reveal>
				<p className="nb-hand m-0 text-[20px] leading-[24px] text-[var(--gb-red)]">
					Umgebung
				</p>
				<div className="relative inline-block">
					<h2 id="connections" className={`${TYPE.h2} m-0`}>
						Connections
					</h2>
					<MarkerUnderline seed={`connections-${node.id}`} />
				</div>
			</Reveal>
			<Reveal className="mt-6">
				<NotebookTrail id={node.id} />
			</Reveal>
			{out.length + back.length > 0 && (
				<div className="mt-10 grid gap-12 lg:grid-cols-2">
					<ConnectionGroup title="Leads to" edges={out} dir="out" />
					<ConnectionGroup title="Comes from" edges={back} dir="in" />
				</div>
			)}
		</section>
	);
}
