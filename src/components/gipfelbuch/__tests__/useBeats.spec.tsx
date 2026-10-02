// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Figure } from "../viz/Figure";
import {
	type BeatClock,
	type BeatSpec,
	dwellOf,
	MOTION,
	useBeatClock,
	useBeats,
} from "../viz/motion";

const STORY: BeatSpec[] = [
	{ id: "guess", kind: "setup" },
	{ id: "measure", kind: "evidence" },
	{ id: "correct", kind: "change" },
	{ id: "snap", kind: "result" },
];

const setWebdriver = (on: boolean) =>
	Object.defineProperty(navigator, "webdriver", {
		value: on,
		configurable: true,
	});

describe("useBeats", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		// no IntersectionObserver: the figure counts as armed and near
		vi.stubGlobal("IntersectionObserver", undefined);
		setWebdriver(false);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setWebdriver(false);
	});

	it("is static (the last beat) without IntersectionObserver", () => {
		const { result } = renderHook(() => useBeats(STORY));
		expect(result.current.index).toBe(3);
		expect(result.current.motion).toBe(false);
		expect(result.current.spillT).toBe(1);
	});

	it("rests on the result under webdriver", () => {
		setWebdriver(true);
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		const { result } = renderHook(() => useBeats(STORY));
		act(() => {
			vi.advanceTimersByTime(20_000);
		});
		expect(result.current).toMatchObject({
			index: 3,
			kind: "result",
			playing: false,
		});
	});

	it("plays from the first beat and loops where motion is fine and the figure is armed", () => {
		// an observer that reports the whole element on screen at once
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				cb: IntersectionObserverCallback;
				constructor(cb: IntersectionObserverCallback) {
					this.cb = cb;
				}
				observe(el: Element) {
					this.cb(
						[
							{
								isIntersecting: true,
								intersectionRect: { height: 100 },
								boundingClientRect: { height: 100 },
								rootBounds: { height: 800 },
								target: el,
							} as unknown as IntersectionObserverEntry,
						],
						this as unknown as IntersectionObserver,
					);
				}
				disconnect() {}
			},
		);
		const Probe = () => {
			const b = useBeats(STORY, { playback: "loop" });
			return (
				<div ref={b.ref} data-beat={b.kind} data-index={b.index}>
					<button type="button" onClick={() => b.setIndex(1)}>
						step
					</button>
				</div>
			);
		};
		const { container, getByText } = render(<Probe />);
		const el = () => container.firstElementChild as HTMLElement;
		expect(el().dataset.index).toBe("0");
		act(() => {
			vi.advanceTimersByTime(MOTION.beat);
		});
		expect(el().dataset.beat).toBe("evidence");
		for (const kind of ["change", "result"]) {
			act(() => {
				vi.advanceTimersByTime(MOTION.beat);
			});
			expect(el().dataset.beat).toBe(kind);
		}
		act(() => {
			vi.advanceTimersByTime(dwellOf("result"));
		});
		expect(el().dataset.index).toBe("0");
		act(() => {
			getByText("step").click();
		});
		for (let i = 0; i < 3; i++)
			act(() => {
				vi.advanceTimersByTime(MOTION.beat);
			});
		expect(el().dataset.index).toBe("1");
	});
});

describe("useBeatClock", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
			],
		});
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		setWebdriver(false);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		setWebdriver(false);
	});

	it("rests at the end where nothing animates", () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		const { result } = renderHook(() => useBeatClock(STORY));
		expect(result.current.ms).toBe(result.current.total);
		expect(result.current).toMatchObject({ index: 3, done: true });
	});

	it("runs on a 30 fps grid once armed, stops at the end, and a seek ends autoplay", () => {
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				cb: IntersectionObserverCallback;
				constructor(cb: IntersectionObserverCallback) {
					this.cb = cb;
				}
				observe(el: Element) {
					this.cb(
						[
							{
								isIntersecting: true,
								intersectionRect: { height: 100 },
								boundingClientRect: { height: 100 },
								rootBounds: { height: 800 },
								target: el,
							} as unknown as IntersectionObserverEntry,
						],
						this as unknown as IntersectionObserver,
					);
				}
				disconnect() {}
			},
		);
		// the clock arms through its ref, so it needs an element
		const result: { current: BeatClock<HTMLDivElement> } = {
			current: null as never,
		};
		const Probe = () => {
			const c = useBeatClock(STORY);
			result.current = c;
			return <div ref={c.ref} />;
		};
		render(<Probe />);
		expect(result.current.ms).toBe(0);
		for (let i = 0; i < 100; i++)
			act(() => {
				vi.advanceTimersByTime(16);
			});
		const ms = result.current.ms;
		expect(ms).toBeGreaterThan(1000);
		expect(ms).toBeLessThan(2000);
		expect((ms * 30) / 1000).toBeCloseTo(Math.round((ms * 30) / 1000), 6);
		for (let i = 0; i < 1000; i++)
			act(() => {
				vi.advanceTimersByTime(16);
			});
		expect(result.current).toMatchObject({ done: true, playing: false });
		act(() => result.current.seek(3));
		expect(result.current).toMatchObject({
			done: true,
			ms: result.current.total,
		});
		act(() => result.current.seek(1));
		expect(result.current).toMatchObject({
			index: 1,
			manual: true,
			playing: false,
		});
		expect(result.current.progress).toBeGreaterThan(0.99);
	});
});

describe("useArmedInView via useBeats", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("observes a frame that mounts after the hook", () => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		const observed: Element[] = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe(el: Element) {
					observed.push(el);
				}
				disconnect() {}
			},
		);
		const Late = ({ open }: { open: boolean }) => {
			const b = useBeats(STORY);
			return open ? <div ref={b.ref} data-late /> : null;
		};
		const { rerender, container } = render(<Late open={false} />);
		expect(observed).toHaveLength(0);
		rerender(<Late open />);
		const el = container.querySelector("[data-late]");
		expect(observed).toContain(el);
	});
});

describe("Figure ground", () => {
	it("sets the --fig-* vars from the photo's palette, and none without one", () => {
		const { container } = render(
			<>
				<Figure ground="demo-01" plate>
					x
				</Figure>
				<Figure>y</Figure>
			</>,
		);
		const [a, b] = Array.from(container.querySelectorAll("figure"));
		expect(a.dataset.ground).toBe("demo-01");
		expect(a.style.getPropertyValue("--fig-wash")).toMatch(/^#[0-9a-f]{6}$/);
		expect(a.style.getPropertyValue("--fig-terrain-ink")).toMatch(
			/^#[0-9a-f]{6}$/,
		);
		expect(b.dataset.ground).toBeUndefined();
		expect(b.style.getPropertyValue("--fig-wash")).toBe("");
	});
});
