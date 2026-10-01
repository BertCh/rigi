// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Type-level assertion helpers for the ontology's compile-time checks (crosswalks, realizations).
// Usage: `export type _x = Assert<Equal<A, B>>;` — exported so noUnusedLocals stays quiet.

export type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
export type Assert<T extends true> = T;
/** every member of union A is in union B */
export type Covers<B, A> = [Exclude<A, B>] extends [never] ? true : false;
/** A is assignable to B */
export type Extends<A, B> = [A] extends [B] ? true : false;
