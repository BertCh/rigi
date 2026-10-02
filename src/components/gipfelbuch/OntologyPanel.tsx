// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { byId } from "#/lib/gipfelbuch/graph-utils";
import {
	type ConceptRef,
	conceptView,
	methodModules,
	methodView,
	type PartView,
} from "#/lib/gipfelbuch/ontology";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { TYPE } from "./swiss/type";
import { CodeRef as BaseCodeRef } from "./viz";
import { Details } from "./viz/explain";

/** viz CodeRef with the global `code` border/padding/background reset (styles.css leaks onto it). */
const CodeRef = ({ path }: { path: string }) => (
	<BaseCodeRef path={path} className={`px-2 py-1 ${TYPE.micro}`} />
);

const Label = ({ children }: { children: ReactNode }) => (
	<h4
		className={`${TYPE.hand} mb-1 font-normal text-[var(--gb-contour,currentColor)]`}
	>
		{children}
	</h4>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[110px_minmax(0,1fr)]">
		<Label>{label}</Label>
		<div className="min-w-0">{children}</div>
	</div>
);

const Word = ({
	children,
	title,
	strike,
}: {
	children: ReactNode;
	title?: string;
	strike?: boolean;
}) => (
	<span
		title={title}
		className={`px-1 py-1 font-mono ${TYPE.micro} ${strike ? "gb-secondary line-through decoration-[var(--gb-red)] decoration-[1.5px]" : "text-[var(--gb-ink)]"}`}
	>
		{children}
	</span>
);

/** Concept name that links to its gipfelbuch node when one exists. */
function Ref({ r }: { r: ConceptRef }) {
	const cls = `${TYPE.caption} !text-[var(--gb-ink)]`;
	return r.nodeId ? (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: r.nodeId }}
			className={`${cls} underline decoration-[var(--gb-water,currentColor)]/50 underline-offset-4 transition hover:text-[var(--gb-red)]`}
		>
			{byId.get(r.nodeId)?.title ?? r.label}
		</Link>
	) : (
		<span className={cls}>{r.label}</span>
	);
}

function PartList({ parts }: { parts: PartView[] }) {
	return (
		<ul className="space-y-1.5">
			{parts.map((p) => (
				<li
					key={`${p.concept}.${p.role}`}
					className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1"
				>
					<Ref r={p} />
					<span className={TYPE.caption}>
						as {p.role.replace(/[-_]/g, " ")}
					</span>
				</li>
			))}
		</ul>
	);
}

const Links = ({ refs }: { refs: ConceptRef[] }) => (
	<div className="flex flex-wrap gap-x-4 gap-y-1.5">
		{refs.map((r) => (
			<Ref key={r.concept} r={r} />
		))}
	</div>
);

/** The sheet's glossary fold: plain definition, relations and method, collapsed; a #ontology hash (link or load) opens it. */
export function OntologyPanel({ node }: { node: GipfelbuchNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const openOnHash = () => {
			if (window.location.hash !== "#ontology") return;
			const details = ref.current?.querySelector("details");
			if (!details) return;
			details.open = true;
			const reduce = window.matchMedia(
				"(prefers-reduced-motion: reduce)",
			).matches;
			details.scrollIntoView({
				behavior: reduce ? "auto" : "smooth",
				block: "start",
			});
		};
		openOnHash();
		window.addEventListener("hashchange", openOnHash);
		return () => window.removeEventListener("hashchange", openOnHash);
	}, []);
	const hasContent = !!node.ontologyId || !!node.methodIds?.length;
	if (!hasContent) return null;
	return (
		<div ref={ref}>
			<Details title="Glossar">
				<OntologyBody node={node} />
			</Details>
		</div>
	);
}

function OntologyBody({ node }: { node: GipfelbuchNode }) {
	const c = node.ontologyId ? conceptView(node.ontologyId) : undefined;
	const methods = (node.methodIds ?? []).map(methodView);
	// "Also called": the UI words, minus the ones that only repeat the sheet or concept name
	const named = new Set([node.title.toLowerCase(), c?.label.toLowerCase()]);
	const alias = c ? c.ui.filter((w) => !named.has(w.toLowerCase())) : [];

	return (
		<section id="ontology" aria-label="Glossar" className="scroll-mt-6 py-6">
			{c && <p className={`${TYPE.body} max-w-[62ch]`}>{c.definition}</p>}
			<div className="mt-6 space-y-6">
				{alias.length > 0 && (
					<Row label="Also called">
						<div className="flex flex-wrap items-center gap-1.5">
							{alias.map((w) => (
								<Word key={w}>{w}</Word>
							))}
						</div>
					</Row>
				)}
				{c?.parent && (
					<Row label="Is a">
						<Links refs={[c.parent]} />
					</Row>
				)}
				{c && c.children.length > 0 && (
					<Row label="Kinds">
						<Links refs={c.children} />
					</Row>
				)}
				{c && c.parts.length > 0 && (
					<Row label="Has">
						<PartList parts={c.parts} />
					</Row>
				)}
				{c && c.partOf.length > 0 && (
					<Row label="Part of">
						<PartList parts={c.partOf} />
					</Row>
				)}
				{methods.length > 0 && (
					<Row label={methods.length > 1 ? "Methods" : "Method"}>
						<div className="space-y-3">
							{methods.map((m) => (
								<div key={m.id} className="flex flex-wrap items-center gap-2">
									<span className={`${TYPE.hand} text-[var(--gb-ink)]`}>
										{m.label}
									</span>
									<span
										title={m.agentBlurb}
										className={`${TYPE.handLabel} px-1 text-[var(--gb-red,var(--accent))]`}
									>
										{m.agent}
									</span>
								</div>
							))}
						</div>
					</Row>
				)}
			</div>
		</section>
	);
}

