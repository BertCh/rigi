// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ConceptPage } from "#/components/gipfelbuch/ConceptPage";
import { SketchDefs } from "#/components/gipfelbuch/notebook/Ink";
import { SheetFrame } from "#/components/gipfelbuch/swiss";
import { ListArrow, MarkerUnderline } from "#/components/gipfelbuch/swiss/hand";
import { GB_THEME } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import { SiteNav } from "#/components/site/SiteNav";
import {
	byId,
	closestSheetIds,
	MERGED_SHEETS,
} from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// One page per concept: /gipfelbuch/<id>. The body is a bespoke page in src/lib/gipfelbuch/pages/<id>.tsx when present.
export const Route = createFileRoute("/gipfelbuch/$concept")({
	ssr: false,
	beforeLoad: ({ params }) => {
		const merged = MERGED_SHEETS[params.concept];
		if (merged)
			throw redirect({
				to: "/gipfelbuch/$concept",
				params: { concept: merged },
				replace: true,
			});
	},
	head: ({ params }) => ({
		meta: [
			{
				title: `${byId.get(params.concept)?.title ?? "Sheet"} · Rigi Gipfelbuch`,
			},
		],
	}),
	component: ConceptRoute,
});

function ConceptRoute() {
	const { concept } = Route.useParams();
	const node = byId.get(concept);
	if (!node) return <OffTheMap id={concept} />;
	return <ConceptPage node={node} />;
}

/** No sheet by that id: a hand note, the closest sheets and the way back to the contents. */
function OffTheMap({ id }: { id: string }) {
	const close = closestSheetIds(id)
		.map((c) => byId.get(c))
		.filter((n): n is GipfelbuchNode => !!n);
	return (
		<main className={`${GB_THEME} pb-16`}>
			<SketchDefs />
			<SiteNav active="gipfelbuch" />
			<SheetFrame
				className="mt-4"
				imprint="Rigi Gipfelbuch · Grundlage © swisstopo · Höhen Mapterhorn"
			>
				<div className="px-6 pt-12 pb-16">
					<p className={`${TYPE.hand} text-[var(--gb-red)]`}>No sheet ‹{id}›</p>
					<div className="relative mt-2 inline-block">
						<h1 className={`${TYPE.h1} m-0`}>Nothing is written here</h1>
						<MarkerUnderline seed="off-the-map" />
					</div>
					{close.length > 0 && (
						<div className="mt-8">
							<p className={`${TYPE.handLabel} gb-secondary`}>Did you mean</p>
							<ul className="m-0 mt-2 list-none p-0">
								{close.map((n) => (
									<li key={n.id}>
										<Link
											to="/gipfelbuch/$concept"
											params={{ concept: n.id }}
											className={`${TYPE.hand} inline-flex items-center gap-2 py-1 hover:text-[var(--gb-red)]`}
										>
											<ListArrow seed={`near-${n.id}`} /> {n.title}
										</Link>
									</li>
								))}
							</ul>
						</div>
					)}
					<p className="mt-8">
						<Link
							to="/gipfelbuch"
							className={`${TYPE.hand} inline-flex items-center gap-2 hover:text-[var(--gb-red)]`}
						>
							<ListArrow seed="off-map-back" dir="in" color="ink" /> Back to
							contents
						</Link>
					</p>
				</div>
			</SheetFrame>
		</main>
	);
}
