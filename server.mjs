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
import { readFile, writeFile, stat, readdir, mkdir, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname, normalize, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "dist"); // built frontend (vite build) for production
const PORT = parseInt(process.env.STUDIO_PORT || "4319", 10);

// The project folder is switchable at runtime (POST /api/project). All of these
// paths are reassigned together by setProjectDir, and every handler reads the
// live bindings — so a switch takes effect immediately. STUDIO_PROJECT sets the
// initial folder; STUDIO_MAIN sets the default main .tex filename.
let PROJECT_DIR, PAPERS_DIR, FIGURES_DIR, CAPTURES_DIR, HIGHLIGHTS_FILE, MAIN_TEX, MAIN_PDF;
const MAIN_NAME = process.env.STUDIO_MAIN || "main.tex";
const MAIN_PDF_NAME = MAIN_NAME.replace(/\.tex$/i, ".pdf");

function setProjectDir(dir) {
  PROJECT_DIR = resolve(dir);
  PAPERS_DIR = join(PROJECT_DIR, "papers");
  FIGURES_DIR = join(PROJECT_DIR, "figures");
  CAPTURES_DIR = join(PROJECT_DIR, ".captures");
  HIGHLIGHTS_FILE = join(PAPERS_DIR, ".highlights.json");
  MAIN_TEX = join(PROJECT_DIR, MAIN_NAME);
  MAIN_PDF = join(PROJECT_DIR, MAIN_PDF_NAME);
}
setProjectDir(process.env.STUDIO_PROJECT || join(__dirname, "project"));

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

/**
 * Resolve a .tex file (may be in a subfolder) safely under PROJECT_DIR. Empty or
 * non-.tex input falls back to the default main file. Also derives the matching
 * PDF path and the directory latexmk/synctex should run in.
 */
function safeTexPath(p) {
  let rel = normalize(String(p || "")).replace(/^([./\\])+/, "");
  if (!rel || !/\.tex$/i.test(rel)) rel = MAIN_NAME;
  const full = join(PROJECT_DIR, rel);
  if (full !== PROJECT_DIR && !full.startsWith(PROJECT_DIR + "/")) return null;
  const pdfRel = rel.replace(/\.tex$/i, ".pdf");
  return {
    rel,
    full,
    dir: dirname(full),
    base: basename(full),
    pdfFull: join(PROJECT_DIR, pdfRel),
    pdfBase: basename(pdfRel),
  };
}

/** Recursively collect *.tex paths under PROJECT_DIR (relative). */
async function walkTex(dir) {
  let out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walkTex(full));
    else if (/\.tex$/i.test(e.name)) out.push(relative(PROJECT_DIR, full));
  }
  return out;
}

/** GET /api/texfiles -> { files: [...], default } */
async function listTexFiles(_req, res) {
  await mkdir(PROJECT_DIR, { recursive: true });
  const files = (await walkTex(PROJECT_DIR)).sort((a, b) => a.localeCompare(b));
  if (!files.includes(MAIN_NAME)) files.unshift(MAIN_NAME);
  json(res, 200, { files, default: MAIN_NAME });
}

/** GET /api/file?name=foo.tex -> { content, name } */
async function getFile(req, res) {
  const sp = safeTexPath(new URL(req.url, "http://localhost").searchParams.get("name"));
  const content = sp ? await readFile(sp.full, "utf8").catch(() => "") : "";
  json(res, 200, { content, name: sp ? sp.rel : MAIN_NAME });
}

/** POST /api/file { name, content } -> { ok } */
async function putFile(req, res) {
  const { name, content } = await readJsonBody(req);
  const sp = safeTexPath(name);
  if (!sp) return json(res, 400, { ok: false });
  await mkdir(sp.dir, { recursive: true });
  await writeFile(sp.full, content ?? "", "utf8");
  json(res, 200, { ok: true });
}

/** POST /api/compile { name } -> { ok, log }; compiles the given .tex in its folder. */
async function compile(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const sp = safeTexPath(body.name);
  if (!sp) return json(res, 400, { ok: false });
  // A pre-existing PDF must NOT count as success — compare its mtime across the
  // run, so a failed compile (stale PDF) reports ok:false with the error log.
  const mtimeBefore = await stat(sp.pdfFull).then((s) => s.mtimeMs).catch(() => 0);
  const r = await run(
    "latexmk",
    ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", sp.base],
    { cwd: sp.dir, timeoutMs: 90_000 },
  );
  const st = await stat(sp.pdfFull).catch(() => null);
  // ok when latexmk succeeded (incl. "already up-to-date") or the PDF was rebuilt
  // despite a nonzero exit (latexmk can exit nonzero on mere warnings).
  const ok = !!st && st.size > 0 && (r.code === 0 || st.mtimeMs > mtimeBefore);
  json(res, 200, {
    ok,
    log: (r.stdout + "\n" + r.stderr).slice(-8000),
    timedOut: r.timedOut,
  });
}

