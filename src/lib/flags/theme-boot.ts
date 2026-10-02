// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { BRAND, BRAND_LIGHT } from "#/brand/khipu";
import { storageKey } from "#/lib/ontology/core/storage";

// The pre-paint theme script (routes/__root.tsx inlines it first in <head>, so the page never flashes the
// wrong theme). It lives under flags/ because it reads ?theme= and __RIGI_FLAGS__ itself, before any module
// runs; src/lib/theme/index.ts resolveTheme() is the same precedence and theme.check.ts keeps them equal.
//
// Precedence, first hit wins:
//   1. __RIGI_FLAGS__.theme, then ?theme=, when it is "light" or "dark"
//   2. the saved choice (storage entry `theme`) ("light" | "dark"; absent = auto)
//   3. navigator.webdriver  -> dark (harnesses render dark unless they pass ?theme=light)
//   4. prefers-color-scheme: light -> light
//   5. dark
// A string literal, not fn.toString(), so a bundler cannot rewrite it.

export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,t=null,o=globalThis.__RIGI_FLAGS__,f=o&&o.theme;if(f!=null)f=String(f).trim().toLowerCase();if(f!=="light"&&f!=="dark"){f=null;try{f=new URLSearchParams(location.search).get("theme");if(f!=null)f=f.trim().toLowerCase()}catch(e){}}if(f==="light"||f==="dark")t=f;if(!t){try{var s=localStorage.getItem("${storageKey("theme")}");if(s==="light"||s==="dark")t=s}catch(e){}}if(!t){if(navigator.webdriver)t="dark";else{try{t=globalThis.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){t="dark"}}}d.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"${BRAND_LIGHT.ink}":"${BRAND.ink}")}catch(e){document.documentElement.dataset.theme="dark"}})();`;
