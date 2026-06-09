/**
 * Backend for the LaTeX + Claude studio.
 *
 * A tiny dependency-free Node server that bridges the browser UI to two tools
 * that already live on this machine:
 *   - `latexmk` (your MacTeX install) for compiling .tex -> .pdf
 *   - the `claude` CLI for AI assistance (ask + agentic edits)
 *
 * It also persists the document to ./project/main.tex so edits survive reloads
 * and so Claude (running in that directory) can read/edit the real file.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "project");
const DIST_DIR = join(__dirname, "dist"); // built frontend (vite build) for production
const PAPERS_DIR = join(PROJECT_DIR, "papers");
const MAIN_TEX = join(PROJECT_DIR, "main.tex");
const MAIN_PDF = join(PROJECT_DIR, "main.pdf");
const PORT = 4319;

// Call binaries directly with an explicit PATH so we never trigger the user's
// login-shell banner and so `claude`/`latexmk`/`node` all resolve.
const HOME = process.env.HOME;
const BIN_PATH = [
  `${HOME}/.local/bin`, // claude
  `${HOME}/.local/node/bin`, // node (claude is a node script)
  "/Library/TeX/texbin", // latexmk + friends
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
const CHILD_ENV = { ...process.env, PATH: BIN_PATH };

/** Run a command, capturing stdout/stderr, with a timeout. */
function run(cmd, args, { cwd, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: CHILD_ENV });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
}

/** Keep a filename safe: strip any path components. */
const safeName = (n) => basename(String(n || "")).replace(/[^\w.\- ]/g, "_");

// --- handlers -------------------------------------------------------------

/** GET /api/file -> { content } */
async function getFile(_req, res) {
  const content = await readFile(MAIN_TEX, "utf8").catch(() => "");
  json(res, 200, { content });
}

/** POST /api/file { content } -> { ok } */
async function putFile(req, res) {
  const { content } = await readJsonBody(req);
  await writeFile(MAIN_TEX, content ?? "", "utf8");
  json(res, 200, { ok: true });
}

/** POST /api/compile -> { ok, log } and writes project/main.pdf */
async function compile(_req, res) {
  const r = await run(
    "latexmk",
    // -synctex=1 emits main.synctex.gz so the PDF can map back to source lines.
    ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"],
    { cwd: PROJECT_DIR, timeoutMs: 90_000 },
  );
  let pdfOk = false;
  try {
    pdfOk = (await stat(MAIN_PDF)).size > 0;
  } catch {
    pdfOk = false;
  }
  // latexmk returns non-zero on warnings sometimes; trust the PDF's existence.
  json(res, 200, {
    ok: pdfOk,
    log: (r.stdout + "\n" + r.stderr).slice(-8000),
    timedOut: r.timedOut,
  });
}

/** GET /api/pdf -> the compiled PDF bytes (cache-busted by the client). */
async function getPdf(_req, res) {
  try {
    await stat(MAIN_PDF);
  } catch {
    res.writeHead(404).end("no pdf yet");
    return;
  }
  res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
  createReadStream(MAIN_PDF).pipe(res);
}

/** GET /api/papers -> { papers: ["a.pdf", ...] } */
async function listPapers(_req, res) {
  await mkdir(PAPERS_DIR, { recursive: true });
  const all = await readdir(PAPERS_DIR).catch(() => []);
  const papers = all.filter((f) => /\.pdf$/i.test(f)).sort();
  json(res, 200, { papers });
}

/** GET /api/paper?name=foo.pdf -> the PDF bytes */
async function getPaper(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name"));
  const path = join(PAPERS_DIR, name);
  try {
    await stat(path);
  } catch {
    res.writeHead(404).end("no such paper");
    return;
  }
  res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
  createReadStream(path).pipe(res);
}

