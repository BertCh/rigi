// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
	ArrowUpRight,
	ChevronRight,
} from "lucide-react";
import { Suspense } from "react";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";
import {
	backlinks,
	byId,
	GROUP_BY_ID,
	groupByRel,
	groupColor,
	KIND_LABEL,
	outgoing,
	STATUS_META,
	siblings,
} from "#/lib/atlas/graph-utils";
import { conceptView, findingsFor } from "#/lib/atlas/ontology";
import type { AtlasEdge, AtlasNode } from "#/lib/atlas/types";
import { AutoVisual } from "./AutoVisual";
import { NeighbourhoodGraph, StatusGlyph } from "./GraphView";
import { bespokePage, PageBoundary } from "./loadPage";
import { OntologyPanel } from "./OntologyPanel";
import { CodeRef, Figure } from "./viz";
import { useInView } from "./viz/hooks";

const Reveal = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => {
	const [ref, on] = useInView();
	return (
		<div
			ref={ref}
			className={`transition duration-1000 ease-out motion-reduce:transition-none ${on ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"} ${className ?? ""}`}
		>
			{children}
		</div>
	);
};

export function Chip({
	children,
	color,
	className,
}: {
	children: React.ReactNode;
	color?: string;
	className?: string;
}) {
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] text-white/70 ring-1 ring-white/12 ${className ?? ""}`}
			style={
				color ? { color, boxShadow: `inset 0 0 0 1px ${color}55` } : undefined
			}
		>
			{children}
		</span>
	);
}

/** A rich link card to another concept. */
export function NodeCard({
	node,
	rel,
	dir,
}: {
	node: AtlasNode;
	rel?: string;
	dir?: "in" | "out";
}) {
	const c = groupColor(node.group);
	const G = GROUP_BY_ID[node.group];
	return (
		<Link
			to="/atlas/$concept"
			params={{ concept: node.id }}
			className="group relative block overflow-hidden rounded-xl bg-white/[0.035] p-4 ring-1 ring-white/9 transition hover:bg-white/[0.065] hover:ring-[color:var(--c)]"
			style={{ "--c": `${c}99` } as React.CSSProperties}
		>
			<span
				className="absolute inset-y-0 left-0 w-[2px] opacity-70"
				style={{ background: c }}
			/>
			<div
				className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase"
				style={{ color: c }}
			>
				<G.icon className="size-3" strokeWidth={1.6} />
				{G.label}
				<span className="ml-auto flex items-center gap-1 text-white/40 normal-case">
					<StatusGlyph status={node.status} on={false} />
					{STATUS_META[node.status].label}
				</span>
			</div>
			<div className="display-title mt-1.5 flex items-start gap-1 text-[17px] leading-snug font-bold text-[var(--rigi-paper)]">
				{node.title}
				<ArrowUpRight className="mt-1 size-3.5 shrink-0 text-white/25 transition group-hover:text-white/80" />
			</div>
			<p className="mt-1 text-[12.5px] leading-snug text-white/52">
				{node.tagline}
			</p>
			{rel && (
				<p className="mt-2.5 font-mono text-[10.5px] text-white/38">
					{dir === "in" ? "← " : "→ "}
					{rel}
				</p>
			)}
		</Link>
	);
}

const fromOntology = (edges: AtlasEdge[], id: string) =>
	edges.find((e) => e.id === id)?.origin === "ontology";

function ConnectionGroup({
	title,
	edges,
	dir,
}: {
	title: string;
	edges: AtlasEdge[];
	dir: "in" | "out";
}) {
	if (!edges.length) return null;
	return (
		<div>
			<h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white/75">
				{dir === "out" ? (
					<ArrowRight className="size-3.5 text-[var(--accent)]" />
				) : (
					<ArrowLeft className="size-3.5 text-[var(--accent)]" />
				)}
				{title}
				<span className="font-mono text-[11px] font-normal text-white/35">
					{edges.length}
				</span>
			</h3>
			<div className="space-y-6">
				{groupByRel(edges).map(([rel, es]) => (
					<div key={rel}>
						<p className="mb-2.5 font-serif text-[13px] text-white/45 italic">
							{dir === "out" ? `this ${rel}` : `${rel} this`}
						</p>
						<div className="grid gap-3 sm:grid-cols-2">
							{es.map((e) => {
								const n = byId.get(e.id);
								return n ? (
									<NodeCard
										key={e.id}
										node={n}
										rel={
											fromOntology([e], e.id) ? `${rel} · from ontology` : rel
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

export function ConceptPage({ node }: { node: AtlasNode }) {
	const col = groupColor(node.group);
	const G = GROUP_BY_ID[node.group];
	const out = outgoing(node.id);
	const back = backlinks(node.id);
	const { prev, next } = siblings(node.id);
	const Bespoke = bespokePage(node.id);
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
			<div className="px-2 py-4">
				<AutoVisual node={node} />
			</div>
		</Figure>
	);

	return (
		<main
			className={`${SITE_THEME} relative pb-24`}
			style={{ "--accent": col } as React.CSSProperties}
		>
			<div
				className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden"
				aria-hidden="true"
			>
				<div
					className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.22] blur-3xl"
					style={{
						background: `radial-gradient(closest-side, ${col}, transparent)`,
					}}
				/>
			</div>
			<div className="relative">
				<SiteNav active="atlas" />
				<header className="mx-auto max-w-6xl px-4 pt-10 pb-6 sm:px-8">
					<nav
						aria-label="Breadcrumb"
						className="mb-8 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-white/40"
					>
						<Link to="/atlas" className="hover:text-[var(--rigi-paper)]">
							Atlas
						</Link>
						<ChevronRight className="size-3" />
						<Link
							to="/atlas"
							hash={`group-${node.group}`}
							className="hover:text-[var(--rigi-paper)]"
							style={{ color: `${col}cc` }}
						>
							{G.label}
						</Link>
						<ChevronRight className="size-3" />
						<span className="text-white/60">{node.title}</span>
					</nav>
					<p
						className="mb-4 flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] uppercase"
						style={{ color: col }}
					>
						<G.icon className="size-4" strokeWidth={1.5} />
						{G.label} · {KIND_LABEL[node.kind]}
					</p>
					<h1 className="display-title max-w-4xl text-[2.6rem] leading-[1.02] font-bold tracking-[-0.02em] sm:text-[3.8rem]">
						{node.title}
					</h1>
					<p className="display-title mt-4 max-w-2xl text-[1.25rem] leading-snug font-medium text-white/60 italic sm:text-[1.45rem]">
						{node.tagline}
					</p>
					<div className="mt-6 flex flex-wrap gap-2">
						<Chip color={col}>
							<G.icon className="size-3" strokeWidth={1.6} />
							{G.label}
						</Chip>
						<Chip>{KIND_LABEL[node.kind]}</Chip>
						<Chip color={STATUS_META[node.status].color}>
							<StatusGlyph status={node.status} />
							{STATUS_META[node.status].label}
						</Chip>
						{hasPanel && (
							<a href="#ontology" className="transition hover:opacity-80">
								<Chip className="text-white/45">
									ontology · {node.ontologyId ?? "methods"}
								</Chip>
							</a>
						)}
					</div>
				</header>

				<div className="mx-auto grid max-w-6xl gap-x-14 px-4 sm:px-8 lg:grid-cols-[minmax(0,1fr)_270px]">
					<article className="min-w-0 max-w-[760px]">
						<p
							className="border-l-2 py-1 pl-5 text-[17px] leading-[1.7] text-white/80"
							style={{ borderColor: col }}
						>
							{node.lede ?? node.summary}
						</p>
						<div className="mt-10">
							{Bespoke ? (
								<PageBoundary fallback={fallback} resetKey={node.id}>
									<Suspense
										fallback={
											<div className="h-64 animate-pulse rounded-2xl bg-white/[0.03]" />
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
							<div className="mt-16">
								<OntologyPanel node={node} />
							</div>
						)}
					</article>
					<aside className="mt-12 lg:mt-0">
						<div className="space-y-8 lg:sticky lg:top-8">
							<Rail title="Status">
								<p className="flex items-center gap-2 text-[13px] text-white/75">
									<StatusGlyph status={node.status} />
									<span style={{ color: STATUS_META[node.status].color }}>
										{STATUS_META[node.status].label}
									</span>
								</p>
								<p className="mt-1 text-[12px] leading-snug text-white/42">
									{STATUS_META[node.status].blurb}
								</p>
							</Rail>
							{hasPanel && (
								<Rail title="Domain">
									<a
										href="#ontology"
										className="text-[13px] text-white/70 hover:text-[var(--rigi-paper)]"
									>
										{node.ontologyId
											? conceptView(node.ontologyId).domain
											: "methods"}
									</a>
								</Rail>
							)}
							{node.lede && (
								<Rail title="Technical summary">
									<p className="text-[12.5px] leading-relaxed text-white/55">
										{node.summary}
									</p>
								</Rail>
							)}
							{node.modules.length > 0 && (
								<Rail title="Code">
									<div className="flex flex-col items-start gap-1.5">
										{node.modules.map((m) => (
											<CodeRef key={m} path={m} />
										))}
									</div>
								</Rail>
							)}
							{node.reports.length > 0 && (
								<Rail title="Reports">
									<div className="flex flex-col items-start gap-1.5">
										{node.reports.map((m) => (
											<CodeRef key={m} path={m} />
										))}
									</div>
								</Rail>
							)}
						</div>
					</aside>
				</div>

				<section
					className="mx-auto mt-20 max-w-6xl px-4 sm:px-8"
					aria-labelledby="connections"
				>
					<Reveal>
						<p className="mb-2 font-mono text-[10.5px] tracking-[0.18em] text-[var(--accent)] uppercase">
							Where it sits
						</p>
						<h2
							id="connections"
							className="display-title text-3xl font-bold tracking-[-0.01em]"
						>
							Connections
						</h2>
					</Reveal>
					<Reveal className="mt-6 overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-white/10">
						<NeighbourhoodGraph
							id={node.id}
							depth={out.length + back.length > 14 ? 1 : 2}
						/>
					</Reveal>
					{out.length + back.length === 0 && (
						<p className="mt-6 text-sm text-white/45">
							Nothing is linked to this concept yet.
						</p>
					)}
					<div className="mt-10 grid gap-12 lg:grid-cols-2">
						<ConnectionGroup title="Leads to" edges={out} dir="out" />
						<ConnectionGroup title="Referenced by" edges={back} dir="in" />
					</div>
				</section>

				{(prev || next) && (
					<nav
						aria-label={`More in ${G.label}`}
						className="mx-auto mt-20 grid max-w-6xl gap-3 px-4 sm:grid-cols-2 sm:px-8"
					>
						{[
							{ n: prev, dir: "Previous" },
							{ n: next, dir: "Next" },
						].map(({ n, dir }) =>
							n ? (
								<Link
									key={dir}
									to="/atlas/$concept"
									params={{ concept: n.id }}
									className={`group rounded-xl p-5 ring-1 ring-white/10 transition hover:bg-white/[0.05] hover:ring-[var(--accent)]/50 ${dir === "Next" ? "text-right" : ""}`}
								>
									<p className="font-mono text-[10.5px] tracking-[0.14em] text-white/40 uppercase">
										{dir} in {G.label}
									</p>
									<p className="display-title mt-1 text-xl font-bold">
										{n.title}
									</p>
									<p className="mt-0.5 text-[12.5px] text-white/50">
										{n.tagline}
									</p>
								</Link>
							) : null,
						)}
					</nav>
				)}
				<div className="mx-auto mt-12 max-w-6xl px-4 sm:px-8">
					<Link
						to="/atlas"
						className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-[var(--rigi-paper)]"
					>
						<ArrowLeft className="size-4" /> Back to the whole atlas
					</Link>
				</div>
			</div>
		</main>
	);
}

function Rail({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<h3 className="mb-2.5 border-b border-white/10 pb-1.5 font-mono text-[10.5px] tracking-[0.18em] text-white/40 uppercase">
				{title}
			</h3>
			{children}
		</div>
	);
}
