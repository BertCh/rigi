// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Drop-in "Export" dropdown for the photo workspace.
//
//   <ExportMenu engine={engineRef} disabled={!!status} withLabels={showPeaks} />
//
// `engine` may be the engine itself, a React ref to it (PhotoWorkspace keeps it in engineRef), or
// a getter; it is resolved at click time, so a ref that is filled after mount works. See
// out/lead/export/API.md, "ExportMenu integration".
import {
	Box,
	ChevronDown,
	Download,
	FileCode,
	FileJson,
	Globe,
	Image as ImageIcon,
	LoaderCircle,
	MapPinned,
	Sparkles,
} from "lucide-react";
import {
	type ComponentType,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer as PhotoEngine } from "#/lib/renderer";
import { cn } from "#/lib/utils";
import {
	downloadBlob,
	type EngineExportOptions,
	EXPORT_FORMATS,
	type ExportKind,
	engineReady,
	exportFromEngine,
} from "./engine-export";
import {
	engineNearFieldScene,
	exportSplatsFromEngine,
	SPLAT_EXPORT_FORMATS,
	type SplatExportKind,
} from "./splat";

export type EngineSource =
	| PhotoEngine
	| null
	| undefined
	| { current: PhotoEngine | null }
	| (() => PhotoEngine | null | undefined);

export type ExportMenuProps = EngineExportOptions & {
	engine: EngineSource;
	/** Only used for the button tooltip before the engine exists; filenames come from engine.photo.id. */
	photo?: Pick<PhotoMeta, "id">;
	/**
	 * REQUIRED for correct exports: true while the host is still loading OR aligning. The engine sets
	 * `terrain` before autoAlign() runs, so engine state alone cannot tell the compass prior from the
	 * final pose. PhotoWorkspace: `disabled={!!status}` (status stays set until after setPose(align)).
	 * While true, every item is disabled, even in an already-open menu.
	 */
	disabled?: boolean;
	className?: string;
	/** Which edge the dropdown aligns to. Default 'right' (for a toolbar's right end). */
	align?: "left" | "right";
	/** Called after each export (tests, toasts). */
	onExported?: (e: {
		/** Splat kinds appear only when the renderer has a Step Inside near-field scene. */
		kind: ExportKind | SplatExportKind;
		filename: string;
		bytes: number;
		notes: string[];
	}) => void;
};

const ICONS: Record<ExportKind, ComponentType<{ className?: string }>> = {
	png: ImageIcon,
	kmz: Globe,
	geojson: MapPinned,
	pose: FileJson,
	colmap: Box,
	xmp: FileCode,
};

function resolve(src: EngineSource): PhotoEngine | null {
	if (!src) return null;
	if (typeof src === "function") return src() ?? null;
	if ("current" in src && !("photo" in src)) return src.current;
	return src as PhotoEngine;
}

