// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import {
	GalleryHorizontalEnd,
	HardDrive,
	ImagePlus,
	Upload,
	Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";
import type { DemoManifest } from "#/lib/demo";
import { photos, regionNames } from "#/lib/photos";
import { listUploadRolls } from "#/lib/roll/mosaic/loadRoll";
import { RollCard } from "#/lib/roll/mosaic/RollCard";
import type { Roll } from "#/lib/roll/types";
import type { LocalPhotoSummary } from "#/lib/upload";

// My library: the user's own photos and rolls (IndexedDB, this device only), the two ways to add
// more, then the bundled samples and developer tools.
export const Route = createFileRoute("/library")({
	ssr: false,
	head: () => ({ meta: [{ title: "My library · Rigi" }] }),
	component: Library,
});

const tools = [
	{
		to: "/roll",
		title: "All camera rolls",
		body: "Your rolls and the bundled sample rolls in one list.",
	},
] as const;

function Library() {
	const local = useLocal();
	const empty = local && !local.photos.length && !local.rolls.length;
	return (
		<main className={`${SITE_THEME} pb-16`}>
			<SiteNav active="library" />
			<header className="mx-auto max-w-6xl px-4 pt-12 pb-8 sm:px-8">
				<p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-[var(--rigi-glow)]/80 uppercase">
					<HardDrive className="size-3.5" /> On this device
				</p>
				<h1 className="text-3xl leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[2.2rem]">
					My library
				</h1>
				<p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
					Your photos are stored in this browser and aligned here too. Nothing
					is uploaded to a server; only public map data (elevation, imagery,
					peaks and trails) is downloaded for the places you visit.
				</p>
				<div className="mt-7 grid gap-3 sm:grid-cols-2">
					<AddCard
						to="/upload"
						testId="upload-card"
						icon={Upload}
						title="Add a photo"
						body="One JPEG, HEIC, PNG, WebP or AVIF. GPS, compass and lens come from the EXIF; pin it on the map if GPS is missing."
						cta="Choose a photo"
					/>
					<AddCard
						to="/roll/import"
						testId="import-roll-entry"
						icon={ImagePlus}
						title="Import a camera roll"
						body="Import a day's photos at once. Photos are grouped by place, timed GPS fills in missing locations, and the whole roll is aligned together."
						cta="Choose photos"
					/>
				</div>
			</header>

			{empty && (
				<section className="mx-auto max-w-6xl px-4 pb-10 sm:px-8">
					<div className="rounded-md bg-white/[0.03] px-5 py-8 text-center text-sm text-white/55">
						Nothing here yet. Add a photo above, or look around the sample trip
						first.
					</div>
				</section>
			)}

			{local && local.rolls.length > 0 && (
				<Section title="Your rolls" count={`${local.rolls.length}`}>
					<div className="grid gap-4 sm:grid-cols-2" data-testid="upload-rolls">
						{local.rolls.map((r) => (
							<RollCard
								key={r.id}
								roll={r}
								thumb={(id) => local.thumbs.get(id) ?? null}
							/>
						))}
					</div>
				</Section>
			)}

			{local && local.photos.length > 0 && (
				<Section title="All your photos" count={`${local.photos.length}`}>
					<div
						className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
						data-testid="local-photos"
					>
						{local.photos.map((p) => (
							<PhotoTile
								key={p.id}
								id={p.id}
								src={p.thumbUrl}
								label={p.meta.local?.fileName || p.id}
								detail={`${p.meta.heading == null ? "no compass" : `${Math.round(p.meta.heading)}°`}${p.meta.alt != null ? ` · ${Math.round(p.meta.alt)} m` : ""}`}
							/>
						))}
					</div>
				</Section>
			)}

			<Samples />

			<section
				className="mx-auto max-w-6xl px-4 pb-10 sm:px-8"
				data-testid="tools"
			>
				<h2 className="mb-4 text-sm font-semibold text-white/70">
					<Wrench
						className="mr-1.5 inline size-3.5 text-[var(--rigi-glow)]"
						strokeWidth={1.5}
					/>{" "}
					Tools
				</h2>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{tools.map((t) => (
						<a
							key={t.to}
							href={t.to}
							className="rounded-md bg-white/[0.04] p-4 transition hover:bg-white/[0.07] hover:ring-1 hover:ring-[var(--rigi-glow)]/50"
						>
							<span className="block text-sm font-semibold">{t.title}</span>
							<span className="mt-1 block text-xs leading-relaxed text-white/55">
								{t.body}
							</span>
							<span className="mt-2 block font-mono text-[11px] text-[var(--rigi-glow)]/70">
								{t.to}
							</span>
						</a>
					))}
				</div>
			</section>
		</main>
	);
}

