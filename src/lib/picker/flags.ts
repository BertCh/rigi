// ?picker=on turns the top-3 picker / tap-a-peak on (roadmap R4). Off by default and outside a browser.
// ?picker=always also opens it expanded on HIGH results (otherwise it stays a collapsed chip there).
import { flagFrom } from "#/lib/flags";

export type PickerMode = "off" | "on" | "always";

export const parsePickerFlag = (search: string): PickerMode =>
	flagFrom(search, "picker");
