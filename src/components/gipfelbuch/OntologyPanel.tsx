// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
	type ConceptRef,
	conceptView,
	findingsFor,
	methodModules,
	methodView,
	type PartView,
} from "#/lib/gipfelbuch/ontology";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { MarkerUnderline } from "./swiss/hand";
import { CodeRef as BaseCodeRef } from "./viz";

/** viz CodeRef with the global `code` border/padding/background reset (styles.css leaks onto it). */
const CodeRef = ({ path }: { path: string }) => (
	<BaseCodeRef path={path} className="px-2 py-1 text-[11px]" />
);

const Label = ({ children }: { children: ReactNode }) => (
	<h4 className="nb-hand mb-1 text-[19px] leading-[22px] font-normal text-[var(--gb-contour,currentColor)]">
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
		className={`px-1 py-1 font-mono text-[11px] leading-none ${strike ? "text-[var(--gb-secondary,#4a545c)] line-through decoration-[var(--gb-red)] decoration-[1.5px]" : "text-[var(--gb-secondary,#4a545c)]"}`}
	>
		{children}
	</span>
);

/** Concept name that links to its gipfelbuch node when one exists. */
function Ref({ r }: { r: ConceptRef }) {
	const cls = "text-[13px] text-[var(--gb-ink)]";
	return r.nodeId ? (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: r.nodeId }}
			className={`${cls} underline decoration-[var(--gb-water,currentColor)]/50 underline-offset-4 transition hover:text-[var(--gb-water,var(--rigi-paper))]`}
		>
			{r.label}
		</Link>
	) : (
		<span className={cls}>{r.label}</span>
	);
}

const Card = ({ card }: { card: string }) => (
	<span className="nb-hand text-[18px] leading-none text-[var(--gb-red,var(--accent))]">
		{card}
	</span>
);

