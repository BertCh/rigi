// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// useStepInside + StepInsidePanel with a fake engine and a fake near-field service: the panel's
// visibility rules, the chip / disabled states and enter / back.
import {
	act,
	cleanup,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	depthMap,
	fakeHost,
	POSE,
} from "#/lib/nearfield/__tests__/step-fixture";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";
import { withFlags } from "#/test/helpers";
import { StepInsidePanel } from "../StepInsidePanel";
import { type StepInside, useStepInside } from "../useStepInside";

const service = vi.hoisted(() => ({ up: true }));
vi.mock("@tanstack/react-router", async () =>
	(await import("#/test/dom")).routerMock(),
);
vi.mock("#/lib/nearfield/client", () => ({
	nearField: {
		available: async () => service.up,
		depth: async () => depthMap(),
		gaussiansWithMeta: async () => null,
	},
}));

function fakeEngine() {
	const host = fakeHost();
	const listeners = new Set<(m: string) => void>();
	const engine = Object.assign(host, {
		steppingInside: false,
		stepCamera: null as null | {
			mode: string;
			atPhoto: boolean;
			onModeChange(cb: (m: string) => void): () => void;
			backToPhoto(): void;
			setMode(m: string): void;
		},
		enterStepInside: vi.fn(() => {
			engine.steppingInside = true;
			engine.stepCamera = {
				mode: "photo",
				atPhoto: true,
				onModeChange: (cb) => {
					listeners.add(cb);
					return () => listeners.delete(cb);
				},
				backToPhoto: vi.fn(),
				setMode: vi.fn(),
			};
		}),
		exitStepInside: vi.fn(() => {
			engine.steppingInside = false;
			engine.stepCamera = null;
		}),
	});
	return engine;
}

let photoN = 0;
function setup(alignState: string | null = "accepted") {
	const engine = fakeEngine();
	const engineRef = { current: engine as unknown as Renderer };
	const photo = { id: `si-${++photoN}`, src: `/si/${photoN}.jpg` } as PhotoMeta;
	const hook = renderHook(
		(p: { alignState: string | null }) =>
			useStepInside({
				engineRef,
				ready: true,
				photo,
				pose: POSE,
				alignState: p.alignState,
				verify: null,
			}),
		{ initialProps: { alignState } },
	);
	return { engine, hook };
}

/** Let the controller's promises (health, build) settle. */
async function settle(ms = 0) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

async function until(cond: () => boolean) {
	for (let i = 0; i < 200 && !cond(); i++) await settle(5);
	expect(cond()).toBe(true);
}

beforeEach(() => {
	service.up = true;
	withFlags({ nearfield: "on" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])]))),
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("useStepInside", () => {
	it("stays hidden while the service is down, and for ?nearfield=off", async () => {
		service.up = false;
		const { hook } = setup();
		await settle();
		expect(hook.result.current.visible).toBe(false);

		service.up = true;
		withFlags({ nearfield: "off" });
		const off = setup();
		await settle();
		expect(off.hook.result.current.visible).toBe(false);
	});

	it("needs an accepted pose to enable the button", async () => {
		const { hook } = setup("auto");
		await settle();
		expect(hook.result.current.visible).toBe(true);
		expect(hook.result.current.accepted).toBe(false);
		expect(hook.result.current.disabledReason).toMatch(/accepted pose/);
		hook.rerender({ alignState: "pinned" });
		expect(hook.result.current.disabledReason).toBeNull();
	});

	it("enters the step camera and keeps the panel (and Back) when the service then goes away", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const { engine, hook } = setup();
		await settle();
		act(() => hook.result.current.enter());
		await until(() => hook.result.current.stepping);
		expect(engine.enterStepInside).toHaveBeenCalledTimes(1);
		expect(hook.result.current.state.phase).toBe("ready");

		service.up = false;
		// the hook's 20 s health poll (fake interval; the client's down-cache is the fake's)
		await act(async () => {
			vi.advanceTimersByTime(20_000);
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(hook.result.current.visible).toBe(true);
		expect(hook.result.current.stepping).toBe(true);

		act(() => hook.result.current.back());
		expect(engine.exitStepInside).toHaveBeenCalled();
		expect(hook.result.current.stepping).toBe(false);
		// a built scene still needs no service: the panel stays
		expect(hook.result.current.visible).toBe(true);
	});
});

function si(over: Partial<StepInside> = {}): StepInside {
	return {
		visible: true,
		state: { phase: "idle" },
		accepted: true,
		disabledReason: null,
		stepping: false,
		camView: null,
		camMode: "photo",
		camModesAllowed: false,
		setCamMode: () => {},
		truth: false,
		setTruth: () => {},
		enter: () => {},
		back: () => {},
		sampleAt: () => null,
		...over,
	};
}

function chip(): string | null {
	return (
		document
			.querySelector("[data-nearfield-status]")
			?.getAttribute("data-nearfield-status") ?? null
	);
}

describe("StepInsidePanel", () => {
	it("renders nothing when not visible", () => {
		const { container } = render(
			<StepInsidePanel si={si({ visible: false })} />,
		);
		expect(container.innerHTML).toBe("");
	});

	it("labels low trust, too weak and failed states", () => {
		const r = render(
			<StepInsidePanel
				si={si({ state: { phase: "ready", quality: 0.2, lowTrust: true } })}
			/>,
		);
		expect(screen.getByText(/low trust/)).toBeTruthy();
		expect(screen.getByText("q 0.20")).toBeTruthy();
		r.rerender(
			<StepInsidePanel
				si={si({
					state: { phase: "low-quality", quality: 0.1 },
					disabledReason: "terrain anchoring too weak",
				})}
			/>,
		);
		expect(chip()).toBe("low-quality");
		expect(screen.getByText(/Step inside · anchoring too weak/)).toBeTruthy();
		expect(
			(document.querySelector("[data-nearfield-enter]") as HTMLButtonElement)
				.disabled,
		).toBe(true);
		r.rerender(<StepInsidePanel si={si({ state: { phase: "error" } })} />);
		expect(screen.getByText(/failed/)).toBeTruthy();
		// a failed build may be retried
		expect(
			(document.querySelector("[data-nearfield-enter]") as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("shows Back to photo while stepping and the research-only badge for SHARP", () => {
		render(
			<StepInsidePanel
				si={si({
					stepping: true,
					state: { phase: "ready", researchOnly: true },
				})}
			/>,
		);
		expect(chip()).toBe("stepping");
		expect(document.querySelector("[data-nearfield-back]")).not.toBeNull();
		expect(screen.getByText("SHARP research-only")).toBeTruthy();
	});
});