/** GET /api/pdf?name=foo.tex -> the compiled PDF bytes for that file. */
async function getPdf(req, res) {
  const sp = safeTexPath(new URL(req.url, "http://localhost").searchParams.get("name"));
  if (!sp) return void res.writeHead(400).end("bad path");
  try {
    await stat(sp.pdfFull);
  } catch {
    res.writeHead(404).end("no pdf yet");
    return;
  }
  res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
  createReadStream(sp.pdfFull).pipe(res);
}

/** Resolve a paper path (may include subfolders) safely under PAPERS_DIR. */
function safePaperPath(p) {
  const rel = normalize(String(p || "")).replace(/^([./\\])+/, "");
  const full = join(PAPERS_DIR, rel);
  if (full !== PAPERS_DIR && !full.startsWith(PAPERS_DIR + "/")) return null;
  return { rel, full };
}

/** Recursively collect *.pdf paths under PAPERS_DIR (so subfolders work). */
async function walkPdfs(dir) {
  let out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walkPdfs(full));
    else if (/\.pdf$/i.test(e.name)) out.push(relative(PAPERS_DIR, full));
  }
  return out;
}

/** GET /api/papers -> { papers: ["a.pdf", "readings/b.pdf", ...] } */
async function listPapers(_req, res) {
  await mkdir(PAPERS_DIR, { recursive: true });
  const papers = (await walkPdfs(PAPERS_DIR)).sort((a, b) => a.localeCompare(b));
  json(res, 200, { papers });
}

/** GET /api/paper?name=readings/foo.pdf -> the PDF bytes */
async function getPaper(req, res) {
  const sp = safePaperPath(new URL(req.url, "http://localhost").searchParams.get("name"));
  if (!sp) return void res.writeHead(400).end("bad path");
  try {
    await stat(sp.full);
  } catch {
    res.writeHead(404).end("no such paper");
    return;
  }
  res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
  createReadStream(sp.full).pipe(res);
}

/** POST /api/paper?name=foo.pdf  (raw PDF body) -> { ok, name } */
async function uploadPaper(req, res) {
  const sp = safePaperPath(new URL(req.url, "http://localhost").searchParams.get("name") || "paper.pdf");
  if (!sp) return void res.writeHead(400).end("bad path");
  await mkdir(dirname(sp.full), { recursive: true });
  await writeFile(sp.full, await readRawBody(req));
  json(res, 200, { ok: true, name: sp.rel });
}

/**
 * POST /api/rename-papers { onlyCryptic } -> { renamed: [{from,to}], skipped }
 * Reads each (cryptically-named) PDF with Claude and renames it to a readable
 * "Author Year - Title.pdf", keeping it in the same subfolder and migrating its
 * highlights. Default targets arXiv-id / all-number filenames only.
 */
