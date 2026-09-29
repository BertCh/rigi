// Minimal store-only (no compression) ZIP writer with CRC-32. Enough for KMZ (JPEG is already
// compressed; doc.kml is tiny). Supports UTF-8 names, no ZIP64 (entries/total < 4 GiB).

let CRC_TABLE: Uint32Array | null = null;
function crcTable() {
	if (CRC_TABLE) return CRC_TABLE;
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	CRC_TABLE = t;
	return t;
}

export function crc32(data: Uint8Array, crc = 0): number {
	const t = crcTable();
	let c = (crc ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array | string; date?: Date };

function dosDateTime(d: Date) {
	const year = Math.max(1980, d.getFullYear());
	const time =
		(d.getHours() << 11) |
		(d.getMinutes() << 5) |
		Math.floor(d.getSeconds() / 2);
	const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

/** Build a store-only ZIP archive. Entry order is preserved (KMZ wants doc.kml first). */
export function zipStore(entries: ZipEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = enc.encode(e.name);
		const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
		const crc = crc32(data);
		const { time, date } = dosDateTime(e.date ?? new Date());
		const lh = new Uint8Array(30 + name.length);
		const lv = new DataView(lh.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true); // version needed
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, 0, true); // stored
		lv.setUint16(10, time, true);
		lv.setUint16(12, date, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, name.length, true);
		lv.setUint16(28, 0, true);
		lh.set(name, 30);

		const ch = new Uint8Array(46 + name.length);
		const cv = new DataView(ch.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true); // version made by (MS-DOS, 2.0)
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, time, true);
		cv.setUint16(14, date, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint16(30, 0, true); // extra
		cv.setUint16(32, 0, true); // comment
		cv.setUint16(34, 0, true); // disk
		cv.setUint16(36, 0, true); // internal attrs
		cv.setUint32(38, 0, true); // external attrs
		cv.setUint32(42, offset, true);
		ch.set(name, 46);

		locals.push(lh, data);
		centrals.push(ch);
		offset += lh.length + data.length;
	}
	const cdSize = centrals.reduce((s, c) => s + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + cdSize + 22);
	let p = 0;
	for (const part of [...locals, ...centrals, eocd]) {
		out.set(part, p);
		p += part.length;
	}
	return out;
}
