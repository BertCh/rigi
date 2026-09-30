// 16-bit index buffers for terrain grids that fit (three's BufferGeometry picks Uint16 the same
// way): half the index bandwidth of Uint32, and the width the GPU's vertex fetch prefers.
// A (seg + 1)² grid plus its four skirt rows has (seg + 1)² + 4 (seg + 1) vertices, so every
// seg ≤ 253 fits; the seg-256 near tiles keep 32-bit indices.

const narrowed = new WeakMap<Uint32Array, Uint16Array>();

/**
 * `indices` as a Uint16Array when every index is < 65536 (`vertexCount` ≤ 65536), else unchanged.
 * Cached per source array (the meshes share one index array per seg), so repeated calls return
 * the same Uint16Array. luma infers the index type from the array (uint16 → UNSIGNED_SHORT).
 */
export function narrowIndices(
	indices: Uint32Array,
	vertexCount: number,
): Uint16Array | Uint32Array {
	if (vertexCount > 0x10000 || indices.length === 0) return indices;
	let out = narrowed.get(indices);
	if (!out) {
		out = Uint16Array.from(indices);
		narrowed.set(indices, out);
	}
	return out;
}