async function renamePapers(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const onlyCryptic = body.onlyCryptic !== false;
  const cryptic = /(^|\/)(\d{4}\.\d{4,5}(v\d+)?|\d{6,}|[0-9a-f]{8,})\.pdf$/i;
  const papers = await walkPdfs(PAPERS_DIR);
  const targets = papers.filter((p) => !onlyCryptic || cryptic.test(p));
  const highlights = await readHighlights();
  const renamed = [];

  for (const rel of targets) {
    const sp = safePaperPath(rel);
    if (!sp) continue;
    const r = await run(
      "claude",
      [
        "-p",
        `Read the PDF at papers/${rel} and reply with ONLY a filename for it and nothing else. ` +
          `Format: "FirstAuthorLastName Year - Short Title.pdf" (max ~90 chars, no slashes/quotes).`,
        "--output-format",
        "json",
        "--allowed-tools",
        "Read",
      ],
      { cwd: PROJECT_DIR, timeoutMs: 150_000 },
    );
    let name = (parseClaudeJson(r.stdout).text || "").trim().split("\n").pop().trim();
    name = name
      .replace(/^["']|["']$/g, "")
      .replace(/[/\\]/g, "-")
      .replace(/[^\w.\-() ]/g, "")
      .trim();
    if (!name) continue;
    if (!/\.pdf$/i.test(name)) name += ".pdf";

    const dir = dirname(rel);
    const prefix = dir === "." ? "" : `${dir}/`;
    let target = prefix + name;
    let n = 1;
    // collision-avoid
    while (await stat(join(PAPERS_DIR, target)).then(() => true).catch(() => false)) {
      target = `${prefix}${name.replace(/\.pdf$/i, "")} (${n++}).pdf`;
    }
    await rename(sp.full, join(PAPERS_DIR, target));
    if (highlights[rel]) {
      highlights[target] = highlights[rel];
      delete highlights[rel];
    }
    renamed.push({ from: rel, to: target });
  }

  await writeFile(HIGHLIGHTS_FILE, JSON.stringify(highlights, null, 2)).catch(() => {});
  json(res, 200, { renamed, considered: targets.length });
}

/** POST /api/figure?name=plot.png  (raw image body) -> { ok, name }.
 * Saves an image into figures/ so \includegraphics{figures/<name>} resolves. */
async function uploadFigure(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name") || "figure.png");
  await mkdir(FIGURES_DIR, { recursive: true });
  await writeFile(join(FIGURES_DIR, name), await readRawBody(req));
  json(res, 200, { ok: true, name });
}

/** POST /api/capture?name=cap.png  (raw PNG body) -> { ok, name }.
 * A cropped region of a paper, saved so Claude can Read it (vision). */
async function uploadCapture(req, res) {
  const name = safeName(new URL(req.url, "http://localhost").searchParams.get("name") || "capture.png");
  await mkdir(CAPTURES_DIR, { recursive: true });
  await writeFile(join(CAPTURES_DIR, name), await readRawBody(req));
  json(res, 200, { ok: true, name });
}

async function readHighlights() {
  try {
    return JSON.parse(await readFile(HIGHLIGHTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Highlights are stored under an arbitrary string key: a paper's relative path,
// or "compiled:<texfile>" for the compiled-PDF pane. It's only ever a JSON key.
const hlKey = (k) => String(k || "").trim();

/** GET /api/highlights?paper=<key> -> { highlights: [...] } */
async function getHighlights(req, res) {
  const key = hlKey(new URL(req.url, "http://localhost").searchParams.get("paper"));
  const all = await readHighlights();
  json(res, 200, { highlights: all[key] || [] });
}

/** POST /api/highlights { paper, highlights } -> { ok } */
async function putHighlights(req, res) {
  const { paper, highlights } = await readJsonBody(req);
  const key = hlKey(paper);
  if (!key) return json(res, 400, { ok: false });
  await mkdir(PAPERS_DIR, { recursive: true });
  const all = await readHighlights();
  if (Array.isArray(highlights) && highlights.length) all[key] = highlights;
  else delete all[key];
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
    // Continue the conversation, forking to a NEW session id each turn. The old
    // ids stay frozen on disk, so any past turn can be resumed later = rewind.
    args.push("--resume", session, "--fork-session");
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
  if (mode === "edit" && r.code === 0) {
    gitCheckpoint(`claude: ${prompt.replace(/\s+/g, " ").slice(0, 72)}`).catch(() => {});
  }
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
  const sp = safeTexPath(q.get("name"));
  if (!sp) return json(res, 400, { line: null });
  const page = parseInt(q.get("page") || "1", 10);
  const x = parseFloat(q.get("x") || "0");
  const y = parseFloat(q.get("y") || "0");
  const r = await run("synctex", ["edit", "-o", `${page}:${x}:${y}:${sp.pdfBase}`], {
    cwd: sp.dir,
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

/**
 * Commit the project (and push in the background) when it's a git repo.
 * Called after Claude edits and from the 📸 button; a no-op without .git.
 */
async function gitCheckpoint(message) {
  try {
    if (!(await stat(join(PROJECT_DIR, ".git"))).isDirectory()) return { committed: false };
  } catch {
    return { committed: false }; // not a git repo — checkpointing is opt-in
  }
  await run("git", ["add", "-A"], { cwd: PROJECT_DIR, timeoutMs: 15_000 });
  const c = await run("git", ["commit", "-m", message.slice(0, 200)], {
    cwd: PROJECT_DIR,
    timeoutMs: 15_000,
  });
  const committed = c.code === 0; // non-zero usually means "nothing to commit"
  if (committed) {
    // Push without blocking the response; failures (offline, no remote) are fine.
    run("git", ["push"], { cwd: PROJECT_DIR, timeoutMs: 60_000 }).catch(() => {});
  }
  return { committed };
}

/** POST /api/checkpoint { message } -> { ok, committed } */
async function checkpoint(req, res) {
  const { message } = await readJsonBody(req).catch(() => ({}));
  const r = await gitCheckpoint(message || "checkpoint");
  json(res, 200, { ok: true, ...r });
}

/** POST /api/pick-folder -> { ok, dir } | { ok:false, cancelled }
 * Shows the native macOS folder chooser (supports ⌘⇧G for typing a path). */
async function pickFolder(_req, res) {
  const r = await run(
    "osascript",
    ["-e", 'POSIX path of (choose folder with prompt "Open studio project folder")'],
    { timeoutMs: 180_000 },
  );
  if (r.code !== 0 || !r.stdout.trim()) return json(res, 200, { ok: false, cancelled: true });
  json(res, 200, { ok: true, dir: r.stdout.trim() });
}

const LATEX_GITIGNORE = `# LaTeX build artifacts (regenerated by latexmk)
*.aux
*.log
*.out
*.fls
*.fdb_latexmk
*.synctex.gz
*.bbl
*.blg
*.toc
/main.pdf

# studio runtime
.captures/
.DS_Store
`;

/**
 * POST /api/make-repo -> { ok, url, already? }
 * Turns the current project into a git repo with a PRIVATE GitHub remote:
 * init (if needed), identity, .gitignore, initial commit, gh repo create --push.
 */
async function makeRepo(_req, res) {
  if ((await run("gh", ["--version"], { timeoutMs: 10_000 })).code !== 0) {
    return json(res, 200, { ok: false, error: "GitHub CLI (gh) not found — install/authenticate it first." });
  }
  const isRepo = await stat(join(PROJECT_DIR, ".git")).then((s) => s.isDirectory()).catch(() => false);
  if (isRepo) {
    const remote = await run("git", ["remote", "get-url", "origin"], { cwd: PROJECT_DIR, timeoutMs: 10_000 });
    if (remote.code === 0) {
      return json(res, 200, { ok: true, already: true, url: remote.stdout.trim().replace(/\.git$/, "") });
    }
  } else {
    await run("git", ["init", "-b", "main"], { cwd: PROJECT_DIR, timeoutMs: 15_000 });
  }
  // Commit identity: prefer existing config, else GitHub login + noreply email.
  if ((await run("git", ["config", "user.email"], { cwd: PROJECT_DIR, timeoutMs: 5_000 })).code !== 0) {
    const login = (await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 })).stdout.trim();
    if (login) {
      await run("git", ["config", "user.name", login], { cwd: PROJECT_DIR, timeoutMs: 5_000 });
      await run("git", ["config", "user.email", `${login}@users.noreply.github.com`], { cwd: PROJECT_DIR, timeoutMs: 5_000 });
    }
  }
  try {
    await stat(join(PROJECT_DIR, ".gitignore"));
  } catch {
    await writeFile(join(PROJECT_DIR, ".gitignore"), LATEX_GITIGNORE);
  }
  await run("git", ["add", "-A"], { cwd: PROJECT_DIR, timeoutMs: 30_000 });
  await run("git", ["commit", "-m", "Initial commit from LaTeX Claude Studio"], { cwd: PROJECT_DIR, timeoutMs: 30_000 });
  const name = basename(PROJECT_DIR).replace(/[^\w.-]+/g, "-");
  const c = await run(
    "gh",
    ["repo", "create", name, "--private", "--source=.", "--remote=origin", "--push"],
    { cwd: PROJECT_DIR, timeoutMs: 180_000 },
  );
  if (c.code !== 0) return json(res, 200, { ok: false, error: (c.stderr || c.stdout).slice(-400) });
  const url = (c.stdout.match(/https:\/\/github\.com\/\S+/) || [`(created: ${name})`])[0];
  json(res, 200, { ok: true, url });
}

/** GET /api/project -> { dir } */
async function getProject(_req, res) {
  json(res, 200, { dir: PROJECT_DIR });
}

/** POST /api/project { dir } -> { ok, dir }. Switches the project folder and
 * persists it to ~/.latex-claude-studio.env so it sticks (and the dock app uses it). */
async function setProject(req, res) {
  const { dir } = await readJsonBody(req);
  if (!dir) return json(res, 400, { ok: false, error: "no folder given" });
  const target = resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  try {
    if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
  } catch {
    return json(res, 400, { ok: false, error: "folder not found" });
  }
  setProjectDir(target);
  await writeFile(join(process.env.HOME, ".latex-claude-studio.env"), `STUDIO_PROJECT=${target}\n`).catch(() => {});
  json(res, 200, { ok: true, dir: PROJECT_DIR });
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
  ".webmanifest": "application/manifest+json",
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
  "GET /api/project": getProject,
  "POST /api/project": setProject,
  "POST /api/checkpoint": checkpoint,
  "POST /api/pick-folder": pickFolder,
  "POST /api/make-repo": makeRepo,
  "GET /api/texfiles": listTexFiles,
  "GET /api/file": getFile,
  "POST /api/file": putFile,
  "POST /api/compile": compile,
  "GET /api/pdf": getPdf,
  "GET /api/papers": listPapers,
  "GET /api/paper": getPaper,
  "POST /api/paper": uploadPaper,
  "POST /api/rename-papers": renamePapers,
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
