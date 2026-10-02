// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useCallback, useEffect, useState } from "react";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoId,
} from "#/components/gipfelbuch/viz/real";
import { storageKey } from "#/lib/gipfelbuch/ontology";

// The demo photo the reader is following through the Gipfelbuch. Picking one on the index or on any
// concept page carries over to the others (same tab via an event, later visits via localStorage, a
// per-viewer convenience that may be unavailable).

const STORAGE_KEY = storageKey("gipfelbuchPhoto");
const CHANGE_EVENT = "gipfelbuch-photo-change";
const DEFAULT_PHOTO: GipfelbuchPhotoId = "demo-01";

const isPhotoId = (value: unknown): value is GipfelbuchPhotoId =>
	typeof value === "string" &&
	(GIPFELBUCH_PHOTO_IDS as readonly string[]).includes(value);

function readStored(): GipfelbuchPhotoId {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return isPhotoId(value) ? value : DEFAULT_PHOTO;
	} catch {
		return DEFAULT_PHOTO;
	}
}

export function useNotebookPhoto(): [
	GipfelbuchPhotoId,
	(id: GipfelbuchPhotoId) => void,
] {
	const [photoId, setPhotoId] = useState<GipfelbuchPhotoId>(DEFAULT_PHOTO);
	useEffect(() => {
		setPhotoId(readStored());
		const onChange = (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail;
			if (isPhotoId(detail)) setPhotoId(detail);
		};
		window.addEventListener(CHANGE_EVENT, onChange);
		return () => window.removeEventListener(CHANGE_EVENT, onChange);
	}, []);
	const select = useCallback((id: GipfelbuchPhotoId) => {
		try {
			localStorage.setItem(STORAGE_KEY, id);
		} catch {
			// Storage blocked: the choice still applies to this tab.
		}
		window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
	}, []);
	return [photoId, select];
}
