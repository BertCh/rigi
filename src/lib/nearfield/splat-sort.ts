// Step Inside: owner of the splat depth-sort worker, with a synchronous fallback (tests, SSR, or a
// browser where the module worker fails to start). One sort is in flight at a time; the caller
// re-requests once it lands (ThreeSplats does this from onBeforeRender), so a fast orbit never
// builds a backlog.
import {
	type DepthRow,
	newSortScratch,
	type SortRequest,
	type SortResponse,
	type SortScratch,
	sortSplatsByDepth,
} from "./splat-sort.worker";

export type { DepthRow } from "./splat-sort.worker";
export { sortSplatsByDepth } from "./splat-sort.worker";

export type SortResult = {
	/** Splat indices, back to front; only the first `count` entries are valid. */
	indices: Uint32Array;
	count: number;
	/** Sort time (ms), in the worker or inline. */
	ms: number;
};

export type SplatSorterOpts = {
	/** false forces the synchronous path (unit tests). Default: use a worker when available. */
	worker?: boolean;
};

export class SplatSorter {
	readonly count: number;
	private worker: Worker | null = null;
	private positions: Float32Array;
	private scratch: SortScratch | null = null;
	private nextId = 1;
	private pending: {
		id: number;
		row: DepthRow;
		near: number;
		cb: (r: SortResult) => void;
	} | null = null;
	private disposed = false;

	constructor(
		positions: Float32Array,
		count: number,
		opts: SplatSorterOpts = {},
	) {
		this.count = count;
		this.positions = positions;
		if (opts.worker !== false && typeof Worker !== "undefined") {
			try {
				this.worker = new Worker(
					new URL("./splat-sort.worker.ts", import.meta.url),
					{
						type: "module",
					},
				);
				// the worker gets its own copy; the cloud's arrays stay usable on the main thread
				const copy = positions.slice(0, 3 * count);
				const msg: SortRequest = { type: "init", positions: copy, count };
				this.worker.postMessage(msg, [copy.buffer]);
				this.worker.onmessage = (ev: MessageEvent<SortResponse>) =>
					this.onResult(ev.data);
				this.worker.onerror = (e) => {
					console.warn(
						"[splat-sort] worker failed, sorting on the main thread",
						e.message,
					);
					this.worker?.terminate();
					this.worker = null;
					// the in-flight buffer is gone with the worker: redo that request inline
					const p = this.pending;
					this.pending = null;
					if (p && !this.disposed)
						this.sort(p.row, new Uint32Array(this.count), p.cb, p.near);
				};
			} catch {
				this.worker = null;
			}
		}
	}

	get usingWorker(): boolean {
		return this.worker !== null;
	}

	/** A sort is in flight; `sort` refuses new requests until it lands. */
	get busy(): boolean {
		return this.pending !== null;
	}

	/**
	 * Sort by depth for this view. `out` (length >= count) is transferred to the worker and comes
	 * back as `indices` in the callback; do not touch it until then. Without a worker the callback
	 * runs synchronously before `sort` returns. Returns false (and does nothing) while busy.
	 */
	sort(
		row: DepthRow,
		out: Uint32Array,
		cb: (r: SortResult) => void,
		near = 0,
	): boolean {
		if (this.disposed || this.pending) return false;
		if (!this.worker) {
			const t0 = performance.now();
			this.scratch ??= newSortScratch(this.count);
			const n = sortSplatsByDepth(
				this.positions,
				this.count,
				row,
				out,
				this.scratch,
				near,
			);
			cb({ indices: out, count: n, ms: performance.now() - t0 });
			return true;
		}
		const id = this.nextId++;
		this.pending = { id, row, near, cb };
		const msg: SortRequest = { type: "sort", id, row, near, out };
		this.worker.postMessage(msg, [out.buffer]);
		return true;
	}

	private onResult(r: SortResponse) {
		const p = this.pending;
		if (!p || p.id !== r.id) return;
		this.pending = null;
		if (this.disposed) return;
		p.cb({ indices: r.indices, count: r.count, ms: r.ms });
	}

	dispose() {
		this.disposed = true;
		this.worker?.terminate();
		this.worker = null;
		this.pending = null;
		this.scratch = null;
	}
}
