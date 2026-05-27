import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserSavedTracks, getLayer1TagsForTracks } from "@/lib/user-library";
import { getCommunityTagsForTracks, getSuggestedTagsForTracks } from "@/lib/community";
import { LibraryTrackRow } from "@/components/library-track-row";
import { LogoutButton } from "@/components/logout-button";

// Page size matches getUserSavedTracks' default; tweaking here cascades. We
// load 50 rows per page — enough to scroll without paging often, small enough
// to keep the community-tags batched fetch under a single round trip.
const PAGE_SIZE = 50;

export default async function LibraryPage({ searchParams }) {
    const params = await searchParams;
    const requestedPage = Number.parseInt(params?.page ?? "1", 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const offset = (page - 1) * PAGE_SIZE;

    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        // /library is auth-only — bounce unauthenticated visitors back to the
        // landing page where they can sign in.
        redirect("/?auth_error=signin_required");
    }

    const { tracks, totalCount } = await getUserSavedTracks(supabase, {
        userId: user.id,
        limit: PAGE_SIZE,
        offset,
    });

    // Two parallel batched queries for the visible page: community tags
    // (Layer 2) and the Layer 1 reference tags (Last.fm + Wikidata). Each
    // returns a Map keyed by track_id; the row component falls back to empty
    // structures when a track is absent.
    const trackIds = tracks.map((t) => t.trackId);
    const [communityTagsByTrack, suggestedTagsByTrack, layer1TagsByTrack] =
        await Promise.all([
            getCommunityTagsForTracks(supabase, {
                trackIds,
                currentUserId: user.id,
                threshold: 2,
            }),
            getSuggestedTagsForTracks(supabase, {
                trackIds,
                currentUserId: user.id,
                threshold: 2,
            }),
            getLayer1TagsForTracks(supabase, trackIds),
        ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const displayName = user.user_metadata?.full_name || user.email;

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
                        href="/create"
                        className="text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
                    >
                        New playlist
                    </Link>
                    <Link
                        href="/profile"
                        className="hidden text-foreground-muted underline-offset-4 hover:text-foreground hover:underline sm:inline"
                    >
                        {displayName}
                    </Link>
                    <LogoutButton />
                </nav>
            </header>

            <section className="border-b border-border px-6 py-14 sm:px-12 sm:py-16">
                <div className="grid grid-cols-12 gap-6">
                    <div className="col-span-12 lg:col-span-7">
                        <p className="eyebrow text-foreground-subtle">
                            Your library
                        </p>
                        <h1 className="mt-3 text-[clamp(2rem,5vw,3.75rem)] font-semibold leading-[1.02] tracking-tight">
                            Tag what fits.
                        </h1>
                        <p className="mt-4 max-w-md text-sm text-foreground-muted">
                            Sorted by each track&rsquo;s dominant Last.fm tag,
                            so genre-adjacent tracks land near each other. Open
                            a row to see all reference tags and to add or vote
                            on community tags — a community tag needs a score
                            of{" "}
                            <span className="tabular text-foreground">2</span>{" "}
                            before it joins the playlist pool.
                        </p>
                    </div>

                    <aside className="col-span-12 mt-8 lg:col-span-5 lg:mt-0 lg:pl-8">
                        <dl className="grid grid-cols-2 gap-8 border-l border-border pl-6">
                            <Stat
                                label="Saved tracks"
                                value={totalCount.toLocaleString()}
                            />
                            <Stat label="Showing" value={tracks.length} />
                        </dl>
                    </aside>
                </div>
            </section>

            <section className="px-6 py-10 sm:px-12">
                {tracks.length === 0 ? (
                    <EmptyState />
                ) : (
                    <ul className="border border-border bg-background-elevated">
                        {tracks.map((t) => (
                            <LibraryTrackRow
                                key={t.trackId}
                                track={t}
                                communityTags={
                                    communityTagsByTrack.get(t.trackId) ?? []
                                }
                                suggestedTags={
                                    suggestedTagsByTrack.get(t.trackId) ?? []
                                }
                                layer1Tags={
                                    layer1TagsByTrack.get(t.trackId) ?? {
                                        lastfm: [],
                                        wikidata: [],
                                        artist: [],
                                    }
                                }
                                currentUserId={user.id}
                            />
                        ))}
                    </ul>
                )}

                {totalPages > 1 && (
                    <nav
                        aria-label="Library pagination"
                        className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-sm"
                    >
                        <div className="text-foreground-muted">
                            Page{" "}
                            <span className="tabular text-foreground">
                                {page}
                            </span>{" "}
                            of{" "}
                            <span className="tabular">{totalPages}</span>
                        </div>
                        <div className="flex gap-3">
                            <PaginationLink
                                href={`/library?page=${page - 1}`}
                                disabled={page <= 1}
                            >
                                ← Previous
                            </PaginationLink>
                            <PaginationLink
                                href={`/library?page=${page + 1}`}
                                disabled={page >= totalPages}
                            >
                                Next →
                            </PaginationLink>
                        </div>
                    </nav>
                )}
            </section>

            <footer className="mt-auto border-t border-border px-6 py-5 sm:px-12">
                <div className="flex items-center justify-between text-xs text-foreground-subtle">
                    <span>
                        Tags you add become part of the public, community-built
                        playlist signal.
                    </span>
                    <span>PlayTag</span>
                </div>
            </footer>
        </main>
    );
}

function Stat({ label, value }) {
    return (
        <div>
            <dt className="eyebrow text-foreground-subtle">{label}</dt>
            <dd className="mt-2 tabular text-2xl font-semibold tracking-tight sm:text-3xl">
                {value}
            </dd>
        </div>
    );
}

function PaginationLink({ href, disabled, children }) {
    if (disabled) {
        return (
            <span className="rounded-full border border-border px-4 py-1.5 text-foreground-subtle opacity-50">
                {children}
            </span>
        );
    }
    return (
        <Link
            href={href}
            className="rounded-full border border-border-strong px-4 py-1.5 text-foreground-muted transition-colors hover:bg-surface hover:text-foreground"
        >
            {children}
        </Link>
    );
}

function EmptyState() {
    return (
        <div className="rounded-md border border-dashed border-border bg-background-elevated p-10 text-center sm:p-14">
            <p className="text-foreground">No saved tracks yet.</p>
            <p className="mt-2 max-w-md mx-auto text-sm text-foreground-muted">
                When you save a song to your Spotify library and PlayTag finishes
                its sync, it&rsquo;ll show up here ready to be tagged.
            </p>
            <Link
                href="/create"
                className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:brightness-110"
            >
                Start a playlist
                <span aria-hidden>→</span>
            </Link>
        </div>
    );
}

function Logomark({ className = "h-5 w-5" }) {
    // Match the home page mark exactly — four uneven bars reading as music.
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
