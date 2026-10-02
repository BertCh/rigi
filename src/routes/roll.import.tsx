// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Copy,
	GalleryHorizontalEnd,
	ImagePlus,
	Loader2,
	MapPin,
	Route as RouteIcon,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "#/components/site/ThemeToggle";
import type { PhotoMeta } from "#/lib/photos";
import {
	addToIndex,
	createPool,
	DECODE_CONCURRENCY,
	idForFile,
	isNameTimeDuplicate,
	type LatLon,
	type Placement,
	placeBatch,
	placedMeta,
	provenanceOf,
	type SaveEntry,
	type StoredIndex,
	saveRoll,
	storedIndex,
} from "#/lib/roll/import";
import {
	dayKey,
	fmtDateSpan,
	fmtDistance,
	fmtTime,
	listUploadRolls,
} from "#/lib/roll/mosaic";
import { clusterPhotos, makeRoll } from "#/lib/roll/roll";
import {
	HeicUnsupportedError,
	type LocalPhotoMeta,
	prepareUpload,
	type UploadDraft,
	type UploadStage,
} from "#/lib/upload";
import { SlippyMap } from "#/lib/upload/SlippyMap";

// client-only: IndexedDB, blob: URLs, canvas decode
export const Route = createFileRoute("/roll/import")({
	ssr: false,
	head: () => ({ meta: [{ title: "Import a camera roll · Rigi" }] }),
	component: ImportPage,
});

type Status =
	| "queued"
	| "hashing"
	| UploadStage
	| "ready"
	| "duplicate"
	| "error"
	| "saving"
	| "saved"
	| "save-error";

type Item = {
	key: number;
	file: File;
	status: Status;
	id?: string;
	draft?: UploadDraft;
	thumbUrl?: string;
	error?: string;
	note?: string;
};

const BUSY: Status[] = ["queued", "hashing", "reading", "exif", "decoding"];
const STATUS_TEXT: Record<Status, string> = {
	queued: "queued",
	hashing: "checking",
	reading: "reading",
	exif: "EXIF",
	decoding: "decoding",
	done: "decoded",
	ready: "ready",
	duplicate: "duplicate",
	error: "failed",
	saving: "saving",
	saved: "saved",
	"save-error": "not saved",
};

const isImageFile = (f: File) =>
	f.type.startsWith("image/") ||
	/\.(heic|heif|jpe?g|png|webp|avif)$/i.test(f.name);

type Phase =
	| { kind: "edit" }
	| { kind: "saving"; roll: number; of: number; stage: string }
	| {
			kind: "done";
			links: { id: string; name: string; count: number }[];
			warnings: string[];
	  };

