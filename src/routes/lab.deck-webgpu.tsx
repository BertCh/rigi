// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lab: the WebGPU renderer (src/lib/deck-webgpu, README there), no DeckEngine / PhotoWorkspace.
//   Default: the whole renderer through WebGpuEngine (src/lib/deck-webgpu/lab-engine.ts): photo view
//     (terrain + styles + trails → photo compositor with ridges / skyline, DOM peak labels) and the
//     world / orbit view (drape, sky, gizmo). Toolbar: view mode, overlay / map style, debug view.
//     Query: ?photo=<id> &host=deck|direct &mode=overlay|replace|world &overlay=contours|bands|slope|none
//            &map=satellite|topo|hillshade|bands &terrain=batched|tiles &debug=geometry|normal|depth
//            &yaw= &pitch= &roll= &vfov= &align=1 &trails=1 &labels=0 &segment=0 &size=<w>x<h>
//     Harness: window.__engine (Renderer), window.__deckWebgpuLab, body[data-ready]
//   ?core=1: the foundation only (src/lib/deck-webgpu/lab.ts): terrain through the photo camera,
//     &view=color|geometry|normal|depth &plugin=footprint &imagery=satellite|topo|none (smoke.mjs)
//   ?spike=1: the deck-on-WebGPU feasibility spike (src/lib/deck-webgpu/spike.ts)
// Needs WebGPU (Chrome/Edge). The deck host and ?spike=1 need deck's full build: serve with
// scripts/deck-webgpu/vite.webgpu.config.ts (port 3111); elsewhere the direct host is used.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { EngineLab } from "#/lib/deck-webgpu/lab-engine";

type Search = {
	photo?: string;
	spike?: boolean;
	core?: boolean;
	host?: "deck" | "direct";
	view?: "color" | "geometry" | "normal" | "depth";
	imagery?: "satellite" | "topo" | "none";
	yaw?: number;
	pitch?: number;
	roll?: number;
	vfov?: number;
	plugin?: "footprint";
	mode?: "overlay" | "replace" | "world";
	overlay?: "contours" | "bands" | "slope" | "none";
	map?: "satellite" | "topo" | "hillshade" | "bands";
	terrain?: "batched" | "tiles";
	debug?: "geometry" | "normal" | "depth";
	align?: boolean;
	trails?: boolean;
	labels?: boolean;
	segment?: boolean;
	size?: string;
};

const num = (v: unknown) => {
	const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : undefined;
};
const oneOf = <T extends string>(v: unknown, all: readonly T[]) =>
	all.includes(v as T) ? (v as T) : undefined;
const flag = (v: unknown) =>
	v === true || v === "1" || v === 1 ? true : undefined;
const offFlag = (v: unknown) =>
	v === false || v === "0" || v === 0 ? false : undefined;

export const Route = createFileRoute("/lab/deck-webgpu")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): Search => ({
		photo: typeof s.photo === "string" ? s.photo : undefined,
		spike: flag(s.spike),
		core: flag(s.core),
		host: oneOf(s.host, ["deck", "direct"] as const),
		view: oneOf(s.view, ["color", "geometry", "normal", "depth"] as const),
		imagery: oneOf(s.imagery, ["satellite", "topo", "none"] as const),
		yaw: num(s.yaw),
		pitch: num(s.pitch),
		roll: num(s.roll),
		vfov: num(s.vfov),
		plugin: oneOf(s.plugin, ["footprint"] as const),
		mode: oneOf(s.mode, ["overlay", "replace", "world"] as const),
		overlay: oneOf(s.overlay, ["contours", "bands", "slope", "none"] as const),
		map: oneOf(s.map, ["satellite", "topo", "hillshade", "bands"] as const),
		terrain: oneOf(s.terrain, ["batched", "tiles"] as const),
		debug: oneOf(s.debug, ["geometry", "normal", "depth"] as const),
		align: flag(s.align),
		trails: flag(s.trails),
		labels: offFlag(s.labels),
		segment: offFlag(s.segment),
		size:
			typeof s.size === "string" && /^\d+x\d+$/.test(s.size)
				? s.size
				: undefined,
	}),
	head: () => ({ meta: [{ title: "Lab · deck WebGPU" }] }),
	component: LabDeckWebgpuGate,
});

let chain: Promise<void> = Promise.resolve();

const MODES = ["overlay", "replace", "world"] as const;
const OVERLAYS = ["contours", "bands", "slope", "none"] as const;
const MAPS = ["satellite", "topo", "hillshade", "bands"] as const;
const DEBUGS = ["color", "geometry", "normal", "depth"] as const;

// dev-only: the production build shows a stub (same gate as dev.graph / lab.splats)
function LabDeckWebgpuGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return <LabDeckWebgpu />;
}

