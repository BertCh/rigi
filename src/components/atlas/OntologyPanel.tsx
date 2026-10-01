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
} from "#/lib/atlas/ontology";
import type { AtlasNode } from "#/lib/atlas/types";
import { CodeRef as BaseCodeRef } from "./viz";

/** viz CodeRef with the global `code` border/padding/background reset (styles.css leaks onto it). */
const CodeRef = ({ path }: { path: string }) => (
	<BaseCodeRef
		path={path}
		className="border-0 bg-white/[0.06] px-2 py-1 text-[11.5px]"
	/>
);

const Label = ({ children }: { children: ReactNode }) => (
	<h4 className="mb-2 font-mono text-[10.5px] tracking-[0.18em] text-white/40 uppercase">
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
		className={`rounded-md bg-white/[0.05] px-2 py-1 font-mono text-[11.5px] leading-none ring-1 ring-white/8 ${strike ? "text-white/35 line-through decoration-white/30" : "text-white/70"}`}
	>
		{children}
	</span>
);

/** Concept name that links to its atlas node when one exists. */
function Ref({ r }: { r: ConceptRef }) {
	const cls = "text-[13px] text-white/80";
	return r.nodeId ? (
		<Link
			to="/atlas/$concept"
			params={{ concept: r.nodeId }}
			className={`${cls} underline decoration-white/20 underline-offset-4 transition hover:text-[var(--rigi-paper)] hover:decoration-[var(--accent)]`}
		>
			{r.label}
		</Link>
	) : (
		<span className={cls}>{r.label}</span>
	);
}

const Card = ({ card }: { card: string }) => (
	<span className="rounded px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--accent)] ring-1 ring-[var(--accent)]/40">
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
					<span className="font-serif text-[12.5px] text-white/40 italic">
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

export function OntologyPanel({ node }: { node: AtlasNode }) {
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
			className="scroll-mt-8 rounded-2xl bg-white/[0.025] p-6 ring-1 ring-white/10 sm:p-8"
		>
			<p className="mb-1 font-mono text-[10.5px] tracking-[0.18em] text-[var(--accent)] uppercase">
				Ontology{c ? ` · ${c.domain}` : ""}
			</p>
			{c && (
				<>
					<h2
						id="ontology-h"
						className="display-title text-2xl font-bold tracking-[-0.01em]"
					>
						{c.label}
					</h2>
					<p className="mt-3 max-w-[62ch] text-[15px] leading-[1.7] text-white/75">
						{c.definition}
					</p>
					<p className="mt-2 font-serif text-[12.5px] text-white/38 italic">
						{c.domainBlurb}
					</p>
				</>
			)}
			{!c && (
				<h2
					id="ontology-h"
					className="display-title text-2xl font-bold tracking-[-0.01em]"
				>
					How it is made
				</h2>
			)}

			<div className="mt-7 space-y-6 border-t border-white/8 pt-6">
				{c && (c.ui.length > 0 || c.code.length > 0 || c.avoid.length > 0) && (
					<Row label="Words">
						<div className="space-y-2">
							{c.ui.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11.5px] text-white/35">
										in the UI
									</span>
									{c.ui.map((w) => (
										<Word key={w}>{w}</Word>
									))}
								</div>
							)}
							{c.code.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11.5px] text-white/35">
										in code
									</span>
									{c.code.map((w) => (
										<Word key={w}>{w}</Word>
									))}
								</div>
							)}
							{c.avoid.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-[11.5px] text-white/35">
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
									<span className="font-mono text-[12.5px] text-white/85">
										{r.exportName}
									</span>
									<CodeRef path={r.file} />
									{r.canonical && homonym && (
										<span className="font-mono text-[10px] tracking-[0.12em] text-[var(--accent)] uppercase">
											canonical
										</span>
									)}
								</li>
							))}
						</ul>
						{homonym && canonical && (
							<p className="mt-2.5 max-w-[60ch] font-serif text-[12.5px] leading-snug text-white/42 italic">
								Several types share this concept; {canonical.exportName} is the
								canonical shape.
							</p>
						)}
					</Row>
				)}
				{c?.frame && (
					<Row label="Frame">
						<p className="max-w-[62ch] text-[13.5px] leading-relaxed text-white/65">
							{c.frame}
						</p>
					</Row>
				)}
				{c?.note && (
					<Row label="Note">
						<p className="max-w-[62ch] text-[13.5px] leading-relaxed text-white/65">
							{c.note}
						</p>
					</Row>
				)}
				{c && c.ids.length > 0 && (
					<Row label="Identity">
						<ul className="space-y-2">
							{c.ids.map((i) => (
								<li key={i.kind} className="text-[13px] text-white/65">
									<span className="text-white/85">{i.kind}</span>
									<span className="ml-2 rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-white/60">
										{i.example}
									</span>
									<span className="ml-2 font-mono text-[10.5px] text-white/38">
										{i.stable ? "stable" : "not stable"} · {i.mintedBy}
									</span>
									{i.note && (
										<span className="mt-0.5 block font-serif text-[12.5px] text-white/40 italic">
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
										<span className="font-mono text-[12px] text-white/75">
											{s.key}
										</span>
										{s.version != null && (
											<span className="font-mono text-[10.5px] text-white/38">
												v{s.version}
											</span>
										)}
										{methodModules(s.module).map((m) => (
											<CodeRef key={m} path={m} />
										))}
									</div>
									<p className="mt-1 max-w-[60ch] text-[12.5px] leading-snug text-white/48">
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
										<span className="display-title text-[15px] font-bold text-[var(--rigi-paper)]">
											{m.label}
										</span>
										<span
											title={m.agentBlurb}
											className="rounded-full px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] text-[var(--accent)] ring-1 ring-[var(--accent)]/40"
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
										<p className="mt-2 text-[12.5px] text-white/50">
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
								<li key={f.summary} className="border-l border-white/12 pl-4">
									<span className="font-mono text-[10px] tracking-[0.14em] text-[var(--accent)] uppercase">
										{f.kind}
									</span>
									<p className="mt-1 max-w-[62ch] text-[13.5px] leading-relaxed text-white/70">
										{f.summary}
									</p>
									<p className="mt-1 max-w-[62ch] font-serif text-[12.5px] leading-snug text-white/42 italic">
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
