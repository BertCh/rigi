#!/bin/sh
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
#
# Width variants (640/1024/1440 JPEG) of the landing page's hero and story images, written to
# public/demo/w/<name>-<width>.jpg. Needs macOS `sips` (no WebP/AVIF encoder is assumed).
set -e
cd "$(dirname "$0")/../.."
for src in photos/demo-09 shots/hero photos/demo-01 shots/demo-01-overlay; do
	name=$(basename "$src")
	for w in 640 1024 1440; do
		sips --resampleWidth "$w" -s format jpeg -s formatOptions 80 \
			"public/demo/$src.jpg" --out "public/demo/w/$name-$w.jpg" >/dev/null
	done
done
