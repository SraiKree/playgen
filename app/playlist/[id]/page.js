import Link from "next/link";

// Stub data — the real version will fetch this playlist by params.id from
// Supabase. Color plates stay until track artwork is wired in.
const PLAYLIST = {
  title: "Midnight Focus",
  generator: "PlayTag · auto",
  trackCount: 25,
  duration: "1h 42m",
  tags: ["Late Night", "Focus", "Electronic"],
  cover: "linear-gradient(135deg, oklch(0.30 0.08 160) 0%, oklch(0.55 0.18 145) 100%)",
  tracks: [
    { n: 1, title: "Solaris Drift", artist: "Etheric Pulse", album: "Nebula Dreams", duration: "4:22" },
    { n: 2, title: "Midnight Syntax", artist: "Code Weaver", album: "Digital Zen", duration: "3:45" },
    { n: 3, title: "Static Bloom", artist: "Low-Fi Flora", album: "Botanical Beats", duration: "5:12" },
    { n: 4, title: "Vapor Trails", artist: "Neon Drifter", album: "After Hours", duration: "2:58" },
    { n: 5, title: "Deep Focus", artist: "The Architect", album: "Foundations", duration: "6:40" },
    { n: 6, title: "Argon Halo", artist: "Tape Hiss", album: "Stations", duration: "4:08" },
    { n: 7, title: "Glass Anchor", artist: "Sundial", album: "Lowlight", duration: "5:31" },
    { n: 8, title: "Tilework", artist: "Marble Index", album: "After-image", duration: "3:12" },
  ],
};

// Plain color plates as track thumbnails until real artwork is wired.
const SWATCHES = [
  "oklch(0.42 0.10 30)",
  "oklch(0.45 0.08 220)",
  "oklch(0.50 0.12 140)",
  "oklch(0.32 0.07 280)",
  "oklch(0.55 0.15 70)",
  "oklch(0.38 0.06 200)",
  "oklch(0.48 0.10 350)",
  "oklch(0.40 0.05 100)",
];

