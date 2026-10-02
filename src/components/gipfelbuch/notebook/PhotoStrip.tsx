// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchIndex,
	type GipfelbuchPhotoId,
} from "#/components/gipfelbuch/viz/real";

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
								src={photo?.thumb ?? `/demo/thumbs/${id}.jpg`}
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
							{id.slice(5)} {photo ? (photo.accepted ? "✓" : "✗") : ""}
						</span>
						{isSelected ? (
							<span
								className="absolute -inset-1.5 rounded-[45%] border-[1.5px] border-[var(--nb-red)]"
								style={{ transform: "rotate(-2deg)" }}
								aria-hidden
							/>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}
