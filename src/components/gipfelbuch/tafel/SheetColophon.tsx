// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { STATUS_META } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { TYPE } from "../swiss/type";
import { CodeRef } from "../viz";

// The sheet's colophon (peak-notebook plan §7.6): the developer facts the old sticky rail carried
// (status, code, reports, ontology), set once at the foot of the sheet
// instead of beside every section. Space separates the groups; nothing is boxed.

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<h3 className={`${TYPE.kicker} gb-secondary mb-3`}>{title}</h3>
			{children}
		</div>
	);
}

export function SheetColophon({
	node,
	ontologyLabel,
}: {
	node: GipfelbuchNode;
	/** Shown as a link to #ontology when the sheet has an ontology panel. */
	ontologyLabel?: string;
}) {
	return (
		<section
			aria-label="Colophon"
			className="grid gap-x-6 gap-y-12 px-6 pt-[72px] pb-12 sm:grid-cols-2 lg:grid-cols-4"
		>
			<Group title="Status">
				<p className={`${TYPE.h3}`}>{STATUS_META[node.status].label}</p>
				<p className={`${TYPE.caption} mt-1.5`}>
					{STATUS_META[node.status].blurb}
				</p>
				{ontologyLabel && (
					<a
						href="#ontology"
						className={`${TYPE.micro} mt-3 inline-block underline underline-offset-2 hover:text-[var(--gb-red)]`}
					>
						ontology · {ontologyLabel}
					</a>
				)}
			</Group>
			{node.modules.length > 0 && (
				<Group title="Code">
					<div className="flex flex-col items-start gap-1.5">
						{node.modules.map((m) => (
							<CodeRef key={m} path={m} />
						))}
					</div>
				</Group>
			)}
			{node.reports.length > 0 && (
				<Group title="Reports">
					<div className="flex flex-col items-start gap-1.5">
						{node.reports.map((m) => (
							<CodeRef key={m} path={m} />
						))}
					</div>
				</Group>
			)}
		</section>
	);
}
