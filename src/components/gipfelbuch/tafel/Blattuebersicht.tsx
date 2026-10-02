// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { publicUrl } from "#/lib/public-url";
import { Hachure, PenCircle, PenLine, SketchRect } from "../notebook/Ink";
import { MarkerUnderline } from "../swiss/hand";
import { TYPE } from "../swiss/type";
import { HandLabel } from "../viz/labels";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "../viz/real";
import { CHAPTERS } from "./chapters";
import { SHEETS } from "./sheets";

// The Blattuebersicht: a one-photo picker, a hand-ruled sheet index (S29), then 16 sheets in data-flow
// order as small multiples of that photo's run. Each card is a 400 x 150 band in a hand-ruled frame,
// the red step ("I.3") and Blatt number in hand capitals, and the value in hand figures. Hand pass
// (reports/gipfelbuch-hand-sketch-2026-10-01.md, K-C): every rule and frame is a pen stroke.

const BAND_W = 400;
const BAND_H = 150;

const BLATT_OF = new Map(GIPFELBUCH_NODES.map((n, i) => [n.id, i + 1]));
const NODE_OF = new Map(GIPFELBUCH_NODES.map((n) => [n.id, n]));
const blattLabel = (id: string) =>
	String(BLATT_OF.get(id) ?? 0).padStart(2, "0");

/** All 12 photos' measured data, for the bands that compare photos (accept-rule, camera-roll). */
function useAllPhotos(): Partial<
	Record<GipfelbuchPhotoId, GipfelbuchPhotoData>
> {
	// A fixed list of hook calls: GIPFELBUCH_PHOTO_IDS is a 12-tuple constant.
	const photos = [
		useGipfelbuchPhoto("demo-01"),
		useGipfelbuchPhoto("demo-02"),
		useGipfelbuchPhoto("demo-03"),
		useGipfelbuchPhoto("demo-04"),
		useGipfelbuchPhoto("demo-05"),
		useGipfelbuchPhoto("demo-06"),
		useGipfelbuchPhoto("demo-07"),
		useGipfelbuchPhoto("demo-08"),
		useGipfelbuchPhoto("demo-09"),
		useGipfelbuchPhoto("demo-10"),
		useGipfelbuchPhoto("demo-11"),
		useGipfelbuchPhoto("demo-12"),
	];
	const out: Partial<Record<GipfelbuchPhotoId, GipfelbuchPhotoData>> = {};
	GIPFELBUCH_PHOTO_IDS.forEach((id, i) => {
		const p = photos[i];
		if (p) out[id] = p;
	});
	return out;
}

const CSS = `
.gb-ix-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 48px 24px; padding-top: 24px; }
.gb-ix-card { position: relative; display: block; color: inherit; text-decoration: none; scroll-margin-top: 96px; }
.gb-ix-trail { position: absolute; top: -16px; left: 0; width: calc(100% + 24px); height: 8px; overflow: visible; pointer-events: none; }
.gb-ix-grid > .gb-ix-card:nth-child(3n) .gb-ix-trail, .gb-ix-grid > .gb-ix-card:last-child .gb-ix-trail { width: 100%; }
.gb-ix-card svg.gb-ix-band { display: block; width: 100%; height: auto; overflow: visible; }
.gb-ix-card:focus-visible { outline: 2px solid var(--gb-red, #bf2233); outline-offset: 6px; }
.gb-ix-card:hover .gb-ix-title { text-decoration: underline; text-decoration-color: var(--gb-red, #bf2233); text-underline-offset: 4px; }
.gb-ix-head { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); gap: 48px; align-items: end; }
.gb-ix-picker button { all: unset; box-sizing: border-box; cursor: pointer; position: relative; display: grid; gap: 2px; justify-items: center; padding: 4px; }
.gb-ix-picker button img { width: 48px; height: 36px; object-fit: cover; opacity: .72; }
.gb-ix-picker button[aria-pressed="true"] img { opacity: 1; }
.gb-ix-picker button:focus-visible { outline: 2px solid var(--gb-ink, #131313); outline-offset: 1px; }
.gb-ix-index a:focus-visible { outline: 2px solid var(--gb-red, #bf2233); outline-offset: 2px; }
@media (max-width: 900px) {
  .gb-ix-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gb-ix-grid > .gb-ix-card:nth-child(3n) .gb-ix-trail { width: calc(100% + 24px); }
  .gb-ix-grid > .gb-ix-card:nth-child(2n) .gb-ix-trail, .gb-ix-grid > .gb-ix-card:last-child .gb-ix-trail { width: 100%; }
  .gb-ix-head { grid-template-columns: 1fr; gap: 6px; }
}
@media (max-width: 560px) {
  .gb-ix-grid { grid-template-columns: 1fr; }
  .gb-ix-grid > .gb-ix-card:nth-child(n) .gb-ix-trail { width: 100%; }
}
`;