/**
 * The developer rows of the ontology (code and avoided words, shapes, frame, identity, storage,
 * method modules), for the sheet's "Für Entwickler" fold. `note` is never rendered.
 */
export function OntologyDevRows({ node }: { node: GipfelbuchNode }) {
	const c = node.ontologyId ? conceptView(node.ontologyId) : undefined;
	const methods = (node.methodIds ?? []).map(methodView);
	const canonical = c?.realizations.find((r) => r.canonical);
	const homonym = c && c.realizations.length > 1;
	const methodFiles = [...new Set(methods.flatMap((m) => m.modules))];
	const estimates = methods.filter((m) => m.estimates.length > 0);
	const hasWords = !!c && (c.code.length > 0 || c.avoid.length > 0);
	if (!c && methodFiles.length === 0 && estimates.length === 0) return null;

	return (
		<div className="space-y-6">
			{c && hasWords && (
				<Row label="Words">
					<div className="space-y-2">
						{c.code.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5">
								<span className={`mr-1 ${TYPE.micro} gb-secondary`}>
									in code
								</span>
								{c.code.map((w) => (
									<Word key={w}>{w}</Word>
								))}
							</div>
						)}
						{c.avoid.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5">
								<span className={`mr-1 ${TYPE.micro} gb-secondary`}>avoid</span>
								{c.avoid.map((w) => (
									<Word key={w} strike title={`Avoid "${w}" for this concept`}>
										{w}
									</Word>
								))}
							</div>
						)}
					</div>
				</Row>
			)}
			{c && c.realizations.length > 0 && (
				<Row label="Shapes">
					<ul className="space-y-1.5">
						{c.realizations.map((r) => (
							<li key={r.key} className="flex flex-wrap items-center gap-2">
								<span
									className={`font-mono ${TYPE.caption} !text-[var(--gb-ink)]`}
								>
									{r.exportName}
								</span>
								<CodeRef path={r.file} />
								{r.canonical && homonym && (
									<span
										className={`${TYPE.handLabel} text-[var(--gb-contour,var(--accent))]`}
									>
										canonical
									</span>
								)}
							</li>
						))}
					</ul>
					{homonym && canonical && (
						<p className={`mt-2.5 max-w-[60ch] ${TYPE.caption}`}>
							Several types share this concept; {canonical.exportName} is the
							canonical shape.
						</p>
					)}
				</Row>
			)}
			{c?.frame && (
				<Row label="Frame">
					<p className={`max-w-[62ch] ${TYPE.caption}`}>{c.frame}</p>
				</Row>
			)}
			{c && c.ids.length > 0 && (
				<Row label="Identity">
					<ul className="space-y-2">
						{c.ids.map((i) => (
							<li key={i.kind} className={`${TYPE.caption}`}>
								<span className="text-[var(--gb-ink)]">{i.kind}</span>
								<span
									className={`ml-2 px-1.5 py-0.5 font-mono ${TYPE.micro} gb-secondary`}
								>
									{i.example}
								</span>
								<span className={`${TYPE.handLabel} gb-secondary ml-2`}>
									{i.stable ? "stable" : "not stable"} · {i.mintedBy}
								</span>
								{i.note && (
									<span className={`mt-0.5 block ${TYPE.caption}`}>
										{i.note}
									</span>
								)}
							</li>
						))}
					</ul>
				</Row>
			)}
			{c && c.storage.length > 0 && (
				<Row label="Persisted as">
					<ul className="space-y-2.5">
						{c.storage.map((s) => (
							<li key={s.id}>
								<div className="flex flex-wrap items-center gap-2">
									<Word>{s.medium}</Word>
									<span className={`font-mono ${TYPE.caption}`}>{s.key}</span>
									{s.version != null && (
										<span className={`font-mono ${TYPE.micro} gb-secondary`}>
											v{s.version}
										</span>
									)}
									{methodModules(s.module).map((m) => (
										<CodeRef key={m} path={m} />
									))}
								</div>
								<p className={`mt-1 max-w-[60ch] ${TYPE.caption}`}>{s.holds}</p>
							</li>
						))}
					</ul>
				</Row>
			)}
			{estimates.length > 0 && (
				<Row label="Estimates">
					<ul className="space-y-1">
						{estimates.map((m) => (
							<li key={m.id} className={TYPE.caption}>
								{m.label}: {m.estimates.join(", ")}
							</li>
						))}
					</ul>
				</Row>
			)}
			{methodFiles.length > 0 && (
				<Row label="Method code">
					<div className="flex flex-wrap gap-1.5">
						{methodFiles.map((p) => (
							<CodeRef key={p} path={p} />
						))}
					</div>
				</Row>
			)}
		</div>
	);
}
