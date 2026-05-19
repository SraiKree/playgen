// Inngest's HTTP transport for this Next.js app. The Inngest dev server
// (and cloud) discovers our functions by hitting this endpoint:
//
//   PUT  /api/inngest  — sync probe: "what functions do you expose?"
//   POST /api/inngest  — invoke a specific step
//   GET  /api/inngest  — introspection / health
//
// The path MUST be /api/inngest for auto-discovery to work (the CLI scans
// common ports for that exact path). If you ever rename it, you'll need to
// pass `-u http://localhost:3000/your/path` to `inngest-cli dev`.

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { librarySync } from "@/lib/inngest/functions/library-sync";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [librarySync],
});
