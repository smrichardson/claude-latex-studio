import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { codeFolding, foldEffect, unfoldEffect, foldedRanges } from "@codemirror/language";
import { latex } from "codemirror-lang-latex";
import { oneDark } from "@codemirror/theme-one-dark";
import { richTextPreview } from "./rich-text-preview";
import * as pdfjsLib from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs";

// Register the worker module on globalThis so pdf.js parses on the main thread.
// This avoids the brittle bundled-worker / workerSrc-URL dance entirely — no
// separate worker process, no network fetch — at the cost of parsing inline
// (fine for the handful of pages in a writeup).
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

// --- DOM ------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const saveStateEl = $("save-state");
const pdfContainer = $("pdf");
const logEl = $("log");
const promptEl = $<HTMLTextAreaElement>("prompt");
const paperSelect = $<HTMLSelectElement>("paper-select");
const texSelect = $<HTMLSelectElement>("tex-select");
const paperPdfEl = $("paper-pdf");
const paperEmpty = $("paper-empty");
const ctxEl = $("ctx");

function setStatus(text: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

// --- editor ---------------------------------------------------------------
const richText = new Compartment();
let richTextOn = true;
let applyingRemote = false;

const saveListener = EditorView.updateListener.of((u) => {
  if (u.docChanged && !applyingRemote) scheduleSave();
});

// --- themes ---------------------------------------------------------------
const THEMES: Record<string, { dark: boolean }> = {
  manuscript: { dark: false },
  slate: { dark: true },
  bw: { dark: false },
};
const storedTheme = localStorage.getItem("theme");
const initialTheme = storedTheme && THEMES[storedTheme] ? storedTheme : "manuscript";
document.body.dataset.theme = initialTheme; // set before first paint to avoid a flash

const editorTheme = new Compartment();
// Light themes: transparent editor so the pane's paper colour shows; vars drive it.
const lightEditorTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "var(--fg)" },
    ".cm-content": { caretColor: "var(--fg)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", borderRight: "1px solid var(--border)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--panel)",
      color: "var(--muted)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      padding: "0 6px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
    },
  },
  { dark: false },
);
// Dark theme: keep oneDark's syntax colours but let the pane background show through.
const darkEditorBg = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "transparent" },
});
const editorThemeExt = (name: string) =>
  THEMES[name]?.dark ? [oneDark, darkEditorBg] : lightEditorTheme;

const view = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      codeFolding({ placeholderText: "⋯  preamble (packages & macros) — click to show  ⋯" }),
      latex({ enableLinting: false }),
      editorTheme.of(editorThemeExt(initialTheme)),
      EditorView.lineWrapping,
      richText.of(richTextPreview()),
      saveListener,
    ],
  }),
  parent: $("editor"),
});

function setEditorContent(text: string) {
  applyingRemote = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  applyingRemote = false;
}

// --- file sync + compile --------------------------------------------------
let activeTex = ""; // the .tex file currently being edited (relative to project)
let saveTimer: number | undefined;
function scheduleSave() {
  saveStateEl.textContent = "unsaved…";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveAndCompile, 700);
}

async function saveFile() {
  await fetch("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: activeTex, content: view.state.doc.toString() }),
  });
  saveStateEl.textContent = "saved";
}

async function compile() {
  setStatus("compiling…");
  try {
    const r = await fetch("/api/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: activeTex }),
    }).then((x) => x.json());
    if (r.ok) {
      await renderCompiled(`/api/pdf?name=${encodeURIComponent(activeTex)}&t=${Date.now()}`);
      setStatus("compiled ✓", "ok");
    } else {
      setStatus("compile error — see chat", "err");
      addMsg("sys", `LaTeX compile failed:\n\n${lastLatexError(r.log)}`);
    }
  } catch {
    setStatus("backend offline?", "err");
  }
}

// Compiles must never overlap: two latexmk runs in one directory fight over the
// aux files and the loser leaves a stale PDF. If a save lands mid-compile, we
// queue exactly one follow-up run that picks up the latest content.
let compileBusy = false;
let compileQueued = false;
async function saveAndCompile() {
  if (compileBusy) {
    compileQueued = true;
    return;
  }
  compileBusy = true;
  try {
    do {
      compileQueued = false;
      await saveFile();
      await compile();
    } while (compileQueued);
  } finally {
    compileBusy = false;
  }
}

