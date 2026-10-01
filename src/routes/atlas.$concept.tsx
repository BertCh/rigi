// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { ConceptPage } from "#/components/atlas/ConceptPage";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";
import { byId } from "#/lib/atlas/graph-utils";

// One page per concept: /atlas/<id>. The body is a bespoke page in src/lib/atlas/pages/<id>.tsx when present.
export const Route = createFileRoute("/atlas/$concept")({
	ssr: false,
	head: ({ params }) => ({
		meta: [
			{ title: `${byId.get(params.concept)?.title ?? "Concept"} · Rigi Atlas` },
		],
	}),
	component: ConceptRoute,
});

function ConceptRoute() {
	const { concept } = Route.useParams();
	const node = byId.get(concept);
	if (!node)
		return (
			<main className={SITE_THEME}>
				<SiteNav active="atlas" />
				<div className="mx-auto max-w-2xl px-4 pt-28 text-center">
					<p className="font-mono text-[11px] tracking-[0.2em] text-[var(--rigi-glow)] uppercase">
						Off the map
					</p>
					<h1 className="display-title mt-3 text-4xl font-bold">
						No concept called "{concept}"
					</h1>
					<Link
						to="/atlas"
						className="mt-6 inline-block text-sm text-white/60 hover:text-[var(--rigi-paper)]"
					>
						Back to the atlas
					</Link>
				</div>
			</main>
		);
	return <ConceptPage node={node} />;
}
