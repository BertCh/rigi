// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-user view style persistence (styling.md §2.4). localStorage key `mt-image.viewStyle.v1`
// holds { v: 1, preset, overrides } with diff-only overrides. Every read/write is try/catch'd;
// corrupt or unknown data falls back to classic. `?style=<preset>` wins over storage and is never
// saved (headless screenshots); while it is active, edits stay in memory for that tab only.
// Other tabs follow through the `storage` event.
import { useCallback, useSyncExternalStore } from "react";
import { flagFrom } from "#/lib/flags";
import { storageKey } from "#/lib/ontology/core/storage";
import {
	isPresetId,
	presetIdFrom,
	presetStyle,
	resolveStyle,
	stateFromStyle,
} from "./presets";
import { pruneOverrides } from "./schema";
import type { DeepPartial, PresetId, StyleState, ViewStyle } from "./types";

export const STYLE_STORAGE_KEY = storageKey("viewStyle");
export const STYLE_URL_PARAM = "style";

/** The app's default look: Landeskarte (preset id "swiss"). Classic stays selectable and byte-identical. */
export const DEFAULT_STYLE_STATE: StyleState = {
	preset: "swiss",
	overrides: {},
};

const PERSIST_DEBOUNCE_MS = 250;

type Stored = { v: 1; preset: PresetId; overrides: DeepPartial<ViewStyle> };

/** Untrusted JSON (storage) → a valid StyleState; anything unusable → the default look. */
export function parseStoredState(raw: string | null | undefined): StyleState {
	if (!raw) return DEFAULT_STYLE_STATE;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return DEFAULT_STYLE_STATE;
	}
	if (typeof v !== "object" || v === null || Array.isArray(v))
		return DEFAULT_STYLE_STATE;
	const o = v as Record<string, unknown>;
	// v: 1 is the only version so far; a future v2 migrates here
	const preset = presetIdFrom(o.preset);
	if (o.v !== 1 || !preset) return DEFAULT_STYLE_STATE;
	return { preset, overrides: pruneOverrides(o.overrides) };
}

export function serializeState(s: StyleState): string {
	const out: Stored = { v: 1, preset: s.preset, overrides: s.overrides };
	return JSON.stringify(out);
}

/** `?style=<preset>` (an id or alias, e.g. landeskarte) from a location.search string, or null. */
export function urlPreset(search: string | null | undefined): PresetId | null {
	if (!search) return null;
	const p = flagFrom(search, STYLE_URL_PARAM);
	return presetIdFrom(p);
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StyleStoreEnv = {
	storage?: StorageLike | null;
	search?: string | null;
	/** subscribe to cross-tab changes of `key`; returns an unsubscribe */
	onExternalChange?: (
		key: string,
		cb: (newValue: string | null) => void,
	) => () => void;
};

export type StyleStore = {
	getState(): StyleState;
	getStyle(): ViewStyle;
	setState(next: StyleState | ((prev: StyleState) => StyleState)): void;
	/** Switch preset, keeping the user's overrides. */
	setPreset(preset: PresetId): void;
	/** Merge a partial into the overrides (kept diff-only against the current preset). */
	patch(partial: DeepPartial<ViewStyle>): void;
	/** Drop all overrides (the "Reset to preset" action). */
	resetOverrides(): void;
	subscribe(cb: () => void): () => void;
	/** Write any pending (debounced) state to storage now. */
	flush(): void;
	/** true while ?style= overrides storage */
	readonly urlOverride: boolean;
	dispose(): void;
};

export function createStyleStore(env: StyleStoreEnv = {}): StyleStore {
	const fromUrl = urlPreset(env.search);
	const read = (): StyleState => {
		try {
			return parseStoredState(env.storage?.getItem(STYLE_STORAGE_KEY));
		} catch {
			return DEFAULT_STYLE_STATE;
		}
	};
	let state: StyleState = fromUrl ? { preset: fromUrl, overrides: {} } : read();
	let style: ViewStyle = resolveStyle(state);
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const cb of listeners) cb();
	};
	const apply = (next: StyleState) => {
		const clean: StyleState = {
			preset: isPresetId(next.preset)
				? next.preset
				: DEFAULT_STYLE_STATE.preset,
			overrides: pruneOverrides(next.overrides),
		};
		if (serializeState(clean) === serializeState(state)) return false;
		state = clean;
		style = resolveStyle(state);
		return true;
	};

	const offExternal =
		!fromUrl && env.onExternalChange
			? env.onExternalChange(STYLE_STORAGE_KEY, (raw) => {
					if (apply(parseStoredState(raw))) emit();
				})
			: () => {};

	// Persistence is debounced (a slider drag would otherwise serialise the whole style per step);
	// in-memory state and subscribers stay synchronous, and a hidden page flushes at once.
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	const persist = () => {
		try {
			if (
				state.preset === DEFAULT_STYLE_STATE.preset &&
				!Object.keys(state.overrides).length
			)
				env.storage?.removeItem(STYLE_STORAGE_KEY);
			else env.storage?.setItem(STYLE_STORAGE_KEY, serializeState(state));
		} catch {
			// storage full / disabled: the style still applies for this session
		}
	};
	const flush = () => {
		if (persistTimer === null) return;
		clearTimeout(persistTimer);
		persistTimer = null;
		persist();
	};
	const schedulePersist = () => {
		if (persistTimer !== null) clearTimeout(persistTimer);
		persistTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") flush();
	};
	const hasWindow = !fromUrl && typeof window !== "undefined";
	if (hasWindow) {
		window.addEventListener("pagehide", flush);
		document.addEventListener("visibilitychange", onVisibility);
	}

	const setState: StyleStore["setState"] = (next) => {
		const n = typeof next === "function" ? next(state) : next;
		if (!apply(n)) return;
		if (!fromUrl) schedulePersist();
		emit();
	};

	return {
		getState: () => state,
		getStyle: () => style,
		setState,
		setPreset: (preset) => setState((s) => ({ ...s, preset })),
		patch: (partial) => {
			// edit the resolved style, then store its diff against the preset (drops no-op overrides)
			const next = resolveStyle({
				preset: state.preset,
				overrides: mergeOverrides(state.overrides, partial),
			});
			setState(stateFromStyle(state.preset, next));
		},
		resetOverrides: () =>
			setState((s) => ({ preset: s.preset, overrides: {} })),
		subscribe: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		flush,
		urlOverride: !!fromUrl,
		dispose: () => {
			flush();
			if (hasWindow) {
				window.removeEventListener("pagehide", flush);
				document.removeEventListener("visibilitychange", onVisibility);
			}
			offExternal();
			listeners.clear();
		},
	};
}

