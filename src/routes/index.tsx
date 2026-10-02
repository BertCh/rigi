// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowRight,
	Cpu,
	Database,
	GalleryHorizontalEnd,
	Globe,
	ImageIcon,
	ShieldCheck,
} from "lucide-react";
import {
	type CSSProperties,
	lazy,
	type ReactNode,
	Suspense,
	useRef,
} from "react";
import { LensGlyph } from "#/brand/LensGlyph";
import { Compare } from "#/components/site/Compare";
import { FadeIn } from "#/components/site/FadeIn";
import { RevealLoop } from "#/components/site/RevealLoop";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";
import { Surround, type SurroundBake } from "#/components/site/Surround";
import story from "#/components/site/surround/demo-01.json";
import hero from "#/components/site/surround/demo-09.json";
import how from "#/components/site/surround/how.json";
import map from "#/components/site/surround/map.json";
import { NearViewport } from "#/components/site/useNearViewport";

// Everything below the first two sections is split out and mounted only when near the viewport
// (NearViewport), with a same-size placeholder, so the hero ships little JS and starts no GPU work.
const PanoramaSection = lazy(() =>
	import("#/components/site/DemoSections").then((m) => ({
		default: m.PanoramaSection,
	})),
);
const TopoSection = lazy(() =>
	import("#/components/site/DemoSections").then((m) => ({
		default: m.TopoSection,
	})),
);
const LiveRollMap = lazy(() =>
	import("#/components/site/LiveRollMap").then((m) => ({
		default: m.LiveRollMap,
	})),
);
const StepInsideDemo = lazy(() =>
	import("#/components/site/StepInsideDemo").then((m) => ({
		default: m.StepInsideDemo,
	})),
);
const HowItWorksScene = lazy(() =>
	import("#/components/site/how/HowItWorksScene").then((m) => ({
		default: m.HowItWorksScene,
	})),
);

const PLACEHOLDER = "bg-white/[0.03]";
/** Width variants of the hero and story stills (scripts/demo/make-landing-variants.sh). */
const variantSet = (name: string) =>
	[640, 1024, 1440].map((w) => `/demo/w/${name}-${w}.jpg ${w}w`).join(", ");
const HERO_SIZES =
	"(min-width: 1024px) 611px, (min-width: 640px) calc(100vw - 64px), calc(100vw - 32px)";
const STORY_SIZES =
	"(min-width: 1280px) 1088px, (min-width: 640px) calc(100vw - 64px), calc(100vw - 32px)";

const PANO_BOX = `h-[380px] rounded-md ${PLACEHOLDER}`;
const TOPO_BOX = `h-[min(640px,75vh)] rounded-md ${PLACEHOLDER}`;
const LIVE_BOX = `aspect-[16/10] max-h-[78vh] w-full rounded-md ${PLACEHOLDER}`;
const STEP_BOX = `aspect-[16/9] max-h-[78vh] w-full rounded-md ${PLACEHOLDER}`;
const HOW_BOX = `aspect-[16/11] rounded-md ${PLACEHOLDER}`;

// The landing page, one scroll: the sample trip (src/lib/demo, a real day on Niederhorn) shows the
// features live (before/after, the overlay reveal, the photos on the topo map, the roll draped in
// 3D), then the local-only angle, then the pitch split evenly between one photo and a whole roll.
export const Route = createFileRoute("/")({ component: Home });

const local = [
	{
		icon: ShieldCheck,
		title: "No upload",
		body: "Photos are decoded and stored in this browser. No account is needed.",
	},
	{
		icon: Cpu,
		title: "Local computation",
		body: "Skyline detection, terrain matching and rendering run in Web Workers and on your GPU, built on luma.gl and its compute graph (upstream codename: Arisia). Bring your own lens.",
	},
	{
		icon: Database,
		title: "Local storage",
		body: "Photos and camera poses are kept in browser storage. Deleting a photo removes it.",
	},
	{
		icon: Globe,
		title: "Public data only",
		body: "Elevation, maps, peaks and trails are downloaded for the area in view. Nothing about you is sent.",
	},
];

