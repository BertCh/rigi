// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Compute code loads its wasm and weights from our own origin: the model files the loaders name are
// manifest rows, and they fetch no code or weights from a third-party host.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modelEntry } from "../fetch";

const LOADERS = ["../../segment/people.ts", "../../sky/model.ts"];

describe("self-hosted models", () => {
	for (const rel of LOADERS) {
		const text = readFileSync(
			fileURLToPath(new URL(rel, import.meta.url)),
			"utf8",
		);
		it(`${rel}: every named weight file has a manifest row`, () => {
			const files = text.match(
				/[\w.-]+\.[0-9a-f]{8}\.(onnx|tflite|safetensors)/g,
			);
			expect(files?.length).toBeGreaterThan(0);
			for (const f of files ?? []) expect(modelEntry(f), f).toBeDefined();
		});
		it(`${rel}: no absolute http(s) URL in code`, () => {
			const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
			expect(code).not.toMatch(/https?:\/\//);
		});
	}
});
