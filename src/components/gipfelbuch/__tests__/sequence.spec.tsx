// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Compare, Details, Stages } from "../viz/explain";
import {
	COMPARE_SCRUB_MS,
	COMPARE_SETUP_MS,
	compareIntroX,
	compareKeyX,
	compareSide,
	easeInOut,
	SEQUENCE_LEAD_MS,
	STEPS_DRAW_MS,
	STEPS_PERIOD_MS,
	stageFrameKey,
	stagesInitialIndex,
	stepsSegmentDelay,
	stepsStationDelay,
	useOpenForPrint,
	useSequenceMotion,
} from "../viz/sequence";
import { AlignmentStoryProvider, useAlignmentStory } from "../viz/story";

const setWebdriver = (on: boolean) =>
	Object.defineProperty(navigator, "webdriver", {
		value: on,
		configurable: true,
	});

describe("sequence timing (pure)", () => {
	it("easeInOut is symmetric and pinned at its ends", () => {
		expect(easeInOut(0)).toBe(0);
		expect(easeInOut(1)).toBe(1);
		expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
		expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 12);
		expect(easeInOut(-1)).toBe(0);
		expect(easeInOut(2)).toBe(1);
	});

	it("the Compare intro holds the guess, scrubs once to start and rests", () => {
		const scrubFrom = SEQUENCE_LEAD_MS + COMPARE_SETUP_MS;
		expect(compareIntroX(0, 0.4)).toEqual({ x: 1, done: false });
		expect(compareIntroX(scrubFrom, 0.4)).toEqual({ x: 1, done: false });
		const mid = compareIntroX(scrubFrom + COMPARE_SCRUB_MS / 2, 0.4);
		expect(mid.x).toBeCloseTo(0.7, 12);
		expect(mid.done).toBe(false);
		expect(compareIntroX(scrubFrom + COMPARE_SCRUB_MS, 0.4)).toEqual({
			x: 0.4,
			done: true,
		});
		// monotone: the wipe never passes its rest (no overshoot)
		let prev = 1;
		for (let ms = 0; ms <= scrubFrom + COMPARE_SCRUB_MS; ms += 50) {
			const { x } = compareIntroX(ms, 0.4);
			expect(x).toBeLessThanOrEqual(prev + 1e-12);
			expect(x).toBeGreaterThanOrEqual(0.4);
			prev = x;
		}
	});

	it("keys move the wipe, clamped; other keys are ignored", () => {
		expect(compareKeyX("ArrowLeft", 0.5)).toBeCloseTo(0.45, 12);
		expect(compareKeyX("ArrowRight", 0.98)).toBe(1);
		expect(compareKeyX("ArrowLeft", 0.02)).toBe(0);
		expect(compareKeyX("Home", 0.7)).toBe(0);
		expect(compareKeyX("End", 0.2)).toBe(1);
		expect(compareKeyX("Enter", 0.5)).toBeNull();
	});

	it("the larger side names the slider value; ties go to before", () => {
		expect(compareSide(0.5)).toBe("before");
		expect(compareSide(0.49)).toBe("after");
		expect(compareSide(1)).toBe("before");
	});

	it("each Steps station appears as the pen reaches it", () => {
		expect(stepsStationDelay(0)).toBe(0);
		for (let i = 0; i < 6; i++) {
			// the pen leaves a station only after it has started to fade in
			expect(stepsSegmentDelay(i)).toBeGreaterThan(stepsStationDelay(i));
			// the next station arrives while its segment is still drawing, not before it starts
			expect(stepsStationDelay(i + 1)).toBeGreaterThan(stepsSegmentDelay(i));
			expect(stepsStationDelay(i + 1)).toBeLessThan(
				stepsSegmentDelay(i) + STEPS_DRAW_MS,
			);
		}
		expect(stepsStationDelay(3)).toBe(3 * STEPS_PERIOD_MS);
	});

	it("Stages starts on the result frame and groups frames by key", () => {
		expect(stagesInitialIndex(4)).toBe(3);
		expect(stagesInitialIndex(0)).toBe(0);
		expect(stageFrameKey({ frame: "photo" }, 2)).toBe("frame:photo");
		expect(stageFrameKey({}, 2)).toBe("stage:2");
		// a frame named like an index never collides with that index
		expect(stageFrameKey({ frame: "1" }, 0)).not.toBe(stageFrameKey({}, 1));
	});
});