/** Deep-merge two override partials (right wins; arrays replace). Validation happens on apply. */
function mergeOverrides(a: unknown, b: unknown): DeepPartial<ViewStyle> {
	const isObj = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	const rec = (x: unknown, y: unknown): unknown => {
		if (y === undefined) return x;
		if (!isObj(x) || !isObj(y)) return y;
		// a discriminated union switching variant replaces the whole node
		for (const tag of ["mode", "kind"])
			if (tag in y && tag in x && x[tag] !== y[tag]) return y;
		const out: Record<string, unknown> = { ...x };
		for (const [k, v] of Object.entries(y)) out[k] = rec(x[k], v);
		return out;
	};
	return (rec(a ?? {}, b) ?? {}) as DeepPartial<ViewStyle>;
}

// ---- browser singleton + React hook ----------------------------------------------------------

let browserStore: StyleStore | null = null;

function safeLocalStorage(): StorageLike | null {
	try {
		return typeof window !== "undefined" ? window.localStorage : null;
	} catch {
		return null;
	}
}

/** The app-wide store (lazy, browser only; on the server it is a memory store at the default look). */
export function getStyleStore(): StyleStore {
	if (browserStore) return browserStore;
	const hasWindow = typeof window !== "undefined";
	browserStore = createStyleStore({
		storage: safeLocalStorage(),
		search: hasWindow ? window.location.search : null,
		onExternalChange: hasWindow
			? (key, cb) => {
					const h = (e: StorageEvent) => {
						if (e.key === key || e.key === null)
							cb(e.key === null ? null : e.newValue);
					};
					window.addEventListener("storage", h);
					return () => window.removeEventListener("storage", h);
				}
			: undefined,
	});
	return browserStore;
}

const serverState = () => DEFAULT_STYLE_STATE;
const serverStyle = () => presetStyle(DEFAULT_STYLE_STATE.preset);

/** [resolved style, stored state, setter]. Re-renders on local edits and on edits in other tabs. */
export function useViewStyle(): [
	ViewStyle,
	StyleState,
	StyleStore["setState"],
] {
	const store = getStyleStore();
	const state = useSyncExternalStore(
		store.subscribe,
		store.getState,
		serverState,
	);
	const style = useSyncExternalStore(
		store.subscribe,
		store.getStyle,
		serverStyle,
	);
	const set = useCallback<StyleStore["setState"]>(
		(n) => store.setState(n),
		[store],
	);
	return [style, state, set];
}
