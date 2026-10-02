// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Resolve rolls on the client: built-in regions, the bundled sample trip (src/lib/demo), or `local-roll-<hash>` from the uploads in
// IndexedDB. The upload module is imported lazily so bundled rolls never pull in the HEIC/EXIF code.

import { storageKey } from "../../ontology/core/storage";
import {
	getBuiltinRoll,
	legacyUploadRollIndex,
	saveSolvedPose,
	UPLOAD_ROLL_PREFIX,
	uploadRolls,
} from "../roll";
import type { Roll } from "../types";

export const LOCAL_ROLL_PREFIX = UPLOAD_ROLL_PREFIX;
export const isLocalRollId = (id: string) => id.startsWith(LOCAL_ROLL_PREFIX);

const thumbUrls = new Map<string, string>();
/** Thumbnail blob URL of an upload photo seen by the last listUploadRolls/loadRoll call, if any. */
export const getUploadThumb = (photoId: string): string | null =>
	thumbUrls.get(photoId) ?? null;

/** Upload rolls for the list page, with thumbnail URLs (meta.src is empty until restored). */
export async function listUploadRolls(): Promise<{
	rolls: Roll[];
	thumbs: Map<string, string>;
}> {
	const m = await import("#/lib/upload");
	const list = await m.listLocalPhotos();
	const thumbs = new Map<string, string>();
	for (const s of list) if (s.thumbUrl) thumbs.set(s.id, s.thumbUrl);
	for (const [k, v] of thumbs) thumbUrls.set(k, v);
	return { rolls: uploadRolls(list.map((s) => s.meta)), thumbs };
}

/**
 * Pick a local roll by id: the stable `local-roll-<hash>` (else the roll now holding photo
 * `local-<hash>`, e.g. after an earlier photo joined it), or a legacy `local-roll-<n>` index.
 */
function findUploadRoll(rolls: Roll[], id: string): Roll | null {
	const exact = rolls.find((r) => r.id === id);
	if (exact) return exact;
	const n = legacyUploadRollIndex(id);
	if (n != null) return rolls[n] ?? null;
	const photoId = `local-${id.slice(LOCAL_ROLL_PREFIX.length)}`;
	return rolls.find((r) => r.photos.some((p) => p.meta.id === photoId)) ?? null;
}

/**
 * A roll by id. Local rolls restore every upload (blob: src, registered with photos.ts so
 * /photo/$id opens them). The blob: URLs are the upload module's per-photo cache (one per
 * photo, reused across visits, revoked when the photo is deleted).
 */
export async function loadRoll(id: string): Promise<Roll | null> {
	if (id === "demo") return (await import("#/lib/demo")).loadDemoRoll();
	if (!isLocalRollId(id)) return getBuiltinRoll(id);
	const m = await import("#/lib/upload");
	const list = await m.listLocalPhotos();
	for (const s of list) if (s.thumbUrl) thumbUrls.set(s.id, s.thumbUrl);
	// Group the stored metas first and register only the requested roll's photos (each registration
	// is a DB read, a full-size blob URL and a map region load).
	const found = findUploadRoll(uploadRolls(list.map((s) => s.meta)), id);
	if (!found) return null;
	const wanted = new Set(found.photos.map((p) => p.meta.id));
	const metas = await Promise.all(
		list.map(async (s) =>
			wanted.has(s.id)
				? ((await m.ensureLocalPhotoRegistered(s.id)) ?? s.meta)
				: s.meta,
		),
	);
	return findUploadRoll(uploadRolls(metas), id);
}

/** Delete every upload in a local roll from this device (IndexedDB, blob: URLs, per-photo poses). */
export async function deleteUploadRoll(roll: Roll) {
	const m = await import("#/lib/upload");
	const { saveProvenance } = await import("../import/provenance");
	for (const p of roll.photos) {
		const id = p.meta.id;
		if (!m.isLocalPhotoId(id)) continue;
		await m.deleteLocalPhoto(id);
		saveSolvedPose(id, null);
		saveProvenance(id, null);
		try {
			localStorage.removeItem(storageKey("savedPose", id));
		} catch {
			// storage unavailable
		}
	}
}
