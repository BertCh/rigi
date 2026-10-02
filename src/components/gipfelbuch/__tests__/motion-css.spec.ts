// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EASE, MOTION } from "../viz/motion";

const css = fs.readFileSync(
	path.join(import.meta.dirname, "..", "swiss", "theme.css"),
	"utf8",
);
const varOf = (name: string) =>
	css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe("theme.css motion vars", () => {
	it("match the motion tokens", () => {
		expect(varOf("--gb-dur-quick")).toBe(`${MOTION.quick}ms`);
		expect(varOf("--gb-dur-fade")).toBe(`${MOTION.fade}ms`);
		expect(varOf("--gb-dur-settle")).toBe(`${MOTION.settle}ms`);
		expect(varOf("--gb-dur-crossfade")).toBe(`${MOTION.crossfade}ms`);
		expect(varOf("--gb-dur-draw")).toBe(`${MOTION.draw}ms`);
		expect(varOf("--gb-ease-out")).toBe(EASE.out);
		expect(varOf("--gb-ease-draw")).toBe(EASE.draw);
		expect(varOf("--gb-ease-in-out")).toBe(EASE.inOut);
		expect(varOf("--gb-ease-standard")).toBe(EASE.standard);
	});
});
