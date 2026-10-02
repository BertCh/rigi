// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// React hooks over the photo look: usePhotoLooks reads each photo's palette + embedding lazily from
// its thumbnail (a few at a time, never blocking render); useLookGroups groups the photos once all
// looks settled. Both are inert until `enabled`; a failed photo is left out of the grouping.
import { useEffect, useRef, useState } from "react";
import {
	type PaletteColor,
	type PhotoLook,
	paletteFromEmbedding,
	photoLookFromUrl,
} from "#/lib/gpu/palette";
import { groupByLook } from "./lookGroups";

export type LookPhoto = { id: string; src?: string | null };

/** Thumbnails decoded at once. */
const LOOK_CONCURRENCY = 3;
/** Minimum ms between state updates while looks stream in. */
const LOOK_FLUSH_MS = 200;

export type PhotoLooks = {
	looks: ReadonlyMap<string, PhotoLook>;
	/** photos still to read */
	pending: number;
	/** photos whose thumbnail could not be read (or have none) */
	failed: ReadonlySet<string>;
};

export function usePhotoLooks(
	photos: LookPhoto[],
	enabled: boolean,
): PhotoLooks {
	const looks = useRef(new Map<string, PhotoLook>());
	const failed = useRef(new Set<string>());
	const [, setVersion] = useState(0);
	const key = photos.map((p) => `${p.id}\n${p.src ?? ""}`).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `photos`
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		const todo = photos.filter(
			(p) => !looks.current.has(p.id) && !failed.current.has(p.id),
		);
		let timer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			timer = null;
			if (!cancelled) setVersion((v) => v + 1);
		};
		const schedule = () => {
			if (timer === null) timer = setTimeout(flush, LOOK_FLUSH_MS);
		};
		let next = 0;
		const worker = async () => {
			while (!cancelled && next < todo.length) {
				const photo = todo[next++];
				try {
					if (!photo.src) throw new Error("no thumbnail");
					looks.current.set(photo.id, await photoLookFromUrl(photo.src));
				} catch {
					failed.current.add(photo.id);
				}
				schedule();
			}
		};
		void Promise.all(
			Array.from({ length: Math.min(LOOK_CONCURRENCY, todo.length) }, worker),
		).then(flush);
		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, [key, enabled]);
	const pending = enabled
		? photos.filter(
				(p) => !looks.current.has(p.id) && !failed.current.has(p.id),
			).length
		: 0;
	return { looks: looks.current, pending, failed: failed.current };
}

export type LookPhotoGroup = {
	/** photo ids, most typical of the look first */
	photoIds: string[];
	/** the group's colours (its centroid's palette), largest share first */
	palette: PaletteColor[];
};

export type LookGroups = {
	/** null until every look has settled, or when grouping is impossible */
	groups: LookPhotoGroup[] | null;
	pending: number;
	/** nothing could be grouped (every read failed, or grouping threw) */
	unavailable: boolean;
};

export function useLookGroups(
	photos: LookPhoto[],
	enabled: boolean,
): LookGroups {
	const { looks, pending, failed } = usePhotoLooks(photos, enabled);
	const [grouped, setGrouped] = useState<{
		key: string;
		groups: LookPhotoGroup[] | null;
	} | null>(null);
	const ready = enabled && pending === 0;
	// the looks map is mutated in place, so this is recomputed every render (a few hundred ids)
	const ids = photos.filter((p) => looks.has(p.id)).map((p) => p.id);
	const key = ids.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
	useEffect(() => {
		if (!ready) return;
		if (!ids.length) {
			setGrouped({ key, groups: null });
			return;
		}
		let cancelled = false;
		groupByLook(ids.map((id) => (looks.get(id) as PhotoLook).embedding))
			.then((result) => {
				if (cancelled) return;
				setGrouped({
					key,
					groups: result.groups.map((g) => ({
						photoIds: g.members.map((m) => ids[m]),
						palette: paletteFromEmbedding(g.centroid),
					})),
				});
			})
			.catch(() => {
				if (!cancelled) setGrouped({ key, groups: null });
			});
		return () => {
			cancelled = true;
		};
	}, [key, ready]);
	const current = ready && grouped?.key === key ? grouped : null;
	return {
		groups: current?.groups ?? null,
		pending,
		unavailable:
			ready &&
			photos.length > 0 &&
			(failed.size >= photos.length || current?.groups === null),
	};
}
