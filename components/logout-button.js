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
      className="text-sm text-foreground-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
    >
      Sign out
    </button>
  );
}
