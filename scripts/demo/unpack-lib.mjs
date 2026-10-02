// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The manifest `poses` entry for an exported roll photo, or null when it has no pose to store.
 * CR-W6: with --keep-prior a photo can have source "prior" or a null/missing pose; it is kept in
 * `photos` but gets no pose entry (the app falls back to the prior heading), instead of a
 * `{ pose: null }` entry that downstream readers dereference.
 */
export function poseEntry(photo) {
	if (photo.poseSource === "prior" || !photo.pose) return null;
	return {
		pose: photo.pose,
		source: photo.poseSource,
		confidence: photo.confidence,
	};
}
