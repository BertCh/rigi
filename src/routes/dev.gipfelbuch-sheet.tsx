// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import { GB_THEME, SheetMap } from "#/components/gipfelbuch/swiss";
import { FurnitureSheet } from "#/components/gipfelbuch/swiss/FurnitureSheet";
import { SiteNav } from "#/components/site/SiteNav";

// Preview of the Gipfelbuch map-sheet kit (src/components/gipfelbuch/swiss): the Niederhorn sheet
// map and every piece of map furniture, for screenshots.
export const Route = createFileRoute("/dev/gipfelbuch-sheet")({
	ssr: false,
	head: () => ({ meta: [{ title: "Gipfelbuch sheet kit" }] }),
	component: PreviewGate,
});

// dev-only: the production build shows a stub (same gate as dev.how-scene)
function PreviewGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return (
		<main className={`${GB_THEME} pb-20`}>
			<SiteNav active="gipfelbuch" />
			<section className="mx-auto max-w-6xl px-4 pt-10 sm:px-8">
				<SheetMap />
			</section>
			<section className="mx-auto mt-12 max-w-6xl px-4 sm:px-8">
				<FurnitureSheet />
			</section>
		</main>
	);
}
