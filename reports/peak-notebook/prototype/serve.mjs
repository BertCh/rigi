// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Static server for the prototype: the page from this folder, /demo/** from public/.
// node reports/peak-notebook/prototype/serve.mjs  →  http://127.0.0.1:3277/?theme=day|night|split
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const HERE = new URL("./", import.meta.url).pathname;
const PUBLIC = new URL("../../../public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".css": "text/css", ".woff2": "font/woff2" };
http
	.createServer((req, res) => {
		const url = decodeURIComponent(req.url.split("?")[0]);
		const file = /^\/(demo|fonts)\//.test(url) ? path.join(PUBLIC, url) : path.join(HERE, url === "/" ? "index.html" : url);
		fs.readFile(file, (err, body) => {
			if (err) return res.writeHead(404).end();
			res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
		});
	})
	.listen(3277, "127.0.0.1", () => console.log("http://127.0.0.1:3277/sheet.html?theme=plate&title=namedek  ·  /index.html"));
