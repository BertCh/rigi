// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LensGlyph } from "#/brand/LensGlyph";
import { GraphProvenance } from "#/components/dev/GraphProvenance";
import {
	type GpuModule,
	ISLANDS,
	isRemote,
	listModules,
	moduleOfGraph,
} from "#/lib/gpu/app-graph/manifest";
import type { DurationSummary, GraphInspection } from "#/lib/gpu/core/inspect";

// Dev only (WAG W0.2): the live compute graphs of THIS page realm, per device, from core/inspect.ts
// (cachedGraph list + upstream preflight + GPUCommandGraphInspector samples), joined with the app
// graph manifest (src/lib/gpu/app-graph). Opening the page starts observing the compiled cached
// graphs (recording only), so later encodes add CPU encode times; GPU times need profiling on.
// Graphs only exist after the app ran in this tab: reach the page by client navigation from /photo
// (a reload starts an empty realm). Worker graphs live in other realms: listed from the manifest
// as "remote".
export const Route = createFileRoute("/dev/graph")({
	ssr: false,
	head: () => ({ meta: [{ title: "Compute graphs" }] }),
	component: GraphPage,
});

type Live = {
	rows: GraphInspection[];
	adoptedId: string | null;
};

const kb = (bytes: number) =>
	bytes >= 1 << 20
		? `${(bytes / (1 << 20)).toFixed(2)} MB`
		: `${(bytes / 1024).toFixed(1)} KB`;
const ms = (d: DurationSummary) =>
	d.samples
		? `${d.p50Ms?.toFixed(3) ?? "–"} / ${d.p95Ms?.toFixed(3) ?? "–"} (${d.samples})`
		: "–";

type FrameTimingsView = {
	latest: { frame: number; totalGpuMs: number } | null;
	mean: {
		passes: { name: string; gpuMs: number }[];
		totalGpuMs: number;
		frames: number;
	};
	disabledReason: string | null;
	deck?: { cpuMs: number; gpuMs: number | null; frames: number } | null;
};