/** Open a .tex file: load its content, make it the active file, compile it. */
async function openTex(name: string) {
  activeTex = name;
  localStorage.setItem("activeTex", name);
  texSelect.value = name;
  const { content } = await fetch(`/api/file?name=${encodeURIComponent(name)}`).then((x) => x.json());
  setEditorContent(content);
  saveStateEl.textContent = "saved";
  await saveAndCompile(); // through the compile lock (content just loaded → save is a no-op)
}

/** Populate the .tex file picker and open the remembered (or default) one. */
async function loadTexFiles() {
  const r = await fetch("/api/texfiles").then((x) => x.json());
  const files: string[] = r.files || [];
  texSelect.innerHTML = files
    .map((f) => `<option value="${f.replace(/"/g, "&quot;")}">${f.replace(/\.tex$/i, "")}</option>`)
    .join("");
  const stored = localStorage.getItem("activeTex") || "";
  const pick = files.includes(stored) ? stored : files.includes(r.default) ? r.default : files[0] || r.default;
  await openTex(pick);
}

texSelect.addEventListener("change", async () => {
  clearTimeout(saveTimer);
  await saveFile(); // flush the current file before switching
  await openTex(texSelect.value);
});

function lastLatexError(log: string): string {
  const lines = (log || "").split("\n");
  const hits = lines.filter((l) => /^!|error|Undefined|\.tex:\d+/i.test(l));
  return (hits.slice(-12).join("\n") || log.slice(-600) || "(no log)").trim();
}

// --- shared pdf.js renderer ----------------------------------------------
interface PageInfo {
  pageNum: number;
  wrap: HTMLElement;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  scale: number; // CSS px per PDF point
  cssW: number;
  cssH: number;
}

/**
 * Render a PDF into `container` as one canvas + transparent overlay per page.
 * `tokenRef.v` guards against an older render finishing after a newer one.
 * Returns the page layout so callers can attach clicks (SyncTeX) or highlights.
 */
async function renderPdfInto(
  container: HTMLElement,
  url: string,
  tokenRef: { v: number },
  zoom = 1,
): Promise<PageInfo[] | null> {
  const token = ++tokenRef.v;
  let doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    doc = await pdfjsLib.getDocument({ url }).promise;
  } catch (err) {
    container.innerHTML = `<div class="empty">PDF render error: ${String(err)}</div>`;
    return null;
  }
  if (token !== tokenRef.v) return null;

  const prevScroll = container.scrollTop;
  container.innerHTML = "";
  const dpr = window.devicePixelRatio || 1;
  const targetW = container.clientWidth - 24;
  const pages: PageInfo[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (token !== tokenRef.v) return null;
    const unit = page.getViewport({ scale: 1 });
    const scale = Math.max(0.25, Math.min(4, (targetW / unit.width) * zoom));
    const vp = page.getViewport({ scale: scale * dpr });
    const cssW = Math.floor(vp.width / dpr);
    const cssH = Math.floor(vp.height / dpr);

    const wrap = document.createElement("div");
    wrap.className = "pg";
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;

    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    container.appendChild(wrap);
    pages.push({ pageNum: n, wrap, overlay, canvas, scale, cssW, cssH });
  }
  container.scrollTop = prevScroll;
  return pages;
}

// --- highlightable PDF panes (paper + compiled share one implementation) --
interface Highlight {
  page: number;
  x0: number; // all fractions of page size, so they survive zoom/resize
  y0: number;
  x1: number;
  y1: number;
}

interface HLPane {
  el: HTMLElement;
  token: { v: number };
  pages: PageInfo[];
  list: Highlight[];
  mode: boolean; // highlight (draw) mode on?
  zoom: number;
  key: () => string | null; // storage key for this pane's current document
  withAsk: boolean; // show the 💬 discuss-with-Claude button (paper only)
  onBareClick?: (e: MouseEvent, p: PageInfo) => void; // when NOT in highlight mode (SyncTeX)
  lastUrl: string;
  reRender: () => void;
  saveTimer?: number;
}

let pendingCapture: string | null = null; // a cropped region queued for the next chat message

const compiledPane: HLPane = {
  el: pdfContainer,
  token: { v: 0 },
  pages: [],
  list: [],
  mode: false,
  zoom: 1,
  key: () => (activeTex ? `compiled:${activeTex}` : null),
  withAsk: false,
  onBareClick: onSyncClick,
  lastUrl: "",
  reRender: () => {
    if (compiledPane.lastUrl) renderPane(compiledPane, compiledPane.lastUrl);
  },
};

