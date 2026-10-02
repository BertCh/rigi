// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it } from "vitest";
import {
	GPU_MODULES,
	type GpuModule,
	isRemote,
	listModules,
	moduleOfGraph,
	registerIsland,
} from "../manifest";

const fake = (over: Partial<GpuModule> = {}): GpuModule => ({
	id: "spec-fake",
	island: "I1",
	paths: [],
	groups: ["spec-group"],
	realms: ["page"],
	cadence: "bench",
	resources: [],
	readbacks: [],
	status: "bench only",
	...over,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("registerIsland / listModules", () => {
	it("appends a registered module and unregisters it", () => {
		const off = registerIsland(fake());
		cleanups.push(off);
		expect(listModules().some((m) => m.id === "spec-fake")).toBe(true);
		off();
		expect(listModules().some((m) => m.id === "spec-fake")).toBe(false);
		expect(listModules().length).toBe(GPU_MODULES.length);
	});
	it("a registered id replaces a static module of the same id", () => {
		const target = GPU_MODULES[0];
		cleanups.push(
			registerIsland(fake({ id: target.id, groups: ["override"] })),
		);
		const found = listModules().filter((m) => m.id === target.id);
		expect(found.length).toBe(1);
		expect(found[0].groups).toEqual(["override"]);
	});
	it("registering the same id twice keeps the latest only", () => {
		cleanups.push(registerIsland(fake({ groups: ["one"] })));
		cleanups.push(registerIsland(fake({ groups: ["two"] })));
		const found = listModules().filter((m) => m.id === "spec-fake");
		expect(found.map((m) => m.groups)).toEqual([["two"]]);
	});
});

describe("moduleOfGraph", () => {
	it("resolves by group (the part before |) and by prefix", () => {
		cleanups.push(registerIsland(fake({ graphIdPrefixes: ["spec-prefix:"] })));
		expect(moduleOfGraph("spec-group|key")?.id).toBe("spec-fake");
		expect(moduleOfGraph("anything", "spec-group")?.id).toBe("spec-fake");
		expect(moduleOfGraph("spec-prefix:abc")?.id).toBe("spec-fake");
		expect(moduleOfGraph("no-such-group|k")).toBeUndefined();
	});
	it("resolves every declared group to its module", () => {
		for (const m of GPU_MODULES)
			for (const g of m.groups)
				expect(moduleOfGraph(`${g}|x`)?.groups).toContain(g);
	});
});

describe("isRemote", () => {
	it("is true only when every realm is a worker", () => {
		expect(isRemote(fake({ realms: ["worker:eye"] }))).toBe(true);
		expect(isRemote(fake({ realms: ["worker:eye", "page"] }))).toBe(false);
		expect(isRemote(fake({ realms: [] }))).toBe(false);
	});
});
