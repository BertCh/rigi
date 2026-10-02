// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Pack consistency check: pack_index.json against the files on disk. Reads only directory listings and the
 * index; it never opens an image and never touches key/ (blinding). Optional key cross-check is a separate
 * function the human runs after verification.
 */
import fs from "node:fs";
import path from "node:path";
import type { KeyFile } from "./lib";

export interface PackIndex {
	folders: string[];
	nFolders: number;
	nImages: number;
	suggestedBatches: string[][];
}

export interface PackReport {
	ok: boolean;
	nFolders: number;
	nOverlays: number;
	problems: string[];
	/** folder -> overlay labels found on disk. */
	labelsByFolder: Record<string, string[]>;
}

const OVERLAY_RE = /^candidate_([A-Z]{2}\d)\.jpg$/;

export function listPack(packDir: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (!fs.existsSync(packDir)) return out;
	for (const f of fs.readdirSync(packDir).sort()) {
		const dir = path.join(packDir, f);
		if (!fs.statSync(dir).isDirectory()) continue;
		out[f] = fs
			.readdirSync(dir)
			.map((n) => OVERLAY_RE.exec(n)?.[1])
			.filter((x): x is string => !!x)
			.sort();
	}
	return out;
}

export function checkPack(
	packDir: string,
	index: PackIndex,
	expected: { folders?: number; overlays?: number } = {},
): PackReport {
	const problems: string[] = [];
	const labelsByFolder = listPack(packDir);
	const onDisk = Object.keys(labelsByFolder);
	const nOverlays = Object.values(labelsByFolder).reduce(
		(s, l) => s + l.length,
		0,
	);
	if (index.nFolders !== index.folders.length)
		problems.push(
			`index nFolders ${index.nFolders} != folders.length ${index.folders.length}`,
		);
	if (new Set(index.folders).size !== index.folders.length)
		problems.push("index lists a folder twice");
	for (const f of index.folders) {
		if (!labelsByFolder[f]) problems.push(`index folder missing on disk: ${f}`);
		else if (!fs.existsSync(path.join(packDir, f, "photo.jpg")))
			problems.push(`no photo.jpg in ${f}`);
		else if (labelsByFolder[f].length === 0)
			problems.push(`no overlays in ${f}`);
	}
	for (const f of onDisk)
		if (!index.folders.includes(f))
			problems.push(`folder on disk not in index: ${f}`);
	if (index.nImages !== nOverlays)
		problems.push(
			`index nImages ${index.nImages} != overlays on disk ${nOverlays}`,
		);
	const batched = index.suggestedBatches.flat();
	if (batched.length !== new Set(batched).size)
		problems.push("a folder is in two batches");
	for (const f of index.folders)
		if (!batched.includes(f)) problems.push(`folder in no batch: ${f}`);
	for (const f of batched)
		if (!index.folders.includes(f))
			problems.push(`batch folder not in index: ${f}`);
	for (const f of fs.existsSync(packDir) ? fs.readdirSync(packDir) : [])
		for (const n of fs.existsSync(path.join(packDir, f)) &&
		fs.statSync(path.join(packDir, f)).isDirectory()
			? fs.readdirSync(path.join(packDir, f))
			: [])
			if (n !== "photo.jpg" && !OVERLAY_RE.test(n))
				problems.push(`unexpected file ${f}/${n}`);
	if (expected.folders !== undefined && onDisk.length !== expected.folders)
		problems.push(
			`expected ${expected.folders} folders, found ${onDisk.length}`,
		);
	if (expected.overlays !== undefined && nOverlays !== expected.overlays)
		problems.push(`expected ${expected.overlays} overlays, found ${nOverlays}`);
	return {
		ok: problems.length === 0,
		nFolders: onDisk.length,
		nOverlays,
		problems,
		labelsByFolder,
	};
}

/** Post-verification only: every key label has an overlay file in its key folder and vice versa. */
export function crossCheckKey(report: PackReport, key: KeyFile): string[] {
	const problems: string[] = [];
	for (const [label, k] of Object.entries(key.candidates))
		if (!report.labelsByFolder[k.folder]?.includes(label))
			problems.push(`key label ${label} has no file in ${k.folder}`);
	const labels = new Set(Object.keys(key.candidates));
	for (const [f, ls] of Object.entries(report.labelsByFolder))
		for (const l of ls)
			if (!labels.has(l)) problems.push(`overlay ${f}/${l} not in key`);
	return problems;
}
