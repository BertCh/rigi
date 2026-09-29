// A tiny bounded-concurrency task queue: at most `limit` tasks run at once, in FIFO order.
export function createPool(limit: number) {
	let running = 0;
	let closed = false;
	const queue: (() => Promise<void>)[] = [];
	const pump = () => {
		while (!closed && running < limit && queue.length) {
			const task = queue.shift() as () => Promise<void>;
			running++;
			task()
				.catch(() => {})
				.finally(() => {
					running--;
					pump();
				});
		}
	};
	return {
		push(task: () => Promise<void>) {
			if (closed) return;
			queue.push(task);
			pump();
		},
		/** Drop queued tasks; running ones finish on their own. */
		close() {
			closed = true;
			queue.length = 0;
		},
		get pending() {
			return queue.length + running;
		},
	};
}