const paperPane: HLPane = {
  el: paperPdfEl,
  token: { v: 0 },
  pages: [],
  list: [],
  mode: false,
  zoom: 1,
  key: () => selectedPaper() || null,
  withAsk: true,
  lastUrl: "",
  reRender: () => {
    const n = selectedPaper();
    if (n) renderPaper(n);
  },
};

/** Render a PDF into a pane and wire up highlights + (optional) SyncTeX clicks. */
async function renderPane(pane: HLPane, url: string) {
  pane.lastUrl = url;
  const key = pane.key();
  pane.list = key
    ? (await fetch(`/api/highlights?paper=${encodeURIComponent(key)}`).then((r) => r.json())).highlights || []
    : [];
  const pages = await renderPdfInto(pane.el, url, pane.token, pane.zoom);
  if (!pages) {
    pane.pages = [];
    return;
  }
  pane.pages = pages;
  pane.el.classList.toggle("hl-mode", pane.mode);
  for (const p of pages) {
    attachDraw(pane, p);
    if (pane.onBareClick) {
      p.overlay.addEventListener("click", (e) => {
        if (!pane.mode) pane.onBareClick!(e as MouseEvent, p);
      });
    }
  }
  drawPaneHighlights(pane);
}

const renderCompiled = (url: string) => renderPane(compiledPane, url);
const renderPaper = (name: string) =>
  renderPane(paperPane, `/api/paper?name=${encodeURIComponent(name)}&t=${Date.now()}`);

/** Zoom: nudge a pane's zoom and re-render. */
function nudgeZoom(which: "compiled" | "paper", dir: 1 | -1) {
  const pane = which === "compiled" ? compiledPane : paperPane;
  pane.zoom = Math.max(0.4, Math.min(3, pane.zoom * (dir > 0 ? 1.2 : 1 / 1.2)));
  pane.reRender();
}

/** Click in the compiled PDF (not in highlight mode) → SyncTeX → jump to source. */
async function onSyncClick(e: MouseEvent, p: PageInfo) {
  const rect = p.overlay.getBoundingClientRect();
  const lx = e.clientX - rect.left;
  const ly = e.clientY - rect.top;
  try {
    const { line } = await fetch(
      `/api/synctex?name=${encodeURIComponent(activeTex)}&page=${p.pageNum}` +
        `&x=${(lx / p.scale).toFixed(2)}&y=${(ly / p.scale).toFixed(2)}`,
    ).then((r) => r.json());
    if (line) {
      jumpToLine(line);
      flashAt(p.wrap, lx, ly);
    }
  } catch {
    /* synctex unavailable — ignore */
  }
}

function jumpToLine(line: number) {
  const n = Math.max(1, Math.min(view.state.doc.lines, line));
  const l = view.state.doc.line(n);
  view.dispatch({
    selection: { anchor: l.from },
    effects: EditorView.scrollIntoView(l.from, { y: "center" }),
  });
  view.focus();
}

function flashAt(wrap: HTMLElement, x: number, y: number) {
  const f = document.createElement("div");
  f.className = "flash";
  f.style.left = `${x - 60}px`;
  f.style.top = `${y - 9}px`;
  f.style.width = "120px";
  f.style.height = "18px";
  wrap.appendChild(f);
  requestAnimationFrame(() => (f.style.opacity = "0"));
  setTimeout(() => f.remove(), 650);
}

