"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { startLibrarySync } from "./actions";

const PHASES = [
  { id: "library", label: "Reading your saved tracks", weight: 40 },
  { id: "enrich", label: "Tagging tracks with Last.fm", weight: 60 },
];

const POLL_MS = 1500;

export default function GeneratingPage() {
  return (
    <Suspense fallback={<Shell progress={0} tags={[]} phaseStatuses={{}} />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const tagsParam = params.get("tags") || "";
  const tags = tagsParam ? tagsParam.split(",").filter(Boolean) : [];

  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);            // last polled snapshot
  const [syncError, setSyncError] = useState(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const res = await startLibrarySync(tags);
      if (!res.ok) setSyncError(res.error);
      else setJobId(res.jobId);
    })();

  }, []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = await res.json();
        if (!cancelled) setJob(next);
      } catch {
      }
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [jobId]);

  const { progress, phaseStatuses } = computeProgress(job);

  useEffect(() => {
    if (job?.status !== "completed") return;
    const t = setTimeout(() => {
      const qs = params.toString();
      router.push(qs ? `/playlist/demo?${qs}` : "/playlist/demo");
    }, 700);
    return () => clearTimeout(t);
  }, [job?.status, params, router]);

  // Surface backend failures (recorded by library-sync's catch) the same way
  // we surface server-action failures.
  const errorMessage = syncError ?? (job?.status === "failed" ? job.error_message : null);

  return (
    <Shell
      progress={progress}
      tags={tags}
      phaseStatuses={phaseStatuses}
      syncError={errorMessage}
    />
  );
}

function computeProgress(job) {
  const statuses = { library: "pending", enrich: "pending" };
  if (!job) return { progress: 0, phaseStatuses: statuses };

  const libFrac =
    job.library_total > 0
      ? Math.min(1, job.library_done / job.library_total)
      : 0;

  const enrFrac =
    job.enrich_total > 0
      ? Math.min(1, job.enrich_done / job.enrich_total)
      : job.status === "enriching" || job.status === "completed"
        ? 1
        : 0;

  if (job.status === "syncing") {
    statuses.library = libFrac >= 1 ? "done" : "active";
  } else if (job.status === "enriching") {
    statuses.library = "done";
    statuses.enrich = enrFrac >= 1 ? "done" : "active";
  } else if (job.status === "completed") {
    statuses.library = "done";
    statuses.enrich = "done";
  }

  const raw =
    libFrac * PHASES[0].weight + enrFrac * PHASES[1].weight;
  const progress =
    job.status === "completed"
      ? 100
      : Math.min(99, Math.floor(raw));

  return { progress, phaseStatuses: statuses };
}

function Shell({ progress, tags, phaseStatuses, syncError = null }) {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <Logomark className="h-5 w-5 text-accent" />
          <span className="text-base font-semibold tracking-tight">PlayTag</span>
        </Link>
        <Link
          href="/create"
          aria-label="Cancel"
          className="text-sm text-foreground-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          Cancel
        </Link>
      </header>

      {syncError && (
        <div
          role="alert"
          className="border-b border-border bg-accent-soft px-6 py-3 text-sm text-accent sm:px-12"
        >
          {syncError === "not_authenticated"
            ? "You need to sign in with Spotify before generating a playlist."
            : syncError === "missing_spotify_token"
              ? "Your Spotify session expired. Sign in again to continue."
              : `Couldn't finish sync: ${syncError}`}
        </div>
      )}

      {/* Full-width progress bar pinned to the top edge — the only motion ornament */}
      <div className="h-1 w-full bg-border" aria-hidden>
        <div
          className="h-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <section className="grid flex-1 grid-cols-12 gap-6 px-6 py-16 sm:px-12 sm:py-20">
        {/* Left: giant percent — typography, not a spinner */}
        <div className="col-span-12 flex flex-col justify-between gap-12 lg:col-span-5">
          <div>
            <p className="eyebrow text-foreground-subtle">Generating</p>
            <p
              className="tabular mt-2 font-semibold leading-[0.85] tracking-tight"
              style={{ fontSize: "clamp(7rem, 20vw, 16rem)" }}
            >
              {String(progress).padStart(2, "0")}
              <span className="text-accent">%</span>
            </p>
          </div>

          {tags.length > 0 && (
            <div>
              <p className="eyebrow text-foreground-subtle">Your tags</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: phase list with state per phase */}
        <div className="col-span-12 lg:col-span-7 lg:pl-8">
          <p className="eyebrow text-foreground-subtle">Steps</p>
          <ol className="mt-4 flex flex-col">
            {PHASES.map((phase) => {
              const status = phaseStatuses[phase.id] ?? "pending";
              return (
                <li
                  key={phase.id}
                  className="flex items-center gap-4 border-b border-border py-4 last:border-b-0"
                >
                  <StatusDot status={status} />
                  <span
                    className={`text-base ${status === "pending"
                      ? "text-foreground-subtle"
                      : "text-foreground"
                      }`}
                  >
                    {phase.label}
                  </span>
                  <span className="ml-auto eyebrow tabular text-foreground-subtle">
                    {status === "done" ? "Done" : status === "active" ? "…" : ""}
                  </span>
                </li>
              );
            })}
          </ol>

          <p className="mt-8 text-sm text-foreground-muted">
            This usually takes under a minute. We&rsquo;ll redirect you when it&rsquo;s ready.
          </p>
        </div>
      </section>

      <footer className="border-t border-border px-6 py-5 sm:px-12">
        <div className="flex items-center justify-between text-xs text-foreground-subtle">
          <span>Running on your saved Spotify library.</span>
          <span className="tabular">{progress}%</span>
        </div>
      </footer>
    </main>
  );
}

function StatusDot({ status }) {
  if (status === "done") {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-ink">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
          <path
            d="M5 12l5 5L20 7"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative flex h-6 w-6 items-center justify-center">
        <span className="absolute h-6 w-6 animate-ping rounded-full bg-accent/40" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 items-center justify-center">
      <span className="h-2 w-2 rounded-full border border-border-strong" />
    </span>
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
