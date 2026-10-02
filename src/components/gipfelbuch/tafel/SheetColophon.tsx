// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { STATUS_META } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { OntologyDevRows } from "../OntologyPanel";
import { MarkerUnderline } from "../swiss/hand";
import { TYPE } from "../swiss/type";
import { Waymark, waymarkForStatus } from "../swiss/Waymark";
import { CodeRef } from "../viz";
import { Details } from "../viz/explain";
import { SheetIndexSketch } from "./Blattuebersicht";

// The sheet's colophon (reports/gipfelbuch.md): the developer facts the old sticky rail carried
// (status, code, reports, ontology), set once at the foot of the sheet
// instead of beside every section, written by hand. Space separates the groups; nothing is boxed.

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<div className="relative mb-3 inline-block min-w-[5rem] pr-4">
				<h3 className={`${TYPE.h3} m-0 text-[22px] leading-[26px]`}>{title}</h3>
				<MarkerUnderline seed={`colophon-${title}`} color="var(--gb-contour)" />
			</div>
			{children}
		</div>
	);
}

export function SheetColophon({
	node,
	hasGlossary,
}: {
	node: GipfelbuchNode;
	/** Shown as a link to #ontology when the sheet has a Glossar fold. */
	hasGlossary?: boolean;
}) {
	return (
		<section
			aria-label="Colophon"
			className="grid gap-x-6 gap-y-12 px-6 pt-[72px] pb-12 sm:grid-cols-2 lg:grid-cols-4"
		>
			<Group title="Status">
				<p className="nb-hand m-0 text-[24px] leading-[28px]">
					<Waymark variant={waymarkForStatus(node.status)}>
						{STATUS_META[node.status].label}
					</Waymark>
				</p>
				<p className={`${TYPE.hand} gb-secondary mt-1.5`}>
					{STATUS_META[node.status].blurb}
				</p>
				{hasGlossary && (
					<a
						href="#ontology"
						className={`${TYPE.handLabel} mt-3 inline-block underline decoration-[var(--gb-red)] underline-offset-4 hover:text-[var(--gb-red)]`}
					>
						Glossar
					</a>
				)}
			</Group>
			<div className="sm:col-span-2 lg:col-span-4">
				<Group title="Standort">
					<SheetIndexSketch current={node.id} hrefBase="/gipfelbuch" />
				</Group>
			</div>
		</section>
	);
}

/**
 * The one closed developer fold at the foot of a sheet: the engineering summary, the code and
 * report files and the ontology's developer rows. Nothing here is reader copy.
 */
export function DevFold({ node }: { node: GipfelbuchNode }) {
	return (
		<div className="px-6 pb-12">
			<Details title="Für Entwickler" className="mt-0">
				<p className={`${TYPE.body} max-w-[66ch]`}>{node.summary}</p>
				{node.modules.length > 0 && (
					<div>
						<h3>Code</h3>
						<div className="mt-2 flex flex-col items-start gap-1.5">
							{node.modules.map((m) => (
								<CodeRef key={m} path={m} />
							))}
						</div>
					</div>
				)}
				{node.reports.length > 0 && (
					<div>
						<h3>Reports</h3>
						<div className="mt-2 flex flex-col items-start gap-1.5">
							{node.reports.map((m) => (
								<CodeRef key={m} path={m} />
							))}
						</div>
					</div>
				)}
				<OntologyDevRows node={node} />
			</Details>
		</div>
	);
}
