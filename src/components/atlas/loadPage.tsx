// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Component, type ComponentType, lazy, type ReactNode } from "react";
import type { AtlasNode } from "#/lib/atlas/types";

type PageProps = { node: AtlasNode };
const mods = import.meta.glob("../../lib/atlas/pages/*.tsx") as Record<
	string,
	() => Promise<{ default: ComponentType<PageProps> }>
>;

const cache = new Map<string, ComponentType<PageProps> | null>();

/** Lazy bespoke page for an id (src/lib/atlas/pages/<id>.tsx), or null when none exists yet. */
export function bespokePage(id: string): ComponentType<PageProps> | null {
	if (cache.has(id)) return cache.get(id) ?? null;
	const key = Object.keys(mods).find((k) => k.endsWith(`/pages/${id}.tsx`));
	const c = key ? lazy(mods[key]) : null;
	cache.set(id, c);
	return c;
}
export const bespokeIds = () =>
	Object.keys(mods).map((k) =>
		k.replace(/^.*\/pages\//, "").replace(/\.tsx$/, ""),
	);

/** Catches a crashing bespoke page so the shell (and the fallback) still render. */
export class PageBoundary extends Component<
	{ fallback: ReactNode; resetKey: string; children: ReactNode },
	{ err: Error | null; key: string }
> {
	state = { err: null as Error | null, key: this.props.resetKey };
	static getDerivedStateFromError(err: Error) {
		return { err };
	}
	static getDerivedStateFromProps(p: { resetKey: string }, s: { key: string }) {
		return p.resetKey !== s.key ? { err: null, key: p.resetKey } : null;
	}
	render() {
		if (this.state.err) {
			return (
				<>
					{this.props.fallback}
					<p className="mt-4 font-mono text-[11px] text-[var(--rigi-trap)]/80">
						This page's custom visual failed to render: {this.state.err.message}
					</p>
				</>
			);
		}
		return this.props.children;
	}
}
