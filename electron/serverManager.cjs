/**
 * Server manager for the Clutchly desktop overlay.
 *
 * The overlay app boots the whole website itself: on launch it starts the Next.js
 * server on the configured port (see settings.serverPort), waits until the site
 * is actually serving, and hands the overlay/settings windows that URL. On quit it
 * tears the server down, so nothing is left running in the background.
 *
 * Ports are always loopback ("127.0.0.1") — the site is only for the local app,
 * not exposed to the network.
 *
 * The spawned child runs through Electron's own bundled Node
 * (ELECTRON_RUN_AS_NODE=1), so neither development nor the packaged .exe needs a
 * separately installed Node.js.
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";

/**
 * @param {{ projectRoot: string, packaged?: boolean, onLog?: (line:string)=>void }} opts
 */
function createServerManager({ projectRoot, onLog }) {
  let child = null;
  let currentPort = null;
  let stopping = false;

  const log = (msg) => {
    if (onLog) onLog(msg);
    else console.log(`[site] ${msg}`);
  };
  const err = (msg) => console.error(`[site] ${msg}`);

  /** Promise a request to the local site; resolves true on an HTTP 2xx/3xx. */
  function probe(port, pathname = "/overlay", timeoutMs = 1500) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: HOST, port, path: pathname, timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  /** True when something is already serving our site on this port. */
  async function isAlive(port) {
    return probe(port);
  }

  function resolveServerEntry() {
    const candidates = [];
    // Packaged app: the site is staged under <resources>/site (unpacked).
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "site", "server.js"));
    }
    // Development / plain build output.
    candidates.push(path.join(projectRoot, ".next", "standalone", "server.js"));
    candidates.push(path.join(projectRoot, ".next", "server.js"));
    for (const p of candidates) {
      if (fs.existsSync(p)) return { type: "standalone", entry: p };
    }
    // A plain `next build` output → `next start`.
    if (fs.existsSync(path.join(projectRoot, ".next", "BUILD_ID"))) {
      return { type: "start", entry: path.join(projectRoot, "node_modules", "next", "dist", "bin", "next") };
    }
    // Nothing built yet → dev server (compiles on the fly).
    return { type: "dev", entry: path.join(projectRoot, "node_modules", "next", "dist", "bin", "next") };
  }

  function spawnNext(port) {
    const runner = resolveServerEntry();
    const args =
      runner.type === "standalone"
        ? [runner.entry, "-H", HOST, "-p", String(port)]
        : [runner.entry, runner.type, "-H", HOST, "-p", String(port)];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: HOST,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      // Standalone trace output relies on a stable dir; keep it inside the build.
      NEXT_RUNTIME_DIR: path.join(projectRoot, ".next"),
    };

    log(`starting site (${runner.type}) on ${HOST}:${port}…`);
    child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

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
      if (!stopping) {
        err(`site exited unexpectedly (code=${code}, signal=${signal}).`);
      }
      child = null;
    });
    return child;
  }

  async function waitUntilReady(port, timeoutMs = 90_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await probe(port)) return true;
      // If the child died, don't wait the full timeout.
      if (!child) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /**
   * Ensure the site is reachable at the given port. Reuses an already-running
   * instance if present; otherwise boots one and waits for it to serve.
   * @returns {Promise<string>} the base URL (http://127.0.0.1:<port>)
   */
  async function ensureServer(port) {
    port = normalizePort(port);
    currentPort = port;
    if (await isAlive(port)) {
      log(`site already running on ${HOST}:${port} — reusing it.`);
      return baseUrl(port);
    }
    spawnNext(port);
    const ready = await waitUntilReady(port);
    if (!ready) {
      err(`site did not become ready on ${port}.`);
      stopServer();
      throw new Error(`The website could not start on port ${port}. It may already be in use by another app — try a different port in Settings.`);
    }
    log(`site ready at ${baseUrl(port)}`);
    return baseUrl(port);
  }

  /** Restart the site on a new port (used when the user changes the port). */
  async function restartServer(newPort) {
    newPort = normalizePort(newPort);
    stopServer();
    await new Promise((r) => setTimeout(r, 350));
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

  return { ensureServer, restartServer, stopServer, isAlive, currentUrl };
}

function normalizePort(input) {
  const n = typeof input === "string" ? parseInt(input, 10) : Number(input);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return 3100;
}

function baseUrl(port) {
  return `http://${HOST}:${port}`;
}

module.exports = { createServerManager, normalizePort };