export default async function PlaylistPage({ params }) {
  await params;

  const { title, generator, trackCount, duration, tags, cover, tracks } = PLAYLIST;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <Logomark className="h-5 w-5 text-accent" />
          <span className="text-base font-semibold tracking-tight">PlayTag</span>
        </Link>
        <Link
          href="/create"
          className="text-sm text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          New playlist
        </Link>
      </header>

      {/* Cover spread — cover plate on the left, title + meta + actions on the right */}
      <section className="grid grid-cols-12 gap-6 border-b border-border px-6 py-16 sm:px-12 sm:py-20">
        <div className="col-span-12 sm:col-span-4 lg:col-span-3">
          <div
            aria-hidden
            className="aspect-square w-full rounded-md"
            style={{ background: cover }}
          />
        </div>

        <div className="col-span-12 sm:col-span-8 lg:col-span-9 lg:pl-6">
          <p className="eyebrow text-foreground-subtle">Generated playlist</p>
          <h1 className="mt-2 text-[clamp(2.5rem,7vw,5.5rem)] font-semibold leading-[0.95] tracking-tight">
            {title}
          </h1>
          <p className="mt-3 text-sm text-foreground-muted">
            <span className="text-foreground">{generator}</span>
            <span className="mx-2 text-foreground-subtle">·</span>
            <span className="tabular">{trackCount}</span> tracks
            <span className="mx-2 text-foreground-subtle">·</span>
            <span className="tabular">{duration}</span>
          </p>

          {/* Filter tags */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent"
              >
                {t}
              </span>
            ))}
          </div>

          {/* Actions — Spotify green ONLY on the Spotify save button */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full bg-spotify px-5 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
            >
              <SpotifyMark className="h-4 w-4" />
              Save to Spotify
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-background-elevated px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            >
              <RefreshIcon className="h-4 w-4" />
              Regenerate
            </button>
            <Link
              href="/create"
              className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-background-elevated px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            >
              <EditIcon className="h-4 w-4" />
              Edit tags
            </Link>
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border-strong bg-background-elevated text-foreground-muted transition-colors hover:text-foreground"
              aria-label="More actions"
            >
              <DotsIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      {/* Tracklist */}
      <section className="px-6 py-10 sm:px-12">
        {/* Column header */}
        <div className="grid grid-cols-[36px_1fr_1fr_60px] items-center gap-4 border-b border-border px-3 pb-3 text-foreground-subtle">
          <span className="eyebrow">#</span>
          <span className="eyebrow">Title</span>
          <span className="eyebrow hidden sm:block">Album</span>
          <ClockIcon className="h-4 w-4 justify-self-end" />
        </div>

        <ol className="mt-1">
          {tracks.map((t, i) => (
            <li
              key={t.n}
              className="group grid grid-cols-[36px_1fr_1fr_60px] items-center gap-4 rounded px-3 py-2.5 text-sm transition-colors hover:bg-background-elevated"
            >
              <span className="tabular text-foreground-subtle group-hover:text-accent">
                {t.n}
              </span>
              <div className="flex min-w-0 items-center gap-3">
                <div
                  aria-hidden
                  className="h-10 w-10 flex-shrink-0 rounded"
                  style={{ background: SWATCHES[i % SWATCHES.length] }}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {t.title}
                  </p>
                  <p className="truncate text-xs text-foreground-muted">
                    {t.artist}
                  </p>
                </div>
              </div>
              <p className="hidden truncate text-foreground-muted sm:block">
                {t.album}
              </p>
              <p className="tabular justify-self-end text-xs text-foreground-subtle">
                {t.duration}
              </p>
            </li>
          ))}
        </ol>

        <p className="mt-8 border-t border-border pt-6 text-sm text-foreground-muted">
          Showing {tracks.length} of {trackCount}.{" "}
          <button className="underline underline-offset-4 hover:text-accent">
            Show all
          </button>
        </p>
      </section>

      <footer className="mt-auto border-t border-border px-6 py-5 sm:px-12">
        <div className="flex items-center justify-between text-xs text-foreground-subtle">
          <span>Saved to your Spotify library when you tap save.</span>
          <span>PlayTag</span>
        </div>
      </footer>
    </main>
  );
}

function Logomark({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <line x1="3" y1="9" x2="3" y2="15" />
        <line x1="8" y1="5" x2="8" y2="19" />
        <line x1="13" y1="11" x2="13" y2="13" />
        <line x1="18" y1="3" x2="18" y2="21" />
      </g>
    </svg>
  );
}

function RefreshIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M14 3l7 7-11 11H3v-7L14 3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotsIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function ClockIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpotifyMark({ className }) {
  return (
    <svg viewBox="0 0 168 168" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M83.996.277C37.747.277.253 37.77.253 84.019c0 46.251 37.494 83.741 83.743 83.741 46.254 0 83.744-37.49 83.744-83.741 0-46.246-37.49-83.738-83.745-83.738zm38.404 120.78a5.217 5.217 0 01-7.18 1.73c-19.662-12.01-44.414-14.73-73.564-8.07a5.222 5.222 0 01-6.249-3.93 5.213 5.213 0 013.926-6.25c31.9-7.29 59.263-4.15 81.337 9.34 2.46 1.51 3.24 4.72 1.73 7.18zm10.25-22.805c-1.89 3.075-5.91 4.045-8.98 2.155-22.51-13.839-56.823-17.846-83.448-9.764-3.453 1.043-7.1-.903-8.148-4.35-1.04-3.453.907-7.093 4.354-8.143C84.61 70.292 122.412 74.85 148.34 90.78c3.07 1.89 4.04 5.91 2.155 8.978zm.88-23.744c-26.99-16.031-71.52-17.505-97.289-9.684-4.138 1.255-8.514-1.081-9.768-5.219a7.835 7.835 0 015.221-9.771c29.581-8.98 78.756-7.245 109.83 11.202a7.823 7.823 0 012.74 10.733c-2.2 3.722-7.02 4.949-10.73 2.739z"
      />
    </svg>
  );
}
