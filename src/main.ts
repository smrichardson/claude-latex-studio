import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
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

const view = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      latex({ enableLinting: false }),
      oneDark,
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
    body: JSON.stringify({ content: view.state.doc.toString() }),
  });
  saveStateEl.textContent = "saved";
}

async function compile() {
  setStatus("compiling…");
  try {
    const r = await fetch("/api/compile", { method: "POST" }).then((x) => x.json());
    if (r.ok) {
      await renderCompiled(`/api/pdf?t=${Date.now()}`);
      setStatus("compiled ✓", "ok");
    } else {
      setStatus("compile error — see chat", "err");
      addMsg("sys", `LaTeX compile failed:\n\n${lastLatexError(r.log)}`);
    }
  } catch {
    setStatus("backend offline?", "err");
  }
}

async function saveAndCompile() {
  await saveFile();
  await compile();
}

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

// --- compiled PDF (clickable → SyncTeX) ----------------------------------
const compiledToken = { v: 0 };
let compiledZoom = 1;
let lastCompiledUrl = "";

async function renderCompiled(url: string) {
  lastCompiledUrl = url;
  const pages = await renderPdfInto(pdfContainer, url, compiledToken, compiledZoom);
  if (!pages) return;
  for (const p of pages) {
    p.overlay.addEventListener("click", (e) => onSyncClick(e as MouseEvent, p));
  }
}

/** Zoom helper: nudge a zoom level by a step and re-render. */
function nudgeZoom(which: "compiled" | "paper", dir: 1 | -1) {
  const factor = dir > 0 ? 1.2 : 1 / 1.2;
  if (which === "compiled") {
    compiledZoom = Math.max(0.4, Math.min(3, compiledZoom * factor));
    if (lastCompiledUrl) renderCompiled(lastCompiledUrl);
  } else {
    paperZoom = Math.max(0.4, Math.min(3, paperZoom * factor));
    const name = selectedPaper();
    if (name) renderPaper(name);
  }
}