/** Drag on a page (in highlight mode) to add a rectangle highlight. */
function attachDraw(pane: HLPane, p: PageInfo) {
  p.overlay.addEventListener("mousedown", (e) => {
    if (!pane.mode) return;
    e.preventDefault();
    const rect = p.overlay.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const draft = document.createElement("div");
    draft.className = "hl-draft";
    p.overlay.appendChild(draft);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const move = (ev: MouseEvent) => {
      const cx = clamp(ev.clientX - rect.left, p.cssW);
      const cy = clamp(ev.clientY - rect.top, p.cssH);
      draft.style.left = `${Math.min(sx, cx)}px`;
      draft.style.top = `${Math.min(sy, cy)}px`;
      draft.style.width = `${Math.abs(cx - sx)}px`;
      draft.style.height = `${Math.abs(cy - sy)}px`;
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      draft.remove();
      const cx = clamp(ev.clientX - rect.left, p.cssW);
      const cy = clamp(ev.clientY - rect.top, p.cssH);
      if (Math.abs(cx - sx) < 6 || Math.abs(cy - sy) < 6) return; // ignore stray clicks
      pane.list.push({
        page: p.pageNum,
        x0: Math.min(sx, cx) / p.cssW,
        y0: Math.min(sy, cy) / p.cssH,
        x1: Math.max(sx, cx) / p.cssW,
        y1: Math.max(sy, cy) / p.cssH,
      });
      savePaneHighlights(pane);
      drawPaneHighlights(pane);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/** Re-paint a pane's highlight rectangles. Hover for remove (and discuss, on paper). */
function drawPaneHighlights(pane: HLPane) {
  for (const p of pane.pages) {
    p.overlay.querySelectorAll(".hl").forEach((n) => n.remove());
    pane.list.forEach((hl, idx) => {
      if (hl.page !== p.pageNum) return;
      const d = document.createElement("div");
      d.className = "hl";
      d.style.left = `${hl.x0 * p.cssW}px`;
      d.style.top = `${hl.y0 * p.cssH}px`;
      d.style.width = `${(hl.x1 - hl.x0) * p.cssW}px`;
      d.style.height = `${(hl.y1 - hl.y0) * p.cssH}px`;

      if (pane.withAsk) {
        const ask = document.createElement("button");
        ask.className = "hl-btn hl-ask";
        ask.textContent = "💬";
        ask.title = "Discuss this region with Claude";
        ask.addEventListener("click", (e) => {
          e.stopPropagation();
          askAboutHighlight(p, hl);
        });
        d.append(ask);
      }
      const rm = document.createElement("button");
      rm.className = "hl-btn hl-rm";
      rm.textContent = "✕";
      rm.title = "Remove highlight";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        pane.list.splice(idx, 1);
        savePaneHighlights(pane);
        drawPaneHighlights(pane);
      });
      d.append(rm);
      p.overlay.appendChild(d);
    });
  }
}

function savePaneHighlights(pane: HLPane) {
  const key = pane.key();
  if (!key) return;
  clearTimeout(pane.saveTimer);
  pane.saveTimer = window.setTimeout(() => {
    fetch("/api/highlights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paper: key, highlights: pane.list }),
    });
  }, 250);
}

/** Crop a highlight out of the page canvas, upload it, and queue it for chat. */
let captureSeq = 0;
async function askAboutHighlight(p: PageInfo, hl: Highlight) {
  const sx = Math.round(hl.x0 * p.canvas.width);
  const sy = Math.round(hl.y0 * p.canvas.height);
  const sw = Math.max(1, Math.round((hl.x1 - hl.x0) * p.canvas.width));
  const sh = Math.max(1, Math.round((hl.y1 - hl.y0) * p.canvas.height));
  const off = document.createElement("canvas");
  off.width = sw;
  off.height = sh;
  off.getContext("2d")?.drawImage(p.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob: Blob | null = await new Promise((r) => off.toBlob((b) => r(b), "image/png"));
  if (!blob) return;
  const name = `cap-${captureSeq++}-${blob.size}.png`;
  await fetch(`/api/capture?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: await blob.arrayBuffer(),
  });
  pendingCapture = name;
  updateCtx();
  promptEl.placeholder = "Ask about the highlighted region…";
  promptEl.focus();
}

// --- rich text + compile buttons -----------------------------------------
$("toggle-rt").addEventListener("click", () => {
  richTextOn = !richTextOn;
  view.dispatch({ effects: richText.reconfigure(richTextOn ? richTextPreview() : []) });
  const btn = $("toggle-rt");
  btn.textContent = `Rich Text: ${richTextOn ? "ON" : "OFF"}`;
  btn.classList.toggle("on", richTextOn);
});
$("compile").addEventListener("click", saveAndCompile);
$("save-btn").addEventListener("click", () => {
  clearTimeout(saveTimer);
  saveAndCompile();
});
$("checkpoint-btn").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  await saveFile();
  setStatus("checkpointing…");
  const r = await fetch("/api/checkpoint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "manual checkpoint from studio" }),
  })
    .then((x) => x.json())
    .catch(() => ({ committed: false }));
  setStatus(r.committed ? "checkpoint committed ✓" : "no changes (or not a git repo)", r.committed ? "ok" : "");
});
$("repo-btn").addEventListener("click", async () => {
  if (!confirm("Create a PRIVATE GitHub repo for this project and push it?")) return;
  setStatus("creating GitHub repo…");
  const r = await fetch("/api/make-repo", { method: "POST" })
    .then((x) => x.json())
    .catch(() => ({ ok: false, error: "request failed" }));
  if (r.ok) {
    setStatus(r.already ? "already on GitHub ✓" : "private repo created ✓", "ok");
    addMsg("sys", (r.already ? "Already connected to GitHub: " : "Created private GitHub repo: ") + r.url);
  } else {
    setStatus("repo creation failed", "err");
    addMsg("sys", `GitHub repo creation failed:\n${r.error || "(unknown error)"}`);
  }
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault(); // Cmd/Ctrl+S = save now
    clearTimeout(saveTimer);
    saveAndCompile();
  }
});

// project switcher
async function refreshProjectLabel(): Promise<string> {
  try {
    const { dir } = await fetch("/api/project").then((x) => x.json());
    $("project-name").textContent = dir.split("/").filter(Boolean).pop() || "project";
    return dir;
  } catch {
    return "";
  }
}
$("project-btn").addEventListener("click", async () => {
  const cur = await refreshProjectLabel();
  // Native folder chooser first (⌘⇧G inside it types a path); prompt() only if
  // the picker is unavailable (e.g. running headless / not on macOS).
  let dir: string | null = null;
  const picked = await fetch("/api/pick-folder", { method: "POST" })
    .then((x) => x.json())
    .catch(() => ({ ok: false, unavailable: true }));
  if (picked.ok) dir = picked.dir;
  else if (picked.cancelled) return;
  else dir = prompt("Open project folder (absolute path):", cur);
  if (!dir || dir.trim() === cur) return;
  setStatus("switching project…");
  try {
    const r = await fetch("/api/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dir.trim() }),
    }).then((x) => x.json());
    if (!r.ok) {
      setStatus(`project: ${r.error || "failed"}`, "err");
      return;
    }
    paperSelect.value = "";
    showPaper(""); // clear the paper pane (project-specific)
    await loadPapers();
    await loadTexFiles();
    await refreshProjectLabel();
    setStatus("project switched ✓", "ok");
  } catch {
    setStatus("project switch failed", "err");
  }
});

// theme switcher
function applyTheme(name: string) {
  if (!THEMES[name]) name = "manuscript";
  document.body.dataset.theme = name;
  localStorage.setItem("theme", name);
  view.dispatch({ effects: editorTheme.reconfigure(editorThemeExt(name)) });
  ($("theme-select") as HTMLSelectElement).value = name;
}
$("theme-select").addEventListener("change", (e) => applyTheme((e.target as HTMLSelectElement).value));
const urlTheme = new URLSearchParams(location.search).get("theme") || "";
applyTheme(THEMES[urlTheme] ? urlTheme : initialTheme);

// --- insert images into the writeup --------------------------------------
function figureSnippet(name: string): string {
  const label = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "");
  return `\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{figures/${name}}\n  \\caption{}\n  \\label{fig:${label}}\n\\end{figure}\n`;
}

function insertAtCursor(text: string) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  view.focus(); // the doc change triggers autosave + recompile
}

async function uploadAndInsertImage(file: File) {
  if (!file.type.startsWith("image/")) return;
  // LaTeX-safe filename: no spaces/odd chars (\includegraphics dislikes them).
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  setStatus(`uploading ${safe}…`);
  const r = await fetch(`/api/figure?name=${encodeURIComponent(safe)}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: await file.arrayBuffer(),
  }).then((x) => x.json());
  insertAtCursor(figureSnippet(r.name || safe));
  setStatus("image inserted ✓", "ok");
}

// editor font size (CodeMirror, KaTeX widgets, and headings all scale in em)
let editorFont = parseInt(localStorage.getItem("editorFont") || "14", 10);
function applyEditorFont() {
  $("editor").style.fontSize = `${editorFont}px`;
  localStorage.setItem("editorFont", String(editorFont));
  view.requestMeasure();
}
$("ef-dec").addEventListener("click", () => {
  editorFont = Math.max(10, editorFont - 1);
  applyEditorFont();
});
$("ef-inc").addEventListener("click", () => {
  editorFont = Math.min(24, editorFont + 1);
  applyEditorFont();
});

$("img-insert").addEventListener("click", () => $<HTMLInputElement>("img-file").click());
$<HTMLInputElement>("img-file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) uploadAndInsertImage(input.files[0]);
  input.value = "";
});

