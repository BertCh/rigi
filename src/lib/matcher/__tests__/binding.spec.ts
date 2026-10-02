// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it } from "vitest";
import {
	bindMatcherEngine,
	boundMatcherEngine,
	type MatcherEngine,
} from "../binding";

const fakeEngine = () => ({}) as MatcherEngine;

afterEach(() => bindMatcherEngine(null));

describe("matcher engine binding", () => {
	it("starts unbound and returns the bound engine", () => {
		expect(boundMatcherEngine()).toBeNull();
		const e = fakeEngine();
		bindMatcherEngine(e);
		expect(boundMatcherEngine()).toBe(e);
	});

	it("unbind clears the engine it bound", () => {
		const unbind = bindMatcherEngine(fakeEngine());
		unbind();
		expect(boundMatcherEngine()).toBeNull();
	});

	it("a stale unbind does not clear a newer engine (workspace remount order)", () => {
		const a = fakeEngine();
		const b = fakeEngine();
		const unbindA = bindMatcherEngine(a);
		bindMatcherEngine(b);
		unbindA();
		expect(boundMatcherEngine()).toBe(b);
	});

	it("binding null unbinds explicitly", () => {
		bindMatcherEngine(fakeEngine());
		bindMatcherEngine(null);
		expect(boundMatcherEngine()).toBeNull();
	});
});
