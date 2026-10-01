// Minimal ESRI shapefile (.shp polygon/polyline/point) + dBase (.dbf) reader. No deps.
import { readFileSync } from "node:fs";

export type ShpRecord = {
	bbox: [number, number, number, number];
	parts: [number, number][][];
};

export function readShp(
	path: string,
	bboxFilter?: [number, number, number, number],
): (ShpRecord | null)[] {
	const b = readFileSync(path);
	const out: (ShpRecord | null)[] = [];
	let p = 100;
	while (p + 8 <= b.length) {
		const len = b.readUInt32BE(p + 4) * 2;
		const q = p + 8;
		const type = b.readInt32LE(q);
		p = q + len;
		if (type === 0) {
			out.push(null);
			continue;
		}
		if (type === 1 || type === 11 || type === 21) {
			const x = b.readDoubleLE(q + 4),
				y = b.readDoubleLE(q + 12);
			out.push({ bbox: [x, y, x, y], parts: [[[x, y]]] });
			continue;
		}
		const bbox: [number, number, number, number] = [
			b.readDoubleLE(q + 4),
			b.readDoubleLE(q + 12),
			b.readDoubleLE(q + 20),
			b.readDoubleLE(q + 28),
		];
		if (
			bboxFilter &&
			(bbox[2] < bboxFilter[0] ||
				bbox[0] > bboxFilter[2] ||
				bbox[3] < bboxFilter[1] ||
				bbox[1] > bboxFilter[3])
		) {
			out.push(null);
			continue;
		}
		const nParts = b.readInt32LE(q + 36),
			nPts = b.readInt32LE(q + 40);
		const parts: [number, number][][] = [];
		const idx: number[] = [];
		for (let i = 0; i < nParts; i++) idx.push(b.readInt32LE(q + 44 + 4 * i));
		idx.push(nPts);
		const base = q + 44 + 4 * nParts;
		for (let i = 0; i < nParts; i++) {
			const r: [number, number][] = [];
			for (let k = idx[i]; k < idx[i + 1]; k++)
				r.push([
					b.readDoubleLE(base + 16 * k),
					b.readDoubleLE(base + 16 * k + 8),
				]);
			parts.push(r);
		}
		out.push({ bbox, parts });
	}
	return out;
}

export function readDbf(
	path: string,
	enc: BufferEncoding = "utf8",
): Record<string, string | number | null>[] {
	const b = readFileSync(path);
	const n = b.readUInt32LE(4),
		hl = b.readUInt16LE(8),
		rl = b.readUInt16LE(10);
	const fields: { name: string; type: string; len: number }[] = [];
	for (let p = 32; b[p] !== 0x0d && p < hl; p += 32)
		fields.push({
			name: b.toString("latin1", p, p + 11).replace(/\0.*$/, ""),
			type: String.fromCharCode(b[p + 11]),
			len: b[p + 16],
		});
	const rows: Record<string, string | number | null>[] = [];
	for (let i = 0; i < n; i++) {
		let p = hl + i * rl + 1;
		const row: Record<string, string | number | null> = {};
		for (const f of fields) {
			const s = b.toString(enc, p, p + f.len).trim();
			row[f.name] =
				s === "" ? null : f.type === "N" || f.type === "F" ? Number(s) : s;
			p += f.len;
		}
		rows.push(row);
	}
	return rows;
}

/** Group polygon rings into outer rings with their holes (shapefile: clockwise = outer). */
export function groupRings(
	parts: [number, number][][],
): [number, number][][][] {
	const area = (r: [number, number][]) => {
		let s = 0;
		for (let i = 0, j = r.length - 1; i < r.length; j = i++)
			s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
		return s / 2;
	};
	const polys: [number, number][][][] = [];
	for (const r of parts) {
		if (r.length < 4) continue;
		if (area(r) < 0)
			polys.push([r]); // clockwise (y-up) => outer
		else if (polys.length) polys[polys.length - 1].push(r);
		else polys.push([r]);
	}
	return polys;
}