function PartList({
	parts,
	inverse,
}: {
	parts: PartView[];
	inverse?: boolean;
}) {
	return (
		<ul className="space-y-1.5">
			{parts.map((p) => (
				<li
					key={`${p.concept}.${p.role}`}
					className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1"
				>
					<Card card={p.card} />
					<Ref r={p} />
					<span className="text-[13px] text-[var(--gb-secondary,#4a545c)]">
						{inverse ? `as its ${p.role}` : `as ${p.role}`}
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

export function OntologyPanel({ node }: { node: GipfelbuchNode }) {
	const c = node.ontologyId ? conceptView(node.ontologyId) : undefined;
	const methods = (node.methodIds ?? []).map(methodView);
	const findings = findingsFor(node);
	if (!c && !methods.length && !findings.length) return null;
	const canonical = c?.realizations.find((r) => r.canonical);
	const homonym = c && c.realizations.length > 1;

	return (
		<section
			id="ontology"
			aria-labelledby="ontology-h"
			className="scroll-mt-6 py-6"
		>
			<p className="nb-hand mb-1 text-[20px] leading-[24px] text-[var(--gb-contour,var(--accent))]">
				Ontology{c ? ` · ${c.domain}` : ""}
			</p>
			{c && (
				<>
					<div className="relative inline-block">
						<h2
							id="ontology-h"
							className="m-0 text-[24px] leading-[28px] sm:text-[30px] sm:leading-[34px]"
						>
							{c.label}
						</h2>
						<MarkerUnderline seed={`ontology-${c.label}`} />
					</div>
					<p className="mt-3 max-w-[62ch] text-[16px] leading-[24px] text-[var(--gb-secondary,#4a545c)]">
						{c.definition}
					</p>
					<p className="mt-2 text-[13px] text-[var(--gb-secondary,#4a545c)]">
						{c.domainBlurb}
					</p>
				</>
			)}
			{!c && (
				<div className="relative inline-block">
					<h2
						id="ontology-h"
						className="m-0 text-[24px] leading-[28px] sm:text-[30px] sm:leading-[34px]"
					>
						How it is made
					</h2>
					<MarkerUnderline seed="ontology-how" />
				</div>
			)}

			<div className="mt-7 space-y-6 pt-6">
				{c && (c.ui.length > 0 || c.code.length > 0 || c.avoid.length > 0) && (
					<Row label="Words">
						<div className="space-y-2">
							{c.ui.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11px] text-[var(--gb-secondary,#4a545c)]">
										in the UI
									</span>
									{c.ui.map((w) => (
										<Word key={w}>{w}</Word>
									))}
								</div>
							)}
							{c.code.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11px] text-[var(--gb-secondary,#4a545c)]">
										in code
									</span>
									{c.code.map((w) => (
										<Word key={w}>{w}</Word>
									))}
								</div>
							)}
							{c.avoid.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11px] text-[var(--gb-secondary,#4a545c)]">
										avoid
									</span>
									{c.avoid.map((w) => (
										<Word
											key={w}
											strike
											title={`Avoid "${w}" for this concept`}
										>
											{w}
										</Word>
									))}
								</div>
							)}
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
						<PartList parts={c.partOf} inverse />
					</Row>
				)}
				{c && c.realizations.length > 0 && (
					<Row label="Shapes">
						<ul className="space-y-1.5">
							{c.realizations.map((r) => (
								<li key={r.key} className="flex flex-wrap items-center gap-2">
									<span className="font-mono text-[13px] text-[var(--gb-ink)]">
										{r.exportName}
									</span>
									<CodeRef path={r.file} />
									{r.canonical && homonym && (
										<span className="nb-hand text-[18px] text-[var(--gb-contour,var(--accent))]">
											canonical
										</span>
									)}
								</li>
							))}
						</ul>
						{homonym && canonical && (
							<p className="mt-2.5 max-w-[60ch] text-[13px] leading-[18px] text-[var(--gb-secondary,#4a545c)]">
								Several types share this concept; {canonical.exportName} is the
								canonical shape.
							</p>
						)}
					</Row>
				)}
				{c?.frame && (
					<Row label="Frame">
						<p className="max-w-[62ch] text-[13px] leading-relaxed text-[var(--gb-secondary,#4a545c)]">
							{c.frame}
						</p>
					</Row>
				)}
				{c?.note && (
					<Row label="Note">
						<p className="max-w-[62ch] text-[13px] leading-relaxed text-[var(--gb-secondary,#4a545c)]">
							{c.note}
						</p>
					</Row>
				)}
				{c && c.ids.length > 0 && (
					<Row label="Identity">
						<ul className="space-y-2">
							{c.ids.map((i) => (
								<li
									key={i.kind}
									className="text-[13px] text-[var(--gb-secondary,#4a545c)]"
								>
									<span className="text-[var(--gb-ink)]">{i.kind}</span>
									<span className="ml-2 px-1.5 py-0.5 font-mono text-[11px] text-[var(--gb-secondary,#4a545c)]">
										{i.example}
									</span>
									<span className="nb-hand ml-2 text-[17px] text-[var(--gb-secondary,#4a545c)]">
										{i.stable ? "stable" : "not stable"} · {i.mintedBy}
									</span>
									{i.note && (
										<span className="mt-0.5 block text-[13px] text-[var(--gb-secondary,#4a545c)]">
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
										<span className="font-mono text-[13px] text-[var(--gb-secondary,#4a545c)]">
											{s.key}
										</span>
										{s.version != null && (
											<span className="font-mono text-[11px] text-[var(--gb-secondary,#4a545c)]">
												v{s.version}
											</span>
										)}
										{methodModules(s.module).map((m) => (
											<CodeRef key={m} path={m} />
										))}
									</div>
									<p className="mt-1 max-w-[60ch] text-[13px] leading-[18px] text-[var(--gb-secondary,#4a545c)]">
										{s.holds}
									</p>
								</li>
							))}
						</ul>
					</Row>
				)}
				{methods.length > 0 && (
					<Row label={methods.length > 1 ? "Methods" : "Method"}>
						<div className="space-y-5">
							{methods.map((m) => (
								<div key={m.id}>
									<div className="flex flex-wrap items-center gap-2">
										<span className="nb-hand text-[22px] leading-[26px] text-[var(--rigi-paper)]">
											{m.label}
										</span>
										<span
											title={m.agentBlurb}
											className="nb-hand px-1 text-[19px] leading-none text-[var(--gb-red,var(--accent))]"
										>
											{m.agent}
										</span>
									</div>
									{m.evidence.length > 0 && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{m.evidence.map((e) => (
												<Word key={e.id} title={e.blurb}>
													{e.id}
												</Word>
											))}
										</div>
									)}
									{m.estimates.length > 0 && (
										<p className="mt-2 text-[13px] text-[var(--gb-secondary,#4a545c)]">
											Estimates {m.estimates.join(", ")}
										</p>
									)}
									{m.modules.length > 0 && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{m.modules.map((p) => (
												<CodeRef key={p} path={p} />
											))}
										</div>
									)}
								</div>
							))}
						</div>
					</Row>
				)}
				{findings.length > 0 && (
					<Row label="Known issues">
						<ul className="space-y-4">
							{findings.map((f) => (
								<li key={f.summary} className="pl-4">
									<span className="nb-hand text-[19px] text-[var(--gb-red,var(--accent))]">
										{f.kind}
									</span>
									<p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-[var(--gb-secondary,#4a545c)]">
										{f.summary}
									</p>
									<p className="mt-1 max-w-[62ch] text-[13px] leading-[18px] text-[var(--gb-secondary,#4a545c)]">
										{f.action}
									</p>
								</li>
							))}
						</ul>
					</Row>
				)}
			</div>
		</section>
	);
}
