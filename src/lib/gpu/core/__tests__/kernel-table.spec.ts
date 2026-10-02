// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Structural lint over every kernel declared with defineKernel under src/lib/gpu: the layout table
// (name -> kind, binding i in order) must match the `@group(0) @binding(i)` declarations in the WGSL.
import { describe, expect, it } from "vitest";
import { definedKernels, isTextureKind } from "../kernel";

// Importing the modules registers their kernels. Benches, checks and self-tests are not product code.
const modules = import.meta.glob(
	[
		"../../**/*.ts",
		"!../../**/__tests__/**",
		"!../../**/*bench*.ts",
		"!../../**/*.check.ts",
		"!../../**/*selftest*.ts",
		"!../../**/*.fixtures.ts",
		"!../../**/*.worker.ts",
		"!../../**/smoke.ts",
	],
	{ eager: false },
);

const loaded = Object.entries(modules).map(async ([path, load]) => {
	try {
		await load();
		return null;
	} catch (e) {
		return `${path}: ${String(e).slice(0, 120)}`;
	}
});

describe("defineKernel layouts", async () => {
	const failures = (await Promise.all(loaded)).filter(Boolean);
	const specs = definedKernels();

	it("most modules import without a GPU", () => {
		expect(failures.length).toBeLessThan(Object.keys(modules).length / 4);
		expect(specs.length).toBeGreaterThan(20);
	});

	it("kernel ids are unique per warm-up group", () => {
		const seen = new Map<string, number>();
		for (const s of specs) {
			const k = `${s.group}/${s.id}/${s.entryPoint}/${JSON.stringify(s.constants ?? {})}`;
			seen.set(k, (seen.get(k) ?? 0) + 1);
		}
		const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
		expect(dup).toEqual([]);
	});

	it("binding names inside one layout are unique", () => {
		for (const s of specs) {
			const names = s.layout.map(([n]) => n);
			expect(new Set(names).size, s.id).toBe(names.length);
		}
	});

	it("the WGSL declares group(0) bindings 0..n-1 matching the layout kinds", () => {
		const bad: string[] = [];
		let checked = 0;
		for (const s of specs) {
			const decls = [
				...s.source.matchAll(
					/@group\(0\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g,
				),
			];
			if (decls.length === 0) continue; // template-built sources are linted by their owners
			checked++;
			const byIndex = new Map<number, { space: string; ty: string }>();
			for (const d of decls)
				byIndex.set(Number(d[1]), { space: d[2] ?? "", ty: d[4] });
			if (byIndex.size !== s.layout.length) {
				bad.push(
					`${s.id}: ${byIndex.size} bindings in WGSL vs ${s.layout.length}`,
				);
				continue;
			}
			s.layout.forEach(([name, kind], i) => {
				const b = byIndex.get(i);
				if (!b) {
					bad.push(`${s.id}: binding ${i} (${name}) missing`);
					return;
				}
				const space = b.space.replace(/\s+/g, "");
				const ok =
					kind === "uniform"
						? space === "uniform"
						: kind === "storage"
							? /^storage,read_write$/.test(space)
							: kind === "read-only-storage"
								? /^storage(,read)?$/.test(space)
								: isTextureKind(kind) && /^texture_/.test(b.ty);
				if (!ok)
					bad.push(
						`${s.id}: binding ${i} (${name}) is ${kind}, WGSL says var<${space}> ${b.ty}`,
					);
			});
		}
		expect(checked).toBeGreaterThan(specs.length / 2);
		expect(bad).toEqual([]);
	});

	it("the entry point exists in the source", () => {
		const bad = specs
			.filter((s) => !new RegExp(`fn\\s+${s.entryPoint}\\s*\\(`).test(s.source))
			.map((s) => s.id);
		expect(bad).toEqual([]);
	});
});
