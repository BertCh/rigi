// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU → worker fallback state machine of the splat sort, free of luma / DOM so node can test it
// (scripts/gpu/splat-sort-check.ts). SplatsCore owns one per cloud:
//   - `fail(reason)` is idempotent and one-way: the first call switches to "worker", records the
//     reason, warns once and runs `onSwitch` (SplatsCore: identity order if no valid sort has landed,
//     start the worker sorter, schedule a redraw); later calls are ignored;
//   - `watch(p, what)` turns a rejection of `p` (pipeline compile failure, a checked submit's
//     validation error, an error scope's error) into `fail(what: message)`.
// Device loss is hooked by the owner with gpu/core/lifecycle `onLost(device, () => fail("device lost"))`.

export type SortBackendName = "worker" | "gpu";

export class SortBackendState {
	backend: SortBackendName;
	/** Why the GPU sort was abandoned (null while it is in use, or when the worker was chosen up front). */
	reason: string | null = null;
	private warned = false;

	constructor(
		initial: SortBackendName,
		private readonly onSwitch: (reason: string) => void,
		private readonly warn: (msg: string) => void = (m) => console.warn(m),
	) {
		this.backend = initial;
	}

	/** Switch to the worker. Returns true only for the call that switched. */
	fail(reason: string): boolean {
		if (this.backend === "worker") return false;
		this.backend = "worker";
		this.reason = reason;
		if (!this.warned) {
			this.warned = true;
			this.warn(`[splat-sort] GPU sort failed (${reason}); using the worker`);
		}
		this.onSwitch(reason);
		return true;
	}

	/** Fail with `what: message` when `p` rejects. */
	watch(p: Promise<unknown>, what: string): void {
		p.catch((e) =>
			this.fail(`${what}: ${e instanceof Error ? e.message : String(e)}`),
		);
	}
}
