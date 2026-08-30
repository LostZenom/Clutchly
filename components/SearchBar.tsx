"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ResolveResponse {
  ok?: boolean;
  steam64?: string;
  profile?: { username?: string | null; avatarUrl?: string | null };
  error?: string;
}

export default function SearchBar({
  placeholder = "Steam64 ID or profile URL",
}: {
  placeholder?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const query = value.trim();
    if (!query || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/steam/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: query }),
      });
      const data = (await res.json()) as ResolveResponse;

      if (res.ok && data.steam64) {
        router.push(`/player/${data.steam64}`);
      } else {
        setError(data.error ?? "Could not resolve that Steam account.");
      }
    } catch {
      setError("Network error while resolving. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="shimmer-card">
      <div className="shimmer-card__inner !p-1">
        <div className="flex items-center gap-2">
          <svg
            className="ml-2 h-4 w-4 shrink-0 text-zinc-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
            />
          </svg>
          <input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={loading}
            placeholder={placeholder}
            aria-label="Steam search"
            aria-busy={loading}
            className="h-9 w-full min-w-0 flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none disabled:cursor-wait"
          />
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="shimmer-btn flex h-9 shrink-0 items-center gap-2 rounded-lg px-4 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-400 disabled:cursor-wait disabled:opacity-70"
          >
            {loading && (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            )}
            {loading ? "Searching…" : "Enter"}
          </button>
        </div>
      </div>
      {error && (
        <p className="px-3 pb-2 pt-1 text-left text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}