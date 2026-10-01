// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Roll } from "#/lib/roll/types";

// Dev only: bundle an upload roll (IndexedDB photos + regions + per-photo localStorage) into one JSON
// download, which scripts/demo/unpack.mjs turns into the bundled demo set in public/demo/.
export const Route = createFileRoute("/dev/export-roll")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): { id?: string } => ({
		id: typeof s.id === "string" ? s.id : undefined,
	}),
	component: ExportRoll,
});

const blobToB64 = (b: Blob) =>
	new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
		r.onerror = () => reject(r.error);
		r.readAsDataURL(b);
	});

function ExportRoll() {
	const { id } = Route.useSearch();
	const [rolls, setRolls] = useState<Roll[] | null>(null);
	const [msg, setMsg] = useState("");
	useEffect(() => {
		import("#/lib/roll/mosaic/loadRoll")
			.then((m) => m.listUploadRolls())
			.then((r) => setRolls(r.rolls))
			.catch((e) => setMsg(String(e)));
	}, []);
	if (!import.meta.env.DEV) return <p>dev only</p>;

	const run = async (roll: Roll) => {
		setMsg("Reading IndexedDB…");
		const store = await import("#/lib/upload/store");
		const photos = [];
		const regions = new Map<string, unknown>();
		for (const p of roll.photos) {
			const rec = await store.getPhotoRecord(p.meta.id);
			if (!rec) continue;
			const ls: Record<string, string> = {};
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k?.includes(p.meta.id)) ls[k] = localStorage.getItem(k) ?? "";
			}
			if (!regions.has(rec.meta.region))
				regions.set(
					rec.meta.region,
					await store.getRegion(rec.meta.region).catch(() => null),
				);
			photos.push({
				meta: rec.meta,
				poseSource: p.poseSource,
				pose: p.pose,
				confidence: p.confidence,
				eyeAlt: p.eyeAlt,
				localStorage: ls,
				jpg: await blobToB64(rec.blob),
				thumb: rec.thumb ? await blobToB64(rec.thumb) : null,
			});
			setMsg(`Read ${photos.length}/${roll.photos.length}`);
		}
		const bundle = {
			exportedAt: new Date().toISOString(),
			roll: { id: roll.id, name: roll.name, viewpoints: roll.viewpoints },
			photos,
			regions: Object.fromEntries(regions),
		};
		const a = document.createElement("a");
		a.href = URL.createObjectURL(
			new Blob([JSON.stringify(bundle)], { type: "application/json" }),
		);
		a.download = `rigi-roll-${roll.id}.json`;
		a.click();
		setMsg(`Downloaded ${a.download} (${photos.length} photos)`);
	};

	const list = rolls?.filter((r) => !id || r.id === id) ?? [];
	return (
		<main className="min-h-dvh bg-[var(--rigi-ink)] p-8 text-[var(--rigi-paper)]">
			<h1 className="text-xl font-semibold">Export an upload roll</h1>
			<p className="mt-2 text-sm text-white/55">
				Downloads one JSON with the photos, regions and saved/solved poses.
			</p>
			{!rolls && <p className="mt-6 text-sm">Loading…</p>}
			{rolls && !list.length && (
				<p className="mt-6 text-sm">No upload roll {id} in this browser.</p>
			)}
			<ul className="mt-6 space-y-2">
				{list.map((r) => (
					<li key={r.id} className="flex items-center gap-4 text-sm">
						<button
							type="button"
							data-testid="export-roll"
							onClick={() => run(r).catch((e) => setMsg(String(e)))}
							className="rounded-lg bg-[var(--rigi-glow)] px-3 py-1.5 font-semibold text-[var(--rigi-ink)]"
						>
							Export
						</button>
						<span className="font-mono">{r.id}</span>
						<span className="text-white/55">
							{r.photos.length} photos ·{" "}
							{r.photos.filter((p) => p.poseSource !== "prior").length} aligned
						</span>
					</li>
				))}
			</ul>
			<p className="mt-6 font-mono text-xs text-white/55">{msg}</p>
		</main>
	);
}