/** POST /api/paper?name=foo.pdf  (raw PDF body) -> { ok, name } */
async function uploadPaper(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name") || "paper.pdf");
  await mkdir(PAPERS_DIR, { recursive: true });
  const buf = await readRawBody(req);
  await writeFile(join(PAPERS_DIR, name), buf);
  json(res, 200, { ok: true, name });
}

const FIGURES_DIR = join(PROJECT_DIR, "figures");

/** POST /api/figure?name=plot.png  (raw image body) -> { ok, name }.
 * Saves an image into figures/ so \includegraphics{figures/<name>} resolves. */
async function uploadFigure(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name") || "figure.png");
  await mkdir(FIGURES_DIR, { recursive: true });
  await writeFile(join(FIGURES_DIR, name), await readRawBody(req));
  json(res, 200, { ok: true, name });
}

const CAPTURES_DIR = join(PROJECT_DIR, ".captures");

/** POST /api/capture?name=cap.png  (raw PNG body) -> { ok, name }.
 * A cropped region of a paper, saved so Claude can Read it (vision). */
async function uploadCapture(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name") || "capture.png");
  await mkdir(CAPTURES_DIR, { recursive: true });
  await writeFile(join(CAPTURES_DIR, name), await readRawBody(req));
  json(res, 200, { ok: true, name });
}

const HIGHLIGHTS_FILE = join(PAPERS_DIR, ".highlights.json");

