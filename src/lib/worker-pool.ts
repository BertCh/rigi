// A few module workers running one job type, round-robin, for CPU work that only needs to leave the main
// thread (dem/decode.worker.ts, terrain-tile.worker.ts). Each job's result must equal what `local` returns
// on the page for the same input: the pool is purely a scheduling choice. Off a page (workers, node) or
// without OffscreenCanvas, and after any worker error, jobs run through `local` instead.

type Reply<Out> = { id: number; out: Out } | { id: number; error: string };

export class WorkerPool<In, Out> {
	private workers: Worker[] | null | undefined;
	private next = 0;
	private nextId = 0;
	private pending = new Map<
		number,
		{ msg: In; resolve: (o: Out) => void; reject: (e: unknown) => void }
	>();

	constructor(
		private make: () => Worker,
		private local: (msg: In) => Promise<Out>,
		private size = Math.max(
			1,
			Math.min(
				4,
				((typeof navigator !== "undefined" && navigator.hardwareConcurrency) ||
					4) - 1,
			),
		),
	) {}

	private pool(): Worker[] | null {
		if (this.workers !== undefined) return this.workers;
		this.workers = null;
		if (
			typeof document === "undefined" ||
			typeof Worker === "undefined" ||
			typeof OffscreenCanvas === "undefined"
		)
			return null;
		try {
			const ws: Worker[] = [];
			for (let i = 0; i < this.size; i++) {
				const w = this.make();
				w.onmessage = (e: MessageEvent<Reply<Out>>) => {
					const p = this.pending.get(e.data.id);
					if (!p) return;
					this.pending.delete(e.data.id);
					if ("out" in e.data) p.resolve(e.data.out);
					else p.reject(new Error(e.data.error));
				};
				// a worker that cannot start or dies: everything runs here from now on, pending jobs too
				w.onerror = () => this.fallBack();
				ws.push(w);
			}
			this.workers = ws;
		} catch {
			this.fallBack();
		}
		return this.workers;
	}

	private fallBack() {
		for (const w of this.workers ?? []) w.terminate();
		this.workers = null;
		const jobs = [...this.pending.values()];
		this.pending.clear();
		for (const p of jobs) this.local(p.msg).then(p.resolve, p.reject);
	}

	run(msg: In): Promise<Out> {
		const ws = this.pool();
		if (!ws) return this.local(msg);
		const id = this.nextId++;
		const w = ws[this.next++ % ws.length];
		return new Promise<Out>((resolve, reject) => {
			this.pending.set(id, { msg, resolve, reject });
			// copied, not transferred: the message is kept for the fallback should the worker die
			w.postMessage({ id, msg });
		});
	}
}

/** Worker side: answer each { id, msg } with handle(msg), transferring what it lists. */
export function serveWorker<In, Out>(
	handle: (msg: In) => Promise<{ out: Out; transfer?: Transferable[] }>,
) {
	const scope = self as unknown as {
		onmessage: ((e: MessageEvent<{ id: number; msg: In }>) => void) | null;
		postMessage(m: unknown, transfer?: Transferable[]): void;
	};
	scope.onmessage = async (e) => {
		const { id, msg } = e.data;
		try {
			const { out, transfer } = await handle(msg);
			scope.postMessage({ id, out } satisfies Reply<Out>, transfer ?? []);
		} catch (err) {
			scope.postMessage({ id, error: String(err) } satisfies Reply<Out>);
		}
	};
}
