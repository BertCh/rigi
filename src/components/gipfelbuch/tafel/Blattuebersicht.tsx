// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { TYPE } from "../swiss/type";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "../viz/real";
import { CHAPTERS } from "./chapters";
import { SHEETS } from "./sheets";

// The Blattuebersicht: a one-photo picker, then 19 sheets in data-flow order as small multiples of that
// photo's run. Each card is a 400 x 150 band, the plain red step ("I.3"), the Blatt number and the value.
// Softer sheet (reports/peak-notebook-plan.md, section 0): a thin solid red trail, no outlines or tape.

const BAND_W = 400;
const BAND_H = 150;

const BLATT_OF = new Map(GIPFELBUCH_NODES.map((n, i) => [n.id, i + 1]));
const NODE_OF = new Map(GIPFELBUCH_NODES.map((n) => [n.id, n]));

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
.gb-ix-card { position: relative; display: block; color: inherit; text-decoration: none; }
.gb-ix-card::before { content: ""; position: absolute; top: -12px; left: 0; right: -24px; height: 1px; background: var(--gb-red, #bf2233); }
.gb-ix-card::after { content: ""; position: absolute; top: -14px; left: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--gb-red, #bf2233); }
.gb-ix-grid > .gb-ix-card:nth-child(3n)::before, .gb-ix-grid > .gb-ix-card:last-child::before { right: 0; }
.gb-ix-card svg { display: block; width: 100%; height: auto; border-radius: 2px; }
.gb-ix-card:focus-visible { outline: 2px solid var(--gb-red, #bf2233); outline-offset: 4px; }
.gb-ix-card:hover .gb-ix-title { text-decoration: underline; text-underline-offset: 3px; }
.gb-ix-head { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); gap: 48px; align-items: end; }
.gb-ix-picker button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 2px; justify-items: center; padding: 3px; border-radius: 3px; }
.gb-ix-picker button img { width: 48px; height: 36px; object-fit: cover; border-radius: 2px; opacity: .72; }
.gb-ix-picker button[aria-pressed="true"] img { opacity: 1; }
.gb-ix-picker button[aria-pressed="true"] { outline: 2px solid var(--gb-red, #bf2233); }
.gb-ix-picker button:focus-visible { outline: 2px solid var(--gb-ink, #131313); outline-offset: 1px; }
@media (max-width: 900px) {
  .gb-ix-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gb-ix-grid > .gb-ix-card:nth-child(3n)::before { right: -24px; }
  .gb-ix-grid > .gb-ix-card:nth-child(2n)::before, .gb-ix-grid > .gb-ix-card:last-child::before { right: 0; }
  .gb-ix-head { grid-template-columns: 1fr; gap: 6px; }
}
@media (max-width: 560px) {
  .gb-ix-grid { grid-template-columns: 1fr; }
  .gb-ix-grid > .gb-ix-card:nth-child(n)::before { right: 0; }
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
				return (
					<button
						key={id}
						type="button"
						aria-pressed={id === followed}
						aria-label={`Photo ${id.slice(5)}${ok == null ? "" : ok ? ", accepted" : ", refused"}`}
						onClick={() => onFollow(id)}
					>
						<img src={`/demo/thumbs/${id}.jpg`} alt="" width={48} height={36} />
						<span className={TYPE.micro}>
							{id.slice(5)}
							{ok == null ? "" : ok ? " ✓" : " ✗"}
						</span>
					</button>
				);
			})}
		</fieldset>
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
		>
			<svg
				viewBox={`0 0 ${BAND_W} ${BAND_H}`}
				role="img"
				aria-label={node.title}
			>
				<rect
					width={BAND_W}
					height={BAND_H}
					fill="var(--gb-paper-deep, #ebebe6)"
				/>
				{d && sheet.band({ d, all, w: BAND_W, h: BAND_H })}
			</svg>
			<div className="mt-2.5 flex items-baseline gap-2.5">
				<span
					className={TYPE.micro}
					style={{ color: "var(--gb-red, #bf2233)" }}
				>
					{label}
				</span>
				<span className={`${TYPE.micro} ml-auto`}>
					Blatt {BLATT_OF.get(id)}
				</span>
			</div>
			<h3 className={`${TYPE.h3} gb-ix-title mt-0.5`}>{node.title}</h3>
			<p className={`${TYPE.caption} mt-0.5`}>{node.tagline}</p>
			<p
				className={`${TYPE.micro} mt-1`}
				style={{ color: "var(--gb-ink, #131313)" }}
			>
				{d ? sheet.value(d) : " "}
			</p>
		</Link>
	);
}

export function Blattuebersicht({
	followed,
	onFollow,
}: {
	followed: GipfelbuchPhotoId;
	onFollow: (id: GipfelbuchPhotoId) => void;
}) {
	const d = useGipfelbuchPhoto(followed);
	const all = useAllPhotos();
	return (
		<div>
			<style>{CSS}</style>
			<PhotoPickerRow followed={followed} onFollow={onFollow} />
			{CHAPTERS.map((chapter) => (
				<section key={chapter.numeral} className="pt-16">
					<div className="gb-ix-head">
						<div>
							<div
								className={TYPE.kicker}
								style={{ color: "var(--gb-contour, #95500c)" }}
							>
								Kapitel {chapter.numeral}
							</div>
							<h2 className={`${TYPE.h2} mt-1.5`}>{chapter.title}</h2>
						</div>
						<div>
							<p className={`${TYPE.body} gb-secondary`}>{chapter.intro}</p>
							<p
								className={`${TYPE.body} gb-num mt-2`}
								style={{ color: "var(--gb-water, #30626b)" }}
							>
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
