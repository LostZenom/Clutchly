import SearchBar from "@/components/SearchBar";
import HomeHeader from "@/components/HomeHeader";

const FEATURES = [
  {
    title: "Player profiles",
    desc: "Trust factor, bans, Steam level and per-map performance for everyone you come across.",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20.5c.9-3.7 3.9-5.5 8-5.5s7.1 1.8 8 5.5H4Z" />
      </svg>
    ),
  },
  {
    title: "Chat archive",
    desc: "Every message from every game — searchable, with speakers color-coded by side.",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5h-7L6.5 18.5v-3.5H7.5A2.5 2.5 0 0 1 5 12.5v-6Z" />
      </svg>
    ),
  },
  {
    title: "Match scoreboards",
    desc: "Full 10-player reports — ratings, ADR, KAST and trust — from cstracker and your own demos.",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <rect x="4" y="3" width="4" height="18" rx="1.2" />
        <rect x="10" y="7" width="4" height="14" rx="1.2" />
        <rect x="16" y="11" width="4" height="10" rx="1.2" />
      </svg>
    ),
  },
  {
    title: "Live overlay",
    desc: "A clean in-game overlay showing your current lobby — trust and bans for every player.",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
        <rect x="1.5" y="18.5" width="21" height="2" rx="1" />
      </svg>
    ),
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-void-950 text-zinc-50">
      {/* Top navigation */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-void-950/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/clutchly-logo.png" alt="" className="h-7 w-7 rounded-md" />
            <span className="text-sm font-semibold tracking-tight">Clutchly</span>
            <span className="ml-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-400">
              CS2
            </span>
          </div>
          <HomeHeader />
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 pb-24">
        {/* Hero */}
        <section className="flex flex-col items-center py-24 text-center">
          <p className="mb-4 rounded-full border border-white/5 bg-white/5 px-3 py-1 text-xs uppercase tracking-widest text-zinc-400">
            CS2 match tracking
          </p>
          <h1 className="max-w-2xl text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Every match,<br />
            <span className="text-gradient">known inside out.</span>
          </h1>
          <p className="mt-6 max-w-xl text-sm leading-relaxed text-zinc-400">
            Look up any player, read the full story of any game — profiles, chat
            archives, scoreboards and a live in-game overlay, all in one place.
          </p>

          {/* Search bar */}
          <div className="mt-10 w-full max-w-md">
            <SearchBar />
          </div>
        </section>

        {/* Features */}
        <section>
          <div className="mb-6 text-center">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              // what you get
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="shimmer-card">
                <div className="shimmer-card__inner flex h-full flex-col gap-3">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-electric-300">
                    {f.icon}
                  </span>
                  <h3 className="text-sm font-semibold text-zinc-50">{f.title}</h3>
                  <p className="text-xs leading-relaxed text-zinc-400">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-24 border-t border-white/5 pt-8 text-center text-xs text-zinc-500">
          Clutchly — CS2 match tracking, chat archives, scoreboards &amp; live overlay.
        </footer>
      </div>
    </main>
  );
}