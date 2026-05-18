import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase redirects here after the Spotify→Supabase exchange.
// We trade the Supabase code for our own session cookie, then send the user wherever they wanted to land.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(error.message)}`);
  }

  return NextResponse.redirect(`${origin}/?auth_error=missing_code`);
}
