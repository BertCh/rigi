// Priority work queue with in-flight dedupe, a concurrency limit, per-caller AbortSignal
// cancellation and re-prioritisation. Pure logic (no fetch / DOM), so it runs under node.
//
// Priority: LOWER numbers run first (think "distance to camera in km"). Ties run FIFO.
//
// Dedupe: `request(key)` while a job for `key` is queued or running joins that job
// instead of starting a new one. Each caller has its own signal: aborting one caller
// rejects only that caller's promise; the underlying job is cancelled (dequeued, or its
// AbortSignal fired if already running) only once every caller has aborted.

export type QueueRequestOptions = {
	/** Lower runs sooner. Default 0. A joined job takes the minimum over its callers. */
	priority?: number;
	signal?: AbortSignal;
};

export type QueueStats = {
	queued: number;
	running: number;
	concurrency: number;
	started: number;
	completed: number;
	failed: number;
	/** Requests that joined an existing queued/running job instead of creating one. */
	deduped: number;
	/** Jobs cancelled because all of their callers aborted. */
	cancelled: number;
	maxRunning: number;
};

type Caller<T> = {
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
	priority: number;
	signal?: AbortSignal;
	onAbort?: () => void;
};

type Job<T> = {
	key: string;
	seq: number;
	/** Explicit override from setPriority/reprioritize; otherwise min over callers. */
	override?: number;
	callers: Set<Caller<T>>;
	state: "queued" | "running";
	controller: AbortController;
};

export function abortError(reason?: unknown): Error {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	try {
		return new DOMException("The operation was aborted.", "AbortError");
	} catch {
		const e = new Error("The operation was aborted.");
		e.name = "AbortError";
		return e;
	}
}

export class PriorityQueue<T> {
	private jobs = new Map<string, Job<T>>();
	private queued = new Set<Job<T>>();
	private runningCount = 0;
	private seq = 0;
	private idleWaiters: (() => void)[] = [];
	private counters = {
		started: 0,
		completed: 0,
		failed: 0,
		deduped: 0,
		cancelled: 0,
		maxRunning: 0,
	};

	constructor(
		private run: (key: string, signal: AbortSignal) => Promise<T>,
		public concurrency = 16,
	) {}

	/** Enqueue (or join) the job for `key`. Resolves with the job's result. */
	request(key: string, opts: QueueRequestOptions = {}): Promise<T> {
		const { signal } = opts;
		const priority = opts.priority ?? 0;
		if (signal?.aborted) return Promise.reject(abortError(signal.reason));
		return new Promise<T>((resolve, reject) => {
			const caller: Caller<T> = { resolve, reject, priority, signal };
			let job = this.jobs.get(key);
			if (job) this.counters.deduped++;
			else {
				job = {
					key,
					seq: this.seq++,
					callers: new Set(),
					state: "queued",
					controller: new AbortController(),
				};
				this.jobs.set(key, job);
				this.queued.add(job);
			}
			job.callers.add(caller);
			if (signal) {
				const j = job;
				caller.onAbort = () =>
					this.detach(j, caller, abortError(signal.reason));
				signal.addEventListener("abort", caller.onAbort, { once: true });
			}
			this.pump();
		});
	}

	/** True while a job for `key` is queued or running. */
	has(key: string) {
		return this.jobs.has(key);
	}

	/** Current effective priority of a queued/running job (undefined if none). */
	priorityOf(key: string): number | undefined {
		const j = this.jobs.get(key);
		return j ? this.effective(j) : undefined;
	}

	/** Override the priority of a queued job (no effect once running). */
	setPriority(key: string, priority: number) {
		const j = this.jobs.get(key);
		if (j) j.override = priority;
	}

	/**
	 * Recompute priorities of all queued jobs, e.g. after the camera moved.
	 * Return `undefined` to keep a job's current priority, `Infinity`/NaN never runs sooner
	 * than anything finite; use `cancel()` to drop jobs outright.
	 */
	reprioritize(fn: (key: string, current: number) => number | undefined) {
		for (const j of this.queued) {
			const p = fn(j.key, this.effective(j));
			if (p !== undefined) j.override = p;
		}
	}

	/** Cancel a job for all callers (they reject with AbortError). */
	cancel(key: string, reason?: unknown) {
		const j = this.jobs.get(key);
		if (!j) return false;
		for (const c of [...j.callers]) this.detach(j, c, abortError(reason));
		return true;
	}

	/** Cancel every queued (not yet running) job whose key matches. */
	cancelQueued(match: (key: string) => boolean = () => true) {
		let n = 0;
		for (const j of [...this.queued])
			if (match(j.key) && this.cancel(j.key)) n++;
		return n;
	}

	stats(): QueueStats {
		return {
			queued: this.queued.size,
			running: this.runningCount,
			concurrency: this.concurrency,
			...this.counters,
		};
	}

	/** Resolves when nothing is queued or running. */
	idle(): Promise<void> {
		if (!this.jobs.size && !this.runningCount) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	private effective(j: Job<T>) {
		if (j.override !== undefined && !Number.isNaN(j.override))
			return j.override;
		let p = Number.POSITIVE_INFINITY;
		for (const c of j.callers) p = Math.min(p, c.priority);
		return p;
	}

	private detach(j: Job<T>, c: Caller<T>, err: unknown) {
		if (!j.callers.delete(c)) return;
		if (c.onAbort) c.signal?.removeEventListener("abort", c.onAbort);
		c.reject(err);
		if (j.callers.size) return;
		// nobody wants it any more
		this.counters.cancelled++;
		// a later request for the same key must start a fresh job, not join this one
		this.jobs.delete(j.key);
		if (j.state === "queued") {
			this.queued.delete(j);
			this.checkIdle();
		} else j.controller.abort(err);
	}

	private checkIdle() {
		if (this.jobs.size || this.runningCount || !this.idleWaiters.length) return;
		const w = this.idleWaiters;
		this.idleWaiters = [];
		for (const r of w) r();
	}

	private next(): Job<T> | undefined {
		let best: Job<T> | undefined;
		let bp = 0;
		for (const j of this.queued) {
			const p = this.effective(j);
			if (!best || p < bp || (p === bp && j.seq < best.seq)) {
				best = j;
				bp = p;
			}
		}
		return best;
	}

	private pump() {
		while (this.runningCount < this.concurrency) {
			const j = this.next();
			if (!j) return;
			this.queued.delete(j);
			j.state = "running";
			this.runningCount++;
			this.counters.started++;
			this.counters.maxRunning = Math.max(
				this.counters.maxRunning,
				this.runningCount,
			);
			let p: Promise<T>;
			try {
				p = this.run(j.key, j.controller.signal);
			} catch (e) {
				p = Promise.reject(e);
			}
			p.then(
				(v) => this.settle(j, true, v),
				(e) => this.settle(j, false, e),
			);
		}
	}

	private settle(j: Job<T>, ok: boolean, v: unknown) {
		this.runningCount--;
		if (this.jobs.get(j.key) === j) this.jobs.delete(j.key);
		if (ok) this.counters.completed++;
		// a job aborted because every caller left was already counted as cancelled
		else if (!j.controller.signal.aborted) this.counters.failed++;
		for (const c of j.callers) {
			if (c.onAbort) c.signal?.removeEventListener("abort", c.onAbort);
			if (ok) c.resolve(v as T);
			else c.reject(v);
		}
		j.callers.clear();
		this.pump();
		this.checkIdle();
	}
}