function ImportPage() {
	const [items, setItems] = useState<Item[]>([]);
	const [pins, setPins] = useState<ReadonlyMap<string, LatLon>>(new Map());
	const [pinFor, setPinFor] = useState<string | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: "edit" });
	const [dragOver, setDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const seq = useRef(0);
	const pool = useRef<ReturnType<typeof createPool> | null>(null);
	const stored = useRef<Promise<StoredIndex> | null>(null);
	const batch = useRef<StoredIndex>({ ids: new Set(), nameTime: new Set() });
	const urls = useRef(new Set<string>());
	const alive = useRef(true);
	const saveCtl = useRef<AbortController | null>(null);

	// one pool per mount; revoke every thumbnail URL and stop queued decodes on leave
	useEffect(() => {
		alive.current = true;
		pool.current = createPool(DECODE_CONCURRENCY);
		stored.current = storedIndex().catch(() => ({
			ids: new Set<string>(),
			nameTime: new Set<string>(),
		}));
		const owned = urls.current;
		return () => {
			alive.current = false;
			pool.current?.close();
			saveCtl.current?.abort();
			for (const u of owned) URL.revokeObjectURL(u);
			owned.clear();
		};
	}, []);

	const update = useCallback((key: number, patch: Partial<Item>) => {
		if (!alive.current) return;
		setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
	}, []);

	const prepareItem = useCallback(
		async (key: number, file: File) => {
			try {
				update(key, { status: "hashing" });
				const idx = (await stored.current) as StoredIndex;
				const id = await idForFile(file);
				if (idx.ids.has(id))
					return update(key, {
						status: "duplicate",
						id,
						note: "already on this device",
					});
				if (batch.current.ids.has(id))
					return update(key, {
						status: "duplicate",
						id,
						note: "same file twice in this import",
					});
				batch.current.ids.add(id);
				const draft = await prepareUpload(file, (s) =>
					update(key, { status: s }),
				);
				if (!alive.current) return;
				if (isNameTimeDuplicate(idx, draft.meta))
					return update(key, {
						status: "duplicate",
						id,
						note: "same name and time as a stored photo",
					});
				if (isNameTimeDuplicate(batch.current, draft.meta))
					return update(key, {
						status: "duplicate",
						id,
						note: "same name and time as another file here",
					});
				addToIndex(batch.current, draft.meta);
				const thumbUrl = URL.createObjectURL(draft.decoded.thumb);
				urls.current.add(thumbUrl);
				update(key, { status: "ready", id, draft, thumbUrl });
			} catch (e) {
				console.error("[roll import]", file.name, e);
				update(key, {
					status: "error",
					error:
						e instanceof HeicUnsupportedError
							? "HEIC could not be decoded in this browser"
							: (e as Error).message,
				});
			}
		},
		[update],
	);

	const addFiles = useCallback(
		(list: FileList | File[] | null) => {
			const files = [...(list ?? [])].filter(isImageFile);
			if (!files.length) return;
			const added = files.map((file) => ({
				key: ++seq.current,
				file,
				status: "queued" as Status,
			}));
			setItems((xs) => [...xs, ...added]);
			for (const it of added)
				pool.current?.push(() => prepareItem(it.key, it.file));
		},
		[prepareItem],
	);

	const reset = () => {
		for (const u of urls.current) URL.revokeObjectURL(u);
		urls.current.clear();
		batch.current = { ids: new Set(), nameTime: new Set() };
		stored.current = storedIndex().catch(() => ({
			ids: new Set<string>(),
			nameTime: new Set<string>(),
		}));
		setItems([]);
		setPins(new Map());
		setPinFor(null);
		setPhase({ kind: "edit" });
	};

	// ---- derived: placements, final metas, clusters ----------------------------------------
	const ready = useMemo(
		() =>
			items.filter(
				(i): i is Item & { draft: UploadDraft } =>
					!!i.draft && i.status !== "duplicate",
			),
		[items],
	);
	const placements = useMemo(
		() =>
			placeBatch(
				ready.map((i) => i.draft.meta),
				pins,
			),
		[ready, pins],
	);
	const placed = useMemo(() => {
		const out = new Map<string, LocalPhotoMeta>();
		for (const i of ready) {
			const m = placedMeta(
				i.draft,
				placements.get(i.draft.id) ?? { kind: "none" },
			);
			if (m) out.set(i.draft.id, m);
		}
		return out;
	}, [ready, placements]);
	const clusters = useMemo(
		() => clusterPhotos([...placed.values()]) as LocalPhotoMeta[][],
		[placed],
	);
	const previews = useMemo(
		() =>
			clusters.map((g, i) => {
				const r = makeRoll(`preview-${i}`, "", g, null);
				return {
					roll: r,
					count: g.length,
					estimated: g.filter((m) => placements.get(m.id)?.kind !== "gps")
						.length,
				};
			}),
		[clusters, placements],
	);

	const busy = items.filter((i) => BUSY.includes(i.status)).length;
	const dups = items.filter((i) => i.status === "duplicate").length;
	const errors = items.filter((i) => i.status === "error").length;
	const unplaced = ready.filter((i) => !placed.has(i.draft.id));
	const counts = { gps: 0, estimate: 0, pin: 0, none: 0 };
	for (const i of ready)
		counts[(placements.get(i.draft.id) ?? { kind: "none" }).kind]++;

	const saveAll = async () => {
		const ctl = new AbortController();
		saveCtl.current = ctl;
		const byId = new Map(ready.map((i) => [i.draft.id, i]));
		const warnings: string[] = [];
		const firstIds: string[] = [];
		for (let ci = 0; ci < clusters.length; ci++) {
			const entries: SaveEntry[] = clusters[ci].map((m) => {
				const it = byId.get(m.id) as Item & { draft: UploadDraft };
				return {
					draft: it.draft,
					meta: m,
					provenance: provenanceOf(placements.get(m.id) as Placement),
				};
			});
			for (const e of entries) {
				const it = byId.get(e.meta.id);
				if (it) update(it.key, { status: "saving" });
			}
			setPhase({
				kind: "saving",
				roll: ci + 1,
				of: clusters.length,
				stage: "map data",
			});
			const res = await saveRoll(entries, {
				signal: ctl.signal,
				onRegion: (stage) =>
					alive.current &&
					setPhase({
						kind: "saving",
						roll: ci + 1,
						of: clusters.length,
						stage: `map data: ${stage}`,
					}),
				onSaved: (id, error) => {
					const it = byId.get(id);
					if (it)
						update(
							it.key,
							error ? { status: "save-error", error } : { status: "saved" },
						);
				},
			});
			if (!alive.current) return;
			if (res.regionError)
				warnings.push(
					`Roll ${ci + 1}: peaks and trails unavailable (${res.regionError}); photos saved without them.`,
				);
			if (res.saved.length) firstIds.push(res.saved[0]);
		}
		// the saved photos may merge with rolls already on this device: link to the rolls they ended up in
		const { rolls } = await listUploadRolls();
		const links = new Map<
			string,
			{ id: string; name: string; count: number }
		>();
		for (const pid of firstIds) {
			const r = rolls.find((x) => x.photos.some((p) => p.meta.id === pid));
			if (r)
				links.set(r.id, { id: r.id, name: r.name, count: r.photos.length });
		}
		const left = ready.length - placed.size;
		if (left > 0)
			warnings.push(
				`${left} photo${left === 1 ? "" : "s"} without a position ${left === 1 ? "was" : "were"} not saved.`,
			);
		if (alive.current)
			setPhase({ kind: "done", links: [...links.values()], warnings });
	};

	const pinItem = pinFor ? ready.find((i) => i.draft.id === pinFor) : undefined;
	const pinPanel = useRef<HTMLDivElement>(null);
	// the panel sits above the grid: bring it on screen when a photo low in a long roll is picked
	useEffect(() => {
		if (pinFor)
			pinPanel.current?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			});
	}, [pinFor]);
	const pinCenter = useMemo(
		() => pinCenterFor(pinFor, ready, placed),
		[pinFor, ready, placed],
	);
	const editing = phase.kind === "edit";

	return (
		<main
			className="min-h-dvh bg-[var(--rigi-ink)] px-4 pb-16 text-[var(--rigi-paper)] sm:px-8"
			data-testid="roll-import"
		>
			<header className="relative mx-auto max-w-6xl pt-8 pb-6">
				<ThemeToggle className="absolute top-8 right-0" />
				<Link
					to="/roll"
					className="mb-6 inline-flex items-center gap-1.5 text-xs text-white/55 hover:text-[var(--rigi-paper)]"
				>
					<ArrowLeft className="size-3.5" /> Camera rolls
				</Link>
				<p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-[var(--rigi-glow)]/80 uppercase">
					<GalleryHorizontalEnd className="size-3.5" /> Import
				</p>
				<h1 className="text-3xl leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[2.2rem]">
					Bring in a whole camera roll.
				</h1>
				<p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
					Drop a day's photos (JPEG, HEIC, PNG, WebP or AVIF). Photos without
					GPS get a position from the ones taken just before and after them.
					Everything stays in this browser.
				</p>
			</header>

			<section className="mx-auto max-w-6xl">
				{editing && (
					<label
						onDragOver={(e) => {
							e.preventDefault();
							setDragOver(true);
						}}
						onDragLeave={() => setDragOver(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragOver(false);
							addFiles(e.dataTransfer.files);
						}}
						className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition ${
							dragOver
								? "border-[var(--rigi-glow)] bg-[var(--rigi-glow)]/10"
								: "border-white/15 bg-white/[0.03] hover:border-white/30"
						}`}
					>
						<ImagePlus className="size-6 text-[var(--rigi-glow)]" />
						<span className="text-sm font-semibold">
							{items.length
								? "Add more photos"
								: "Drop photos here, or pick them"}
						</span>
						<span className="text-xs text-white/45">
							Decoded {DECODE_CONCURRENCY} at a time. Duplicates of stored
							photos are skipped.
						</span>
						<input
							ref={inputRef}
							type="file"
							multiple
							accept="image/*,.heic,.heif,.avif"
							className="sr-only"
							data-testid="import-input"
							onChange={(e) => {
								addFiles(e.target.files);
								e.target.value = "";
							}}
						/>
					</label>
				)}

				{items.length > 0 && (
					<div
						className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/60"
						data-testid="import-summary"
					>
						<span>
							<b className="text-[var(--rigi-paper)]">{ready.length}</b> ready
							of {items.length}
						</span>
						{busy > 0 && (
							<span className="inline-flex items-center gap-1">
								<Loader2 className="size-3 animate-spin" /> {busy} in progress
							</span>
						)}
						{counts.gps > 0 && <span>{counts.gps} with GPS</span>}
						{counts.estimate > 0 && (
							<span className="text-sky-300 light:text-[var(--rigi-glow)]">
								{counts.estimate} placed by time
							</span>
						)}
						{counts.pin > 0 && (
							<span className="text-emerald-300 light:text-[var(--rigi-result)]">
								{counts.pin} pinned
							</span>
						)}
						{counts.none > 0 && (
							<span className="text-amber-300 light:text-[var(--rigi-lesson)]">
								{counts.none} need a position
							</span>
						)}
						{dups > 0 && (
							<span className="text-white/40">{dups} duplicates skipped</span>
						)}
						{errors > 0 && (
							<span className="text-red-300 light:text-[var(--rigi-trap)]">
								{errors} failed
							</span>
						)}
						<div className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-white/8">
							<div
								className="h-full bg-[var(--rigi-glow)] transition-all"
								style={{
									width: `${((items.length - busy) / items.length) * 100}%`,
								}}
							/>
						</div>
					</div>
				)}

				{pinItem && editing && (
					<div
						ref={pinPanel}
						className="mt-5 scroll-mt-4 rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10"
						data-testid="pin-panel"
					>
						<div className="mb-2 flex items-center gap-3 text-xs">
							{pinItem.thumbUrl && (
								<img
									src={pinItem.thumbUrl}
									alt=""
									className="h-10 rounded object-cover"
								/>
							)}
							<span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold text-white/80">
								<MapPin className="size-3.5 shrink-0 text-red-400 light:text-[var(--rigi-trap)]" />
								<span className="truncate">
									Click the map where {pinItem.file.name} was taken
								</span>
							</span>
							{pins.has(pinItem.draft.id) && (
								<button
									type="button"
									className="text-sky-300 light:text-[var(--rigi-glow)] hover:underline"
									onClick={() => {
										const next = new Map(pins);
										next.delete(pinItem.draft.id);
										setPins(next);
									}}
								>
									Remove pin
								</button>
							)}
							<button
								type="button"
								aria-label="Close"
								onClick={() => setPinFor(null)}
								className="rounded p-1 text-white/60 hover:bg-white/10"
							>
								<X className="size-4" />
							</button>
						</div>
						<SlippyMap
							center={pinCenter.center}
							zoom={pinCenter.zoom}
							pin={placed.get(pinItem.draft.id) ?? null}
							accuracyM={placed.get(pinItem.draft.id)?.hAccuracy ?? null}
							onPick={(p) => setPins(new Map(pins).set(pinItem.draft.id, p))}
						/>
					</div>
				)}

				{items.length > 0 && (
					<ul
						className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6"
						data-testid="import-items"
					>
						{items.map((it) => (
							<ItemCard
								key={it.key}
								item={it}
								placement={it.draft ? placements.get(it.draft.id) : undefined}
								active={!!it.draft && it.draft.id === pinFor}
								onPin={
									editing &&
									it.draft &&
									placements.get(it.draft.id)?.kind !== "gps"
										? () => setPinFor(it.draft?.id ?? null)
										: undefined
								}
							/>
						))}
					</ul>
				)}
			</section>

			{previews.length > 0 && (
				<section
					className="mx-auto mt-8 max-w-6xl"
					data-testid="import-preview"
				>
					<h2 className="mb-3 text-sm font-semibold text-white/70">
						{previews.length} roll{previews.length === 1 ? "" : "s"}{" "}
						<span className="text-white/35">
							· photos within 15 km of each other form one roll
						</span>
					</h2>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{previews.map(({ roll, count, estimated }) => (
							<div
								key={roll.id}
								className="rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/8"
								data-testid="preview-roll"
							>
								<div className="flex items-baseline justify-between gap-3">
									<span className="text-sm font-semibold">
										{count} photo{count === 1 ? "" : "s"}
									</span>
									<span className="font-mono text-[11px] text-white/40">
										{fmtDateSpan(roll.photos)}
									</span>
								</div>
								<div className="mt-1 text-xs text-white/55">
									near {roll.center.lat.toFixed(3)}°,{" "}
									{roll.center.lon.toFixed(3)}° · {roll.viewpoints.length}{" "}
									viewpoint
									{roll.viewpoints.length === 1 ? "" : "s"}
									{roll.radiusM > 0 &&
										` · ${fmtDistance(2 * roll.radiusM)} across`}
								</div>
								<div className="mt-1 text-[11px] text-white/40">
									{timeSpan(roll.photos.map((p) => p.meta))}
									{estimated > 0 && ` · ${estimated} placed without GPS`}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			{items.length > 0 && (
				<section className="mx-auto mt-6 max-w-6xl">
					{phase.kind === "edit" && (
						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								data-testid="import-save"
								disabled={busy > 0 || placed.size === 0}
								onClick={saveAll}
								className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-4 py-2 text-sm font-semibold text-[var(--rigi-ink)] hover:brightness-110 disabled:opacity-40"
							>
								<Check className="size-4" /> Save {placed.size} photo
								{placed.size === 1 ? "" : "s"}
								{previews.length > 1 ? ` as ${previews.length} rolls` : ""}
							</button>
							{busy > 0 && (
								<span className="text-xs text-white/50">
									Waiting for {busy} file{busy === 1 ? "" : "s"}…
								</span>
							)}
							{busy === 0 && unplaced.length > 0 && (
								<span className="text-xs text-amber-300 light:text-[var(--rigi-lesson)]">
									{unplaced.length} without a position will be left out: click
									one to place it.
								</span>
							)}
							<button
								type="button"
								onClick={reset}
								className="text-xs text-white/50 hover:text-white"
							>
								Clear
							</button>
						</div>
					)}
					{phase.kind === "saving" && (
						<p
							className="inline-flex items-center gap-2 text-sm text-white/70"
							data-testid="import-saving"
						>
							<Loader2 className="size-4 animate-spin" /> Saving roll{" "}
							{phase.roll} of {phase.of} · {phase.stage}
						</p>
					)}
					{phase.kind === "done" && (
						<div
							className="rounded-xl bg-emerald-400/10 p-4 ring-1 ring-emerald-300/25 light:ring-[var(--rigi-result)]/25"
							data-testid="import-done"
						>
							<p className="text-sm font-semibold text-emerald-200 light:text-[var(--rigi-result)]">
								Saved. Open your roll{phase.links.length === 1 ? "" : "s"}:
							</p>
							<div className="mt-3 flex flex-wrap gap-2">
								{phase.links.map((l) => (
									<Link
										key={l.id}
										to="/roll/$id"
										params={{ id: l.id }}
										data-testid="import-roll-link"
										className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-3 py-1.5 text-xs font-semibold text-[var(--rigi-ink)] hover:brightness-110"
									>
										<RouteIcon className="size-3.5" /> {l.name} · {l.count}
									</Link>
								))}
							</div>
							{phase.warnings.map((w) => (
								<p
									key={w}
									className="mt-2 text-xs text-amber-300 light:text-[var(--rigi-lesson)]"
								>
									{w}
								</p>
							))}
							<button
								type="button"
								onClick={reset}
								className="mt-3 text-xs text-white/60 hover:text-white"
							>
								Import more
							</button>
						</div>
					)}
				</section>
			)}
		</main>
	);
}

function ItemCard({
	item,
	placement,
	active,
	onPin,
}: {
	item: Item;
	placement?: Placement;
	active: boolean;
	onPin?: () => void;
}) {
	const busy = BUSY.includes(item.status);
	const Tag = onPin ? "button" : "div";
	return (
		<li
			data-testid="import-item"
			data-status={item.status}
			data-position={placement?.kind ?? ""}
		>
			<Tag
				{...(onPin ? { type: "button" as const, onClick: onPin } : {})}
				className={`block w-full overflow-hidden rounded-lg bg-white/[0.04] text-left ring-1 transition ${
					active
						? "ring-[var(--rigi-glow)]"
						: placement?.kind === "none"
							? "ring-amber-300/40 light:ring-[var(--rigi-lesson)]/40"
							: "ring-white/8"
				} ${onPin ? "hover:ring-[var(--rigi-glow)]/60" : ""}`}
			>
				<div data-theme="dark" className="relative aspect-[4/3] bg-black/50">
					{item.thumbUrl && (
						<img
							src={item.thumbUrl}
							alt=""
							className={`size-full object-cover ${item.status === "duplicate" ? "opacity-30" : ""}`}
						/>
					)}
					{busy && (
						<span className="absolute inset-0 flex items-center justify-center text-white/50">
							<Loader2 className="size-5 animate-spin" />
						</span>
					)}
					<span className="absolute top-1 left-1">
						<StatusChip item={item} />
					</span>
				</div>
				<div className="px-2 py-1.5">
					<div
						className="truncate font-mono text-[10.5px] text-white/60"
						title={item.file.name}
					>
						{item.file.name}
					</div>
					<div
						className="mt-0.5 truncate text-[10.5px]"
						title={item.error ?? item.note}
					>
						{item.error ? (
							<span className="text-red-300 light:text-[var(--rigi-trap)]">
								{item.error}
							</span>
						) : item.note ? (
							<span className="text-white/40">{item.note}</span>
						) : (
							<PositionText p={placement} />
						)}
					</div>
				</div>
			</Tag>
		</li>
	);
}

function StatusChip({ item }: { item: Item }) {
	const s = item.status;
	const cls =
		s === "saved"
			? "bg-emerald-400/90 text-black light:text-[var(--rigi-paper)]"
			: s === "error" || s === "save-error"
				? "bg-red-400/90 text-black light:text-[var(--rigi-paper)]"
				: s === "duplicate"
					? "bg-white/20 text-white"
					: s === "ready"
						? "bg-black/60 text-white/80"
						: "bg-[var(--rigi-glow)]/90 text-black light:text-[var(--rigi-ink)]";
	const Icon =
		s === "saved"
			? Check
			: s === "duplicate"
				? Copy
				: s === "error" || s === "save-error"
					? AlertTriangle
					: null;
	return (
		<span
			className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
		>
			{Icon && <Icon className="size-3" />}
			{STATUS_TEXT[s]}
		</span>
	);
}

function PositionText({ p }: { p?: Placement }) {
	if (!p) return <span className="text-white/30">…</span>;
	if (p.kind === "gps") return <span className="text-white/45">GPS</span>;
	if (p.kind === "pin")
		return (
			<span className="text-emerald-300 light:text-[var(--rigi-result)]">
				pinned
			</span>
		);
	if (p.kind === "estimate")
		return (
			<span
				className="text-sky-300 light:text-[var(--rigi-glow)]"
				title={`from ${p.est.from.join(", ")}; ${Math.round(p.est.gapS / 60)} min to the nearest GPS photo`}
			>
				{p.est.method === "interpolated" ? "interpolated" : "nearest GPS"} ±
				{p.est.accuracyM} m
			</span>
		);
	return (
		<span className="text-amber-300 light:text-[var(--rigi-lesson)]">
			needs a position
		</span>
	);
}

/** "10:02–14:37 (4 h 35 min)" in the photos' own wall-clock time; just the duration across days. */
function timeSpan(ms: PhotoMeta[]) {
	if (!ms.length) return "";
	const a = ms[0];
	const b = ms[ms.length - 1];
	const d = (Date.parse(b.takenAt) - Date.parse(a.takenAt)) / 60_000;
	const dur =
		d < 60
			? `${Math.round(d)} min`
			: `${Math.floor(d / 60)} h ${Math.round(d % 60)} min`;
	if (dayKey(a) !== dayKey(b)) return `${dur} from first to last`;
	return `${fmtTime(a)}–${fmtTime(b)}${d < 1 ? "" : ` (${dur})`}`;
}

/** Where to open the pin map: the photo's current estimate, else the batch photo nearest in time, else the batch centre. */
function pinCenterFor(
	id: string | null,
	ready: (Item & { draft: UploadDraft })[],
	placed: Map<string, LocalPhotoMeta>,
) {
	const fallback = { center: { lat: 46.6, lon: 8.0 }, zoom: 7 };
	if (!id) return fallback;
	const own = placed.get(id);
	if (own) return { center: { lat: own.lat, lon: own.lon }, zoom: 14 };
	const me = ready.find((i) => i.draft.id === id);
	const t = me ? Date.parse(me.draft.meta.takenAt) : Number.NaN;
	let best: LocalPhotoMeta | null = null;
	for (const m of placed.values())
		if (
			!best ||
			Math.abs(Date.parse(m.takenAt) - t) <
				Math.abs(Date.parse(best.takenAt) - t)
		)
			best = m;
	return best
		? { center: { lat: best.lat, lon: best.lon }, zoom: 12 }
		: fallback;
}
