// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The standalone luma.gl / deck.gl examples under examples/ (see examples/README.md). Each example is a folder
// with its own package.json, laid out like luma.gl's examples/, but resolving packages from the root install
// (luma.gl runs them as yarn workspaces; we keep one lockfile).
//
//   node scripts/examples.mjs list
//   node scripts/examples.mjs start deck/summit-view      vite dev server for one example
//   node scripts/examples.mjs build [id…]                 tsc -p + vite build into out/examples/<id> (all by default)
//   node scripts/examples.mjs check [id…]                 tsc -p only (CI fast tier: no browser, no network)
//   node scripts/examples.mjs smoke [id…]                 scripts/visual-smoke.mjs, under the machine-wide render lock
//   node scripts/examples.mjs site                        build every example into out/examples-site/<id>/ plus a
//                                                         gallery index.html (title + blurb from each README, backends
//                                                         from mobile-support.ts, thumbnail.jpg), like luma.gl's
//                                                         website examples page. Static: serve the folder anywhere.

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = join(root, "examples");

function findExamples(directory = examplesRoot) {
	const found = [];
	for (const name of readdirSync(directory)) {
		if (name === "node_modules" || name === "dist") continue;
		const path = join(directory, name);
		if (!statSync(path).isDirectory()) continue;
		if (existsSync(join(path, "package.json")))
			found.push(relative(examplesRoot, path));
		else found.push(...findExamples(path));
	}
	return found.sort();
}

