// T0.1 Legend: a compact key for what the CURRENT view encodes. (a) a vertical elevation ramp in
// metres with a bracket for the elevation range visible in the photo (or "relative to this view" when
// the ramp is rescaled per view); (b) the contour interval, index interval and, with ink-by-cover, the
// soil / rock / ice inks; (c) swatches for the land-cover classes actually in view; (d) the pack
// credit. Collapsible to a pill. In the world view the photo's geometry buffer does not apply, so it
// keeps the ramp key and the pack's cover classes only.

import { useEffect, useRef, useState } from "react";
import { BRAND } from "#/brand/khipu";
import { rampCss } from "#/lib/style/ramps";
import type { RampRef } from "#/lib/style/types";
import { CONTOUR_INK, COVER_CLASSES, coverInfo } from "../classes";
import { packCredit } from "../pack";
import { niceTicks } from "../viz/geo";
import { FONT } from "../viz/ink";
import { type ViewStats, viewStats } from "../viz/view";
import type { TerroirCtx } from "./context";

const BAR_H = 112;

function elevationKey(
	ctx: TerroirCtx,
): { ramp: RampRef; range: { lo: number; hi: number } | null } | null {
	const st = ctx.style;
	const abs =
		st.terrain.rampRange.mode === "absolute" ? st.terrain.rampRange : null;
	const range = abs ? { lo: abs.lo, hi: abs.hi } : null;
	const os = ctx.engine.settings.overlayStyle;
	if (ctx.mode === "overlay") {
		if (os === "contours" && st.overlay.contours.color.mode === "ramp")
			return { ramp: st.overlay.contours.color.ramp, range };
		if (os === "bands") return { ramp: st.overlay.bands.ramp, range };
		return null;
	}
	if (ctx.mode === "replace") {
		const b =
			st.replace.bands === "overlay" ? st.overlay.bands : st.replace.bands;
		return { ramp: b.ramp, range };
	}
	return { ramp: st.terrain.reliefRamp, range };
}

/** Visible-terrain stats at ≤ 2 Hz: leading call, then a trailing one so the last frame lands. */
function useViewStats(ctx: TerroirCtx, on: boolean): ViewStats | null {
	const [stats, setStats] = useState<ViewStats | null>(null);
	const last = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const ctxRef = useRef(ctx);
	ctxRef.current = ctx;
	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx.frame drives the re-measure
	useEffect(() => {
		if (!on) return;
		const run = () => {
			timer.current = null;
			last.current = performance.now();
			const c = ctxRef.current;
			setStats(viewStats((u, v) => c.engine.sampleAt(u, v), c.cover));
		};
		const wait = 500 - (performance.now() - last.current);
		if (wait <= 0) run();
		else if (!timer.current) timer.current = setTimeout(run, wait);
	}, [on, ctx.frame]);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return stats;
}