function Samples() {
	const demo = useDemoRoll();
	const byRegion = Object.entries(
		photos.reduce<Record<string, typeof photos>>((acc, p) => {
			acc[p.region] ??= [];
			acc[p.region].push(p);
			return acc;
		}, {}),
	);
	// trips first, largest first; one-photo places share a section instead of a row each
	const groups = byRegion
		.filter(([, list]) => list.length > 1)
		.sort((a, b) => b[1].length - a[1].length);
	const singles = byRegion.filter(([, list]) => list.length === 1);
	const sampleDetail = (p: (typeof photos)[number]) =>
		`${Math.round(p.heading ?? 0)}° · ${p.f35} mm · ${Math.round(p.alt ?? 0)} m`;
	return (
		<>
			{demo && (
				<Section title="Sample trip" count="bundled">
					<div className="grid gap-4 sm:grid-cols-2">
						<RollCard
							roll={demo.roll}
							thumb={(id) =>
								demo.manifest.photos.find((p) => p.id === id)?.thumb ?? null
							}
						/>
						<Link
							to="/photo/$id"
							params={{ id: "demo-09" }}
							className="flex flex-col justify-center rounded-md p-5 transition hover:bg-white/[0.03] hover:ring-1 hover:ring-[var(--rigi-glow)]/50"
						>
							<span className="flex items-center gap-2 text-sm font-semibold">
								<GalleryHorizontalEnd className="size-4 text-[var(--rigi-glow)]" />
								Open a photo from the trip
							</span>
							<span className="mt-1.5 text-xs leading-relaxed text-white/50">
								The Bernese Alps from Niederhorn, already aligned: switch
								between overlay, blend and 3D in the workspace.
							</span>
						</Link>
					</div>
				</Section>
			)}
			{groups.map(([region, list]) => (
				<Section
					key={region}
					title={regionNames[region] ?? region}
					count={`${list.length} sample photos`}
				>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{list.map((p) => (
							<PhotoTile
								key={p.id}
								id={p.id}
								src={p.src}
								label={p.id}
								detail={sampleDetail(p)}
							/>
						))}
					</div>
				</Section>
			))}
			{singles.length > 0 && (
				<Section
					title="More places"
					count={`${singles.length} sample photo${singles.length === 1 ? "" : "s"}`}
				>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{singles.map(([region, [p]]) => (
							<PhotoTile
								key={p.id}
								id={p.id}
								src={p.src}
								label={p.id}
								place={regionNames[region] ?? region}
								detail={sampleDetail(p)}
							/>
						))}
					</div>
				</Section>
			)}
		</>
	);
}

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count: string;
	children: React.ReactNode;
}) {
	return (
		<section className="mx-auto max-w-6xl px-4 pb-10 sm:px-8">
			<h2 className="mb-4 text-sm font-semibold text-white/70">
				{title} <span className="text-white/35">· {count}</span>
			</h2>
			{children}
		</section>
	);
}

function AddCard({
	to,
	testId,
	icon: Icon,
	title,
	body,
	cta,
}: {
	to: "/upload" | "/roll/import";
	testId: string;
	icon: typeof Upload;
	title: string;
	body: string;
	cta: string;
}) {
	return (
		<Link
			to={to}
			data-testid={testId}
			className="group flex flex-col rounded-md p-5 transition hover:bg-white/[0.03] hover:ring-1 hover:ring-[var(--rigi-glow)]/50"
		>
			<span className="flex size-10 items-center justify-center rounded-lg bg-[var(--rigi-glow)]/12 text-[var(--rigi-glow)]">
				<Icon className="size-5" strokeWidth={1.5} />
			</span>
			<span className="mt-4 text-sm font-semibold">{title}</span>
			<span className="mt-1 flex-1 text-xs leading-relaxed text-white/50">
				{body}
			</span>
			<span className="mt-4 text-xs font-medium text-white/55 transition group-hover:text-[var(--rigi-glow)]">
				{cta} →
			</span>
		</Link>
	);
}

function PhotoTile({
	id,
	src,
	label,
	place,
	detail,
}: {
	id: string;
	src: string | null;
	label: string;
	/** Where the photo was taken; shown above the file name when set. */
	place?: string;
	detail: string;
}) {
	return (
		<Link
			to="/photo/$id"
			params={{ id }}
			className="group overflow-hidden rounded-md bg-white/[0.04] transition hover:ring-1 hover:ring-[var(--rigi-glow)]/50"
		>
			<div data-theme="dark" className="aspect-[4/3] overflow-hidden bg-black">
				{src && (
					<img
						src={src}
						alt={place ?? label}
						loading="lazy"
						className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
					/>
				)}
			</div>
			{place && (
				<div className="truncate px-3 pt-2 text-xs font-semibold text-white/80">
					{place}
				</div>
			)}
			<div
				className={`flex flex-wrap items-center justify-between gap-x-2 px-3 text-[11px] text-white/55 ${place ? "pt-0.5 pb-2" : "py-2"}`}
			>
				{/* shrink-0 + wrap: on narrow tiles the detail drops below instead of eliding the name */}
				<span className="max-w-full shrink-0 truncate font-mono" title={label}>
					{label}
				</span>
				<span className="shrink-0">{detail}</span>
			</div>
		</Link>
	);
}

/** Uploads and upload rolls from IndexedDB, loaded after mount. */
function useLocal() {
	const [v, setV] = useState<{
		photos: LocalPhotoSummary[];
		rolls: Roll[];
		thumbs: Map<string, string>;
	} | null>(null);
	useEffect(() => {
		let live = true;
		Promise.all([
			import("#/lib/upload").then((m) => m.listLocalPhotos()),
			listUploadRolls(),
		])
			.then(([photos, r]) => live && setV({ photos, ...r }))
			.catch(() => live && setV({ photos: [], rolls: [], thumbs: new Map() }));
		return () => {
			live = false;
		};
	}, []);
	return v;
}

function useDemoRoll() {
	const [v, setV] = useState<{ roll: Roll; manifest: DemoManifest } | null>(
		null,
	);
	useEffect(() => {
		let live = true;
		import("#/lib/demo")
			.then(async (m) => ({
				manifest: await m.loadDemo(),
				roll: await m.loadDemoRoll(),
			}))
			.then((d) => live && setV(d))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return v;
}