function Home() {
	// the plan around the topo board follows the board's pan
	const mapLayer = useRef<HTMLDivElement>(null);
	const panMapSurround = (p: { x: number; y: number }) => {
		if (mapLayer.current)
			mapLayer.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
	};
	// the hero's terrain spill left of the photo shows only with the divider near the far left, where
	// the photo's left edge is the overlay too; the right spill always matches the overlay side
	const heroFrame = useRef<HTMLDivElement>(null);
	const showHeroLeftSpill = (v: number) => {
		const t = Math.min(1, Math.max(0, (0.12 - v) / 0.1));
		heroFrame.current?.style.setProperty("--surround-left", String(t));
	};
	return (
		<main className={`${SITE_THEME} overflow-x-clip pb-10`}>
			<SiteNav />

			{/* hero */}
			<header className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-12 pb-20 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pt-16">
				<FadeIn cssOnly>
					<p className="mb-4 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
						Photo-to-terrain alignment, in the browser
					</p>
					<h1 className="text-[2.2rem] leading-[1.05] font-semibold tracking-[-0.025em] sm:text-5xl">
						Mountain photos, aligned to a terrain model.
					</h1>
					<p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/60">
						Rigi estimates where a photo was taken and where the camera pointed
						by matching its skyline to a 3D elevation model. With the pose
						known, peaks, contours and trails can be drawn into the image.
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						<a
							href="#start"
							className="inline-flex items-center gap-2 rounded-lg bg-[var(--rigi-glow)] px-4 py-2.5 text-sm font-semibold text-[var(--rigi-ink)] hover:brightness-110"
						>
							Try it with your photos <ArrowRight className="size-4" />
						</a>
						<a
							href="#story"
							className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white/70 bg-white/[0.06] hover:bg-white/10 hover:text-[var(--rigi-paper)]"
						>
							See an example <ArrowDown className="size-4" />
						</a>
					</div>
				</FadeIn>
				<FadeIn delay={150} cssOnly>
					<figure>
						<Surround
							bake={hero as SurroundBake}
							eager
							rootRef={heroFrame}
							style={{ "--surround-left": 0 } as CSSProperties}
						>
							<Compare
								onMove={showHeroLeftSpill}
								before="/demo/photos/demo-09.jpg"
								after="/demo/shots/hero.jpg"
								beforeSet={variantSet("demo-09")}
								afterSet={variantSet("hero")}
								sizes={HERO_SIZES}
								priority
								alt="A photo from Niederhorn with the Bernese Alps' peaks named"
								aspect={4 / 3}
								className="rounded-md"
							/>
						</Surround>
						<figcaption className="mt-2.5 font-mono text-[10.5px] text-white/40">
							Niederhorn, Lake Thun · iPhone photo · drag to compare
						</figcaption>
					</figure>
				</FadeIn>
			</header>

			{/* the overlay reveal */}
			<Story
				id="story"
				eyebrow="01 · Single photo"
				title="Map data, drawn into the photo."
				body="Once the camera pose is solved, contours, ridgelines and peak names are projected from the terrain model into the image."
				cta={{ to: "demo-01", label: "Open this photo" }}
			>
				<RevealLoop
					photo="/demo/photos/demo-01.jpg"
					overlay="/demo/shots/demo-01-overlay.jpg"
					photoSet={variantSet("demo-01")}
					overlaySet={variantSet("demo-01-overlay")}
					sizes={STORY_SIZES}
					alt="Contours, ridgelines and peak names blooming out over Lake Thun"
					aspect={4 / 3}
					className="rounded-md"
					surround={story as SurroundBake}
					surroundClassName="md:mt-14"
				/>
			</Story>

			{/* the panorama */}
			<Story
				eyebrow="02 · Panorama"
				bleed
				title="Twelve photos from one viewpoint."
				body="Each photo is placed by its solved view direction, against the skyline computed from the elevation model. Gaps are filled with rendered terrain."
			>
				<NearViewport placeholder={<div className={PANO_BOX} />} margin={800}>
					<Suspense fallback={<div className={PANO_BOX} />}>
						<PanoramaSection />
					</Suspense>
				</NearViewport>
			</Story>

			{/* the topo board */}
			<Story
				eyebrow="03 · Map"
				title="Positions and view directions."
				body="Each photo is shown where it was taken, with the direction it faced. Click one to open it."
			>
				<Surround bake={map as SurroundBake} layerRef={mapLayer}>
					<NearViewport placeholder={<div className={TOPO_BOX} />} margin={800}>
						<Suspense fallback={<div className={TOPO_BOX} />}>
							<TopoSection onPan={panMapSurround} />
						</Suspense>
					</NearViewport>
				</Surround>
			</Story>

			{/* the live roll map */}
			<Story
				eyebrow="04 · 3D"
				title="Photos projected onto the terrain."
				body="Each photo is draped onto the slopes visible in it. This view renders live in your browser. Drag to orbit, click a pin to enter a photo."
			>
				<NearViewport placeholder={<div className={LIVE_BOX} />} margin={400}>
					<Suspense fallback={<div className={LIVE_BOX} />}>
						<LiveRollMap
							poster="/demo/shots/drape.jpg"
							className="aspect-[16/10] max-h-[78vh] w-full rounded-md"
						/>
					</Suspense>
				</NearViewport>
			</Story>

			{/* step inside */}
			<Story
				eyebrow="05 · Step inside"
				title="Walk into the photo."
				body="The hiker, the hut and the lift pylon in front of the camera become 3D splats, placed on the terrain by the solved pose. Beyond the photo's frame, Google's photorealistic 3D tiles carry the view on. Drag to look around."
			>
				<NearViewport placeholder={<div className={STEP_BOX} />} margin={400}>
					<Suspense fallback={<div className={STEP_BOX} />}>
						<StepInsideDemo className="aspect-[16/9] max-h-[78vh] w-full rounded-md" />
					</Suspense>
				</NearViewport>
			</Story>

			{/* how */}
			<Story
				id="how"
				eyebrow="06 · Method"
				title="Guess, measure, correct, snap."
				body="A phone records position, heading and tilt. The heading is often off by several degrees, which is too much to identify peaks reliably. Rigi renders the expected skyline from the elevation model and adjusts the camera until the rendered and photographed skylines match."
			>
				<NearViewport placeholder={<div className={HOW_BOX} />} margin={600}>
					<Suspense fallback={<div className={HOW_BOX} />}>
						<HowItWorksScene surround={how as SurroundBake} />
					</Suspense>
				</NearViewport>
			</Story>

			{/* local */}
			<Story
				eyebrow="07 · Data"
				title="Processing is local."
				body="Every step shown above ran in this tab. Your own photos are processed the same way and stay on your device."
			>
				<div className="grid gap-px overflow-hidden rounded-md bg-white/8 sm:grid-cols-2 lg:grid-cols-4">
					{local.map((f) => (
						<div key={f.title} className="bg-[var(--rigi-ink)] p-5">
							<f.icon
								className="mb-3 size-4 text-[var(--rigi-glow)]"
								strokeWidth={1.5}
							/>
							<h3 className="text-sm font-semibold">{f.title}</h3>
							<p className="mt-1.5 text-xs leading-relaxed text-white/50">
								{f.body}
							</p>
						</div>
					))}
				</div>
			</Story>

			{/* the pitch: one photo or the whole roll */}
			<section
				id="start"
				className="mx-auto max-w-6xl scroll-mt-8 px-4 pt-6 pb-16 sm:px-8"
				data-testid="pitch"
			>
				<FadeIn>
					<h2 className="text-center text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
						Use your own photos.
					</h2>
					<p className="mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed text-white/55">
						A single photo, or a full camera roll.
					</p>
				</FadeIn>
				<div className="mt-10 grid gap-4 md:grid-cols-2">
					<FadeIn>
						<Pitch
							to="/upload"
							testId="upload-card"
							icon={ImageIcon}
							title="One photo"
							body="Add a photo to identify the peaks in it and overlay contours and trails."
							points={[
								"JPEG, HEIC, PNG, WebP, AVIF",
								"Result in seconds",
								"Export the annotated image",
							]}
							cta="Add a photo"
						/>
					</FadeIn>
					<FadeIn delay={120}>
						<Pitch
							to="/roll/import"
							testId="roll-card"
							icon={GalleryHorizontalEnd}
							title="A whole camera roll"
							body="Import a hike or a trip. Photos are grouped by location, aligned together, and shown on the map and in 3D."
							points={[
								"Hundreds of photos per import",
								"Panoramas per viewpoint",
								"GeoJSON export",
							]}
							cta="Import a roll"
						/>
					</FadeIn>
				</div>
				<p className="mt-8 text-center text-xs text-white/45">
					Returning?{" "}
					<Link
						to="/library"
						className="text-[var(--rigi-glow)] hover:underline"
					>
						Open library →
					</Link>
				</p>
			</section>

			<footer className="mx-auto max-w-6xl border-t border-white/8 px-4 pt-6 font-mono text-[10.5px] leading-relaxed text-white/35 sm:px-8">
				Elevation via Mapterhorn · maps © swisstopo · peaks and trails ©
				OpenStreetMap contributors · imagery credited in the app.
				<span className="mt-1.5 flex items-center gap-1.5">
					<LensGlyph size={11} />
					Compute graph: luma.gl GPUCommandGraph
				</span>
			</footer>
		</main>
	);
}

