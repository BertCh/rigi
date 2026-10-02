// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION } from "../viz/motion";
import { useHeroBloom } from "../viz/real-reveal";

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let observed: Callback[] = [];
const webdriver = navigator.webdriver;
const setWebdriver = (on: boolean) =>
	Object.defineProperty(navigator, "webdriver", {
		value: on,
		configurable: true,
	});

beforeEach(() => {
	observed = [];
	setWebdriver(false);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(cb: Callback) {
				observed.push(cb);
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}));
});
afterEach(() => {
	cleanup();
	setWebdriver(webdriver);
	vi.unstubAllGlobals();
});

/** Tell every observer the frame is `share` on screen (a 400 px frame in an 800 px viewport). */
const show = (share: number) =>
	act(() => {
		for (const cb of observed)
			cb([
				{
					isIntersecting: share > 0,
					intersectionRect: { height: 400 * share } as DOMRectReadOnly,
					boundingClientRect: { height: 400 } as DOMRectReadOnly,
					rootBounds: { height: 800 } as DOMRectReadOnly,
				},
			]);
	});

function Probe({ enabled = true }: { enabled?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const { phase } = useHeroBloom(ref, {
		enabled,
		ready: true,
		key: "demo-09",
		labels: 1,
	});
	return <div ref={ref} data-testid="probe" data-phase={phase} />;
}

const phaseOf = (el: HTMLElement) => el.getAttribute("data-phase");

describe("useHeroBloom", () => {
	it("pends until the frame is in view, plays, then settles", async () => {
		const { getByTestId } = render(<Probe />);
		const probe = getByTestId("probe");
		await waitFor(() => expect(phaseOf(probe)).toBe("pending"));
		show(0.5); // under ARM: still waiting
		expect(phaseOf(probe)).toBe("pending");
		show(0.9);
		await waitFor(() => expect(phaseOf(probe)).toBe("play"));
		await waitFor(() => expect(phaseOf(probe)).toBe("settled"), {
			timeout: 3000,
		});
		// a pointer rest replays it: the lit frame fades out for replayFade, then blooms
		act(() => {
			probe.dispatchEvent(new Event("pointerenter"));
		});
		await waitFor(() => expect(phaseOf(probe)).toBe("pending"));
		const faded = performance.now();
		await waitFor(() => expect(phaseOf(probe)).toBe("play"));
		expect(performance.now() - faded).toBeGreaterThanOrEqual(
			MOTION.replayFade - 50,
		);
		await waitFor(() => expect(phaseOf(probe)).toBe("settled"), {
			timeout: 3000,
		});
		// leaving the view re-arms it, to replay on return
		show(0.1);
		await waitFor(() => expect(phaseOf(probe)).toBe("pending"));
	});

	it("stays settled under webdriver (harness frames are the static design)", async () => {
		setWebdriver(true);
		const { getByTestId } = render(<Probe />);
		await act(async () => {});
		expect(phaseOf(getByTestId("probe"))).toBe("settled");
	});

	it("stays settled when disabled", async () => {
		const { getByTestId } = render(<Probe enabled={false} />);
		await act(async () => {});
		expect(phaseOf(getByTestId("probe"))).toBe("settled");
	});

	it("stays settled under reduced motion", async () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		}));
		const { getByTestId } = render(<Probe />);
		await act(async () => {});
		expect(phaseOf(getByTestId("probe"))).toBe("settled");
	});
});
