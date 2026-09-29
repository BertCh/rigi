import { createFileRoute } from "@tanstack/react-router";
import { BaselinePage } from "#/baseline-ui/BaselinePage";

export const Route = createFileRoute("/baseline")({
	validateSearch: (search: Record<string, unknown>): { sample?: string } =>
		typeof search.sample === "string" ? { sample: search.sample } : {},
	head: () => ({ meta: [{ title: "Georeferencing baseline" }] }),
	component: BaselineRoute,
});

function BaselineRoute() {
	const { sample } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<BaselinePage
			sample={sample}
			onSampleChange={(name) =>
				navigate({ search: name ? { sample: name } : {}, replace: true })
			}
		/>
	);
}
