"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const SUGGESTED = [
  "Gym",
  "Study",
  "Road Trip",
  "Chill",
  "Party",
  "Rainy Sunday",
  "Coffee Shop",
];
const INITIAL_TAGS = ["Late Night", "Focus", "Electronic"];

export default function CreatePage() {
  const router = useRouter();
  const [tags, setTags] = useState(INITIAL_TAGS);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function addTag(value) {
    const clean = value.trim();
    if (!clean) return;
    // Match the project's normalization rule: case-insensitive dedupe.
    const exists = tags.some((t) => t.toLowerCase() === clean.toLowerCase());
    if (exists) return;
    setTags([...tags, clean]);
    setDraft("");
  }

  function removeTag(value) {
    setTags(tags.filter((t) => t !== value));
  }

  function submit() {
    if (!tags.length || submitting) return;
    setSubmitting(true);
    const params = new URLSearchParams({ tags: tags.join(",") });
    router.push(`/create/generating?${params.toString()}`);
  }

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <Logomark className="h-5 w-5 text-accent" />
          <span className="text-base font-semibold tracking-tight">PlayTag</span>
        </Link>
        <Link
          href="/"
          className="text-sm text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          ← Back
        </Link>
      </header>

      <section className="grid grid-cols-12 gap-6 px-6 py-16 sm:px-12 sm:py-24">
        <aside className="col-span-12 lg:col-span-4">
          <p className="eyebrow text-foreground-subtle">New playlist</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Tell us the{" "}
            <span className="display-italic text-accent">vibe</span>.
          </h1>
          <p className="mt-5 max-w-sm text-base text-foreground-muted">
            Add a few tags — a mood, a genre, what you&rsquo;re doing. The
            looser, the better.
          </p>
        </aside>

        <div className="col-span-12 lg:col-span-8 lg:pl-8">
          {/* Your tags — real chips with × button. */}
          <div>
            <p className="eyebrow text-foreground-subtle">Your tags</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {tags.length === 0 && (
                <p className="py-2 text-sm italic text-foreground-subtle">
                  No tags yet — add one below.
                </p>
              )}
              {tags.map((t) => (
                <span
                  key={t}
                  className="group inline-flex items-center gap-1.5 rounded-full bg-accent pl-3 pr-2 text-sm font-medium text-accent-ink"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTag(t)}
                    aria-label={`Remove ${t}`}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-accent-ink/70 transition-colors hover:bg-accent-ink/15 hover:text-accent-ink"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Add a tag — input + add button */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addTag(draft);
            }}
            className="mt-10"
          >
            <p className="eyebrow text-foreground-subtle">Add a tag</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background-elevated focus-within:border-accent">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. Synthwave, Coffee Shop, Late-night drive…"
                maxLength={40}
                className="flex-1 bg-transparent px-4 py-3 text-base text-foreground placeholder:text-foreground-subtle focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Add tag"
                className="mr-1.5 flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-ink transition-opacity hover:brightness-110 disabled:opacity-30"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </div>
          </form>

          {/* Suggestions */}
          <div className="mt-10">
            <p className="eyebrow text-foreground-subtle">Suggestions</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTED.filter(
                (s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()),
              ).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => addTag(s)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-elevated px-3 py-1.5 text-sm text-foreground-muted transition-colors hover:border-accent hover:text-foreground"
                >
                  <PlusIcon className="h-3 w-3" />
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Submit row */}
          <div className="mt-16 flex flex-col items-start gap-4 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-md text-xs text-foreground-subtle">
              By generating, you agree to save the result to your Spotify
              library. We never post on your behalf.
            </p>
            <button
              type="button"
              onClick={submit}
              disabled={!tags.length || submitting}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-ink transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            >
              {submitting ? "Generating…" : "Generate playlist"}
              {!submitting && <span aria-hidden>→</span>}
            </button>
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t border-border px-6 py-5 sm:px-12">
        <div className="flex items-center justify-between text-xs text-foreground-subtle">
          <span>
            {tags.length} tag{tags.length === 1 ? "" : "s"} added
          </span>
          <span className="eyebrow">PlayTag</span>
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

function PlusIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
