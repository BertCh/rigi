import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, GalleryHorizontalEnd, ImagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import {
	fmtDateSpan,
	fmtDistance,
	listUploadRolls,
	POSE_SOURCE_COLOR,
	POSE_SOURCE_LABEL,
	POSE_SOURCES,
} from "#/lib/roll/mosaic";
import { builtinRolls } from "#/lib/roll/roll";
import type { Roll } from "#/lib/roll/types";

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
		<main className="min-h-dvh bg-[var(--rigi-ink)] px-4 pb-16 text-[var(--rigi-paper)] [--rigi-glow:#dca27a] [--rigi-ink:#0e1012] [--rigi-paper:#ece6da] sm:px-8">
			<header className="mx-auto max-w-6xl pt-8 pb-8">
				<Link
					to="/"
					className="mb-6 inline-flex items-center gap-1.5 text-xs text-white/55 hover:text-[var(--rigi-paper)]"
				>
					<ArrowLeft className="size-3.5" /> Rigi
				</Link>
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
							· {uploads.rolls.length} rolls on this device
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

function RollCard({
	roll,
	thumb,
}: {
	roll: Roll;
	thumb: (id: string) => string | null;
}) {
	const n = roll.photos.length;
	const counts = POSE_SOURCES.map(
		(s) => [s, roll.photos.filter((p) => p.poseSource === s).length] as const,
	).filter(([, c]) => c);
	const strip = roll.photos.slice(0, 6);
	return (
		<Link
			to="/roll/$id"
			params={{ id: roll.id }}
			data-testid="roll-card"
			className="group overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/8 transition hover:ring-[var(--rigi-glow)]/50"
		>
			<div className="flex h-28 gap-px overflow-hidden bg-black">
				{strip.map((p) => {
					const src = thumb(p.meta.id);
					return (
						<div
							key={p.meta.id}
							className="h-full min-w-0 flex-1 overflow-hidden"
							style={{ flexGrow: p.meta.width / p.meta.height }}
						>
							{src && (
								<img
									src={src}
									alt=""
									loading="lazy"
									className="size-full object-cover transition duration-500 group-hover:scale-[1.04]"
								/>
							)}
						</div>
					);
				})}
				{n > strip.length && (
					<div className="flex w-12 shrink-0 items-center justify-center bg-white/[0.05] text-xs text-white/55">
						+{n - strip.length}
					</div>
				)}
			</div>
			<div className="px-4 py-3">
				<div className="flex items-baseline justify-between gap-3">
					<span className="truncate text-sm font-semibold">{roll.name}</span>
					<span className="shrink-0 font-mono text-[11px] text-white/40">
						{fmtDateSpan(roll.photos)}
					</span>
				</div>
				<div className="mt-1 text-xs text-white/55">
					{n} photo{n === 1 ? "" : "s"} · {roll.viewpoints.length} viewpoint
					{roll.viewpoints.length === 1 ? "" : "s"}
					{roll.radiusM > 0 && ` · ${fmtDistance(2 * roll.radiusM)} across`}
				</div>
				<div
					className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-white/8"
					aria-hidden="true"
				>
					{counts.map(([s, c]) => (
						<span
							key={s}
							style={{
								width: `${(c / n) * 100}%`,
								background: POSE_SOURCE_COLOR[s],
							}}
						/>
					))}
				</div>
				<div className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px] text-white/45">
					{counts.map(([s, c]) => (
						<span key={s} className="inline-flex items-center gap-1">
							<span
								className="size-1.5 rounded-full"
								style={{ background: POSE_SOURCE_COLOR[s] }}
							/>
							{c} {POSE_SOURCE_LABEL[s]}
						</span>
					))}
				</div>
			</div>
		</Link>
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
