import { createFileRoute, Link } from "@tanstack/react-router";
import {
	GalleryHorizontalEnd,
	Layers,
	Map as MapIcon,
	Sparkles,
	Upload,
	Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { RigiMark } from "#/brand/RigiMark";
import { RigiPanorama, VEX } from "#/brand/RigiPanorama";
import { photos, regionNames } from "#/lib/photos";
import type { LocalPhotoSummary } from "#/lib/upload";

export const Route = createFileRoute("/")({ component: Home });

const tools = [
	{
		to: "/roll",
		title: "Camera rolls",
		body: "A whole day’s photos at once: mosaic, per-spot panoramas and every photo draped on the 3D terrain.",
	},
	{
		to: "/baseline",
		title: "Georeferencing baseline",
		body: "Core CPU pipeline: horizon, skyline detection, pose solve and peak matching.",
	},
] as const;

const modes = [
	{
		icon: Layers,
		title: "Overlay",
		body: "Contours, elevation bands, ridgelines, peak names and hiking trails drawn from the camera’s exact viewpoint.",
	},
	{
		icon: Sparkles,
		title: "Blend",
		body: "Swap parts of the photo for a 3D satellite or topo map with a lens, a swipe, a distance cut-off or a brush.",
	},
	{
		icon: MapIcon,
		title: "In map",
		body: "Project the photo onto 3D terrain, orbit around it, then fly back into the photographer’s viewpoint.",
	},
];

function Home() {
	const groups = Object.entries(
		photos.reduce<Record<string, typeof photos>>((acc, p) => {
			acc[p.region] ??= [];
			acc[p.region].push(p);
			return acc;
		}, {}),
	);
	const local = useLocalPhotos();
	return (
		<main className="min-h-dvh bg-[var(--rigi-ink)] pb-16 text-[var(--rigi-paper)] [--rigi-glow:#dca27a] [--rigi-ink:#0e1012] [--rigi-paper:#ece6da]">
			<nav className="mx-auto flex max-w-6xl items-center justify-between px-4 pt-6 sm:px-8">
				<Link to="/" className="flex items-center gap-2.5">
					<RigiMark className="size-7" />
					<span className="text-[17px] font-semibold tracking-[-0.01em]">
						Rigi
					</span>
				</Link>
				<Link
					to="/upload"
					className="text-xs font-medium text-white/55 transition hover:text-[var(--rigi-paper)]"
				>
					Upload a photo
				</Link>
			</nav>
			<figure className="mt-6">
				<RigiPanorama className="h-[clamp(220px,25vw,340px)] w-full text-[var(--rigi-paper)]" />
				<figcaption className="mx-auto flex max-w-6xl flex-wrap justify-between gap-x-6 gap-y-1 px-4 pt-3 font-mono text-[10.5px] text-white/35 sm:px-8">
					<span>
						View south from Rigi Kulm · 1797 m
						<span className="hidden sm:inline"> · 47.0567° N 8.4853° E</span>
					</span>
					<span>
						swissALTI3D via Mapterhorn · peaks © OpenStreetMap · vertical ×{VEX}
					</span>
				</figcaption>
			</figure>
			<header className="mx-auto max-w-6xl px-4 pt-14 pb-10 sm:px-8">
				<h1 className="max-w-3xl text-3xl leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[2.6rem]">
					Mountain photos, placed in the terrain they show.
				</h1>
				<p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/55">
					Each photo is placed from its GPS position, compass heading, gravity
					sensor and lens. The skyline is then matched against a 3D elevation
					model, and that one camera model powers three ways to combine the
					photo with map data.
				</p>
				<div className="mt-10 grid gap-px overflow-hidden rounded-xl bg-white/8 ring-1 ring-white/8 sm:grid-cols-3">
					{modes.map((m) => (
						<div key={m.title} className="bg-[var(--rigi-ink)] p-5">
							<m.icon
								className="mb-3 size-4 text-[var(--rigi-glow)]"
								strokeWidth={1.5}
							/>
							<h2 className="text-sm font-semibold">{m.title}</h2>
							<p className="mt-1.5 text-xs leading-relaxed text-white/50">
								{m.body}
							</p>
						</div>
					))}
				</div>
				<Link
					to="/upload"
					data-testid="upload-card"
					className="group mt-3 flex items-center gap-4 rounded-xl p-4 ring-1 ring-white/10 transition hover:bg-white/[0.03] hover:ring-[var(--rigi-glow)]/50"
				>
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--rigi-glow)]/12 text-[var(--rigi-glow)]">
						<Upload className="size-5" strokeWidth={1.5} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-semibold">
							Upload your photo
						</span>
						<span className="mt-0.5 block text-xs leading-relaxed text-white/50">
							JPEG, HEIC, PNG, WebP or AVIF from any phone or camera. It stays
							in this browser; GPS, compass and lens come from the EXIF, and you
							can pin the position on a map if GPS is missing.
						</span>
					</span>
					<span className="text-xs font-medium text-white/50 transition group-hover:text-[var(--rigi-glow)]">
						Upload →
					</span>
				</Link>
				<Link
					to="/roll"
					data-testid="roll-card"
					className="group mt-3 flex items-center gap-4 rounded-xl p-4 ring-1 ring-white/10 transition hover:bg-white/[0.03] hover:ring-[var(--rigi-glow)]/50"
				>
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--rigi-glow)]/12 text-[var(--rigi-glow)]">
						<GalleryHorizontalEnd className="size-5" strokeWidth={1.5} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-semibold">Camera rolls</span>
						<span className="mt-0.5 block text-xs leading-relaxed text-white/50">
							See a whole day's photos at once: a mosaic, panoramas stitched
							from each spot, and every photo draped on the 3D terrain.
						</span>
					</span>
					<span className="text-xs font-medium text-white/50 transition group-hover:text-[var(--rigi-glow)]">
						Open →
					</span>
				</Link>
			</header>
			{local.length > 0 && (
				<section
					className="mx-auto max-w-6xl px-4 pb-10 sm:px-8"
					data-testid="local-photos"
				>
					<h2 className="mb-4 text-sm font-semibold text-white/70">
						Your uploads{" "}
						<span className="text-white/35">
							· {local.length} on this device
						</span>
					</h2>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{local.map((p) => (
							<Link
								key={p.id}
								to="/photo/$id"
								params={{ id: p.id }}
								className="group overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/8 transition hover:ring-[var(--rigi-glow)]/50"
							>
								<div className="aspect-[4/3] overflow-hidden bg-black">
									{p.thumbUrl && (
										<img
											src={p.thumbUrl}
											alt={p.id}
											loading="lazy"
											className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
										/>
									)}
								</div>
								<div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-white/55">
									<span
										className="truncate font-mono"
										title={p.meta.local?.fileName}
									>
										{p.meta.local?.fileName || p.id}
									</span>
									<span className="shrink-0">
										{p.meta.heading == null
											? "no compass"
											: `${Math.round(p.meta.heading)}°`}
										{p.meta.alt != null && ` · ${Math.round(p.meta.alt)} m`}
									</span>
								</div>
							</Link>
						))}
					</div>
				</section>
			)}
			{groups.map(([region, list]) => (
				<section key={region} className="mx-auto max-w-6xl px-4 pb-10 sm:px-8">
					<h2 className="mb-4 text-sm font-semibold text-white/70">
						{regionNames[region] ?? region}{" "}
						<span className="text-white/35">· {list.length} photos</span>
					</h2>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{list.map((p) => (
							<Link
								key={p.id}
								to="/photo/$id"
								params={{ id: p.id }}
								className="group overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/8 transition hover:ring-[var(--rigi-glow)]/50"
							>
								<div className="aspect-[4/3] overflow-hidden bg-black">
									<img
										src={p.src}
										alt={p.id}
										loading="lazy"
										className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
									/>
								</div>
								<div className="flex items-center justify-between px-3 py-2 text-[11px] text-white/55">
									<span className="font-mono">{p.id}</span>
									<span>
										{Math.round(p.heading ?? 0)}° · {p.f35} mm ·{" "}
										{Math.round(p.alt ?? 0)} m
									</span>
								</div>
							</Link>
						))}
					</div>
				</section>
			))}
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
							className="rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/8 transition hover:bg-white/[0.07] hover:ring-[var(--rigi-glow)]/50"
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

/** Uploads stored in this browser (IndexedDB). Loaded after mount, so SSR and the bundled gallery never wait on it. */
function useLocalPhotos() {
	const [list, setList] = useState<LocalPhotoSummary[]>([]);
	useEffect(() => {
		let live = true;
		import("#/lib/upload")
			.then((m) => m.listLocalPhotos())
			.then((l) => live && setList(l))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return list;
}