/** Click in the compiled PDF → ask SyncTeX for the source line → jump there. */
async function onSyncClick(e: MouseEvent, p: PageInfo) {
  const rect = p.overlay.getBoundingClientRect();
  const lx = e.clientX - rect.left;
  const ly = e.clientY - rect.top;
  try {
    const { line } = await fetch(
      `/api/synctex?page=${p.pageNum}&x=${(lx / p.scale).toFixed(2)}&y=${(ly / p.scale).toFixed(2)}`,
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

/** Brief flash where you clicked, for feedback. */
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

// --- paper PDF (highlightable) -------------------------------------------
interface Highlight {
  page: number;
  x0: number; // all fractions of page size, so they survive zoom/resize
  y0: number;
  x1: number;
  y1: number;
}

const paperToken = { v: 0 };
let paperPages: PageInfo[] = [];
let paperHighlights: Highlight[] = [];
let highlightModeOn = false;
let paperZoom = 1;
let pendingCapture: string | null = null; // a cropped region queued for the next chat message

async function renderPaper(name: string) {
  paperHighlights =
    (await fetch(`/api/highlights?paper=${encodeURIComponent(name)}`).then((r) => r.json()))
      .highlights || [];
  const pages = await renderPdfInto(
    paperPdfEl,
    `/api/paper?name=${encodeURIComponent(name)}&t=${Date.now()}`,
    paperToken,
    paperZoom,
  );
  if (!pages) {
    paperPages = [];
    return;
  }
  paperPages = pages;
  paperPdfEl.classList.toggle("hl-mode", highlightModeOn);
  for (const p of pages) attachHighlightDrawing(p);
  drawHighlights();
}

/** Drag on a page (in highlight mode) to add a rectangle highlight. */
function attachHighlightDrawing(p: PageInfo) {
  p.overlay.addEventListener("mousedown", (e) => {
    if (!highlightModeOn) return;
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
      paperHighlights.push({
        page: p.pageNum,
        x0: Math.min(sx, cx) / p.cssW,
        y0: Math.min(sy, cy) / p.cssH,
        x1: Math.max(sx, cx) / p.cssW,
        y1: Math.max(sy, cy) / p.cssH,
      });
      saveHighlights();
      drawHighlights();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/** Re-paint all highlight rectangles from the model. Click one to remove it. */
function drawHighlights() {
  for (const p of paperPages) {
    p.overlay.querySelectorAll(".hl").forEach((n) => n.remove());
    paperHighlights.forEach((hl, idx) => {
      if (hl.page !== p.pageNum) return;
      const d = document.createElement("div");
      d.className = "hl";
      d.style.left = `${hl.x0 * p.cssW}px`;
      d.style.top = `${hl.y0 * p.cssH}px`;
      d.style.width = `${(hl.x1 - hl.x0) * p.cssW}px`;
      d.style.height = `${(hl.y1 - hl.y0) * p.cssH}px`;

      // Hover buttons: 💬 discuss with Claude, ✕ remove.
      const ask = document.createElement("button");
      ask.className = "hl-btn hl-ask";
      ask.textContent = "💬";
      ask.title = "Discuss this region with Claude";
      ask.addEventListener("click", (e) => {
        e.stopPropagation();
        askAboutHighlight(p, hl);
      });
      const rm = document.createElement("button");
      rm.className = "hl-btn hl-rm";
      rm.textContent = "✕";
      rm.title = "Remove highlight";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        paperHighlights.splice(idx, 1);
        saveHighlights();
        drawHighlights();
      });
      d.append(ask, rm);
      p.overlay.appendChild(d);
    });
  }
}

let saveHlTimer: number | undefined;
function saveHighlights() {
  const paper = selectedPaper();
  if (!paper) return;
  clearTimeout(saveHlTimer);
  saveHlTimer = window.setTimeout(() => {
    fetch("/api/highlights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paper, highlights: paperHighlights }),
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
    paperToken.v++; // cancel any in-flight render
    paperPages = [];
    paperHighlights = [];
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
$("hl-toggle").addEventListener("click", () => {
  highlightModeOn = !highlightModeOn;
  $("hl-toggle").classList.toggle("on", highlightModeOn);
  paperPdfEl.classList.toggle("hl-mode", highlightModeOn);
});
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

// Persist user/bot turns so the transcript survives a refresh. (Each Claude call
// is still independent — see README: multi-turn continuity is a separate step.)
type Turn = { kind: "user" | "bot"; text: string };
let transcript: Turn[] = [];
function pushTurn(kind: "user" | "bot", text: string) {
  transcript.push({ kind, text });
  transcript = transcript.slice(-100);
  localStorage.setItem("chat", JSON.stringify(transcript));
}
function restoreTranscript() {
  try {
    transcript = JSON.parse(localStorage.getItem("chat") || "[]");
  } catch {
    transcript = [];
  }
  for (const t of transcript) addMsg(t.kind, t.text);
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
  addMsg("user", userText);
  pushTurn("user", userText);
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
      body: JSON.stringify({ prompt, mode, paper, capture }),
    }).then((x) => x.json());

    pending.remove();
    addMsg("bot", r.output || "(no output)");
    pushTurn("bot", r.output || "(no output)");

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

$("send").addEventListener("click", sendToClaude);
promptEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    sendToClaude();
  }
});

// --- resizable columns ----------------------------------------------------
function initResizers() {
  const panes = Array.from(document.querySelectorAll<HTMLElement>("#panes .pane"));
  panes.forEach((p) => {
    p.style.flex = `${p.dataset.grow ?? "1"} 1 0`;
  });
  const resizers = Array.from(document.querySelectorAll<HTMLElement>("#panes .resizer"));
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
  restoreTranscript();
  updateCtx();
  setStatus("loading…");
  const { content } = await fetch("/api/file").then((x) => x.json());
  setEditorContent(content);
  saveStateEl.textContent = "saved";
  await loadPapers();
  await compile();
})();
