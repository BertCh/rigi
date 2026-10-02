// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { ConceptPage } from "#/components/gipfelbuch/ConceptPage";
import { GB_THEME } from "#/components/gipfelbuch/swiss/palette";
import { SiteNav } from "#/components/site/SiteNav";
import { byId } from "#/lib/gipfelbuch/graph-utils";

// One page per concept: /gipfelbuch/<id>. The body is a bespoke page in src/lib/gipfelbuch/pages/<id>.tsx when present.
export const Route = createFileRoute("/gipfelbuch/$concept")({
	ssr: false,
	head: ({ params }) => ({
		meta: [
			{
				title: `${byId.get(params.concept)?.title ?? "Concept"} · Rigi Gipfelbuch`,
			},
		],
	}),
	component: ConceptRoute,
});

function ConceptRoute() {
	const { concept } = Route.useParams();
	const node = byId.get(concept);
	if (!node)
		return (
			<main className={GB_THEME}>
				<SiteNav active="gipfelbuch" />
				<div className="mx-auto max-w-2xl px-4 pt-28 text-center">
					<p className="font-mono text-[11px] tracking-[0.2em] text-[var(--rigi-glow)] uppercase">
						Off the map
					</p>
					<h1 className="display-title mt-3 text-[40px] font-bold">
						No concept called "{concept}"
					</h1>
					<Link
						to="/gipfelbuch"
						className="mt-6 inline-block text-[13px] text-[var(--gb-secondary,#4a545c)] hover:text-[var(--rigi-paper)]"
					>
						Back to the gipfelbuch
					</Link>
				</div>
			</main>
		);
	return <ConceptPage node={node} />;
}
