// PhotoWorkspace's one picker call site. Without ?picker the mount renders nothing and never loads the
// panel chunk, so the default view (classic included) is untouched.
import { lazy, Suspense } from "react";
import { useFlag } from "#/lib/flags/react";
import type { PickerPanelProps } from "./PickerPanel";

const PickerPanel = lazy(() => import("./PickerPanel"));

export function PickerMount(props: Omit<PickerPanelProps, "mode">) {
	const mode = useFlag("picker");
	if (mode === "off") return null;
	return (
		<Suspense fallback={null}>
			<PickerPanel {...props} mode={mode} />
		</Suspense>
	);
}