async function readHighlights() {
  try {
    return JSON.parse(await readFile(HIGHLIGHTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** GET /api/highlights?paper=foo.pdf -> { highlights: [...] } (for one paper) */
async function getHighlights(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("paper") || "");
  const all = await readHighlights();
  json(res, 200, { highlights: all[name] || [] });
}

/** POST /api/highlights { paper, highlights } -> { ok } */
async function putHighlights(req, res) {
  const { paper, highlights } = await readJsonBody(req);
  const name = safeName(paper || "");
  if (!name) return json(res, 400, { ok: false });
  await mkdir(PAPERS_DIR, { recursive: true });
  const all = await readHighlights();
  if (Array.isArray(highlights) && highlights.length) all[name] = highlights;
  else delete all[name];
  await writeFile(HIGHLIGHTS_FILE, JSON.stringify(all, null, 2));
  json(res, 200, { ok: true });
}

/**
 * POST /api/claude { prompt, mode, paper } -> { ok, output, edited, content }
 *   mode "ask"  : Claude reads the doc + papers and answers (no file changes).
 *   mode "edit" : Claude Code edits main.tex / references.bib directly (acceptEdits).
 *   paper       : optional papers/<name>.pdf the question is about.
 *
 * In both modes Claude gets read-only tools (Read/Glob/Grep) so it can open the
 * source PDFs in papers/ — the Read tool understands PDF content.
 */
/** Pull { text, session } out of `claude --output-format json` (an event array). */
function parseClaudeJson(stdout) {
  try {
    const events = JSON.parse(stdout);
    const arr = Array.isArray(events) ? events : [events];
    const result = arr.find((e) => e.type === "result") || {};
    return { text: result.result || result.error || "", session: result.session_id || null };
  } catch {
    return { text: stdout, session: null };
  }
}

async function claude(req, res) {
  const { prompt, mode = "ask", paper, capture, session } = await readJsonBody(req);
  if (!prompt || !prompt.trim()) return json(res, 400, { ok: false, output: "Empty prompt." });

  const paperName = paper ? safeName(paper) : null;
  const captureName = capture ? safeName(capture) : null;

  // Per-message context lives in the user prompt (not the system prompt), so it
  // stays correct turn-to-turn even when resuming a session.
  let ctx = "";
  if (paperName) ctx += `[Read papers/${paperName} (a source PDF) for this question.]\n`;
  if (captureName)
    ctx += `[The user highlighted a region — Read the image .captures/${captureName} to see exactly what they marked.]\n`;
  if (mode === "edit")
    ctx += "[Make the change by editing main.tex and/or references.bib directly, then summarize. Add a BibTeX entry for any new citation.]\n";
  const userPrompt = ctx + prompt;

  const args = ["-p", userPrompt, "--output-format", "json"];

  if (session) {
    // Continue the existing conversation — it already has the system context.
    args.push("--resume", session);
  } else {
    args.push(
      "--append-system-prompt",
      "You are assisting with a LaTeX literature review in the current directory: " +
        "main.tex (the writeup), references.bib (BibTeX), and papers/ (source PDFs). " +
        "Read files for their current state. Keep answers concise.",
    );
  }
  if (mode === "edit") {
    args.push("--permission-mode", "acceptEdits", "--allowed-tools", "Edit", "Write", "Read", "Glob", "Grep");
  } else {
    args.push("--allowed-tools", "Read", "Glob", "Grep");
  }

  const r = await run("claude", args, {
    cwd: PROJECT_DIR,
    timeoutMs: mode === "edit" ? 300_000 : 180_000,
  });
  const parsed = parseClaudeJson(r.stdout);
  const content = mode === "edit" ? await readFile(MAIN_TEX, "utf8").catch(() => null) : null;
  json(res, 200, {
    ok: r.code === 0,
    output: parsed.text.trim() || r.stderr.trim() || "(no output)",
    session: parsed.session,
    edited: mode === "edit",
    content,
  });
}

/**
 * GET /api/synctex?page=1&x=120&y=300 -> { line }
 * Maps a click in the compiled PDF back to a source line via `synctex edit`.
 * x/y are in PDF points (top-left origin), as produced by the pdf.js viewport.
 */
async function synctex(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const page = parseInt(q.get("page") || "1", 10);
  const x = parseFloat(q.get("x") || "0");
  const y = parseFloat(q.get("y") || "0");
  const r = await run("synctex", ["edit", "-o", `${page}:${x}:${y}:main.pdf`], {
    cwd: PROJECT_DIR,
    timeoutMs: 10_000,
  });
  // Output includes a line like "Line:28" for the first (closest) hit.
  const m = r.stdout.match(/\bLine:(\d+)/);
  const fileM = r.stdout.match(/\bInput:(.+)/);
  json(res, 200, {
    line: m ? parseInt(m[1], 10) : null,
    file: fileM ? fileM[1].trim() : null,
  });
}

// --- static frontend (production: serve the vite build from dist/) --------

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(req, res) {
  // Map "/" to index.html; prevent path traversal out of DIST_DIR.
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const path = normalize(join(DIST_DIR, rel));
  if (!path.startsWith(DIST_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    await stat(path);
  } catch {
    // SPA fallback to index.html for unknown non-asset routes.
    if (!extname(path)) return serveIndex(res);
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
  createReadStream(path).pipe(res);
}

async function serveIndex(res) {
  try {
    const html = await readFile(join(DIST_DIR, "index.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  } catch {
    res.writeHead(404).end("build the frontend first: npm run build");
  }
}

// --- router ---------------------------------------------------------------

const routes = {
  "GET /api/file": getFile,
  "POST /api/file": putFile,
  "POST /api/compile": compile,
  "GET /api/pdf": getPdf,
  "GET /api/papers": listPapers,
  "GET /api/paper": getPaper,
  "POST /api/paper": uploadPaper,
  "GET /api/synctex": synctex,
  "GET /api/highlights": getHighlights,
  "POST /api/highlights": putHighlights,
  "POST /api/capture": uploadCapture,
  "POST /api/figure": uploadFigure,
  "POST /api/claude": claude,
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    // Anything that isn't an API route falls through to the static frontend.
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      try {
        await serveStatic(req, res);
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }
    res.writeHead(404).end("not found");
    return;
  }
  try {
    await handler(req, res);
  } catch (err) {
    json(res, 500, { ok: false, error: String(err) });
  }
}).listen(PORT, () => {
  console.log(`[studio] backend on http://localhost:${PORT}  (project: ${PROJECT_DIR})`);
});
