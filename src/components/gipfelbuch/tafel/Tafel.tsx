// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type ReactNode,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { HandDot, PenLine, SketchPath } from "../notebook/Ink";
import { TYPE } from "../swiss/type";
import { useInView } from "../viz/hooks";
import { HandLabel } from "../viz/labels";
import {
	type GipfelbuchPeak,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	LAYER_STYLE,
	rowsPath,
	useGipfelbuchPhoto,
} from "../viz/real";
import { azAtX, projectAzEl, type TafelCamera } from "./project";
import { type TafelBake, useTafelBake } from "./useTafelBake";
import "./tafel.css";

/** CSS px per working px. */
export type TafelCtx = { d: GipfelbuchPhotoData; s: number };
/** SVG children drawn in WORKING-FRAME px (800 wide). */
export type TafelLayer = (ctx: TafelCtx) => ReactNode;
export type TafelNote = {
	at: [col: number, row: number];
	text: string;
	tone?: "route" | "measure" | "photo";
};

const WORK_W = 800;
const PHONE = 720;
const PAD = 24;
const NOTE_COLOR = { photo: "#fff", route: "#ffc7cd", measure: "#bfe9ef" };
const CARDINAL: Record<number, string> = {
	0: "N",
	45: "NE",
	90: "E",
	135: "SE",
	180: "S",
	225: "SW",
	270: "W",
	315: "NW",
};

/** Skyline rows 10th to 90th percentile of the voted columns, padded. */
function computeBand(d: GipfelbuchPhotoData): [number, number] {
	const h = d.photo.height;
	const ys: number[] = [];
	d.skyline.rows.forEach((r, i) => {
		if (r != null && d.skyline.weight[i] > 0) ys.push(r);
	});
	if (!ys.length) return [0, h];
	ys.sort((a, b) => a - b);
	const lo = ys[Math.floor(ys.length * 0.1)];
	const hi = ys[Math.floor(ys.length * 0.9)];
	let a = lo - h * 0.16;
	let b = hi + h * 0.28;
	if (b - a < 160) {
		const m = (a + b) / 2;
		a = m - 80;
		b = m + 80;
	}
	return [Math.max(0, a), Math.min(h, b)];
}