// Drag an image file straight onto the editor to insert it at the cursor.
const editorEl = $("editor");
editorEl.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
editorEl.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  for (const f of files) uploadAndInsertImage(f);
});

// --- hide/show the preamble (fold everything before \begin{document}) ----
function preambleFold(): { from: number; to: number } | null {
  let r: { from: number; to: number } | null = null;
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    if (from === 0 && !r) r = { from, to };
  });
  return r;
}

function togglePreamble() {
  const existing = preambleFold();
  if (existing) {
    view.dispatch({ effects: unfoldEffect.of(existing) });
  } else {
    const idx = view.state.doc.toString().indexOf("\\begin{document}");
    if (idx <= 0) return;
    const to = view.state.doc.lineAt(idx).from - 1; // up to the newline before \begin{document}
    if (to <= 0) return;
    view.dispatch({ effects: foldEffect.of({ from: 0, to }) });
  }
  const folded = !!preambleFold();
  const btn = $("preamble-toggle");
  btn.textContent = folded ? "Show preamble" : "Hide preamble";
  btn.classList.toggle("on", folded);
}
$("preamble-toggle").addEventListener("click", togglePreamble);

// --- papers ---------------------------------------------------------------
function selectedPaper(): string {
  return paperSelect.value;
}

function showPaper(name: string) {
  if (name) {
    localStorage.setItem("lastPaper", name); // restore on next launch
    paperPdfEl.style.display = "block";
    paperEmpty.style.display = "none";
    renderPaper(name);
  } else {
    localStorage.removeItem("lastPaper");
    paperPane.token.v++; // cancel any in-flight render
    paperPane.pages = [];
    paperPane.list = [];
    paperPdfEl.innerHTML = "";
    paperPdfEl.style.display = "none";
    paperEmpty.style.display = "block";
  }
  updateCtx();
}

