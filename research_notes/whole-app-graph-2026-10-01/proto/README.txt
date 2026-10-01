Typecheck-only sketches (2026-10-01), renamed to .txt so the repo tsc (include **/*.ts) skips them.
To typecheck them, copy them to a scratch dir, drop the .txt suffix, and run npx tsc --noEmit -p tsconfig.json against this repo's node_modules.
The WGSL is unvalidated. Neither sketch has run on a GPU. See ../upstream-api.md §8.
