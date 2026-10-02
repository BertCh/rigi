// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure bind-time validation for storage buffer bindings (no GPU, node-testable). Called by
// encodeDispatch() for every compute dispatch, so graph nodes and direct callers share it.

type RangeBinding = {
	buffer: { byteLength: number };
	offset?: number;
	size?: number;
};
type SpecLike = { label: string; layout: [string, string][] };

/**
 * Throw on a storage binding WebGPU would reject. Both failures invalidate the WHOLE submit
 * silently (the reads then return stale bytes), so refuse while encoding and let the caller's catch
 * take its CPU path. A zero-size storage binding is a validation error (luma #3338); a storage
 * binding offset must be a multiple of minStorageBufferOffsetAlignment (luma #3332).
 * `alignment` undefined (hand-built kernel without a device) skips the offset rule.
 */
export function checkStorageBindings(
	spec: SpecLike,
	bindings: Record<string, unknown>,
	alignment?: number,
) {
	for (const [name, kind] of spec.layout) {
		if (kind !== "storage" && kind !== "read-only-storage") continue;
		const v = bindings[name] as Partial<RangeBinding> | undefined;
		// a bare Buffer binds its whole range; { buffer, offset, size } an explicit one
		const buffer = v?.buffer ?? (v as { byteLength?: number } | undefined);
		if (!buffer || typeof buffer.byteLength !== "number") continue;
		const offset = v?.buffer ? (v.offset ?? 0) : 0;
		const size = v?.buffer
			? (v.size ?? buffer.byteLength - offset)
			: buffer.byteLength;
		if (size <= 0)
			throw new Error(
				`[gpu] ${spec.label}: storage binding "${name}" has size 0 (a zero-size storage binding invalidates the whole submit)`,
			);
		if (alignment && offset % alignment)
			throw new Error(
				`[gpu] ${spec.label}: storage binding "${name}" offset ${offset} is not a multiple of minStorageBufferOffsetAlignment ${alignment}`,
			);
	}
}
