"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

// Concrete backend steps the real implementation will report. Each has a
// progress threshold — when overall progress passes the threshold, the step
// is "done"; the next pending step is shown as "running".
const STEPS = [
  { id: "library", label: "Reading your saved tracks", at: 30 },
  { id: "match", label: "Matching tags against your library", at: 65 },
  { id: "rank", label: "Ranking and ordering tracks", at: 90 },
  { id: "save", label: "Preparing the playlist", at: 100 },
];

export default function GeneratingPage() {
  return (
    <Suspense fallback={<Shell progress={0} tags={[]} />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const tagsParam = params.get("tags") || "";
  const tags = tagsParam ? tagsParam.split(",").filter(Boolean) : [];

  const [progress, setProgress] = useState(0);

  // Ease-out-quart over ~4.5s. Real implementation will replace this with a
  // server-sent-events stream from the Inngest job.
  useEffect(() => {
    const start = performance.now();
    const duration = 4500;
    let frame;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      setProgress(Math.floor(eased * 100));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (progress < 100) return;
    const t = setTimeout(() => {
      router.push(`/playlist/demo?${params.toString()}`);
    }, 700);
    return () => clearTimeout(t);
  }, [progress, params, router]);

  return <Shell progress={progress} tags={tags} />;
}

function Shell({ progress, tags }) {
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

      {/* Full-width progress bar pinned to the top edge — the only motion ornament */}
      <div className="h-1 w-full bg-border" aria-hidden>
        <div
          className="h-full bg-accent transition-[width] duration-100 ease-out"
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

        {/* Right: step list with state per step */}
        <div className="col-span-12 lg:col-span-7 lg:pl-8">
          <p className="eyebrow text-foreground-subtle">Steps</p>
          <ol className="mt-4 flex flex-col">
            {STEPS.map((step, i) => {
              const prev = i === 0 ? 0 : STEPS[i - 1].at;
              const done = progress >= step.at;
              const active = !done && progress >= prev;
              const status = done ? "done" : active ? "active" : "pending";
              return (
                <li
                  key={step.id}
                  className="flex items-center gap-4 border-b border-border py-4 last:border-b-0"
                >
                  <StatusDot status={status} />
                  <span
                    className={`text-base ${
                      status === "done"
                        ? "text-foreground"
                        : status === "active"
                          ? "text-foreground"
                          : "text-foreground-subtle"
                    }`}
                  >
                    {step.label}
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