/** "© swisstopo · GLAMOS · OSM · Mapzen": a short credit line; the full text goes in a tooltip. */
function shortCredit(credits: string[]): string {
	const out: string[] = [];
	for (const c of credits) {
		const m = /swisstopo/i.test(c)
			? "swisstopo"
			: /glamos/i.test(c)
				? "GLAMOS"
				: /openstreetmap|osm/i.test(c)
					? "OSM"
					: /mapzen/i.test(c)
						? "Mapzen"
						: c
								.replace(/^©\s*/, "")
								.split(/[\s(,:]+/)
								.slice(0, 2)
								.join(" ");
		if (m && !out.includes(m)) out.push(m);
	}
	return `© ${out.join(" · ")}`;
}

const txt = "text-[10px] leading-tight text-white/75";

export function Legend({ ctx }: { ctx: TerroirCtx }) {
	const [open, setOpen] = useState(true);
	const world = ctx.mode === "world";
	const t = ctx.style.terroir;
	const stats = useViewStats(ctx, !world && open);
	const ek = elevationKey(ctx);

	// elevation key geometry
	let lo = 0;
	let hi = 1;
	let ticks: number[] = [];
	let relative = false;
	if (ek) {
		if (ek.range) {
			lo = ek.range.lo;
			hi = ek.range.hi;
			ticks = niceTicks(lo, hi, 7);
		} else if (stats) {
			relative = true;
			lo = Math.floor(stats.hMin / 10) * 10;
			hi = Math.max(lo + 10, Math.ceil(stats.hMax / 10) * 10);
			ticks = [lo, hi];
		} else relative = true;
	}
	const ypos = (m: number) =>
		(1 - Math.min(1, Math.max(0, (m - lo) / (hi - lo)))) * BAR_H;
	const showBar = !!ek && (!relative || !!stats || world);
	const gradient = ek ? rampCss(ek.ramp, 14).replace("90deg", "to top") : "";

	// contour key
	const s = ctx.engine.settings;
	const showContours = !world && s.overlayStyle === "contours";
	const every = ctx.style.overlay.contours.majorEvery;
	const minor = s.contourInterval;
	const index = t.contours.swissIndex ? 100 : minor * every;
	const inks = showContours && t.contours.inkByCover && !!ctx.cover;

	// land cover key
	const showCover = t.cover.on && ctx.mode !== "overlay" && !!ctx.cover;
	let classes: number[] = [];
	if (showCover) {
		if (world) {
			const hist = ctx.pack?.cover?.histogram ?? {};
			classes = Object.entries(hist)
				.filter(([k, n]) => Number(k) > 0 && n > 0)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 8)
				.map(([k]) => Number(k));
		} else if (stats) {
			classes = [...stats.cover.entries()]
				.filter(([, f]) => f >= 0.015)
				.sort((a, b) => b[1] - a[1])
				.map(([c]) => c);
		}
	}

	const credit = ctx.pack ? packCredit(ctx.pack) : "";
	const creditShort = ctx.pack
		? shortCredit(ctx.pack.sources.map((x) => x.credit))
		: "";
	const empty = !showBar && !showContours && !classes.length;
	if (empty && !credit) return null;

	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="pointer-events-auto absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white/85 ring-1 ring-white/10 backdrop-blur hover:text-white"
				style={{ fontFamily: FONT }}
			>
				Key
			</button>
		);

	return (
		<div
			className="pointer-events-auto absolute bottom-3 left-3 max-w-[210px] rounded-lg bg-black/65 p-2.5 text-white/90 ring-1 ring-white/10 backdrop-blur"
			style={{ fontFamily: FONT }}
		>
			<div className="mb-1.5 flex items-center justify-between">
				<span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/60">
					Key
				</span>
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="Collapse key"
					className="-mr-1 px-1 text-[13px] leading-none text-white/50 hover:text-white"
				>
					–
				</button>
			</div>
			{showBar && ek && (
				<div className="mb-2 flex gap-2">
					<div
						className="relative shrink-0"
						style={{ width: 70, height: BAR_H + 8 }}
					>
						<div
							className="absolute"
							style={{
								left: 8,
								top: 4,
								width: 10,
								height: BAR_H,
								background: gradient,
								borderRadius: 2,
							}}
						/>
						<svg
							width={70}
							height={BAR_H + 8}
							className="absolute inset-0"
							role="img"
							aria-label="Elevation key"
						>
							{ticks.map((m) => (
								<g key={m}>
									<line
										x1={18}
										x2={22}
										y1={4 + ypos(m)}
										y2={4 + ypos(m)}
										stroke={BRAND.paper}
										strokeOpacity={0.7}
									/>
									<text
										x={25}
										y={4 + ypos(m) + 3}
										fontSize={9}
										fill={BRAND.paper}
										fillOpacity={0.8}
									>
										{Math.round(m)} m
									</text>
								</g>
							))}
							{stats && (
								<path
									d={`M6 ${4 + ypos(stats.hMax)}H3V${4 + ypos(stats.hMin)}H6`}
									fill="none"
									stroke={BRAND.glow}
									strokeWidth={1.5}
								/>
							)}
						</svg>
					</div>
					<div className={txt}>
						{stats && (
							<div>
								In view
								<br />
								{Math.round(stats.hMin)}–{Math.round(stats.hMax)} m
							</div>
						)}
						{relative && (
							<div className="mt-1 text-white/55">relative to this view</div>
						)}
					</div>
				</div>
			)}
			{showContours && (
				<div className="mb-2">
					<div className={txt}>
						Contours {minor} m · index {index} m
					</div>
					{inks && (
						<div className="mt-1 flex gap-2.5">
							{(
								[
									["soil", "soil"],
									["rock", "rock"],
									["ice", "ice, water"],
								] as const
							).map(([k, label]) => (
								<span key={k} className={`flex items-center gap-1 ${txt}`}>
									<span
										className="inline-block h-[2px] w-3 rounded"
										style={{ background: CONTOUR_INK[k] }}
									/>
									{label}
								</span>
							))}
						</div>
					)}
				</div>
			)}
			{classes.length > 0 && (
				<div className="mb-2 grid grid-cols-1 gap-y-0.5">
					{classes.map((c) => {
						const info = coverInfo(c);
						return (
							<span key={c} className={`flex items-center gap-1.5 ${txt}`}>
								<span
									className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-white/20"
									style={{ background: COVER_CLASSES[c]?.color ?? info.color }}
								/>
								{info.label}
							</span>
						);
					})}
				</div>
			)}
			{credit && (
				<div
					className="truncate whitespace-nowrap text-[9px] leading-snug text-white/40"
					title={credit}
				>
					{creditShort}
				</div>
			)}
		</div>
	);
}
