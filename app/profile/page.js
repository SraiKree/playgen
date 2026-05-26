import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfilePageData, rankForXp, popularityDescriptor } from "@/lib/profile";
import { LogoutButton } from "@/components/logout-button";

export default async function ProfilePage() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/?auth_error=signin_required");

    const data = await getProfilePageData(supabase, user.id);
    const { overview, genres, tags, decades, xp, contribution } = data;

    const displayName = user.user_metadata?.full_name || user.email || "You";
    const firstName = String(displayName).trim().split(/\s+/)[0];
    const hasLibrary = overview.trackCount > 0;

    const rank = rankForXp(xp.total);
    const taste = buildTasteSentence({ genres, decades, overview });

    return (
        <main className="flex min-h-screen flex-col">
            <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-12">
                <Link href="/" className="flex items-center gap-2.5">
                    <Logomark className="h-5 w-5 text-accent" />
                    <span className="text-base font-semibold tracking-tight">
                        PlayTag
                    </span>
                </Link>
                <nav className="flex items-center gap-5 text-sm sm:gap-6">
                    <Link
                        href="/library"
                        className="text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
                    >
                        Library
                    </Link>
                    <Link
                        href="/create"
                        className="text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
                    >
                        New playlist
                    </Link>
                    <LogoutButton />
                </nav>
            </header>

            {/* Masthead — name, the synthesized taste line, headline figures. */}
            <section className="border-b border-border px-6 py-14 sm:px-12 sm:py-20">
                <div className="grid grid-cols-12 gap-y-10 gap-x-6">
                    <div className="col-span-12 lg:col-span-7">
                        <p className="eyebrow text-foreground-subtle">
                            Listening dossier
                        </p>
                        <h1 className="display mt-4 text-[clamp(2.5rem,7vw,5.25rem)]">
                            {firstName}&rsquo;s
                            <br />
                            <span className="display-italic text-accent">
                                taste, on record
                            </span>
                        </h1>
                        {hasLibrary ? (
                            <p className="mt-7 max-w-xl text-lg leading-relaxed text-foreground-muted">
                                {taste}
                            </p>
                        ) : (
                            <p className="mt-7 max-w-xl text-lg leading-relaxed text-foreground-muted">
                                Your dossier is empty. Save songs on Spotify and
                                let PlayTag finish a sync — the read on your taste
                                builds itself from what lands in your library.
                            </p>
                        )}
                    </div>

                    {hasLibrary && (
                        <aside className="col-span-12 lg:col-span-5 lg:pl-10">
                            <dl className="grid grid-cols-3 gap-6 border-t border-border pt-6 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
                                <Figure
                                    label="Tracks"
                                    value={overview.trackCount.toLocaleString()}
                                />
                                <Figure
                                    label="Artists"
                                    value={overview.artistCount.toLocaleString()}
                                />
                                <Figure
                                    label="Hours"
                                    value={formatHours(overview.totalDurationMs)}
                                />
                            </dl>
                        </aside>
                    )}
                </div>
            </section>

            {hasLibrary && (
                <>
                    {/* Genres — ranked with proportional weight bars. */}
                    <Section
                        label="What you reach for"
                        note="Spotify genres across every artist in your library, by frequency."
                    >
                        {genres.length === 0 ? (
                            <Quiet>
                                No genre data yet — enrichment may still be
                                running for these artists.
                            </Quiet>
                        ) : (
                            <ol className="space-y-px">
                                {genres.map((g, i) => {
                                    const max = genres[0].count || 1;
                                    const pct = Math.max(
                                        6,
                                        (g.count / max) * 100,
                                    );
                                    return (
                                        <li
                                            key={g.genre}
                                            className="rise group relative flex items-center gap-4 py-3"
                                            style={{ "--delay": `${i * 45}ms` }}
                                        >
                                            <span className="tabular w-7 shrink-0 text-sm text-foreground-subtle">
                                                {String(i + 1).padStart(2, "0")}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline justify-between gap-4">
                                                    <span className="truncate text-base font-medium capitalize text-foreground">
                                                        {g.genre}
                                                    </span>
                                                    <span className="tabular shrink-0 text-xs text-foreground-subtle">
                                                        {g.count}
                                                    </span>
                                                </div>
                                                <div className="mt-2 h-px w-full bg-border">
                                                    <div
                                                        className="h-px bg-accent transition-[width]"
                                                        style={{
                                                            width: `${pct}%`,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </Section>

                    {/* Sonic signature — tag cloud sized by summed Last.fm weight. */}
                    <Section
                        label="Sonic signature"
                        note="Last.fm descriptors, sized by how strongly they recur."
                    >
                        {tags.length === 0 ? (
                            <Quiet>No Last.fm tags captured for your tracks yet.</Quiet>
                        ) : (
                            <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                                {tags.map((t, i) => {
                                    const max = tags[0].weight || 1;
                                    const min = tags[tags.length - 1].weight || 0;
                                    const span = Math.max(1, max - min);
                                    const size =
                                        0.95 + ((t.weight - min) / span) * 1.55;
                                    return (
                                        <li
                                            key={t.tag}
                                            className="rise leading-tight"
                                            style={{ "--delay": `${i * 35}ms` }}
                                        >
                                            <span
                                                className={`lowercase ${
                                                    i === 0
                                                        ? "display-italic text-accent"
                                                        : i < 4
                                                          ? "text-foreground"
                                                          : "text-foreground-muted"
                                                }`}
                                                style={{
                                                    fontSize: `${size.toFixed(2)}rem`,
                                                }}
                                            >
                                                {t.tag}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Section>

                    {/* Eras + mainstream/underground axis, side by side on wide. */}
                    <Section
                        label="Where it lives"
                        note="The decades you collect from, and how far off-centre your taste sits."
                    >
                        <div className="grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-2">
                            <div>
                                <p className="eyebrow mb-5 text-foreground-subtle">
                                    By decade
                                </p>
                                {decades.length === 0 ? (
                                    <Quiet>No release dates on file.</Quiet>
                                ) : (
                                    <div className="flex h-32 items-end gap-2">
                                        {decades.map((d, i) => {
                                            const max = Math.max(
                                                ...decades.map((x) => x.count),
                                            );
                                            const h = Math.max(
                                                4,
                                                (d.count / max) * 100,
                                            );
                                            return (
                                                <div
                                                    key={d.decade}
                                                    className="rise flex flex-1 flex-col items-center justify-end gap-2"
                                                    style={{
                                                        "--delay": `${i * 50}ms`,
                                                    }}
                                                >
                                                    <span className="tabular text-[10px] text-foreground-subtle">
                                                        {d.count}
                                                    </span>
                                                    <div
                                                        className="w-full bg-accent-soft"
                                                        style={{
                                                            height: `${h}%`,
                                                        }}
                                                    >
                                                        <div className="h-1 w-full bg-accent" />
                                                    </div>
                                                    <span className="tabular text-xs text-foreground-muted">
                                                        {decadeLabel(d.decade)}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div>
                                <p className="eyebrow mb-5 text-foreground-subtle">
                                    Mainstream &harr; Underground
                                </p>
                                <div className="relative mt-9 h-px w-full bg-border-strong">
                                    <div
                                        className="absolute -top-1.5 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-accent bg-background"
                                        style={{
                                            left: `${clamp(overview.avgPopularity)}%`,
                                        }}
                                    />
                                </div>
                                <div className="mt-3 flex justify-between text-xs text-foreground-subtle">
                                    <span>Underground</span>
                                    <span>Mainstream</span>
                                </div>
                                <p className="mt-6 max-w-sm text-sm leading-relaxed text-foreground-muted">
                                    Average popularity{" "}
                                    <span className="tabular text-foreground">
                                        {Math.round(overview.avgPopularity)}
                                    </span>
                                    /100 — you sit in{" "}
                                    <span className="text-foreground">
                                        {popularityDescriptor(
                                            overview.avgPopularity,
                                        )}
                                    </span>
                                    .
                                </p>
                            </div>
                        </div>
                    </Section>
                </>
            )}

            {/* Standing — the XP payoff. Boldest moment on the page. */}
            <section className="px-6 py-16 sm:px-12 sm:py-20">
                <div className="grid grid-cols-12 gap-y-10 gap-x-6">
                    <div className="col-span-12 lg:col-span-4">
                        <p className="eyebrow text-foreground-subtle">Standing</p>
                        <p className="mt-4 max-w-xs text-sm leading-relaxed text-foreground-muted">
                            XP comes from tagging. Plant a tag and earn when
                            others vote on it — and earn for voting yourself.
                        </p>
                    </div>

                    <div className="col-span-12 lg:col-span-8">
                        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
                            <span className="display text-[clamp(3.5rem,12vw,7rem)] text-foreground">
                                {xp.total.toLocaleString()}
                            </span>
                            <span className="eyebrow mb-3 text-accent">
                                XP
                            </span>
                        </div>

                        <div className="mt-6 max-w-md">
                            <div className="flex items-baseline justify-between">
                                <span className="display-italic text-2xl text-accent">
                                    {rank.name}
                                </span>
                                {rank.next && (
                                    <span className="text-xs text-foreground-subtle">
                                        <span className="tabular text-foreground-muted">
                                            {rank.toNext}
                                        </span>{" "}
                                        to {rank.next.name}
                                    </span>
                                )}
                            </div>
                            <div className="mt-3 h-1 w-full bg-border">
                                <div
                                    className="h-1 bg-accent"
                                    style={{
                                        width: `${Math.round(rank.progress * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>

                        <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8 border-t border-border pt-8 sm:grid-cols-4">
                            <Figure
                                label="From your tags"
                                value={signed(xp.asAuthor)}
                            />
                            <Figure
                                label="From voting"
                                value={signed(xp.asVoter)}
                            />
                            <Figure
                                label="Tags planted"
                                value={contribution.submitted.toLocaleString()}
                            />
                            <Figure
                                label="Graduated"
                                value={contribution.graduated.toLocaleString()}
                            />
                        </dl>

                        {xp.total === 0 && contribution.submitted === 0 && (
                            <p className="mt-8 max-w-md text-sm leading-relaxed text-foreground-muted">
                                Nothing earned yet.{" "}
                                <Link
                                    href="/library"
                                    className="text-accent underline-offset-4 hover:underline"
                                >
                                    Open your library
                                </Link>{" "}
                                and tag a track to get on the board.
                            </p>
                        )}
                    </div>
                </div>
            </section>

            <footer className="mt-auto border-t border-border px-6 py-5 sm:px-12">
                <div className="flex items-center justify-between text-xs text-foreground-subtle">
                    <span>Your taste, read from the tracks you keep.</span>
                    <span>PlayTag</span>
                </div>
            </footer>
        </main>
    );
}

// --- presentational pieces ------------------------------------------------

function Section({ label, note, children }) {
    return (
        <section className="border-b border-border px-6 py-14 sm:px-12 sm:py-16">
            <div className="grid grid-cols-12 gap-y-6 gap-x-6">
                <div className="col-span-12 lg:col-span-3">
                    <h2 className="text-xl font-semibold tracking-tight text-foreground">
                        {label}
                    </h2>
                    {note && (
                        <p className="mt-2 max-w-[15rem] text-sm leading-relaxed text-foreground-subtle">
                            {note}
                        </p>
                    )}
                </div>
                <div className="col-span-12 lg:col-span-9 lg:pl-6">
                    {children}
                </div>
            </div>
        </section>
    );
}

function Figure({ label, value }) {
    return (
        <div>
            <dt className="eyebrow text-foreground-subtle">{label}</dt>
            <dd className="mt-2 tabular text-3xl font-semibold tracking-tight">
                {value}
            </dd>
        </div>
    );
}

function Quiet({ children }) {
    return <p className="text-sm text-foreground-muted">{children}</p>;
}

// --- pure helpers ---------------------------------------------------------

function buildTasteSentence({ genres, decades, overview }) {
    const top = genres[0]?.genre;
    const dominantDecade = decades.length
        ? decades.reduce((a, b) => (b.count > a.count ? b : a))
        : null;
    const parts = [];
    if (top) parts.push(`You lean ${top}`);
    if (dominantDecade)
        parts.push(`anchored in the ${decadeLabel(dominantDecade.decade)}`);
    parts.push(popularityDescriptor(overview.avgPopularity));
    return parts.join(", ") + ".";
}

function decadeLabel(decade) {
    return `${String(decade).slice(2)}s`;
}

function formatHours(ms) {
    const hours = Math.round(ms / 3_600_000);
    return hours > 0 ? hours.toLocaleString() : "—";
}

function clamp(n) {
    return Math.min(100, Math.max(0, Number(n) || 0));
}

function signed(n) {
    const v = Number(n) || 0;
    return v > 0 ? `+${v.toLocaleString()}` : v.toLocaleString();
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