export function ExportMenu({
	engine,
	photo,
	disabled,
	className,
	align = "right",
	onExported,
	...opts
}: ExportMenuProps) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<ExportKind | SplatExportKind | null>(null);
	// Step Inside: splat exports are listed only while the renderer has a near-field scene
	const [hasSplats, setHasSplats] = useState(false);
	const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(
		null,
	);
	const [ready, setReady] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	// close on outside click / Escape
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (root.current && !root.current.contains(e.target as Node))
				setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// menu opened while terrain was loading: track engine readiness. This only says terrain exists;
	// whether the pose is final comes from the host via `disabled`, which gates items directly.
	useEffect(() => {
		if (!open || ready) return;
		const t = setInterval(() => {
			const eng = resolve(engine);
			setHasSplats(!!engineNearFieldScene(eng));
			if (engineReady(eng)) setReady(true);
		}, 250);
		return () => clearInterval(t);
	}, [open, ready, engine]);
	const canExport = ready && !disabled;
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;

	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next) {
			setReady(engineReady(resolve(engine)));
			setHasSplats(!!engineNearFieldScene(resolve(engine)));
			setMsg(null);
		}
	};

	const runSplats = useCallback(
		(kind: SplatExportKind) => {
			const eng = resolve(engine);
			if (disabledRef.current || !engineReady(eng)) {
				setMsg({
					text: "Still loading or aligning: the pose is not final yet",
					error: true,
				});
				return;
			}
			setMsg(null);
			try {
				const r = exportSplatsFromEngine(eng, kind, {
					geoidUndulation: opts.geoidUndulation,
				});
				downloadBlob(r.blob, r.filename);
				setMsg({ text: [`Saved ${r.filename}`, ...r.notes].join(" · ") });
				onExported?.({
					kind,
					filename: r.filename,
					bytes: r.blob.size,
					notes: r.notes,
				});
			} catch (e) {
				setMsg({ text: `Export failed: ${(e as Error).message}`, error: true });
			}
		},
		[engine, onExported, opts.geoidUndulation],
	);

	const run = useCallback(
		async (kind: ExportKind) => {
			const eng = resolve(engine);
			if (disabledRef.current || !engineReady(eng)) {
				setMsg({
					text: "Still loading or aligning: the pose is not final yet",
					error: true,
				});
				return;
			}
			setBusy(kind);
			setMsg(null);
			try {
				const r = await exportFromEngine(eng, kind, opts);
				downloadBlob(r.blob, r.filename);
				setMsg({ text: [`Saved ${r.filename}`, ...r.notes].join(" · ") });
				onExported?.({
					kind,
					filename: r.filename,
					bytes: r.blob.size,
					notes: r.notes,
				});
			} catch (e) {
				setMsg({ text: `Export failed: ${(e as Error).message}`, error: true });
			} finally {
				setBusy(null);
			}
		},
		// opts is a fresh object each render; its fields are what matter
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[engine, onExported, opts.withLabels, opts.geoidUndulation, opts.maxRange],
	);

	return (
		<div
			ref={root}
			className={cn("pointer-events-auto relative", className)}
			data-export-menu=""
		>
			<button
				type="button"
				onClick={toggle}
				disabled={disabled}
				aria-haspopup="menu"
				aria-expanded={open}
				title={photo ? `Export ${photo.id}` : "Export"}
				className="flex items-center gap-1.5 rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-medium text-white/80 ring-1 ring-white/10 backdrop-blur hover:text-white disabled:opacity-40"
			>
				{busy ? (
					<LoaderCircle className="size-3.5 animate-spin" />
				) : (
					<Download className="size-3.5" />
				)}{" "}
				Export
				<ChevronDown
					className={cn("size-3 transition-transform", open && "rotate-180")}
				/>
			</button>
			{open && (
				<div
					role="menu"
					className={cn(
						"absolute top-full z-40 mt-1.5 w-64 rounded-xl bg-[#121820]/95 p-1 shadow-2xl ring-1 ring-white/10 backdrop-blur",
						align === "right" ? "right-0" : "left-0",
					)}
				>
					{!canExport && (
						<p
							data-export-loading=""
							className="px-2.5 py-1.5 text-[11px] text-amber-200/80"
						>
							Still loading and aligning; exports unlock once the pose is final.
						</p>
					)}
					{EXPORT_FORMATS.map((f) => {
						const Icon = ICONS[f.kind];
						return (
							<button
								key={f.kind}
								type="button"
								role="menuitem"
								data-export-kind={f.kind}
								disabled={!canExport || !!busy}
								onClick={() => run(f.kind)}
								className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/8 disabled:opacity-40 disabled:hover:bg-transparent"
							>
								{busy === f.kind ? (
									<LoaderCircle className="size-4 shrink-0 animate-spin text-cyan-300" />
								) : (
									<Icon className="size-4 shrink-0 text-white/55" />
								)}
								<span className="min-w-0 flex-1">
									<span className="block text-xs font-medium text-white/90">
										{f.label}
									</span>
									<span className="block truncate text-[10px] text-white/40">
										{f.hint}
									</span>
								</span>
								<span className="font-mono text-[10px] text-white/30">
									{f.ext.split(".").pop()}
								</span>
							</button>
						);
					})}
					{hasSplats &&
						SPLAT_EXPORT_FORMATS.map((f) => (
							<button
								key={f.kind}
								type="button"
								role="menuitem"
								data-export-kind={f.kind}
								disabled={!canExport || !!busy}
								onClick={() => runSplats(f.kind)}
								className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/8 disabled:opacity-40 disabled:hover:bg-transparent"
							>
								<Sparkles className="size-4 shrink-0 text-white/55" />
								<span className="min-w-0 flex-1">
									<span className="block text-xs font-medium text-white/90">
										{f.label}
									</span>
									<span className="block truncate text-[10px] text-white/40">
										{f.hint}
									</span>
								</span>
								<span className="font-mono text-[10px] text-white/30">
									{f.ext.split(".").pop()}
								</span>
							</button>
						))}
					{msg && (
						<p
							data-export-status={msg.error ? "error" : "ok"}
							className={cn(
								"border-t border-white/8 px-2.5 pt-1.5 pb-1 text-[10px] leading-snug",
								msg.error ? "text-red-300" : "text-white/45",
							)}
						>
							{msg.text}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