function useWidth<T extends HTMLElement>() {
	const ref = useRef<T | null>(null);
	const [w, setW] = useState(1200);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setW(el.getBoundingClientRect().width || 1200);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

function skylineColumns(d: GipfelbuchPhotoData) {
	return d.skyline.weight.filter((v) => v > 0).length;
}

function describe(d: GipfelbuchPhotoData) {
	const named = d.peaks
		.filter((p) => p.labelled)
		.sort((a, b) => b.dem - a.dem)
		.slice(0, 5)
		.map((p) => `${p.name} ${Math.round(p.ele ?? p.dem)} m`);
	return `Skyline detected in ${skylineColumns(d)} of ${d.skyline.weight.length} columns${named.length ? `; peaks: ${named.join(", ")}` : ""}`;
}

const kmText = (m: number) => (m / 1000).toFixed(m < 10000 ? 1 : 0);

/** The detected skyline: a white halo under a 2 px line in the detected colour. */
function defaultLayer({ d, s }: TafelCtx) {
	const path = rowsPath(
		d.skyline.rows.map((r, i) => (d.skyline.weight[i] > 0 ? r : null)),
	);
	return (
		<g fill="none" strokeLinejoin="round" strokeLinecap="round">
			<path d={path} stroke="#fff" strokeOpacity={0.75} strokeWidth={4.5 / s} />
			<SketchPath
				d={path}
				data
				seed={`tafel-default-skyline-${d.id}`}
				color={LAYER_STYLE.skyline.color}
				width={2 / s}
			/>
		</g>
	);
}

/** Two label stacks (name over sub-line, above the summit at ypx) touch. */
function boxesOverlap(
	x1: number,
	y1: number,
	t1: number,
	w1: number,
	x2: number,
	y2: number,
	t2: number,
	w2: number,
) {
	const b1 = y1 - 24 - t1 * 30;
	const b2 = y2 - 24 - t2 * 30;
	return Math.abs(x1 - x2) < (w1 + w2) / 2 && Math.abs(b1 - b2) < 28;
}

type Placed = {
	x: number;
	y: number;
	/** Summit y in px from the band top. */
	ypx: number;
	p: GipfelbuchPeak;
	tier: number;
	w: number;
};

/** In-frame labels: highest first, two tiers, clear of each other, clamped inside the photo. */
function placeInFrame(
	d: GipfelbuchPhotoData,
	s: number,
	band: [number, number],
	max: number,
): Placed[] {
	const out: Placed[] = [];
	const photoPx = WORK_W * s;
	const peaks = d.peaks
		.filter((p) => p.labelled && p.solved)
		.sort((a, b) => b.dem - a.dem);
	for (const p of peaks) {
		if (out.length >= max) break;
		const [wx, wy] = p.solved as [number, number];
		if (wx < 0 || wx > WORK_W) continue;
		const w = Math.max(p.name.length * 7.4, 84) + 12;
		const px = Math.min(Math.max(wx * s, w / 2 + 8), photoPx - w / 2 - 8);
		const ypx = (wy - band[0]) * s;
		const tier = [0, 1, 2].find(
			(t) =>
				// the label stack sits above the summit inside the band
				ypx >= 50 + t * 30 &&
				!out.some((q) => boxesOverlap(q.x, q.ypx, q.tier, q.w, px, ypx, t, w)),
		);
		if (tier === undefined) continue;
		out.push({ x: px, y: wy, ypx, p, tier, w });
	}
	return out;
}

export function Tafel({
	photo,
	layer,
	notes,
	maxPeaks = 6,
	caption,
}: {
	photo: GipfelbuchPhotoId;
	layer?: TafelLayer;
	notes?: TafelNote[];
	maxPeaks?: number;
	caption?: ReactNode;
}) {
	const [rootRef, W] = useWidth<HTMLElement>();
	const [viewRef, inView] = useInView<HTMLDivElement>({
		margin: "400px 0px 400px 0px",
	});
	const d = useGipfelbuchPhoto(inView ? photo : null);
	const bake = useTafelBake(inView ? photo : null);
	const phone = W < PHONE;
	const photoW = phone ? W - 32 : Math.min(1000, W * 0.64);
	const s = photoW / WORK_W;
	const ox = (W - photoW) / 2;
	const rulerY = PAD + 16;
	const oy = rulerY + (phone ? 40 : 44);

	const band = useMemo<[number, number] | null>(
		() => (bake ? bake.band : d ? computeBand(d) : null),
		[bake, d],
	);
	const bandRows = band ? band[1] - band[0] : (photoW * 0.42) / s;
	const bandH = bandRows * s;
	const stageH = oy + bandH + 36;

	const cam: TafelCamera | null = useMemo(() => {
		if (bake) return bake.camera;
		if (!d) return null;
		const c = d.solved.accepted || !d.app ? d.solved : null;
		return (
			c ?? {
				yaw: d.solved.yaw,
				pitch: d.solved.pitch,
				roll: d.solved.roll,
				f: d.solved.f,
			}
		);
	}, [bake, d]);

	const ready = !!(d && band && cam);
	const fy = oy - (band?.[0] ?? 0) * s; // top of the full photo

	return (
		<figure
			ref={rootRef}
			className="tafel-root m-0 pb-6"
			style={{ paddingTop: 0 }}
		>
			<div
				ref={viewRef}
				role="img"
				aria-label={d ? describe(d) : "Loading figure"}
				className="relative"
				style={{ height: stageH }}
			>
				{ready && d && band && cam && (
					<TafelStage
						d={d}
						bake={bake}
						band={band}
						cam={cam}
						W={W}
						phone={phone}
						photoW={photoW}
						s={s}
						ox={ox}
						oy={oy}
						fy={fy}
						rulerY={rulerY}
						bandH={bandH}
						stageH={stageH}
						layer={layer}
						notes={notes}
						maxPeaks={phone ? Math.min(3, maxPeaks) : maxPeaks}
					/>
				)}
			</div>
			<figcaption
				className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:justify-between sm:gap-6"
				style={{ marginLeft: ox, width: photoW }}
			>
				<span className={`${TYPE.caption} nb-hand`}>
					{caption ??
						"Photo with its measured skyline. The terrain carries on past the frame."}
				</span>
				<span className={`${TYPE.micro} gb-secondary shrink-0 sm:text-right`}>
					{d
						? `Aufnahme ${d.id}${d.photo.takenAt ? `, ${d.photo.takenAt.slice(0, 10)}` : ""}`
						: "\u00a0"}
				</span>
			</figcaption>
		</figure>
	);
}

function TafelStage(props: {
	d: GipfelbuchPhotoData;
	bake: TafelBake | null;
	band: [number, number];
	cam: TafelCamera;
	W: number;
	phone: boolean;
	photoW: number;
	s: number;
	ox: number;
	oy: number;
	fy: number;
	rulerY: number;
	bandH: number;
	stageH: number;
	layer?: TafelLayer;
	notes?: TafelNote[];
	maxPeaks: number;
}) {
	const {
		d,
		bake,
		band,
		cam,
		W,
		phone,
		photoW,
		s,
		ox,
		oy,
		fy,
		rulerY,
		bandH,
		stageH,
	} = props;
	const h = d.photo.height;
	const every = phone ? 30 : 15;

	// canvas box of the bake in figure px
	const canvas = useMemo(() => {
		if (!bake) return null;
		const cw = photoW / bake.photo.w;
		const ch = (h * s) / bake.photo.h;
		return {
			left: ox - bake.photo.x * cw,
			top: fy - bake.photo.y * ch,
			cw,
			ch,
		};
	}, [bake, photoW, h, s, ox, fy]);

	// ruler ticks in figure px
	const ticks = useMemo(() => {
		const out: { x: number; az: number; label?: string; cardinal: boolean }[] =
			[];
		const norm = (a: number) => ((a % 360) + 360) % 360;
		const show = (az: number, cardinal: boolean, given?: string) => {
			const a = norm(az);
			const lab = a % every === 0 || cardinal;
			return lab ? (CARDINAL[a] ?? given ?? `${a}°`) : undefined;
		};
		if (bake && canvas) {
			for (const t of bake.ticks) {
				const x = canvas.left + t.x * canvas.cw;
				if (x < 0 || x > W) continue;
				const card = !!t.cardinal || CARDINAL[norm(t.az)] !== undefined;
				out.push({
					x,
					az: t.az,
					label: show(t.az, card, t.label),
					cardinal: card,
				});
			}
		} else {
			const a0 = azAtX(cam, WORK_W, -ox / s);
			const a1 = azAtX(cam, WORK_W, (W - ox) / s);
			for (let a = Math.ceil(a0 / 5) * 5; a <= a1; a += 5) {
				const x = ox + projectAzEl(cam, WORK_W, h, a, 0)[0] * s;
				const card = CARDINAL[norm(a)] !== undefined;
				out.push({ x, az: a, label: show(a, card), cardinal: card });
			}
		}
		return out;
	}, [bake, canvas, cam, W, ox, s, h, every]);

	const inFrame = useMemo(
		() => placeInFrame(d, s, band, props.maxPeaks),
		[d, s, band, props.maxPeaks],
	);

	// spill labels: from the bake, on the paper side, kept off the photo and inside the viewport
	const spillLabels = useMemo(() => {
		if (!bake || !canvas || phone) return [];
		const out: {
			x: number;
			y: number;
			p: TafelBake["peaks"][number];
			tier: number;
			w: number;
		}[] = [];
		const sorted = [...bake.peaks].sort((a, b) => b.ele - a.ele);
		for (const p of sorted) {
			if (out.length >= 8) break;
			const x = canvas.left + p.x * canvas.cw;
			const y = canvas.top + p.y * canvas.ch;
			const w = Math.max(p.name.length * 7.4, 84) + 12;
			if (x - w / 2 < 8 || x + w / 2 > W - 8) continue;
			if (x > ox - 4 && x < ox + photoW + 4) continue;
			if (y < rulerY + 36 || y > stageH - 8) continue;
			const tier = [0, 1, 2].find(
				(t) =>
					y - 24 - t * 30 > rulerY + 24 &&
					!out.some((q) => boxesOverlap(q.x, q.y, q.tier, q.w, x, y, t, w)),
			);
			if (tier === undefined) continue;
			out.push({ x, y, p, tier, w });
		}
		return out;
	}, [bake, canvas, phone, W, ox, photoW, rulerY, stageH]);

	const bandTop = oy;
	const bandBottom = oy + bandH;
	const spillStyle = useMemo(() => {
		if (!bake || !canvas) return undefined;
		const { photo } = bake;
		const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
		const fl = pct(photo.x * 0.6);
		const fr = pct(1 - (1 - photo.x - photo.w) * 0.6);
		const horizontal = `linear-gradient(to right, transparent, #000 ${fl}, #000 ${fr}, transparent)`;
		const a = bandBottom - 40 - canvas.top;
		const b = bandBottom + 10 - canvas.top;
		const vertical = `linear-gradient(to bottom, #000 ${a}px, transparent ${b}px)`;
		const src = `url(${bake.src})`;
		const image = `${src}, ${horizontal}, ${vertical}`;
		return {
			left: canvas.left,
			top: canvas.top,
			width: canvas.cw,
			height: canvas.ch,
			WebkitMaskImage: image,
			maskImage: image,
		};
	}, [bake, canvas, bandBottom]);

	const u = 1 / s;
	const noteList = props.notes ?? [];
	if (import.meta.env.DEV) {
		for (const n of noteList)
			if (/\d/.test(n.text))
				console.warn(`[Tafel] a note is words only, no digits: "${n.text}"`);
	}
	const layerNode = (props.layer ?? defaultLayer)({ d, s });

	return (
		<>
			{/* (a) compass ruler */}
			<svg
				aria-hidden="true"
				className="absolute left-0 top-0"
				width={W}
				height={rulerY + 14}
			>
				<PenLine
					from={[0, rulerY]}
					to={[W, rulerY]}
					seed="tafel-ruler"
					color="var(--gb-secondary)"
					width={1}
				/>
				{ticks.map((t) => (
					<g key={t.az}>
						<PenLine
							from={[t.x, rulerY]}
							to={[t.x, rulerY + (t.label ? 8 : 4)]}
							seed={`tafel-ruler-tick-${t.az}`}
							color={t.cardinal ? "var(--gb-red)" : "var(--gb-secondary)"}
							width={1}
						/>
						{t.label && (
							<HandLabel
								x={t.x}
								y={rulerY - 8}
								anchor="middle"
								size={12}
								caps={t.cardinal}
								color={t.cardinal ? "var(--gb-red)" : "var(--gb-secondary)"}
							>
								{t.label}
							</HandLabel>
						)}
					</g>
				))}
			</svg>

			{/* (b) the spill: one element, CSS mask */}
			{!phone && bake && spillStyle && (
				<div className="tafel-spill" style={spillStyle} aria-hidden="true" />
			)}

			{/* (c) the photo band */}
			<div
				className="absolute overflow-hidden"
				style={{ left: ox, top: bandTop, width: photoW, height: bandH }}
			>
				<img
					src={d.photo.src}
					alt=""
					width={photoW}
					height={h * s}
					draggable={false}
					className="absolute left-0 max-w-none"
					style={{ top: -band[0] * s, width: photoW, height: h * s }}
				/>
				{/* (d) measured layer, peaks and hand notes in working px */}
				<svg
					aria-hidden="true"
					className="absolute inset-0 size-full"
					viewBox={`0 ${band[0]} ${WORK_W} ${band[1] - band[0]}`}
					preserveAspectRatio="none"
				>
					{layerNode}
					<g>
						{inFrame.map(({ x, y, p, tier }) => {
							const wx = x * u;
							const ly = y - (24 + tier * 30) * u;
							return (
								<g
									key={p.name}
									className="tafel-onphoto"
									fill="#fff"
									textAnchor="middle"
								>
									<PenLine
										from={[wx, ly + 4 * u]}
										to={[wx, y - 3 * u]}
										seed={`tafel-peak-leader-${p.name}`}
										color="#fff"
										opacity={0.7}
										width={0.8 * u}
									/>
									<HandDot
										x={wx}
										y={y}
										r={2.4 * u}
										data
										seed={`tafel-peak-dot-${p.name}`}
										color="#fff"
										opacity={1}
									/>
									<HandLabel
										x={wx}
										y={ly - 11 * u}
										anchor="middle"
										size={13 * u}
										caps
										color="#fff"
										halo={3 * u}
										haloColor="rgba(0,0,0,0.55)"
									>
										{p.name}
									</HandLabel>
									<HandLabel
										x={wx}
										y={ly + 1 * u}
										anchor="middle"
										size={11 * u}
										italic
										color="#fff"
										halo={3 * u}
										haloColor="rgba(0,0,0,0.55)"
									>
										{`${Math.round(p.ele ?? p.dem)} m · ${kmText(p.distance)} km`}
									</HandLabel>
								</g>
							);
						})}
						{noteList.map((n) => (
							<HandLabel
								key={n.text}
								x={n.at[0]}
								y={n.at[1]}
								size={16 * u}
								mono={false}
								color={NOTE_COLOR[n.tone ?? "photo"]}
								halo={3 * u}
								haloColor="rgba(0,0,0,0.55)"
							>
								{n.text}
							</HandLabel>
						))}
					</g>
				</svg>
			</div>

			{/* (e) spill peak labels on the paper side */}
			{!phone && spillLabels.length > 0 && (
				<svg
					aria-hidden="true"
					className="absolute left-0 top-0 pointer-events-none"
					width={W}
					height={stageH}
				>
					{spillLabels.map(({ x, y, p, tier }) => {
						const ly = y - 24 - tier * 30;
						return (
							<g key={p.name} textAnchor="middle">
								<PenLine
									from={[x, ly + 4]}
									to={[x, y - 3]}
									seed={`tafel-spill-leader-${p.name}`}
									color="var(--gb-navy)"
									opacity={0.7}
									width={0.8}
								/>
								<HandDot
									x={x}
									y={y}
									r={2.4}
									data
									seed={`tafel-spill-dot-${p.name}`}
									color="var(--gb-navy)"
									opacity={1}
								/>
								<HandLabel
									x={x}
									y={ly - 11}
									anchor="middle"
									size={13}
									caps
									color="var(--gb-navy)"
									haloColor="var(--gb-paper-deep)"
								>
									{p.name}
								</HandLabel>
								<HandLabel
									x={x}
									y={ly + 1}
									anchor="middle"
									size={11}
									italic
									color="var(--gb-secondary)"
									haloColor="var(--gb-paper-deep)"
								>
									{`${Math.round(p.ele)} m · ${kmText(p.km * 1000)} km`}
								</HandLabel>
							</g>
						);
					})}
				</svg>
			)}
		</>
	);
}