/** Rolling per-pass GPU times of the WebGPU engine (?gpuFrameTimings=on, same tab as the photo). */
function FrameTimingsPanel() {
	const [view, setView] = useState<FrameTimingsView | null>(null);
	useEffect(() => {
		let stop = false;
		const tick = async () => {
			const { currentFrameTimings } = await import(
				"#/lib/deck-webgpu/frame-timings"
			);
			if (!stop) setView(currentFrameTimings());
		};
		void tick();
		const t = setInterval(tick, 1000);
		return () => {
			stop = true;
			clearInterval(t);
		};
	}, []);
	return (
		<section className="mt-6 font-mono text-xs" data-testid="frame-timings">
			<h2 className="text-sm text-[var(--rigi-glow)]">Render pass GPU times</h2>
			{!view ? (
				<p className="mt-1 text-white/55">
					Off: open the photo with ?gpuFrameTimings=on on a WebGPU device with
					timestamp-query (also covers deck.gl's own timings).
				</p>
			) : (
				<p className="mt-1 text-white/55">
					{view.disabledReason ?? `mean of ${view.mean.frames} frames`}
					{view.mean.passes.map((p) => (
						<span key={p.name} className="ml-4">
							{p.name} {p.gpuMs.toFixed(3)} ms
						</span>
					))}
					{view.deck && (
						<span className="ml-4">
							deck cpu {view.deck.cpuMs.toFixed(3)} ms
						</span>
					)}
					<span className="ml-4">
						total {view.mean.totalGpuMs.toFixed(3)} ms
					</span>
				</p>
			)}
		</section>
	);
}

function GraphPage() {
	const [live, setLive] = useState<Live | null>(null);
	const [error, setError] = useState("");
	const [profiling, setProfiling] = useState(
		() => globalThis.__RIGI_GPU_PROFILE__ === true,
	);
	useEffect(() => {
		let stop = false;
		const tick = async () => {
			try {
				const [{ inspectGraphs }, { adoptedRenderDevice }] = await Promise.all([
					import("#/lib/gpu/core/inspect"),
					import("#/lib/gpu/device"),
				]);
				if (!stop)
					setLive({
						rows: inspectGraphs(),
						adoptedId: adoptedRenderDevice()?.id ?? null,
					});
			} catch (e) {
				if (!stop) setError(String(e));
			}
		};
		void tick();
		const t = setInterval(tick, 1000);
		return () => {
			stop = true;
			clearInterval(t);
		};
	}, []);
	if (!import.meta.env.DEV) return <p>dev only</p>;

	const toggleProfiling = () => {
		globalThis.__RIGI_GPU_PROFILE__ = profiling ? undefined : true;
		setProfiling(!profiling);
	};
	const devices = new Map<string, GraphInspection[]>();
	for (const r of live?.rows ?? []) {
		const list = devices.get(r.device.id) ?? [];
		list.push(r);
		devices.set(r.device.id, list);
	}
	const liveGroups = new Set(live?.rows.map((r) => r.group ?? r.id) ?? []);
	const modules = listModules();

	return (
		<main className="min-h-dvh bg-[var(--rigi-ink)] p-8 text-[var(--rigi-paper)]">
			<p className="mb-2 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--rigi-glow)]">
				<LensGlyph size={14} title="Arisia" />
				compute graph, observed
			</p>
			<h1 className="text-xl font-semibold">Compute graphs</h1>
			<p className="mt-2 max-w-3xl text-sm text-white/55">
				The live ComputeGraphs of this page realm, per device: nodes, transient
				bytes, aliasing savings, the upstream preflight fit and the inspector's
				p50 / p95 timings (ms, samples). Graphs exist only after the app ran in
				this tab (navigate here from a photo; a reload starts empty). GPU times
				need profiling.
			</p>
			<div className="mt-4 flex items-center gap-4 text-sm">
				<button
					type="button"
					data-testid="toggle-profile"
					onClick={toggleProfiling}
					className="rounded-lg bg-[var(--rigi-glow)] px-3 py-1.5 font-semibold text-[var(--rigi-ink)]"
				>
					{profiling ? "Stop GPU profiling" : "Start GPU profiling"}
				</button>
				<span className="text-white/55">
					{live ? `${live.rows.length} graphs` : "Loading…"}
				</span>
			</div>
			<FrameTimingsPanel />
			{error && (
				<p className="mt-4 font-mono text-xs text-[var(--rigi-trap)]">
					{error}
				</p>
			)}

			{live && !live.rows.length && (
				<p className="mt-6 text-sm" data-testid="graph-empty">
					Clear ether. Open a photo, then come back here.
				</p>
			)}
			{[...devices].map(([id, rows]) => (
				<section key={id} className="mt-8">
					<h2 className="font-mono text-sm text-[var(--rigi-glow)]">
						device {id} · {rows[0].device.type}
						{id === live?.adoptedId ? " · render device (adopted)" : ""}
					</h2>
					<div className="mt-2 overflow-x-auto">
						<table
							className="w-full font-mono text-xs"
							data-testid="graph-table"
						>
							<thead className="text-left text-white/55">
								<tr>
									<th className="py-1 pr-3">group</th>
									<th className="pr-3">key</th>
									<th className="pr-3">island</th>
									<th className="pr-3">nodes</th>
									<th className="pr-3">transient</th>
									<th className="pr-3">aliasing saved</th>
									<th className="pr-3">preflight</th>
									<th className="pr-3">encodes</th>
									<th className="pr-3">cpu encode</th>
									<th className="pr-3">gpu</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<GraphRow key={r.id} row={r} />
								))}
							</tbody>
						</table>
					</div>
				</section>
			))}

			<section className="mt-10">
				<h2 className="text-lg font-semibold">Islands (app graph manifest)</h2>
				<p className="mt-1 text-sm text-white/55">
					src/lib/gpu/app-graph/manifest.ts. "remote": the module runs in a
					worker realm, whose graphs this page cannot list.
				</p>
				<table className="mt-3 w-full text-xs">
					<thead className="text-left text-white/55">
						<tr>
							<th className="py-1 pr-3">island</th>
							<th className="pr-3">module</th>
							<th className="pr-3">status</th>
							<th className="pr-3">realm</th>
							<th className="pr-3">cadence</th>
							<th className="pr-3">groups</th>
							<th className="pr-3">here</th>
						</tr>
					</thead>
					<tbody>
						{ISLANDS.flatMap((island) => {
							const mods = modules.filter((m) => m.island === island.id);
							if (!mods.length)
								return [
									<tr key={island.id} className="border-t border-white/10">
										<td className="py-1 pr-3 font-mono">{island.id}</td>
										<td className="pr-3 text-white/55" colSpan={6}>
											{island.name} (no GPU module)
										</td>
									</tr>,
								];
							return mods.map((m, i) => (
								<tr key={m.id} className="border-t border-white/10">
									<td className="py-1 pr-3 font-mono">
										{i === 0 ? `${island.id} ${island.name}` : ""}
									</td>
									<td className="pr-3 font-mono">{m.id}</td>
									<td className="pr-3">{m.status}</td>
									<td className="pr-3">{m.realms.join(", ")}</td>
									<td className="pr-3">{m.cadence}</td>
									<td className="pr-3 font-mono">
										{m.groups.join(", ") || "–"}
									</td>
									<td className="pr-3">
										{presence(m, liveGroups, live?.rows ?? [])}
									</td>
								</tr>
							));
						})}
					</tbody>
				</table>
			</section>
		</main>
	);
}

