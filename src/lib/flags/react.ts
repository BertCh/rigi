// React readers for the flags that apply live (everything outside RESTART_FLAGS): re-render when the
// URL changes. Kept out of ./index.ts so workers never pull in the router.
import { useRouterState } from "@tanstack/react-router";
import {
	type FlagName,
	type Flags,
	flagFrom,
	flagOverride,
	getFlag,
} from "#/lib/flags";

export function useFlag<K extends FlagName>(name: K): Flags[K] {
	const search = useRouterState({ select: (s) => s.location.searchStr });
	return flagOverride(name) !== undefined
		? getFlag(name)
		: flagFrom(search, name);
}
