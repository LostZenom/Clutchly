/**
 * Minimal, idempotent .env writer (server-side equivalent of the Electron
 * settings store's writeEnv). Used to persist the Steam GC refresh token so
 * future feed logins skip Steam Guard entirely. Only touches the keys passed
 * in `patch`; everything else in .env is left alone.
 */
import * as fs from "fs";
import * as path from "path";

export function persistEnvKeys(patch: Record<string, string>): void {
  const file = path.join(process.cwd(), ".env");
  let lines: string[] = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  }
  const written = new Set<string>();
  const out = lines.map((line) => {
    for (const [key, value] of Object.entries(patch)) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
        written.add(key);
        return `${key}="${String(value ?? "")}"`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(patch)) {
    if (!written.has(key)) out.push(`${key}="${String(value ?? "")}"`);
  }
  try {
    fs.writeFileSync(file, out.join("\n").replace(/\n+/g, "\n") + "\n", "utf8");
  } catch (err) {
    console.error("[overlay] could not write .env:", err instanceof Error ? err.message : err);
  }
}
