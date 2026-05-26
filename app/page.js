import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { LoginButton } from "@/components/login-button";
import { LogoutButton } from "@/components/logout-button";

export default async function Home({ searchParams }) {
  const params = await searchParams;
  const authError = params?.auth_error;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const displayName = user?.user_metadata?.full_name || user?.email;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <Logomark className="h-5 w-5 text-accent" />
          <span className="text-base font-semibold tracking-tight">PlayTag</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <a
            href="#how"
            className="hidden text-foreground-muted underline-offset-4 hover:text-foreground hover:underline sm:inline"
          >
            How it works
          </a>
          {user ? (
            <div className="flex items-center gap-4">
              <Link
                href="/library"
                className="text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
              >
                Library
              </Link>
              <span className="hidden text-foreground-muted sm:inline">
                {displayName}
              </span>
              <LogoutButton />
            </div>
          ) : (
            <LoginButton />
          )}
        </nav>
      </header>

      {/* Hero — short, direct, asymmetric 5/7 grid. No glow, no halo, no nested card. */}
      <section className="grid grid-cols-12 gap-6 px-6 py-20 sm:px-12 sm:py-28">
        <div className="col-span-12 lg:col-span-7">
          <h1 className="text-[clamp(3rem,8vw,7rem)] font-semibold leading-[0.95] tracking-tight">
            Tags in.
            <br />
            <span className="display-italic text-accent">A playlist</span> out.
          </h1>
          <p className="mt-8 max-w-md text-base text-foreground-muted">
            Type a mood, a genre, or what you&rsquo;re doing. PlayTag scans your
            saved tracks and assembles a Spotify playlist that fits. Most runs
            finish under a minute.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
            {user ? (
              <Link
                href="/create"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:brightness-110"
              >
                Start a playlist
                <span aria-hidden>→</span>
              </Link>
            ) : (
              <LoginButton />
            )}
            <a
              href="#how"
              className="text-sm text-foreground-muted underline underline-offset-4 hover:text-foreground"
            >
              How it works
            </a>
          </div>
        </div>

        {/* Right column: a quiet stat block, no cards, no avatars-strip cliché */}
        <aside className="col-span-12 mt-12 lg:col-span-5 lg:mt-0 lg:pl-8">
          <dl className="grid grid-cols-2 gap-8 border-l border-border pl-6 sm:gap-12">
            <Stat label="Curators using it" value="12,073" />
            <Stat label="Median time to playlist" value="48s" />
            <Stat label="Tracks tagged by users" value="284k" />
            <Stat label="Made this week" value="3,420" />
          </dl>
        </aside>
      </section>

      {/* How it works — three numbered lines, no cards, no icons */}
      <section id="how" className="border-t border-border px-6 py-20 sm:px-12">
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-4">
            <p className="eyebrow text-foreground-subtle">How it works</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Three steps,
              <br />
              about a minute.
            </h2>
          </div>
          <ol className="col-span-12 flex flex-col gap-px bg-border lg:col-span-8">
            <Step
              n="01"
              title="Tag your mood"
              body="A few words is plenty. &ldquo;Rainy Sunday jazz&rdquo;, &ldquo;gym warm-up&rdquo;, &ldquo;late-night coding&rdquo;. Loose descriptions outperform precise ones."
            />
            <Step
              n="02"
              title="We scan your library"
              body="Each tag is matched against your saved tracks across theme, tempo, era and energy. The community-built tag layer fills the long tail Spotify won't."
            />
            <Step
              n="03"
              title="Save to Spotify"
              body="A 25–30 track playlist lands in your Spotify library, named for the mood. Regenerate any time — your library only gets richer."
            />
          </ol>
        </div>
      </section>

      {/* Closing CTA — single line, single action, no separate "card" container */}
      <section className="border-t border-border px-6 py-24 sm:px-12">
        <div className="grid grid-cols-12 items-end gap-6">
          <div className="col-span-12 lg:col-span-8">
            <h2 className="text-[clamp(2rem,5vw,4rem)] font-semibold leading-[1.02] tracking-tight">
              Stop scrolling.{" "}
              <span className="display-italic text-accent">Make the playlist</span>{" "}
              instead.
            </h2>
          </div>
          <div className="col-span-12 flex flex-col items-start gap-3 lg:col-span-4 lg:items-end">
            {user ? (
              <Link
                href="/create"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:brightness-110"
              >
                Start a playlist
                <span aria-hidden>→</span>
              </Link>
            ) : (
              <LoginButton />
            )}
            <p className="text-xs text-foreground-subtle">
              Free. Connects with Spotify in two taps. Your library, your data.
            </p>
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t border-border px-6 py-6 sm:px-12">
        <div className="flex flex-col items-center justify-between gap-3 text-xs text-foreground-subtle sm:flex-row">
          <div className="flex items-center gap-2.5">
            <Logomark className="h-4 w-4 text-accent" />
            <span>© 2026 PlayTag</span>
          </div>
          <div className="flex gap-6">
            <a href="#" className="underline-offset-4 hover:text-foreground hover:underline">
              Privacy
            </a>
            <a href="#" className="underline-offset-4 hover:text-foreground hover:underline">
              Terms
            </a>
            <a href="#" className="underline-offset-4 hover:text-foreground hover:underline">
              Contact
            </a>
          </div>
        </div>
      </footer>

      {authError && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded border border-accent/40 bg-background-elevated px-4 py-2 text-sm text-accent shadow-lg">
          Couldn&rsquo;t finish sign-in: {authError}
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <dt className="eyebrow text-foreground-subtle">{label}</dt>
      <dd className="mt-2 tabular text-3xl font-semibold tracking-tight sm:text-4xl">
        {value}
      </dd>
    </div>
  );
}

function Step({ n, title, body }) {
  return (
    <li className="flex items-baseline gap-6 bg-background p-6 transition-colors hover:bg-background-elevated sm:gap-8 sm:p-8">
      <span className="tabular text-2xl font-semibold text-foreground-subtle sm:text-3xl">
        {n}
      </span>
      <div className="flex-1">
        <h3 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground-muted sm:text-base">
          {body}
        </p>
      </div>
    </li>
  );
}

function Logomark({ className = "h-5 w-5" }) {
  // Audio-bars mark — reads as music without being a literal speaker icon.
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
