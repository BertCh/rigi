// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Byte-capped LRU index. Pure bookkeeping (no I/O): it tracks which keys exist, their
// sizes and recency, and tells the caller which keys to evict. Used both for the
// persistent tile store's metadata and for the in-memory hot tier.

export type LruEntry = {
	/** Body size in bytes. */
	size: number;
	/** Last access, ms since epoch (informational; order is the Map's insertion order). */
	atime: number;
	/** MIME type of the stored body. */
	type: string;
};

/** Serialised form: least-recently-used first. */
export type LruSnapshot = {
	version: 1;
	entries: [key: string, size: number, atime: number, type: string][];
};

export class LruIndex {
	/** Insertion order == recency order: first key is the least recently used. */
	private map = new Map<string, LruEntry>();
	private total = 0;

	constructor(public capBytes: number) {}

	get bytes() {
		return this.total;
	}

	get size() {
		return this.map.size;
	}

	has(key: string) {
		return this.map.has(key);
	}

	get(key: string): LruEntry | undefined {
		return this.map.get(key);
	}

	/** Mark `key` as most recently used. Returns false if it is unknown. */
	touch(key: string, now = Date.now()): boolean {
		const e = this.map.get(key);
		if (!e) return false;
		this.map.delete(key);
		e.atime = now;
		this.map.set(key, e);
		return true;
	}

	/**
	 * Insert or replace `key` as most recently used, then return the keys that must be
	 * evicted to get back under the cap (oldest first; never `key` itself unless the
	 * single entry is larger than the whole cap).
	 */
	add(
		key: string,
		size: number,
		type = "application/octet-stream",
		now = Date.now(),
	): string[] {
		this.remove(key);
		this.map.set(key, { size, atime: now, type });
		this.total += size;
		return this.evict();
	}

	remove(key: string): boolean {
		const e = this.map.get(key);
		if (!e) return false;
		this.map.delete(key);
		this.total -= e.size;
		return true;
	}

	/** Drop least-recently-used entries until `bytes <= capBytes`; returns the dropped keys. */
	evict(capBytes = this.capBytes): string[] {
		const out: string[] = [];
		for (const [k, e] of this.map) {
			if (this.total <= capBytes) break;
			this.map.delete(k);
			this.total -= e.size;
			out.push(k);
		}
		return out;
	}

	clear() {
		this.map.clear();
		this.total = 0;
	}

	keys(): string[] {
		return [...this.map.keys()];
	}

	toJSON(): LruSnapshot {
		return {
			version: 1,
			entries: [...this.map].map(([k, e]) => [k, e.size, e.atime, e.type]),
		};
	}

	/** Restore from a snapshot; malformed input yields an empty index. */
	static fromJSON(snap: unknown, capBytes: number): LruIndex {
		const idx = new LruIndex(capBytes);
		const s = snap as Partial<LruSnapshot> | null;
		if (!s || s.version !== 1 || !Array.isArray(s.entries)) return idx;
		for (const row of s.entries) {
			if (!Array.isArray(row) || typeof row[0] !== "string") continue;
			const size = Number(row[1]);
			if (!Number.isFinite(size) || size < 0) continue;
			idx.map.set(row[0], {
				size,
				atime: Number(row[2]) || 0,
				type: String(row[3] ?? ""),
			});
			idx.total += size;
		}
		return idx;
	}
}
