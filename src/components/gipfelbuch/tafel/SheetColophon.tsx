// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { STATUS_META } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { MarkerUnderline } from "../swiss/hand";
import { TYPE } from "../swiss/type";
import { Waymark, waymarkForStatus } from "../swiss/Waymark";
import { CodeRef } from "../viz";

// The sheet's colophon (peak-notebook plan §7.6): the developer facts the old sticky rail carried
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
				<p className="nb-hand m-0 text-[24px] leading-[28px]">
					<Waymark variant={waymarkForStatus(node.status)}>
						{STATUS_META[node.status].label}
					</Waymark>
				</p>
				<p className={`${TYPE.hand} gb-secondary mt-1.5`}>
					{STATUS_META[node.status].blurb}
				</p>
				{ontologyLabel && (
					<a
						href="#ontology"
						className={`${TYPE.handLabel} mt-3 inline-block underline decoration-[var(--gb-red)] underline-offset-4 hover:text-[var(--gb-red)]`}
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
