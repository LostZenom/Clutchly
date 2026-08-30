/**
 * cstracker.gg-style CS2 Premier rating badge.
 *
 * A slanted (skewed) parallelogram with the tier's background strip and color,
 * exactly like the `cs2rating` badges on cstracker.gg. The tier is derived from
 * the rating value (CS2 Premier color brackets):
 *
 *   common     < 5,000    grey-blue
 *   uncommon   5,000+     light blue
 *   rare       10,000+    blue
 *   mythical   15,000+    purple
 *   legendary  20,000+    magenta/pink
 *   ancient    25,000+    red
 *   unusual    30,000+    gold
 */

const TIERS = [
  { min: 30_000, tier: "unusual" },
  { min: 25_000, tier: "ancient" },
  { min: 20_000, tier: "legendary" },
  { min: 15_000, tier: "mythical" },
  { min: 10_000, tier: "rare" },
  { min: 5_000, tier: "uncommon" },
  { min: 0, tier: "common" },
] as const;

export type PremierTier = (typeof TIERS)[number]["tier"];

export function premierTier(rating: number): PremierTier {
  for (const t of TIERS) {
    if (rating >= t.min) return t.tier;
  }
  return "common";
}

export default function RatingBadge({
  rating,
  title,
  compact,
}: {
  rating: number | null | undefined;
  title?: string;
  /** Smaller footprint for table cells (rank before/after in match lists). */
  compact?: boolean;
}) {
  if (rating == null) return null;
  const parts = rating.toLocaleString("en-US").split(",");
  return (
    <span
      className={`cs2rating ${premierTier(rating)} ${compact ? "cs2rating--compact" : ""}`}
      title={title ?? `Premier rating ${rating.toLocaleString("en-US")}`}
    >
      <span>
        {parts[0]}
        {parts.length > 1 && <span className="text-[10px]">,{parts.slice(1).join(",")}</span>}
      </span>
    </span>
  );
}
