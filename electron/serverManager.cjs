/**
 * Server manager for the Clutchly desktop overlay.
 *
 * The overlay app boots the whole website itself: on launch it starts the Next.js
 * server on the configured port, waits until the site is actually serving, and
 * hands the overlay/settings windows that URL. On quit it tears the server down,
 * so nothing is left running in the background.
 *
 * Ports are always loopback ("127.0.0.1") — the site is only for the local app.
 *
 * Startup is deliberately robust:
 *   - The project's `.env` is injected into the server's environment (DATABASE_URL,
 *     REDIS_*, Steam keys, etc.) so the site boots fully, not half-configured.
 *   - A real Node.js on the PATH is used when available (a genuine background
 *     console/terminal process that starts and runs the site); packaged builds
 *     fall back to Electron's own bundled Node (ELECTRON_RUN_AS_NODE=1), so no
 *     separately installed Node is required in a .exe.
 *   - If a port refuses to come up (already in use, or won't boot), the manager
 *     automatically moves on to the next free port instead of just failing.
 *   - "Ready" means the process is actually serving HTTP, not merely that a
 *     process was spawned.
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const AUTO_FALLBACK_TRIES = 12; // try port, port+1, … port+11 before giving up
const BOOT_TIMEOUT_MS = 35_000; // how long to wait per port attempt

/**
 * @param {{ projectRoot: string, onLog?: (line:string)=>void, onAttempt?: (port:number)=>void }} opts
 */
