import { FileCode2, FileText } from "lucide-react";
import { cn } from "#/lib/utils";

/** A repo path as a code chip. Paths under reports/ or ending .md get a document glyph. */
export function CodeRef({
	path,
	className,
	children,
}: {
	path: string;
	className?: string;
	children?: string;
}) {
	const doc = path.endsWith(".md") || path.startsWith("reports/");
	const Icon = doc ? FileText : FileCode2;
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 font-mono text-[11.5px] leading-none text-white/70 ring-1 ring-white/8",
				className,
			)}
			title={path}
		>
			<Icon
				className="size-3 shrink-0 text-[var(--accent)]"
				strokeWidth={1.6}
			/>
			<span className="truncate">{children ?? path}</span>
		</span>
	);
}
