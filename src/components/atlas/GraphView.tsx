import { useNavigate } from "@tanstack/react-router";
import { Maximize2, Minus, Plus, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
	GROUPS,
	LINKS,
	NODES,
	neighbourhood,
	STATUS_META,
} from "#/lib/atlas/graph-utils";
import { searchWords } from "#/lib/atlas/ontology";
import type { AtlasGroup, AtlasStatus } from "#/lib/atlas/types";
import { cn } from "#/lib/utils";
import { type GraphApi, GraphCanvas } from "./GraphCanvas";

function useOpen() {
	const navigate = useNavigate();
	return (id: string) =>
		navigate({ to: "/atlas/$concept", params: { concept: id } });
}

const glass = "bg-[var(--rigi-ink)]/72 ring-1 ring-white/10 backdrop-blur-md";

/** The full interactive graph: search, group + status filters, zoom buttons. */
export function GraphView({ className }: { className?: string }) {
	const open = useOpen();
	const api = useRef<GraphApi>(null);
	const [q, setQ] = useState("");
	const [groups, setGroups] = useState<Set<AtlasGroup>>(new Set());
	const [statuses, setStatuses] = useState<Set<AtlasStatus>>(new Set());
	const [onto, setOnto] = useState(false);

	const present = useMemo(
		() => GROUPS.filter((g) => NODES.some((n) => n.group === g.id)),
		[],
	);
	// Haystacks (node text + ontology words) are built once, not per keystroke.
	const hay = useMemo(
		() =>
			new Map(
				NODES.map((n) => [
					n.id,
					`${n.title} ${n.tagline} ${n.id} ${n.summary} ${searchWords(n).join(" ")}`.toLowerCase(),
				]),
			),
		[],
	);
	const matchIds = useMemo(() => {
		const ql = q.trim().toLowerCase();
		if (!ql && !groups.size && !statuses.size && !onto) return null;
		const s = new Set<string>();
		for (const n of NODES) {
			if (onto && !n.ontologyId && !n.methodIds?.length) continue;
			if (groups.size && !groups.has(n.group)) continue;
			if (statuses.size && !statuses.has(n.status)) continue;
			if (ql && !hay.get(n.id)?.includes(ql)) continue;
			s.add(n.id);
		}
		return s;
	}, [q, groups, statuses, onto, hay]);

	const toggle = <T,>(set: Set<T>, v: T, put: (s: Set<T>) => void) => {
		const n = new Set(set);
		if (!n.delete(v)) n.add(v);
		put(n);
	};
	const first =
		matchIds && q.trim() ? NODES.find((n) => matchIds.has(n.id)) : undefined;

	return (
		<div className={cn("relative", className)} data-testid="atlas-graph">
			<GraphCanvas
				nodes={NODES}
				links={LINKS}
				onOpen={open}
				matchIds={matchIds}
				apiRef={api}
				className="h-full w-full"
			/>

			<div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-3 sm:p-5">
				<div
					className={cn(
						"pointer-events-auto flex w-full max-w-[320px] items-center gap-2 rounded-xl px-3 py-2",
						glass,
					)}
				>
					<Search className="size-4 shrink-0 text-white/40" strokeWidth={1.6} />
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && first) api.current?.focus(first.id);
							if (e.key === "Escape") setQ("");
						}}
						placeholder="Search concepts…"
						aria-label="Search concepts"
						className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--rigi-paper)] outline-none placeholder:text-white/30"
					/>
					{matchIds && (
						<span className="font-mono text-[10.5px] text-white/40">
							{matchIds.size}/{NODES.length}
						</span>
					)}
					{(q || groups.size > 0 || statuses.size > 0 || onto) && (
						<button
							type="button"
							aria-label="Clear filters"
							onClick={() => {
								setQ("");
								setGroups(new Set());
								setStatuses(new Set());
								setOnto(false);
							}}
							className="text-white/40 hover:text-white"
						>
							<X className="size-3.5" />
						</button>
					)}
				</div>
				<div
					className={cn(
						"pointer-events-auto flex flex-col overflow-hidden rounded-xl",
						glass,
					)}
				>
					{[
						{ l: "Zoom in", i: Plus, f: () => api.current?.zoomBy(1.4) },
						{ l: "Zoom out", i: Minus, f: () => api.current?.zoomBy(1 / 1.4) },
						{ l: "Fit to view", i: Maximize2, f: () => api.current?.fit() },
					].map((b) => (
						<button
							key={b.l}
							type="button"
							aria-label={b.l}
							onClick={b.f}
							className="grid size-9 place-items-center text-white/60 transition hover:bg-white/8 hover:text-white"
						>
							<b.i className="size-4" strokeWidth={1.6} />
						</button>
					))}
				</div>
			</div>

			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 p-3 sm:p-5">
				<div className="pointer-events-auto flex max-w-full flex-wrap gap-1.5">
					{present.map((g) => {
						const on = groups.has(g.id);
						return (
							<button
								key={g.id}
								type="button"
								aria-pressed={on}
								onClick={() => toggle(groups, g.id, setGroups)}
								className={cn(
									"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition",
									glass,
									on
										? "text-[var(--rigi-paper)]"
										: "text-white/55 hover:text-white",
								)}
								style={
									on
										? {
												boxShadow: `inset 0 0 0 1px ${g.color}`,
												background: `${g.color}22`,
											}
										: undefined
								}
							>
								<span
									className="size-2 rounded-full"
									style={{ background: g.color }}
								/>
								{g.label}
							</button>
						);
					})}
					<button
						type="button"
						aria-pressed={onto}
						onClick={() => setOnto((v) => !v)}
						title="Concepts and methods linked to the ontology"
						className={cn(
							"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition",
							glass,
							onto
								? "text-[var(--rigi-paper)]"
								: "text-white/55 hover:text-white",
						)}
						style={
							onto
								? {
										boxShadow: "inset 0 0 0 1px var(--rigi-paper)",
										background: "rgba(236,230,218,0.12)",
									}
								: undefined
						}
					>
						<span className="size-2 rounded-full border border-[var(--rigi-paper)] border-dashed" />
						Ontology
					</button>
				</div>
				<div className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-1.5">
					{(Object.keys(STATUS_META) as AtlasStatus[]).map((s) => {
						const on = statuses.has(s);
						return (
							<button
								key={s}
								type="button"
								aria-pressed={on}
								onClick={() => toggle(statuses, s, setStatuses)}
								title={STATUS_META[s].blurb}
								className={cn(
									"flex items-center gap-1.5 font-mono text-[10.5px] transition",
									on
										? "text-[var(--rigi-paper)]"
										: "text-white/40 hover:text-white/80",
								)}
							>
								<StatusGlyph status={s} on={on} />
								{STATUS_META[s].label}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/** Tiny glyph matching how the canvas draws each status. */
export function StatusGlyph({
	status,
	on = true,
}: {
	status: AtlasStatus;
	on?: boolean;
}) {
	const c = on ? "var(--rigi-paper)" : "rgba(236,230,218,0.55)";
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			{status === "live" && <circle cx="6" cy="6" r="4" fill={c} />}
			{status === "flagged" && (
				<>
					<circle cx="6" cy="6" r="3" fill={c} fillOpacity="0.5" stroke={c} />
					<circle
						cx="6"
						cy="6"
						r="5.2"
						fill="none"
						stroke={c}
						strokeWidth="0.8"
						strokeDasharray="1.5 1.8"
					/>
				</>
			)}
			{status === "research" && (
				<circle
					cx="6"
					cy="6"
					r="3.8"
					fill={c}
					fillOpacity="0.14"
					stroke={c}
					strokeWidth="1.4"
				/>
			)}
			{status === "killed" && (
				<circle
					cx="6"
					cy="6"
					r="3.8"
					fill="none"
					stroke={c}
					strokeOpacity="0.7"
					strokeDasharray="1.6 1.8"
				/>
			)}
		</svg>
	);
}

/** Compact ego-graph for concept pages: the node plus its neighbours within `depth` hops. */
export function NeighbourhoodGraph({
	id,
	depth = 1,
	className,
}: {
	id: string;
	depth?: number;
	className?: string;
}) {
	const open = useOpen();
	const { nodes, links } = useMemo(() => {
		const hood = neighbourhood(id, depth);
		return {
			nodes: NODES.filter((n) => hood.has(n.id)),
			links: LINKS.filter((l) => hood.has(l.from) && hood.has(l.to)),
		};
	}, [id, depth]);
	return (
		<GraphCanvas
			key={id}
			nodes={nodes}
			links={links}
			focusId={id}
			compact
			noHint
			onOpen={(n) => n !== id && open(n)}
			className={cn("h-[340px] w-full", className)}
		/>
	);
}
