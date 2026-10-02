// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { expect } from "vitest";
import type { CameraInput } from "../camera";

/** A solved photo near Niederhorn: eye 1361 m above a frame at the Swiss geoid-free origin. */
export const FIXTURE: CameraInput = {
	photoId: "IMG_7131",
	width: 4032,
	height: 3024,
	pose: { yaw: 20.84, pitch: -3.41, roll: -0.73, vfov: 53.06 },
	frame: { lat: 46.97596111111111, lon: 8.668494444444445, h: 0 },
	eye: [0, 0, 1361.3],
	demAtCamera: 1350,
	takenAt: "2023-07-01T10:20:30Z",
	geoidUndulation: 49,
};

export const SOUTH: CameraInput = {
	...FIXTURE,
	photoId: "syd",
	frame: { lat: -33.9, lon: 151.2, h: 12 },
	pose: { yaw: 181, pitch: -35, roll: -12, vfov: 65 },
	geoidUndulation: undefined,
	demAtCamera: undefined,
	takenAt: null,
};

/** Minimal zip reader over the central directory (store-only archives). */
export function readZip(bytes: Uint8Array) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(dv.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
	const count = dv.getUint16(bytes.length - 22 + 10, true);
	let p = dv.getUint32(bytes.length - 22 + 16, true);
	const out: { name: string; data: Uint8Array; crc: number }[] = [];
	for (let i = 0; i < count; i++) {
		expect(dv.getUint32(p, true)).toBe(0x02014b50);
		const crc = dv.getUint32(p + 16, true);
		const size = dv.getUint32(p + 24, true);
		const nameLen = dv.getUint16(p + 28, true);
		const off = dv.getUint32(p + 42, true);
		const name = new TextDecoder().decode(
			bytes.subarray(p + 46, p + 46 + nameLen),
		);
		expect(dv.getUint32(off, true)).toBe(0x04034b50);
		const lnLen = dv.getUint16(off + 26, true);
		const start = off + 30 + lnLen;
		out.push({ name, data: bytes.slice(start, start + size), crc });
		p += 46 + nameLen;
	}
	return out;
}

/**
 * Tiny XML well-formedness check: balanced tags, quoted attributes, no stray "<" or "&" in text.
 * Returns the root element name and every attribute (name -> value) seen, unescaped.
 */
export function parseXml(xml: string) {
	const attrs: Record<string, string>[] = [];
	const stack: string[] = [];
	let root = "";
	const body = xml
		.replace(/^<\?xml[^>]*\?>\s*/, "")
		.replace(/<\?xpacket[^>]*\?>/g, "");
	const unescapeXml = (s: string) =>
		s
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&");
	const re =
		/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
	let pos = 0;
	for (let m = re.exec(body); m; m = re.exec(body)) {
		if (m.index !== pos)
			throw new Error(`not well-formed near ${body.slice(pos, pos + 40)}`);
		pos = re.lastIndex;
		if (m[5] !== undefined) {
			// text: every & must start an entity
			if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]))
				throw new Error(`bare & in text: ${m[5]}`);
			continue;
		}
		const [, close, name, attrText, self] = m;
		if (close) {
			if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
			continue;
		}
		const a: Record<string, string> = {};
		for (const am of attrText.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
			if (/&(?!(amp|lt|gt|quot|apos);)/.test(am[2]))
				throw new Error(`bare & in ${am[1]}`);
			a[am[1]] = unescapeXml(am[2]);
		}
		attrs.push({ _tag: name, ...a });
		if (!root) root = name;
		if (!self) stack.push(name);
	}
	if (pos !== body.length) throw new Error("trailing garbage");
	if (stack.length) throw new Error(`unclosed <${stack.pop()}>`);
	return { root, attrs };
}

/** Text of the first <tag>…</tag>. */
export const tagText = (xml: string, tag: string) =>
	new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
