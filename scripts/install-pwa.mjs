/**
 * Install the studio as a standalone Chrome web app — programmatically.
 *
 * Launches Chrome on the studio's dedicated profile with a DevTools port and
 * calls the (experimental) `PWA.install` CDP command. On success Chrome writes
 * a real .app shim (with the manifest's icon) under ~/Applications, which then
 * opens as its own application — own window, own Dock icon.
 *
 * Usage: node scripts/install-pwa.mjs   (server must be running on :4319)
 */
import { spawn } from "node:child_process";

const APP_URL = "http://localhost:4319/";
const DEBUG_PORT = 9223;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = `${process.env.HOME}/.latex-claude-studio-chrome`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Chrome with CDP enabled on the dedicated profile (kept separate from the
//    user's main browser, so we never touch their real profile).
const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    APP_URL, // open the page so the manifest is fetched
  ],
  { stdio: "ignore" },
);

// 2. Wait for DevTools, then attach to the PAGE target showing the studio —
//    the PWA.* commands are exposed on page sessions, not the browser socket.
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.url.startsWith(APP_URL));
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch {
    /* not up yet */
  }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) {
  console.log(JSON.stringify({ ok: false, error: "CDP endpoint never came up" }));
  chrome.kill();
  process.exit(1);
}

const sock = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  sock.onopen = res;
  sock.onerror = () => rej(new Error("websocket failed"));
});
let msgId = 0;
const pending = new Map();
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    sock.send(JSON.stringify({ id, method, params }));
  });

// 3. Give the page a moment to load the manifest, then install.
await sleep(2500);
const result = await cdp("PWA.install", {
  manifestId: APP_URL, // no explicit `id` in the manifest → id defaults to start_url
  installUrlOrBundleUrl: APP_URL,
});
console.log(JSON.stringify({ ok: !result.error, result }));

// 4. Let Chrome finish writing the app shim, then close this helper instance.
await sleep(3000);
sock.close();
chrome.kill();
process.exit(result.error ? 1 : 0);
