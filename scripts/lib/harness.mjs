// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared defaults of the browser harnesses under scripts/. Start the app with `npm run dev` (:3100);
// point a harness at another server with APP_URL=http://localhost:<port> or its --url flag.
export const APP_URL = process.env.APP_URL ?? "http://localhost:3100";