function Story({
	id,
	eyebrow,
	title,
	body,
	cta,
	bleed = false,
	children,
}: {
	id?: string;
	/** children run edge to edge (a hair of padding), the heading stays in the column */
	bleed?: boolean;
	eyebrow: string;
	title: string;
	body: string;
	cta?: { to: string; label: string };
	children: ReactNode;
}) {
	return (
		<section
			id={id}
			className="mx-auto max-w-6xl scroll-mt-8 px-4 pb-28 sm:px-8"
		>
			<FadeIn>
				<p className="mb-3 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
					{eyebrow}
				</p>
				<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
					<div className="max-w-2xl">
						<h2 className="text-3xl leading-tight font-semibold tracking-[-0.02em] sm:text-4xl">
							{title}
						</h2>
						<p className="mt-3 text-[15px] leading-relaxed text-white/55">
							{body}
						</p>
					</div>
					{cta && (
						<Link
							to="/photo/$id"
							params={{ id: cta.to }}
							className="inline-flex items-center gap-1 text-xs font-medium text-[var(--rigi-glow)]/80 hover:text-[var(--rigi-glow)]"
						>
							{cta.label} <ArrowRight className="size-3.5" />
						</Link>
					)}
				</div>
			</FadeIn>
			<FadeIn className="mt-8" delay={120} plain>
				{bleed ? (
					<div className="relative left-1/2 w-[calc(100vw-12px)] -translate-x-1/2">
						{children}
					</div>
				) : (
					children
				)}
			</FadeIn>
		</section>
	);
}

