"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // router.refresh() forces the home page (server component) to re-read the session
    // and re-render — otherwise the user still sees the logged-in UI until a hard reload.
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="flex h-10 items-center justify-center rounded-full border border-black/10 px-5 text-sm font-medium text-zinc-700 transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/[.06]"
    >
      Log out
    </button>
  );
}