function createServerManager({ projectRoot, onLog, onAttempt }) {
  let child = null;
  let currentPort = null;
  let stopping = false;

  const log = (msg) => {
    if (onLog) onLog(msg);
    else console.log(`[site] ${msg}`);
  };
  const err = (msg) => console.error(`[site] ${msg}`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Promise a request to the local site. Resolves true when the server returns
   * ANY HTTP response (status code present) — i.e. it is up and serving. A page
   * rendering error (5xx) still counts as "up"; we detect the process is really
   * listening rather than waiting forever on a boot process that never serves.
   */
  function respond(port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const req = http.get({ host: HOST, port, path: "/overlay", timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode != null);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  /** True when something is already serving on this port. */
  async function isAlive(port) {
    return respond(port);
  }

  /** Parse the project's `.env` (KEY="VALUE" / KEY=VALUE, # = comment). */
  function loadDotEnv() {
    const out = {};
    const file = path.join(projectRoot, ".env");
    try {
      if (!fs.existsSync(file)) return out;
      for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key) out[key] = value;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Resolve the Node binary used to run the site. Prefer a real `node` on the
   * PATH (a true background console process that fully boots the site); in a
   * packaged app with no Node installed, fall back to Electron's own node.
   */
  function resolveNode() {
    if (process.env.NODE && process.env.NODE.trim() && fs.existsSync(process.env.NODE.trim())) {
      return { exe: process.env.NODE.trim(), electron: false };
    }
    try {
      const r = spawnSync("where", ["node"], { encoding: "utf8", windowsHide: true });
      const first = ((r.stdout || "").split(/\r?\n/).find(Boolean) || "").trim();
      if (first && fs.existsSync(first)) {
        log(`using system node at ${first}`);
        return { exe: first, electron: false };
      }
    } catch {
      /* continue to fallback */
    }
    // Packaged or no node on PATH: drive Electron's bundled Node.
    log("no system node found — using Electron's bundled Node.");
    return { exe: process.execPath, electron: true };
  }

  function resolveServerEntry() {
    const candidates = [];
    // Packaged app: the site is staged under <resources>/site (unpacked).
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "site", "server.js"));
    }
    candidates.push(path.join(projectRoot, ".next", "standalone", "server.js"));
    candidates.push(path.join(projectRoot, ".next", "server.js"));
    for (const p of candidates) {
      if (fs.existsSync(p)) return { type: "standalone", entry: p };
    }
    if (fs.existsSync(path.join(projectRoot, ".next", "BUILD_ID"))) {
      return { type: "start", entry: path.join(projectRoot, "node_modules", "next", "dist", "bin", "next") };
    }
    return { type: "dev", entry: path.join(projectRoot, "node_modules", "next", "dist", "bin", "next") };
  }

  function spawnNext(port) {
    const runner = resolveServerEntry();
    const node = resolveNode();
    const args =
      runner.type === "standalone"
        ? [runner.entry, "-H", HOST, "-p", String(port)]
        : [runner.entry, runner.type, "-H", HOST, "-p", String(port)];

    // The site must see the project's .env (DB, Redis, Steam) to boot fully.
    const env = {
      ...process.env,
      ...loadDotEnv(),
      HOSTNAME: HOST,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_RUNTIME_DIR: path.join(projectRoot, ".next"),
    };
    if (node.electron) env.ELECTRON_RUN_AS_NODE = "1";

    log(`starting site (${runner.type}) on ${HOST}:${port}…`);
    child = spawn(node.exe, args, {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    // Stream the server's own output into the debug console so you can see it
    // actually booting, not just guessing.
    const pipe = (stream) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) log(line);
        }
      });
      stream.on("end", () => {
        if (buf.trim()) log(buf.trim());
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on("error", (e) => err(`could not start server: ${e && e.message}`));
    child.on("exit", (code, signal) => {
      if (!stopping) err(`site exited unexpectedly (code=${code}, signal=${signal}).`);
      child = null;
    });
    return child;
  }

  async function waitUntilReady(port, timeoutMs) {
    const start = Date.now();
    let lastBeat = 0;
    while (Date.now() - start < timeoutMs) {
      if (await respond(port)) return true;
      if (!child) return false; // process died — don't wait the full timeout
      if (Date.now() - lastBeat > 3000) {
        lastBeat = Date.now();
        log(`waiting for the site on port ${port} to come up…`);
      }
      await sleep(400);
    }
    return false;
  }

  /**
   * Ensure the site is reachable. Free the port, boot, and if it doesn't come
   * up, automatically advance to the next free port until one serves.
   * @returns {Promise<string>} the actual base URL that came up
   */
  async function ensureServer(port) {
    port = normalizePort(port);
    // Our own healthy server from earlier in this session -> reuse it.
    if (child && child.pid != null && (await respond(port))) {
      currentPort = port;
      log(`site already running on ${HOST}:${port} — reusing it.`);
      return baseUrl(port);
    }

    const candidates = [];
    for (let i = 0; i < AUTO_FALLBACK_TRIES; i++) candidates.push(port + i);
    const tried = [];

    for (const attempt of candidates) {
      tried.push(attempt);
      if (onAttempt) onAttempt(attempt);

      // Close any residual localhost listener on this port so we boot clean.
      await freePort(attempt, child && child.pid);
      spawnNext(attempt);
      const ready = await waitUntilReady(attempt, BOOT_TIMEOUT_MS);
      if (ready) {
        currentPort = attempt;
        log(`site ready at ${baseUrl(attempt)}`);
        return baseUrl(attempt);
      }
      err(`site did not become ready on ${attempt}.`);
      stopServer();
      await sleep(250);
    }

    currentPort = null;
    throw new Error(
      `The server could not start on ports ${tried.join(", ")}. They may be in use or the site failed to boot — try a different port.`,
    );
  }

  /** Restart the site on a new port (used on port change / retry). */
  async function restartServer(newPort) {
    newPort = normalizePort(newPort);
    stopServer();
    await sleep(350);
    return ensureServer(newPort);
  }

  function stopServer() {
    stopping = true;
    const c = child;
    child = null;
    if (!c || c.pid == null) {
      stopping = false;
      return;
    }
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
      } else {
        try {
          process.kill(-c.pid, "SIGTERM");
        } catch {
          c.kill("SIGTERM");
        }
      }
    } catch (e) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    log("site stopped.");
    stopping = false;
  }

  function currentUrl() {
    return currentPort ? baseUrl(currentPort) : null;
  }
  function getPort() {
    return currentPort;
  }

  return { ensureServer, restartServer, stopServer, isAlive, currentUrl, getPort };
}

function normalizePort(input) {
  const n = typeof input === "string" ? parseInt(input, 10) : Number(input);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return 3100;
}

/** Best-effort: close any localhost process listening on `port` (skip our own). */
async function freePort(port, excludePid) {
  const target = `${HOST}:${port}`;
  const pids = [];
  const kill = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === excludePid) return;
    pids.push(pid);
  };
  try {
    if (process.platform === "win32") {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, encoding: "utf8" });
      for (const line of (out.stdout || "").split(/\r?\n/)) {
        const cols = line.split(/\s+/).filter(Boolean);
        if (cols[0] !== "TCP") continue;
        if (cols[1] === target && /^LISTEN/i.test(cols[3] || "")) {
          kill(parseInt(cols[cols.length - 1], 10));
        }
      }
      for (const pid of pids) {
        try {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
          console.log(`[site] closed leftover localhost server on ${target} (PID ${pid})`);
        } catch {
          /* best-effort */
        }
      }
    } else {
      const out = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
      for (const pidStr of (out.stdout || "").split(/\s+/).filter(Boolean)) {
        kill(parseInt(pidStr, 10));
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
          console.log(`[site] closed leftover localhost server on ${target} (PID ${pid})`);
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort; if we can't probe we simply attempt boot */
  }
  return pids.length;
}

function baseUrl(port) {
  return `http://${HOST}:${port}`;
}

module.exports = { createServerManager, normalizePort };