describe("sequence components (happy-dom)", () => {
	beforeEach(() => {
		// an observer that never reports: figures stay out of view, so no clock or intro runs, and
		// motion is decided by webdriver / reduced motion alone (not by a missing observer)
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
				takeRecords() {
					return [];
				}
			},
		);
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		setWebdriver(false);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		setWebdriver(false);
	});

	it("useSequenceMotion is off under webdriver and in print, on otherwise", () => {
		setWebdriver(true);
		const off = renderHook(() => useSequenceMotion(false));
		expect(off.result.current).toBe(false);
		setWebdriver(false);
		const on = renderHook(() => useSequenceMotion(false));
		expect(on.result.current).toBe(true);
		act(() => {
			window.dispatchEvent(new Event("beforeprint"));
		});
		expect(on.result.current).toBe(false);
		act(() => {
			window.dispatchEvent(new Event("afterprint"));
		});
		expect(on.result.current).toBe(true);
		const reduced = renderHook(() => useSequenceMotion(true));
		expect(reduced.result.current).toBe(false);
	});

	it("useOpenForPrint opens a closed details for print and restores it", () => {
		const { result } = renderHook(() => {
			const ref = useRef<HTMLDetailsElement>(null);
			useOpenForPrint(ref);
			return ref;
		});
		const el = document.createElement("details");
		result.current.current = el;
		act(() => {
			window.dispatchEvent(new Event("beforeprint"));
		});
		expect(el.open).toBe(true);
		act(() => {
			window.dispatchEvent(new Event("afterprint"));
		});
		expect(el.open).toBe(false);
		// one the reader opened stays open
		el.open = true;
		act(() => {
			window.dispatchEvent(new Event("beforeprint"));
			window.dispatchEvent(new Event("afterprint"));
		});
		expect(el.open).toBe(true);
	});

	it("Details opens for print", () => {
		const { container } = render(<Details>mechanism</Details>);
		const el = container.querySelector("details") as HTMLDetailsElement;
		expect(el.open).toBe(false);
		act(() => {
			window.dispatchEvent(new Event("beforeprint"));
		});
		expect(el.open).toBe(true);
	});

	const STAGES = [
		{ label: "Photo", caption: "the photo", render: () => <p>frame 1</p> },
		{ label: "Line", caption: "the line", render: () => <p>frame 2</p> },
		{ label: "Fit", caption: "the fit", render: () => <p>frame 3</p> },
	];

	it("Stages under webdriver rests on the last stage and lists every caption for print", () => {
		setWebdriver(true);
		const { container, getByText } = render(<Stages stages={STAGES} />);
		expect(getByText("frame 3")).toBeTruthy();
		const list = container.querySelector("ol");
		expect(list?.className).toContain("print:block");
		expect(list?.querySelectorAll("li")).toHaveLength(3);
	});

	it("Stages steps back to the first stage where motion is allowed, and a tab picks a stage", () => {
		const { getByText, getAllByRole } = render(<Stages stages={STAGES} />);
		expect(getByText("frame 1")).toBeTruthy();
		const tabs = getAllByRole("button", { pressed: false });
		fireEvent.click(tabs[1]);
		expect(getByText("frame 3")).toBeTruthy();
	});

	const POSED = [
		{ label: "Guess", caption: "guess", pose: 0, render: () => <p>posed 1</p> },
		{ label: "Turn", caption: "turn", pose: 0, render: () => <p>posed 2</p> },
		{
			label: "Solved",
			caption: "solved",
			pose: 1,
			render: () => <p>posed 3</p>,
		},
	];
	function StoryProbe() {
		const story = useAlignmentStory();
		return <output>{story?.t}</output>;
	}

	it("Stages in a story starting at the guess keeps its static result frame (webdriver)", () => {
		setWebdriver(true);
		const { getByText, container } = render(
			<AlignmentStoryProvider initial={0}>
				<Stages stages={POSED} />
				<StoryProbe />
			</AlignmentStoryProvider>,
		);
		expect(getByText("posed 3")).toBeTruthy();
		expect(container.querySelector("output")?.textContent).toBe("1");
	});

	it("Stages in a story steps back to the first stage and keeps playing", () => {
		const { getByText, getByRole, container } = render(
			<AlignmentStoryProvider initial={0}>
				<Stages stages={POSED} />
				<StoryProbe />
			</AlignmentStoryProvider>,
		);
		expect(getByText("posed 1")).toBeTruthy();
		expect(container.querySelector("output")?.textContent).toBe("0");
		// autoplay was not ended by the story's own initial t
		expect(getByRole("button", { name: "Pause" })).toBeTruthy();
	});

	it("Compare under webdriver rests at start and names the larger side", () => {
		setWebdriver(true);
		const { getByRole } = render(
			<Compare
				before={<div>guess</div>}
				after={<div>solved</div>}
				beforeLabel="guess"
				afterLabel="solved"
				start={0.3}
			/>,
		);
		const slider = getByRole("slider");
		expect(slider.getAttribute("aria-valuenow")).toBe("30");
		expect(slider.getAttribute("aria-valuetext")).toBe("solved");
		fireEvent.keyDown(slider, { key: "End" });
		expect(slider.getAttribute("aria-valuenow")).toBe("100");
		expect(slider.getAttribute("aria-valuetext")).toBe("guess");
	});

	it("Compare waits on the guess (setup frame) where motion is allowed", () => {
		const { getByRole } = render(
			<Compare
				before={<div>guess</div>}
				after={<div>solved</div>}
				beforeLabel="guess"
				afterLabel="solved"
			/>,
		);
		expect(getByRole("slider").getAttribute("aria-valuenow")).toBe("100");
	});
});
