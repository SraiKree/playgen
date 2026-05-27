// The path MUST be /api/inngest for auto-discovery to work (the CLI scans
// common ports for that exact path). If you ever rename it, you'll need to
// pass `-u http://localhost:3000/your/path` to `inngest-cli dev`.

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { librarySync } from "@/lib/inngest/functions/library-sync";
import { trackEnrich } from "@/lib/inngest/functions/track-enrich";
import { trackEnrichCron } from "@/lib/inngest/functions/track-enrich-cron";
import { trackEnrichWikidata } from "@/lib/inngest/functions/track-enrich-wikidata";
import { trackEnrichWikidataCron } from "@/lib/inngest/functions/track-enrich-wikidata-cron";
import { artistEnrich } from "@/lib/inngest/functions/artist-enrich";
import { artistEnrichCron } from "@/lib/inngest/functions/artist-enrich-cron";
import { trackEnrichDeezerCron } from "@/lib/inngest/functions/track-enrich-deezer-cron";
import { trackEnrichItunesCron } from "@/lib/inngest/functions/track-enrich-itunes-cron";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    librarySync,
    trackEnrich,
    trackEnrichCron,
    trackEnrichWikidata,
    trackEnrichWikidataCron,
    artistEnrich,
    artistEnrichCron,
    trackEnrichDeezerCron,
    trackEnrichItunesCron,
  ],
});