function updateCtx() {
  const p = selectedPaper();
  let txt = p ? `writeup + “${p}”` : "writeup only";
  if (pendingCapture) txt += "  ·  📎 region";
  ctxEl.textContent = txt;
}

async function loadPapers(selectName?: string) {
  const { papers } = await fetch("/api/papers").then((x) => x.json());
  const prev = selectName ?? (selectedPaper() || localStorage.getItem("lastPaper") || "");
  paperSelect.innerHTML =
    `<option value="">— none —</option>` +
    papers.map((p: string) => `<option value="${p}">${p}</option>`).join("");
  if (prev && papers.includes(prev)) paperSelect.value = prev;
  showPaper(paperSelect.value);
}

paperSelect.addEventListener("change", () => showPaper(selectedPaper()));
$("paper-refresh").addEventListener("click", () => loadPapers());
$("paper-tidy").addEventListener("click", async () => {
  if (
    !confirm(
      "Rename arXiv-numbered / cryptic PDFs to readable “Author Year - Title” names?\nClaude reads each (~10-15s per paper).",
    )
  )
    return;
  const prev = selectedPaper();
  setStatus("tidying paper names…");
  try {
    const r = await fetch("/api/rename-papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((x) => x.json());
    const map = Object.fromEntries((r.renamed || []).map((x: { from: string; to: string }) => [x.from, x.to]));
    await loadPapers(map[prev] || prev);
    const n = r.renamed?.length || 0;
    setStatus(n ? `renamed ${n} paper(s) ✓` : "nothing to tidy", n ? "ok" : "");
    if (n) addMsg("sys", "Renamed:\n" + r.renamed.map((x: { to: string }) => `• ${x.to}`).join("\n"));
  } catch {
    setStatus("rename failed", "err");
  }
});
$("paper-upload-btn").addEventListener("click", () => $<HTMLInputElement>("paper-file").click());
$<HTMLInputElement>("paper-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  setStatus(`uploading ${file.name}…`);
  await fetch(`/api/paper?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: await file.arrayBuffer(),
  });
  setStatus("uploaded ✓", "ok");
  await loadPapers(file.name);
});

// highlight mode + clear
function toggleHighlightMode(pane: HLPane, btnId: string) {
  pane.mode = !pane.mode;
  $(btnId).classList.toggle("on", pane.mode);
  pane.el.classList.toggle("hl-mode", pane.mode);
}
$("hl-toggle").addEventListener("click", () => toggleHighlightMode(paperPane, "hl-toggle"));
$("chl-toggle").addEventListener("click", () => toggleHighlightMode(compiledPane, "chl-toggle"));
$("pz-out").addEventListener("click", () => nudgeZoom("paper", -1));
$("pz-in").addEventListener("click", () => nudgeZoom("paper", 1));
$("cz-out").addEventListener("click", () => nudgeZoom("compiled", -1));
$("cz-in").addEventListener("click", () => nudgeZoom("compiled", 1));

// --- Claude chat ----------------------------------------------------------
function addMsg(kind: "user" | "bot" | "sys", text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

// Persist user/bot turns so the transcript survives a refresh — and make every
// user turn a CHECKPOINT. Each Claude call resumes with --fork-session, so the
// session id recorded before a turn stays frozen on disk forever; rewinding is
// just "resume that old id + restore the .tex snapshot taken at send time".
type Turn = {
  kind: "user" | "bot";
  text: string;
  session?: string | null; // user turns: the session id active BEFORE this message
  tex?: string; // user turns: the document at send time
  texName?: string; // which .tex file the snapshot belongs to
};
let transcript: Turn[] = [];
let claudeSession: string | null = localStorage.getItem("claudeSession"); // resume id for multi-turn memory

function persistTranscript() {
  // Cap stored size: keep tex snapshots only on the most recent 15 user turns.
  const slim = transcript.slice(-100);
  let snapshots = 0;
  for (let i = slim.length - 1; i >= 0; i--) {
    if (slim[i].tex != null && ++snapshots > 15) {
      slim[i] = { ...slim[i], tex: undefined };
    }
  }
  localStorage.setItem("chat", JSON.stringify(slim));
}

function pushTurn(turn: Turn) {
  transcript.push(turn);
  transcript = transcript.slice(-100);
  persistTranscript();
}

/** Rewind to just before user turn `idx`: restore chat, session, and TeX. */
async function rewindTo(idx: number) {
  const t = transcript[idx];
  if (!t || t.kind !== "user") return;
  if (!confirm("Rewind to before this message? Later chat turns are discarded" + (t.tex != null ? " and the document is restored to that point." : "."))) return;
  claudeSession = t.session ?? null;
  if (claudeSession) localStorage.setItem("claudeSession", claudeSession);
  else localStorage.removeItem("claudeSession");
  transcript = transcript.slice(0, idx);
  persistTranscript();
  redrawTranscript();
  addMsg("sys", "⏪ Rewound. The conversation continues from this point.");
  // Put the original message back in the composer so it can be edited/resent.
  promptEl.value = t.text.replace(/\n\n\[[^\]]*\]$/, "");
  promptEl.focus();
  if (t.tex != null) {
    if (t.texName && t.texName !== activeTex) await openTex(t.texName);
    setEditorContent(t.tex);
    await saveAndCompile();
  }
}

function renderTurn(t: Turn, idx: number) {
  const div = addMsg(t.kind, t.text);
  if (t.kind === "user") {
    const rw = document.createElement("button");
    rw.className = "rw";
    rw.textContent = "⏪";
    rw.title = "Rewind to before this message (restores the document too)";
    rw.addEventListener("click", () => rewindTo(idx));
    div.appendChild(rw);
  }
}

function redrawTranscript() {
  logEl.innerHTML = "";
  transcript.forEach((t, i) => renderTurn(t, i));
}

function restoreTranscript() {
  try {
    transcript = JSON.parse(localStorage.getItem("chat") || "[]");
  } catch {
    transcript = [];
  }
  redrawTranscript();
}

async function sendToClaude() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const mode = $<HTMLInputElement>("editmode").checked ? "edit" : "ask";
  const paper = selectedPaper() || undefined;
  const capture = pendingCapture || undefined;
  promptEl.value = "";
  const tags = [paper ? `about: ${paper}` : "", capture ? "📎 highlighted region" : ""].filter(Boolean);
  const userText = prompt + (tags.length ? `\n\n[${tags.join("; ")}]` : "");
  // Checkpoint: the pre-send session id + document state make this turn rewindable.
  pushTurn({
    kind: "user",
    text: userText,
    session: claudeSession,
    tex: view.state.doc.toString(),
    texName: activeTex,
  });
  renderTurn(transcript[transcript.length - 1], transcript.length - 1);
  const pending = addMsg(
    "sys",
    mode === "edit"
      ? "Claude is editing the files…"
      : capture
        ? "Claude is looking at the highlighted region…"
        : paper
          ? `Claude is reading ${paper}…`
          : "Claude is thinking…",
  );
  // capture is one-shot: clear it now that it's attached to this message
  pendingCapture = null;
  promptEl.placeholder = "Chat with Claude!";
  updateCtx();

  try {
    const r = await fetch("/api/claude", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        mode,
        paper,
        capture,
        session: claudeSession || undefined,
        model: modelSelect.value || undefined,
      }),
    }).then((x) => x.json());

    if (r.session) {
      claudeSession = r.session;
      localStorage.setItem("claudeSession", r.session); // remember the conversation
    }
    pending.remove();
    addMsg("bot", r.output || "(no output)");
    pushTurn({ kind: "bot", text: r.output || "(no output)" });

    if (mode === "edit") {
      if (r.content != null && r.content !== view.state.doc.toString()) {
        setEditorContent(r.content);
        addMsg("sys", "Applied Claude's edits — recompiling.");
      }
      await saveAndCompile(); // bib/aux may have changed even if main.tex didn't
    }
  } catch (e) {
    pending.remove();
    addMsg("sys", `Request failed: ${e}`);
  }
}

// per-message model override (persisted); "" = your Claude Code default
const modelSelect = $<HTMLSelectElement>("model-select");
{
  const saved = localStorage.getItem("chatModel") || "";
  if (Array.from(modelSelect.options).some((o) => o.value === saved)) modelSelect.value = saved;
}
modelSelect.addEventListener("change", () => localStorage.setItem("chatModel", modelSelect.value));

$("send").addEventListener("click", sendToClaude);
promptEl.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter inserts a newline (Cmd/Ctrl+Enter still works).
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendToClaude();
  }
});
$("new-chat").addEventListener("click", () => {
  claudeSession = null;
  transcript = [];
  localStorage.removeItem("claudeSession");
  localStorage.removeItem("chat");
  logEl.innerHTML = "";
  addMsg("sys", "New conversation. Claude won't remember the previous chat.");
});

// --- panel visibility -------------------------------------------------------
const paneEls = Array.from(document.querySelectorAll<HTMLElement>("#panes .pane"));
const resizerEls = Array.from(document.querySelectorAll<HTMLElement>("#panes .resizer"));
let panesVisible: boolean[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("panesVisible") || "");
    if (Array.isArray(v) && v.length === paneEls.length) return v;
  } catch {
    /* default below */
  }
  return paneEls.map(() => true);
})();

function applyPaneVisibility() {
  paneEls.forEach((p, i) => p.classList.toggle("hidden", !panesVisible[i]));
  // A resizer sits between panes i and i+1; only show it when both are visible.
  resizerEls.forEach((r, i) => r.classList.toggle("hidden", !(panesVisible[i] && panesVisible[i + 1])));
  panesVisible.forEach((v, i) => $(`pv-${i}`).classList.toggle("on", v));
  localStorage.setItem("panesVisible", JSON.stringify(panesVisible));
}

function togglePane(i: number) {
  if (panesVisible[i] && panesVisible.filter(Boolean).length === 1) return; // keep ≥1 visible
  panesVisible[i] = !panesVisible[i];
  applyPaneVisibility();
  // PDF panes render at their container width — re-render after a size change.
  if (panesVisible[0] && i === 0) paperPane.reRender();
  if (panesVisible[2] && i === 2) compiledPane.reRender();
}
for (let i = 0; i < paneEls.length; i++) $(`pv-${i}`).addEventListener("click", () => togglePane(i));

// --- resizable columns ----------------------------------------------------
function initResizers() {
  const panes = paneEls;
  panes.forEach((p) => {
    p.style.flex = `${p.dataset.grow ?? "1"} 1 0`;
  });
  const resizers = resizerEls;
  resizers.forEach((rz, i) => {
    const left = panes[i];
    const right = panes[i + 1];
    rz.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const total = left.getBoundingClientRect().width + right.getBoundingClientRect().width;
      const gL = parseFloat(left.style.flexGrow || "1");
      const gR = parseFloat(right.style.flexGrow || "1");
      const sumG = gL + gR;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const frac = Math.max(-0.85, Math.min(0.85, dx / total));
        left.style.flexGrow = String(Math.max(0.1, gL + frac * sumG));
        right.style.flexGrow = String(Math.max(0.1, gR - frac * sumG));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// --- boot -----------------------------------------------------------------
(async function boot() {
  initResizers();
  applyPaneVisibility();
  applyEditorFont();
  restoreTranscript();
  updateCtx();
  setStatus("loading…");
  await refreshProjectLabel();
  await loadPapers();
  await loadTexFiles(); // sets the active .tex, loads it, and compiles
})();