/** Title, blurb, backends and thumbnail of one example, read from the files every example already has. */
function describeExample(id) {
	const directory = join(examplesRoot, id);
	const readme = readFileSync(join(directory, "README.md"), "utf8");
	const title = readme.match(/^# (.+)$/m)?.[1] ?? id;
	const blurb =
		readme
			.split(/\n\s*\n/)
			.find((paragraph) => paragraph.trim() && !/^[#<]/.test(paragraph.trim()))
			?.replace(/\s+/g, " ")
			.replace(/`/g, "")
			.trim() ?? "";
	const support = existsSync(join(directory, "mobile-support.ts"))
		? readFileSync(join(directory, "mobile-support.ts"), "utf8")
		: "";
	const backends = (support.match(/backends:\s*\[([^\]]*)\]/)?.[1] ?? "")
		.match(/'([^']+)'/g)
		?.map((backend) => backend.replace(/'/g, "")) ?? ["webgpu", "webgl2"];
	const thumbnail = existsSync(join(directory, "thumbnail.jpg"))
		? "thumbnail.jpg"
		: null;
	return { id, title, blurb, backends, thumbnail };
}

const escapeHtml = (text) =>
	text.replace(
		/[&<>"]/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
	);

function writeGallery(outputDirectory, examples) {
	const cards = examples
		.map(
			({
				id,
				title,
				blurb,
				backends,
				thumbnail,
			}) => `      <a class="card" href="./${id}/">
        ${thumbnail ? `<img src="./${id}/${thumbnail}" alt="" loading="lazy" />` : '<div class="placeholder"></div>'}
        <div class="body">
          <div class="eyebrow">${escapeHtml(id.split("/")[0].toUpperCase())} · ${backends.map((backend) => (backend === "webgpu" ? "WebGPU" : "WebGL2")).join(" + ")}</div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(blurb)}</p>
        </div>
      </a>`,
		)
		.join("\n");
	writeFileSync(
		join(outputDirectory, "index.html"),
		`<!doctype html>
<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rigi examples · luma.gl + deck.gl</title>
    <style>
      :root { color-scheme: dark; --bg: #0b1016; --card: #141c25; --line: #243140; --text: #e6edf3; --muted: #93a4b5; --accent: #8fd3c1; }
      body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
      header { max-width: 1100px; margin: 0 auto; padding: 48px 16px 8px; }
      header .eyebrow { color: var(--accent); letter-spacing: .12em; font-size: 12px; }
      h1 { margin: 4px 0 8px; font-size: 32px; }
      header p { color: var(--muted); max-width: 720px; }
      main { max-width: 1100px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
      .card { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; color: inherit; text-decoration: none; }
      .card:hover { border-color: var(--accent); }
      .card img, .placeholder { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; background: #1c2733; display: block; }
      .body { padding: 12px 14px 16px; }
      .body .eyebrow { color: var(--accent); font-size: 11px; letter-spacing: .1em; }
      .body h2 { margin: 4px 0 6px; font-size: 18px; }
      .body p { margin: 0; color: var(--muted); font-size: 14px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
      footer { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; color: var(--muted); font-size: 13px; }
      footer a { color: var(--accent); }
    </style>
  </head>
  <body>
    <header>
      <div class="eyebrow">LUMA.GL + DECK.GL</div>
      <h1>Rigi examples</h1>
      <p>Standalone examples distilled from Rigi, which matches mountain photos to terrain. They run on luma.gl 10 with WebGPU, with WebGL2 where the example supports it.</p>
    </header>
    <main>
${cards}
    </main>
    <footer>Terrain © <a href="https://mapterhorn.com">Mapterhorn</a> (swisstopo, Copernicus) · Peaks © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Code MIT, see LICENSE and NOTICE.md.</footer>
  </body>
</html>
`,
	);
}

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		cwd: root,
		...options,
	});
	return result.status ?? 1;
}

const [action = "list", ...requested] = process.argv.slice(2);
const all = findExamples();
const unknown = requested.filter((id) => !all.includes(id));
if (unknown.length) {
	console.error(
		`unknown example(s): ${unknown.join(", ")}; have: ${all.join(", ")}`,
	);
	process.exit(2);
}
const selected = requested.length ? requested : all;

let failures = 0;
switch (action) {
	case "list":
		for (const id of all) console.log(id);
		break;
	case "start": {
		if (selected.length !== 1) {
			console.error("start takes exactly one example id");
			process.exit(2);
		}
		process.exit(run("npx", ["vite", join("examples", selected[0])]));
		break;
	}
	case "check":
	case "build":
		for (const id of selected) {
			const directory = join("examples", id);
			failures += run("npx", ["tsc", "--noEmit", "-p", directory]) ? 1 : 0;
			if (action === "build")
				failures += run("npx", [
					"vite",
					"build",
					directory,
					"--outDir",
					join(root, "out", "examples", id),
					"--emptyOutDir",
				])
					? 1
					: 0;
		}
		break;
	case "smoke":
		for (const id of selected) {
			const script = join("examples", id, "scripts", "visual-smoke.mjs");
			if (!existsSync(join(root, script))) {
				console.log(`${id}: no scripts/visual-smoke.mjs, skipped`);
				continue;
			}
			failures += run("node", [
				"scripts/gpu/with-render-lock.mjs",
				"--",
				"node",
				script,
			])
				? 1
				: 0;
		}
		break;
	case "site": {
		const outputDirectory = join(root, "out", "examples-site");
		mkdirSync(outputDirectory, { recursive: true });
		const described = [];
		for (const id of selected) {
			const directory = join("examples", id);
			const target = join(outputDirectory, id);
			const status = run("npx", [
				"vite",
				"build",
				directory,
				"--outDir",
				target,
				"--emptyOutDir",
			]);
			if (status) {
				failures++;
				continue;
			}
			const example = describeExample(id);
			if (example.thumbnail)
				copyFileSync(
					join(examplesRoot, id, example.thumbnail),
					join(target, example.thumbnail),
				);
			described.push(example);
		}
		writeGallery(outputDirectory, described);
		console.log(
			`gallery: ${join(outputDirectory, "index.html")} (${described.length} examples)`,
		);
		const photos = described.filter(({ id }) =>
			readdirSync(join(examplesRoot, id)).some(
				(name) => name.endsWith(".jpg") && name !== "thumbnail.jpg",
			),
		);
		if (photos.length)
			console.log(
				`note: ${photos.map(({ id }) => id).join(", ")} bundle a local photo; photos are not licensed for publishing yet (NOTICE.md)`,
			);
		break;
	}
	default:
		console.error(
			`unknown action ${action}: list | start | build | check | smoke | site`,
		);
		process.exit(2);
}
if (failures) {
	console.error(`${failures} step(s) failed`);
	process.exit(1);
}
