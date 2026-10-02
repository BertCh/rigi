// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { GalleryHorizontalEnd, ImagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { SiteNav } from "#/components/site/SiteNav";
import { listUploadRolls } from "#/lib/roll/mosaic";
import { RollCard } from "#/lib/roll/mosaic/RollCard";
import { builtinRolls } from "#/lib/roll/roll";

// client-only: pose sources read saved poses from localStorage
export const Route = createFileRoute("/roll/")({
	ssr: false,
	head: () => ({ meta: [{ title: "Camera rolls · Rigi" }] }),
	component: RollList,
});

function RollList() {
	const [builtin] = useState(builtinRolls);
	const uploads = useUploadRolls();
	return (
		<main className="min-h-dvh bg-[var(--rigi-ink)] px-4 pb-16 text-[var(--rigi-paper)] sm:px-8">
			{/* <main> sets the gutter here */}
			<SiteNav active="library" className="px-0 sm:px-0" />
			<header className="mx-auto max-w-6xl pt-10 pb-8">
				<p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-[var(--rigi-glow)]/80 uppercase">
					<GalleryHorizontalEnd className="size-3.5" /> Camera rolls
				</p>
				<h1 className="text-3xl leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[2.2rem]">
					Every photo of a day out, at once.
				</h1>
				<p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
					Photos of one area become a roll. See them as a mosaic, stitched into
					panoramas where they were taken from the same spot, or all draped on
					the 3D terrain.
				</p>
				<Link
					to="/roll/import"
					data-testid="import-roll-entry"
					className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-3.5 py-2 text-sm font-semibold text-[var(--rigi-ink)] hover:brightness-110"
				>
					<ImagePlus className="size-4" /> Import a camera roll
				</Link>
			</header>
			{uploads && uploads.rolls.length > 0 && (
				<section className="mx-auto max-w-6xl pb-10" data-testid="upload-rolls">
					<h2 className="mb-4 text-sm font-semibold text-white/70">
						Your uploads{" "}
						<span className="text-white/35">
							· {uploads.rolls.length} roll
							{uploads.rolls.length === 1 ? "" : "s"} on this device
						</span>
					</h2>
					<div className="grid gap-4 sm:grid-cols-2">
						{uploads.rolls.map((r) => (
							<RollCard
								key={r.id}
								roll={r}
								thumb={(id) => uploads.thumbs.get(id) ?? null}
							/>
						))}
					</div>
				</section>
			)}
			<section className="mx-auto max-w-6xl pb-10">
				<h2 className="mb-4 text-sm font-semibold text-white/70">
					Bundled{" "}
					<span className="text-white/35">· {builtin.length} rolls</span>
				</h2>
				<div className="grid gap-4 sm:grid-cols-2">
					{builtin.map((r) => (
						<RollCard
							key={r.id}
							roll={r}
							thumb={(id) =>
								r.photos.find((p) => p.meta.id === id)?.meta.src ?? null
							}
						/>
					))}
				</div>
			</section>
		</main>
	);
}

/** Upload rolls from IndexedDB, loaded after mount. */
function useUploadRolls() {
	const [v, setV] = useState<Awaited<
		ReturnType<typeof listUploadRolls>
	> | null>(null);
	useEffect(() => {
		let live = true;
		listUploadRolls()
			.then((r) => live && setV(r))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return v;
}
