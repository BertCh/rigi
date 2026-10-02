// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {defineConfig} from 'vite';

export default defineConfig({
  base: './',
  // The shared example support files live two directories up, outside this package root.
  server: {fs: {allow: ['../..']}},
  build: {target: 'esnext'}
});