function Pitch({
	to,
	testId,
	icon: Icon,
	title,
	body,
	points,
	cta,
}: {
	to: "/upload" | "/roll/import";
	testId: string;
	icon: typeof ImageIcon;
	title: string;
	body: string;
	points: string[];
	cta: string;
}) {
	return (
		<Link
			to={to}
			data-testid={testId}
			className="group flex h-full flex-col rounded-md bg-white/[0.03] p-6 transition hover:bg-white/[0.05] hover:ring-1 hover:ring-[var(--rigi-glow)]/50"
		>
			<span className="flex size-11 items-center justify-center rounded-md bg-[var(--rigi-glow)]/12 text-[var(--rigi-glow)]">
				<Icon className="size-5" strokeWidth={1.5} />
			</span>
			<span className="mt-5 text-lg font-semibold">{title}</span>
			<span className="mt-2 text-sm leading-relaxed text-white/55">{body}</span>
			<ul className="mt-4 flex-1 space-y-1.5 text-xs text-white/50">
				{points.map((p) => (
					<li key={p} className="flex items-center gap-2">
						<span className="size-1 rounded-full bg-[var(--rigi-glow)]" />
						{p}
					</li>
				))}
			</ul>
			<span className="mt-6 inline-flex w-fit items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-3.5 py-2 text-sm font-semibold text-[var(--rigi-ink)] transition group-hover:brightness-110">
				{cta} <ArrowRight className="size-4" />
			</span>
		</Link>
	);
}