/** "remote", "live (n)" or "–" for a module on this page. */
function presence(m: GpuModule, groups: Set<string>, rows: GraphInspection[]) {
	if (isRemote(m)) return "remote";
	const n =
		m.groups.filter((g) => groups.has(g)).length +
		rows.filter(
			(r) => !r.cached && m.graphIdPrefixes?.some((p) => r.id.startsWith(p)),
		).length;
	return n ? `live (${n})` : "–";
}

function GraphRow({ row }: { row: GraphInspection }) {
	const [open, setOpen] = useState(false);
	const module = moduleOfGraph(row.id, row.group);
	const t = row.transient;
	const fit = row.preflight
		? row.preflight.fitsDeviceLimits
			? "fits"
			: "EXCEEDS"
		: row.compiled
			? "–"
			: "not compiled";
	return (
		<>
			<tr
				className="cursor-pointer border-t border-white/10 hover:bg-white/5"
				onClick={() => setOpen(!open)}
			>
				<td className="py-1 pr-3">{row.group ?? `${row.id} (uncached)`}</td>
				<td className="pr-3">{row.key ?? ""}</td>
				<td className="pr-3">
					{module ? `${module.island} ${module.id}` : "?"}
				</td>
				<td className="pr-3">{row.nodeCount}</td>
				<td className="pr-3">
					{kb(t.logicalBufferBytes)} → {kb(t.physicalBufferBytes)}
					{t.logicalTextureBytes ? ` (+tex ${kb(t.physicalTextureBytes)})` : ""}
				</td>
				<td className="pr-3">
					{kb(t.reusedBufferBytes + t.reusedTextureBytes)} (
					{t.reusePercentage.toFixed(0)}%)
				</td>
				<td
					className={`pr-3 ${row.preflight && !row.preflight.fitsDeviceLimits ? "text-[var(--rigi-trap)]" : ""}`}
				>
					{fit}
				</td>
				<td className="pr-3">{row.encodings}</td>
				<td className="pr-3">{ms(row.totals.cpu)}</td>
				<td className="pr-3">{ms(row.totals.gpu)}</td>
			</tr>
			{open && (
				<tr>
					<td colSpan={10} className="pb-3 pl-4">
						{row.preflight && (
							<p className="py-1 text-white/55">
								largest buffer {kb(row.preflight.largestBufferByteLength)} of{" "}
								{kb(row.preflight.maxBufferByteLength)} · largest storage
								binding{" "}
								{kb(row.preflight.largestStorageBufferBindingByteLength)} of{" "}
								{kb(row.preflight.maxStorageBufferBindingByteLength)} · imports{" "}
								{kb(row.importedBufferBytes)} ·{" "}
								{row.preflight.conditionalNodeCount} conditional nodes
							</p>
						)}
						<GraphProvenance nodes={row.nodes} />
						<table className="w-full">
							<thead className="text-left text-white/55">
								<tr>
									<th className="pr-3">node</th>
									<th className="pr-3">type</th>
									<th className="pr-3">condition</th>
									<th className="pr-3">max invocations</th>
									<th className="pr-3">cpu encode</th>
									<th className="pr-3">gpu</th>
								</tr>
							</thead>
							<tbody>
								{row.nodes.map((n) => (
									<tr key={n.id}>
										<td className="pr-3">{n.id}</td>
										<td className="pr-3">{n.type ?? ""}</td>
										<td className="pr-3">{n.condition ?? ""}</td>
										<td className="pr-3">{n.maximumInvocationCount ?? ""}</td>
										<td className="pr-3">{ms(n.cpu)}</td>
										<td className="pr-3">{ms(n.gpu)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</td>
				</tr>
			)}
		</>
	);
}