function PhotoPickerRow({
	followed,
	onFollow,
}: {
	followed: GipfelbuchPhotoId;
	onFollow: (id: GipfelbuchPhotoId) => void;
}) {
	const index = useGipfelbuchIndex();
	const mark = new Map(index?.photos.map((p) => [p.id, p.accepted]));
	return (
		<fieldset
			aria-label="Follow one photo through the sheets"
			className="gb-ix-picker m-0 mt-6 flex min-w-0 flex-wrap items-start gap-1.5 border-0 p-0"
		>
			{GIPFELBUCH_PHOTO_IDS.map((id) => {
				const ok = mark.get(id);
				const pressed = id === followed;
				return (
					<button
						key={id}
						type="button"
						aria-pressed={pressed}
						aria-label={`Photo ${id.slice(5)}${ok == null ? "" : ok ? ", accepted" : ", refused"}`}
						onClick={() => onFollow(id)}
					>
						<img
							src={publicUrl(`/demo/thumbs/${id}.jpg`)}
							alt=""
							width={48}
							height={36}
						/>
						<span
							className={`nb-num text-[12px] leading-[14px] ${ok === false ? "text-[var(--gb-red)]" : ""}`}
						>
							{id.slice(5)}
							{ok == null ? "" : ok ? " ✓" : " ✗"}
						</span>
						{/* the followed photo is circled by hand, not boxed */}
						{pressed ? (
							<svg
								className="pointer-events-none absolute -inset-1 overflow-visible"
								width="64"
								height="62"
								viewBox="0 0 64 62"
								aria-hidden="true"
							>
								<PenCircle
									center={[32, 30]}
									radiusX={31}
									radiusY={29}
									seed={`ix-follow-${id}`}
									color="red"
									width={1.5}
								/>
							</svg>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}

const INDEX_CELL_W = 64;
const INDEX_CELL_H = 40;
const INDEX_PAD = 10;

/**
 * The sheet index drawn by hand (S29): one hand-ruled rectangle per sheet, corners overshooting, the
 * chapters as rows, Blatt numbers in hand figures. Each rectangle links to its card below; `current`
 * (a sheet id) is hatched in pencil.
 */
export function SheetIndexSketch({
	current,
	hrefBase = "",
}: {
	current?: string;
	/** Path prefix for the card anchors, e.g. "/gipfelbuch" when drawn on a concept sheet. */
	hrefBase?: string;
}) {
	const columns = Math.max(...CHAPTERS.map((c) => c.ids.length));
	const width = INDEX_PAD * 2 + 34 + columns * INDEX_CELL_W;
	const height = INDEX_PAD * 2 + CHAPTERS.length * INDEX_CELL_H;
	return (
		<nav aria-label="Sheet index" className="gb-ix-index mt-8 overflow-x-auto">
			<svg
				viewBox={`0 0 ${width} ${height}`}
				width={width}
				height={height}
				className="block max-w-full overflow-visible"
			>
				<title>Sheet index</title>
				{CHAPTERS.map((chapter, row) => {
					const y = INDEX_PAD + row * INDEX_CELL_H;
					return (
						<g key={chapter.numeral}>
							<HandLabel
								x={INDEX_PAD + 24}
								y={y + INDEX_CELL_H / 2 + 6}
								anchor="end"
								size={18}
								color="var(--gb-contour)"
								halo={0}
								mono={false}
							>
								{chapter.numeral}
							</HandLabel>
							{chapter.ids.map((id, column) => {
								const x = INDEX_PAD + 34 + column * INDEX_CELL_W;
								const node = NODE_OF.get(id);
								const rect = `M${x} ${y}h${INDEX_CELL_W}v${INDEX_CELL_H}h${-INDEX_CELL_W}Z`;
								return (
									<a
										key={id}
										href={`${hrefBase}#chapter-${id}`}
										aria-label={`Sheet ${blattLabel(id)}: ${node?.title ?? id}`}
									>
										<title>{node?.title ?? id}</title>
										<rect
											x={x}
											y={y}
											width={INDEX_CELL_W}
											height={INDEX_CELL_H}
											fill="transparent"
										/>
										{id === current ? (
											<Hachure
												d={rect}
												seed={`ix-current-${id}`}
												color="pencil"
												width={0.8}
												opacity={0.55}
												gap={3.5}
											/>
										) : null}
										<SketchRect
											x={x}
											y={y}
											width={INDEX_CELL_W}
											height={INDEX_CELL_H}
											seed={`ix-cell-${id}`}
											color="ink"
											penWidth={0.9}
											tolerance={0.9}
										/>
										<HandLabel
											x={x + INDEX_CELL_W / 2}
											y={y + INDEX_CELL_H / 2 + 6}
											anchor="middle"
											size={17}
											color="var(--gb-ink)"
											halo={0}
										>
											{blattLabel(id)}
										</HandLabel>
									</a>
								);
							})}
						</g>
					);
				})}
			</svg>
		</nav>
	);
}

function Card({
	id,
	label,
	d,
	all,
}: {
	id: string;
	label: string;
	d: GipfelbuchPhotoData | null;
	all: Partial<Record<GipfelbuchPhotoId, GipfelbuchPhotoData>>;
}) {
	const node = NODE_OF.get(id);
	const sheet = SHEETS[id];
	if (!node || !sheet) return null;
	return (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="gb-ix-card"
			id={`chapter-${id}`}
		>
			{/* the red trail from sheet to sheet: one pen stroke, a hand dot where the step starts */}
			<svg
				className="gb-ix-trail [&_path]:[vector-effect:non-scaling-stroke]"
				viewBox="0 0 100 8"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<PenLine
					from={[0.5, 4]}
					to={[100, 4]}
					seed={`ix-trail-${id}`}
					color="red"
					width={1.1}
				/>
			</svg>
			<svg
				className="gb-ix-band"
				viewBox={`0 0 ${BAND_W} ${BAND_H}`}
				role="img"
				aria-label={node.title}
			>
				<rect
					width={BAND_W}
					height={BAND_H}
					fill="var(--gb-paper-deep, #ebebe6)"
				/>
				{/* the band svg overflows for the frame's overshoot, so clip the band itself (the sampler zooms a 10x DEM) */}
				<clipPath id={`ix-clip-${id}`}>
					<rect width={BAND_W} height={BAND_H} />
				</clipPath>
				<g clipPath={`url(#ix-clip-${id})`}>
					{d && sheet.band({ d, all, w: BAND_W, h: BAND_H })}
				</g>
				{/* hand-ruled frame, corners overshooting (S29) */}
				<SketchRect
					x={0}
					y={0}
					width={BAND_W}
					height={BAND_H}
					seed={`ix-frame-${id}`}
					color="ink"
					penWidth={1.2}
					opacity={0.85}
					tolerance={1.4}
				/>
			</svg>
			<div className="mt-2.5 flex items-baseline gap-2.5">
				<span className="nb-hand text-[20px] leading-[20px] text-[var(--gb-red)]">
					{label}
				</span>
				<span className="nb-label ml-auto text-[13px] tracking-[0.08em]">
					Blatt <span className="nb-num">{blattLabel(id)}</span>
				</span>
			</div>
			<h3
				className={`${TYPE.h3} gb-ix-title mt-0.5 text-[24px] leading-[28px]`}
			>
				{node.title}
			</h3>
			<p className={`${TYPE.caption} mt-0.5`}>{node.tagline}</p>
			<p className="nb-num mt-1 text-[13px] leading-[18px] text-[var(--gb-ink)]">
				{d ? sheet.value(d) : " "}
			</p>
		</Link>
	);
}

export function Blattuebersicht({
	followed,
	onFollow,
	current,
}: {
	followed: GipfelbuchPhotoId;
	onFollow: (id: GipfelbuchPhotoId) => void;
	/** A sheet id to hatch in the hand sheet index (the sheet the reader is on). */
	current?: string;
}) {
	const d = useGipfelbuchPhoto(followed);
	const all = useAllPhotos();
	return (
		<div>
			<style>{CSS}</style>
			<PhotoPickerRow followed={followed} onFollow={onFollow} />
			<SheetIndexSketch current={current} />
			{CHAPTERS.map((chapter) => (
				<section key={chapter.numeral} className="pt-16">
					<div className="gb-ix-head">
						<div>
							<div className="nb-hand text-[20px] leading-[24px] text-[var(--gb-contour)]">
								Kapitel {chapter.numeral}
							</div>
							<div className="relative mt-1 inline-block">
								<h2 className={`${TYPE.h2} m-0`}>{chapter.title}</h2>
								<MarkerUnderline seed={`ix-chapter-${chapter.numeral}`} />
							</div>
						</div>
						<div>
							<p className={`${TYPE.body} gb-secondary`}>{chapter.intro}</p>
							<p className="nb-hand mt-2 text-[20px] leading-[24px] text-[var(--gb-water)]">
								{d ? chapter.fieldNote(d) : " "}
							</p>
						</div>
					</div>
					<div className="gb-ix-grid">
						{chapter.ids.map((id, i) => (
							<Card
								key={id}
								id={id}
								label={`${chapter.numeral}.${i + 1}`}
								d={d}
								all={all}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
