// Inngest client. One instance per app, shared by both the serve endpoint
// (which registers functions with the Inngest dev/cloud server) and any
// server-side code that needs to send events (server actions, route handlers).
//
// In local dev: set INNGEST_DEV=1 so the SDK talks to the local dev server
// (default http://localhost:8288) and skips signature verification.
// Without it, the SDK defaults to Cloud mode and the serve endpoint will
// return 500 ("In cloud mode but no signing key found").
//
// In production: leave INNGEST_DEV unset and provide INNGEST_EVENT_KEY +
// INNGEST_SIGNING_KEY (the SDK reads them from process.env automatically).

import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "playgen" });
