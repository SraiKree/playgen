import { Geist } from "next/font/google";
import { Fraunces } from "next/font/google";
import "./globals.css";

// Body: Geist Sans — neutral but well-cut. Good companion to a strong serif.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

// Display: Fraunces — variable serif with optical sizing. Treated as the
// magazine's headline face. Roman + italic, with the SOFT axis dialed up so
// the curves feel like a deliberate type choice, not a default Google font.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  style: ["normal", "italic"],
});

export const metadata = {
  title: "PlayTag — A Quarterly of Personal Playlists",
  description:
    "Tag the moment, get a Spotify playlist. PlayTag turns moods, genres, and activities into curated playlists.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
