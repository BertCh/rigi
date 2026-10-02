// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Storage binding guards (core/binding-guard.ts), node-only. Run: npx tsx src/lib/gpu/core/binding-guard.check.ts
import assert from "node:assert/strict";
import { checkStorageBindings } from "./binding-guard";

const spec = {
	label: "t",
	layout: [
		["u", "uniform"],
		["a", "storage"],
		["b", "read-only-storage"],
	] as [string, string][],
};
const buf = (byteLength: number) => ({ byteLength });
const ok = (b: Record<string, unknown>, align?: number) =>
	assert.doesNotThrow(() => checkStorageBindings(spec, b, align));
const bad = (b: Record<string, unknown>, re: RegExp, align?: number) =>
	assert.throws(() => checkStorageBindings(spec, b, align), re);

ok({ u: buf(0), a: buf(16), b: buf(4) }, 256);
// uniforms are not checked
ok({ u: buf(0), a: buf(16), b: buf(16) });
// zero-size: whole buffer, explicit size, offset at the end
bad({ a: buf(0), b: buf(4) }, /"a" has size 0/);
bad({ a: buf(16), b: { buffer: buf(16), size: 0 } }, /"b" has size 0/);
bad({ a: { buffer: buf(256), offset: 256 }, b: buf(4) }, /"a" has size 0/, 256);
// alignment
ok({ a: { buffer: buf(1024), offset: 256, size: 16 }, b: buf(4) }, 256);
bad(
	{ a: { buffer: buf(1024), offset: 128, size: 16 }, b: buf(4) },
	/offset 128/,
	256,
);
ok({ a: { buffer: buf(1024), offset: 32, size: 16 }, b: buf(4) }, 32);
// no device alignment: offset rule skipped, size rule kept
ok({ a: { buffer: buf(1024), offset: 7, size: 16 }, b: buf(4) });
console.log("binding-guard: ok");
