import { env } from "@/lib/env";

/**
 * CS2 match share code decode.
 *
 * A share code looks like `CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Removing the
 * `CSGO-` prefix leaves 25 characters from a custom base-57 alphabet, which we
 * decode into a single big integer and then split into three packed fields:
 *
 *   matchId    — low 50 bits
 *   outcomeId  — next 21 bits
 *   token      — next 32 bits   (total 103 bits ≤ 25 chars ≈ 145 bits)
 *
 * The replay CDN then serves the demo at
 *   {replayBase}/730/{matchId}_{outcomeId}_{token}.dem.bz2
 */

// Base-57 alphabet (avoids visually ambiguous chars: I, l, O, 0 excluded).
export const SHARE_CODE_ALPHABET =
  "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

const SHARE_CODE_RE = new RegExp(
  `^CSGO-([${SHARE_CODE_ALPHABET}]{5})` +
    `-([${SHARE_CODE_ALPHABET}]{5})-([${SHARE_CODE_ALPHABET}]{5})` +
    `-([${SHARE_CODE_ALPHABET}]{5})-([${SHARE_CODE_ALPHABET}]{5})$`,
);

export interface DecodedShareCode {
  matchId: string;
  outcomeId: string;
  token: string;
  appId: number;
}

/** Validate shape; returns the five stripped groups or null. */
export function normalizeShareCode(code: string): string | null {
  const m = code.trim().match(SHARE_CODE_RE);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`;
}

/** Decode a validated (prefix-stripped) 25-char code into its packed fields. */
export function decodeShareCode(code: string): DecodedShareCode {
  const stripped = normalizeShareCode(code);
  if (!stripped) throw new Error(`Invalid CS2 match share code: "${code}"`);

  let value = 0n;
  for (const ch of stripped) {
    value = value * 57n + BigInt(SHARE_CODE_ALPHABET.indexOf(ch));
  }

  const matchId = value & ((1n << 50n) - 1n);
  const outcomeId = (value >> 50n) & ((1n << 21n) - 1n);
  const token = (value >> 71n) & ((1n << 32n) - 1n);

  return {
    matchId: matchId.toString(),
    outcomeId: outcomeId.toString(),
    token: token.toString(),
    appId: 730,
  };
}

/** Encode matchid/outcomeid/token back into a share code (GC → replay URL). */
export function encodeShareCode(matchId: bigint | number | string, outcomeId: bigint | number | string, token: bigint | number | string): string {
  const m = BigInt(matchId) & ((1n << 50n) - 1n);
  const o = BigInt(outcomeId) & ((1n << 21n) - 1n);
  const t = BigInt(token) & ((1n << 32n) - 1n);
  let value = m | (o << 50n) | (t << 71n);

  let s = "";
  for (let i = 0; i < 25; i++) {
    s = SHARE_CODE_ALPHABET[Number(value % 57n)] + s;
    value /= 57n;
  }
  return `CSGO-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}-${s.slice(20, 25)}`;
}

/** Assemble the Valve replay CDN URL for a decoded share code. */
export function demoUrlFromShareCode(
  code: string | DecodedShareCode,
  replayBase: string = env.replayBase,
): string {
  const decoded = typeof code === "string" ? decodeShareCode(code) : code;
  const suffix =
    `${decoded.matchId}_${decoded.outcomeId}_${decoded.token}.dem.bz2`;
  const base = replayBase.replace(/\/$/, "");
  return `${base}/730/${suffix}`;
}