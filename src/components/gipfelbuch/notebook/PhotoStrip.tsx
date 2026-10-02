// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchIndex,
	type GipfelbuchPhotoId,
} from "#/components/gipfelbuch/viz/real";
import { publicUrl } from "#/lib/public-url";
import { PenCircle, SketchPath } from "./Ink";

/** A pen tick or cross, standing in for the glyph (the button's aria-label carries the meaning). */
function HandMark({ ok, seed }: { ok: boolean; seed: string }) {
	return (
		<svg
			viewBox="0 0 12 12"
			width={11}
			height={11}
			className="ml-0.5 inline-block overflow-visible align-baseline"
			aria-hidden="true"
		>
			{ok ? (
				<SketchPath
					d="M1.5 6.5L4.5 10L10.5 1.5"
					seed={seed}
					color="forest"
					width={1.5}
					passes={1}
					tolerance={0.4}
				/>
			) : (
				<SketchPath
					d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
					seed={seed}
					color="red"
					width={1.5}
					passes={1}
					tolerance={0.4}
				/>
			)}
		</svg>
	);
}

/** Thumbnails of the twelve demo photos, ticked or crossed by the accept gate. */
export function PhotoStrip({
	index,
	selected,
	onSelect,
	small = false,
}: {
	small?: boolean;
	index: GipfelbuchIndex | null;
	selected: GipfelbuchPhotoId;
	onSelect: (id: GipfelbuchPhotoId) => void;
}) {
	// Print (mat included) and label row, in px, so the pen loop is drawn at the right size.
	const printWidth = small ? 41 : 56;
	const printHeight = small ? 32 : 44;
	const loopWidth = printWidth + 18;
	const loopHeight = printHeight + 14 + 18;
	return (
		<fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
			<legend className="sr-only">Demo photo</legend>
			{GIPFELBUCH_PHOTO_IDS.map((id) => {
				const photo = index?.photos.find((entry) => entry.id === id);
				const isSelected = id === selected;
				return (
					<button
						key={id}
						type="button"
						onClick={() => onSelect(id)}
						aria-pressed={isSelected}
						aria-label={`${id}${photo ? (photo.accepted ? ", solved" : ", refused") : ""}`}
						className="group relative flex flex-col items-center"
					>
						<span
							className={`nb-print block transition ${isSelected ? "" : "opacity-75 group-hover:opacity-100"}`}
							style={{ padding: "3px 3px 3px" }}
						>
							<img
								src={photo?.thumb ?? publicUrl(`/demo/thumbs/${id}.jpg`)}
								alt=""
								className={
									small
										? "block h-[26px] w-[35px] object-cover"
										: "block h-[38px] w-[50px] object-cover"
								}
								loading="lazy"
							/>
						</span>
						<span
							className={`nb-hand mt-0.5 text-[13px] leading-none ${photo && !photo.accepted ? "text-[var(--nb-red)]" : "text-[var(--nb-pencil)]"}`}
						>
							{id.slice(5)}
							{photo ? (
								<HandMark ok={photo.accepted} seed={`strip-mark-${id}`} />
							) : null}
						</span>
						{isSelected ? (
							<svg
								viewBox={`0 0 ${loopWidth} ${loopHeight}`}
								width={loopWidth}
								height={loopHeight}
								className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-visible"
								aria-hidden="true"
							>
								<PenCircle
									seed={`strip-${id}`}
									center={[loopWidth / 2, loopHeight / 2]}
									radiusX={loopWidth / 2 - 1}
									radiusY={loopHeight / 2 - 1}
									color="red"
									width={1.6}
								/>
							</svg>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}