function LabDeckWebgpu() {
	const search = Route.useSearch();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const labelsRef = useRef<HTMLDivElement>(null);
	const labRef = useRef<EngineLab | null>(null);
	const [status, setStatus] = useState("starting…");
	const [report, setReport] = useState<string>("");
	const [engineUp, setEngineUp] = useState(false);
	const [mode, setMode] = useState<(typeof MODES)[number]>(
		search.mode ?? "overlay",
	);
	const [overlay, setOverlay] = useState<(typeof OVERLAYS)[number]>(
		search.overlay ?? "contours",
	);
	const [map, setMap] = useState<(typeof MAPS)[number]>(
		search.map ?? "satellite",
	);
	const [debug, setDebug] = useState<(typeof DEBUGS)[number]>(
		search.debug ?? "color",
	);
	const [labels, setLabels] = useState(search.labels !== false);

	useEffect(() => {
		const canvas = canvasRef.current;
		const labelLayer = labelsRef.current;
		if (!canvas || !labelLayer) return;
		let dispose: (() => void) | undefined;
		let cancelled = false;
		// one WebGPU device per canvas at a time: a StrictMode remount waits for the previous
		// instance to be torn down (two devices configuring one canvas break each other)
		chain = chain
			.then(async () => {
				if (cancelled) return;
				if (search.spike) {
					const { runSpike } = await import("#/lib/deck-webgpu/spike");
					setStatus("running spike…");
					const r = await runSpike(canvas);
					(
						window as unknown as { __deckWebgpuSpike?: unknown }
					).__deckWebgpuSpike = r;
					setReport(JSON.stringify(r, null, 2));
					setStatus("spike done");
					return;
				}
				if (search.core) {
					const { startLab } = await import("#/lib/deck-webgpu/lab");
					if (cancelled) return;
					dispose = await startLab(canvas, search, setStatus);
					if (cancelled) dispose();
					return;
				}
				const { startEngineLab } = await import("#/lib/deck-webgpu/lab-engine");
				if (cancelled) return;
				const lab = await startEngineLab(canvas, labelLayer, search, setStatus);
				labRef.current = lab;
				dispose = () => {
					labRef.current = null;
					lab.dispose();
				};
				if (cancelled) dispose();
				else setEngineUp(true);
			})
			.catch((e) => {
				console.error("[lab.deck-webgpu]", e);
				setStatus(`error: ${(e as Error).message}`);
			});
		return () => {
			cancelled = true;
			setEngineUp(false);
			dispose?.();
		};
	}, [search]);

	const btn = (on: boolean) =>
		`rounded px-2 py-0.5 ${on ? "bg-sky-700 text-white" : "bg-neutral-800 hover:bg-neutral-700"}`;

	return (
		<div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
			<div className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs">
				<span className="font-semibold">deck-webgpu lab</span>
				<span data-testid="status" data-status={status}>
					{status}
				</span>
				{engineUp && (
					<>
						<span className="flex gap-1" data-testid="mode">
							{MODES.map((m) => (
								<button
									type="button"
									key={m}
									className={btn(mode === m)}
									onClick={() => {
										setMode(m);
										labRef.current?.setSettings({ mode: m });
									}}
								>
									{m}
								</button>
							))}
						</span>
						{mode === "overlay" && (
							<select
								className="bg-neutral-800"
								value={overlay}
								onChange={(e) => {
									const v = e.target.value as (typeof OVERLAYS)[number];
									setOverlay(v);
									labRef.current?.setSettings({ overlayStyle: v });
								}}
							>
								{OVERLAYS.map((o) => (
									<option key={o}>{o}</option>
								))}
							</select>
						)}
						{mode === "replace" && (
							<select
								className="bg-neutral-800"
								value={map}
								onChange={(e) => {
									const v = e.target.value as (typeof MAPS)[number];
									setMap(v);
									labRef.current?.setSettings({ mapStyle: v });
								}}
							>
								{MAPS.map((o) => (
									<option key={o}>{o}</option>
								))}
							</select>
						)}
						{mode === "world" && (
							<button
								type="button"
								className={btn(false)}
								onClick={() => labRef.current?.flyToPhoto()}
							>
								fly to photo
							</button>
						)}
						{mode !== "world" && (
							<select
								className="bg-neutral-800"
								value={debug}
								onChange={(e) => {
									const v = e.target.value as (typeof DEBUGS)[number];
									setDebug(v);
									labRef.current?.setDebug(v);
								}}
							>
								{DEBUGS.map((o) => (
									<option key={o}>{o}</option>
								))}
							</select>
						)}
						<label className="flex items-center gap-1">
							<input
								type="checkbox"
								checked={labels}
								onChange={(e) => {
									setLabels(e.target.checked);
									if (labelsRef.current)
										labelsRef.current.style.display = e.target.checked
											? ""
											: "none";
								}}
							/>
							labels
						</label>
					</>
				)}
			</div>
			<div className="relative flex-1 overflow-hidden">
				<canvas
					ref={canvasRef}
					className="absolute inset-0 h-full w-full"
					data-testid="webgpu-canvas"
				/>
				<div ref={labelsRef} data-testid="labels" />
				{report && (
					<pre className="absolute top-2 right-2 max-h-[90%] max-w-[50%] overflow-auto bg-black/80 p-2 text-[10px]">
						{report}
					</pre>
				)}
			</div>
		</div>
	);
}
