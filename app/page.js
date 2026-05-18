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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-zinc-50 px-6 dark:bg-black">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          playgen
        </h1>
        <p className="text-base text-zinc-600 dark:text-zinc-400">
          Generate Spotify playlists from your library, by tag and vibe.
        </p>

        {user ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Signed in as{" "}
              <span className="font-medium text-black dark:text-zinc-50">
                {user.user_metadata?.full_name || user.email}
              </span>
            </p>
            <LogoutButton />
          </div>
        ) : (
          <LoginButton />
        )}

        {authError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            Auth error: {authError}
          </p>
        )}
      </div>
    </div>
  );
}
