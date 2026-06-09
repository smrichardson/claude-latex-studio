/**
 * Rich Text (live preview) extension for the LaTeX editor.
 *
 * This is the "visual editor" mode — comparable to Overleaf's Rich Text view
 * and Obsidian's Live Preview. It does NOT introduce a separate WYSIWYG
 * document model: the LaTeX source remains the single source of truth. We only
 * *decorate* the existing CodeMirror document:
 *
 *   - inline / display math ($...$, \(...\), \[...\], $$...$$) is replaced with
 *     a KaTeX-rendered widget,
 *   - \section / \subsection / \subsubsection titles are enlarged and the
 *     command wrapper is hidden,
 *   - \textbf / \textit / \emph content is styled and the wrapper hidden,
 *   - \item is shown as a bullet.
 *
 * "Reveal on active line": any construct on a line that currently holds the
 * selection is shown as raw source, so editing stays natural. Move the cursor
 * away and it renders again.
 *
 * The module depends only on @codemirror/{view,state} and katex, so it can be
 * exercised in an isolated Vite harness as well as inside the real editor.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import katex from "katex";

/** A single thing we want to render differently, discovered by scanning a line. */
interface Match {
  from: number;
  to: number;
  deco: Decoration;
  /** Lower runs first when two matches start at the same position. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Renders a TeX fragment with KaTeX. Equal widgets are reused by CodeMirror. */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.display ? "cm-rt-math cm-rt-math-display" : "cm-rt-math";
    try {
      katex.render(this.tex, span, {
        displayMode: this.display,
        throwOnError: false,
        output: "html",
      });
    } catch {
      // KaTeX should not throw with throwOnError:false, but never let a render
      // error take down the whole editor — fall back to showing the source.
      span.textContent = this.display ? `\\[${this.tex}\\]` : `$${this.tex}$`;
      span.classList.add("cm-rt-math-error");
    }
    return span;
  }

  /** Math is opaque; clicks inside it shouldn't reposition the caret. */
  ignoreEvent() {
    return false;
  }
}

/** A bullet shown in place of \item. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-rt-bullet";
    span.textContent = "•";
    return span;
  }
}

/** A citation chip shown in place of \citep{key} / \citet{key}. */
class CitationWidget extends WidgetType {
  constructor(
    readonly keys: string,
    readonly parens: boolean,
  ) {
    super();
  }
  eq(other: CitationWidget) {
    return other.keys === this.keys && other.parens === this.parens;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-rt-cite";
    const label = this.keys
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .join(", ");
    span.textContent = this.parens ? `[${label}]` : label;
    return span;
  }
}

// ---------------------------------------------------------------------------
// Decoration factories
// ---------------------------------------------------------------------------

const hideMark = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

const boldMark = Decoration.mark({ class: "cm-rt-bold" });
const italicMark = Decoration.mark({ class: "cm-rt-italic" });
const linkMark = Decoration.mark({ class: "cm-rt-link" });

const headingMarks: Record<number, Decoration> = {
  1: Decoration.mark({ class: "cm-rt-h1" }),
  2: Decoration.mark({ class: "cm-rt-h2" }),
  3: Decoration.mark({ class: "cm-rt-h3" }),
};

// ---------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------

// Math first so we don't mis-handle a `$` inside other constructs. Each regex
// is applied to the raw line text; capture group 1 is the inner content.
const MATH_PATTERNS: Array<{ re: RegExp; display: boolean }> = [
  { re: /\$\$([^$]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\$([^$\n]+?)\$/g, display: false },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
];

const HEADING_RE = /\\(sub){0,2}section\*?\{([^}]*)\}/g;
const BOLD_RE = /\\textbf\{([^}]*)\}/g;
const ITALIC_RE = /\\(?:textit|emph)\{([^}]*)\}/g;
const ITEM_RE = /\\item\b/g;
// \begin{itemize}/\end{enumerate}/etc — hide the environment scaffolding lines.
const ENV_RE = /\\(?:begin|end)\{(?:itemize|enumerate|description)\}/g;
// \citep{a,b} / \citet{a} / \cite{a} — render as a chip showing the key(s).
const CITE_RE = /\\cite([tp]?)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g;
// \href{url}{text} — hide the url, keep text as a link.
const HREF_RE = /\\href\{[^}]*\}\{([^}]*)\}/g;
// \url{u} — show the url itself, styled as a link.
const URL_RE = /\\url\{([^}]*)\}/g;

/** True if [from,to) overlaps any range already claimed on this line. */
function overlaps(claimed: Array<[number, number]>, from: number, to: number) {
  for (const [a, b] of claimed) {
    if (from < b && to > a) return true;
  }
  return false;
}

/**
 * Collect decorations for one line of text. `base` is the document offset of
 * the line start. We claim character ranges greedily in priority order so two
 * constructs never decorate the same characters (CodeMirror forbids
 * overlapping replace decorations).
 */
function scanLine(text: string, base: number, out: Match[]) {
  const claimed: Array<[number, number]> = [];

  const claim = (from: number, to: number) => {
    claimed.push([from, to]);
  };

  // 1. Math → replace whole span with a KaTeX widget.
  for (const { re, display } of MATH_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(claimed, from, to)) continue;
      const tex = m[1].trim();
      if (!tex) continue;
      out.push({
        from,
        to,
        deco: Decoration.replace({ widget: new MathWidget(tex, display) }),
        priority: 0,
      });
      claim(from, to);
    }
  }

  // 2. Headings → hide `\section{` and the closing `}`, enlarge the title.
  HEADING_RE.lastIndex = 0;
  let h: RegExpExecArray | null;
  while ((h = HEADING_RE.exec(text))) {
    const level = h[1] ? (h[0].includes("subsub") ? 3 : 2) : 1;
    const titleStart = base + h.index + h[0].indexOf("{") + 1;
    const titleEnd = base + h.index + h[0].length - 1;
    const openFrom = base + h.index;
    if (overlaps(claimed, openFrom, titleEnd + 1)) continue;
    out.push({ from: openFrom, to: titleStart, deco: hideMark, priority: 1 });
    out.push({ from: titleStart, to: titleEnd, deco: headingMarks[level], priority: 2 });
    out.push({ from: titleEnd, to: titleEnd + 1, deco: hideMark, priority: 1 });
    claim(openFrom, titleEnd + 1);
  }

  // 3. Bold / italic → hide the wrapper, style the inner text.
  const styleWrapped = (re: RegExp, mark: Decoration) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const innerStart = base + m.index + m[0].indexOf("{") + 1;
      const innerEnd = base + m.index + m[0].length - 1;
      const wrapFrom = base + m.index;
      if (overlaps(claimed, wrapFrom, innerEnd + 1)) continue;
      out.push({ from: wrapFrom, to: innerStart, deco: hideMark, priority: 1 });
      out.push({ from: innerStart, to: innerEnd, deco: mark, priority: 2 });
      out.push({ from: innerEnd, to: innerEnd + 1, deco: hideMark, priority: 1 });
      claim(wrapFrom, innerEnd + 1);
    }
  };
  styleWrapped(BOLD_RE, boldMark);
  styleWrapped(ITALIC_RE, italicMark);

  // 4. \item → bullet.
  ITEM_RE.lastIndex = 0;
  let it: RegExpExecArray | null;
  while ((it = ITEM_RE.exec(text))) {
    const from = base + it.index;
    const to = from + it[0].length;
    if (overlaps(claimed, from, to)) continue;
    out.push({ from, to, deco: bulletDeco, priority: 1 });
    claim(from, to);
  }

  // 5. List environment scaffolding (\begin{itemize} / \end{enumerate}) → hide.
  ENV_RE.lastIndex = 0;
  let env: RegExpExecArray | null;
  while ((env = ENV_RE.exec(text))) {
    const from = base + env.index;
    const to = from + env[0].length;
    if (overlaps(claimed, from, to)) continue;
    out.push({ from, to, deco: hideMark, priority: 1 });
    claim(from, to);
  }

  // 6. Citations → chip showing the key(s).
  CITE_RE.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = CITE_RE.exec(text))) {
    const from = base + c.index;
    const to = from + c[0].length;
    if (overlaps(claimed, from, to)) continue;
    const parens = c[1] !== "t"; // \citet is textual (no brackets); \citep/\cite use [ ]
    out.push({
      from,
      to,
      deco: Decoration.replace({ widget: new CitationWidget(c[2], parens) }),
      priority: 1,
    });
    claim(from, to);
  }

  // 7. \href{url}{text} → hide url, style the visible text as a link.
  HREF_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = HREF_RE.exec(text))) {
    const textStart = base + a.index + a[0].lastIndexOf("{") + 1;
    const textEnd = base + a.index + a[0].length - 1;
    const from = base + a.index;
    if (overlaps(claimed, from, textEnd + 1)) continue;
    out.push({ from, to: textStart, deco: hideMark, priority: 1 });
    out.push({ from: textStart, to: textEnd, deco: linkMark, priority: 2 });
    out.push({ from: textEnd, to: textEnd + 1, deco: hideMark, priority: 1 });
    claim(from, textEnd + 1);
  }

  // 8. \url{u} → hide the wrapper, style the url as a link.
  URL_RE.lastIndex = 0;
  let u: RegExpExecArray | null;
  while ((u = URL_RE.exec(text))) {
    const innerStart = base + u.index + u[0].indexOf("{") + 1;
    const innerEnd = base + u.index + u[0].length - 1;
    const from = base + u.index;
    if (overlaps(claimed, from, innerEnd + 1)) continue;
    out.push({ from, to: innerStart, deco: hideMark, priority: 1 });
    out.push({ from: innerStart, to: innerEnd, deco: linkMark, priority: 2 });
    out.push({ from: innerEnd, to: innerEnd + 1, deco: hideMark, priority: 1 });
    claim(from, innerEnd + 1);
  }
}

// ---------------------------------------------------------------------------
// View plugin
// ---------------------------------------------------------------------------

function buildDecorations(view: EditorView): DecorationSet {
  const matches: Match[] = [];

  // Lines that currently hold a cursor/selection are shown as raw source.
  const activeLines = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) activeLines.add(n);
  }

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (!activeLines.has(line.number) && line.length > 0) {
        scanLine(line.text, line.from, matches);
      }
      pos = line.to + 1;
    }
  }

  // CodeMirror needs ranges sorted by `from`, then by startSide. Mark
  // decorations (priority 2) must come after the replace that hides the
  // opening brace (priority 1) at the same offset.
  matches.sort((x, y) => x.from - y.from || x.priority - y.priority);

  const builder = new RangeSetBuilder<Decoration>();
  const ranges: Array<Range<Decoration>> = matches.map((m) => m.deco.range(m.from, m.to));
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

class RichTextPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

const richTextPlugin = ViewPlugin.fromClass(RichTextPlugin, {
  decorations: (v) => v.decorations,
  // Make the math widgets atomic so the caret hops over them as one unit.
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
});

/** Styling for the decorated content. Scoped under .cm-content. */
const richTextTheme = EditorView.theme({
  ".cm-rt-h1": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-rt-h2": { fontSize: "1.35em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-rt-h3": { fontSize: "1.15em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-rt-bold": { fontWeight: "700" },
  ".cm-rt-italic": { fontStyle: "italic" },
  ".cm-rt-bullet": { paddingRight: "0.4em", opacity: "0.7" },
  ".cm-rt-cite": { color: "#89b4fa", fontVariant: "small-caps", whiteSpace: "nowrap" },
  ".cm-rt-link": { color: "#89b4fa", textDecoration: "underline" },
  ".cm-rt-math": { padding: "0 1px" },
  ".cm-rt-math-display": { display: "block", textAlign: "center", margin: "0.3em 0" },
  ".cm-rt-math-error": { color: "#ef4444" },
});

/**
 * The Rich Text extension. Add to the editor's extension list (ideally inside a
 * Compartment so it can be toggled at runtime):
 *
 *   const richTextCompartment = new Compartment();
 *   // ...extensions: [ richTextCompartment.of([]) ]
 *   view.dispatch({ effects: richTextCompartment.reconfigure(richTextPreview()) });
 */
export function richTextPreview(): Extension {
  return [richTextPlugin, richTextTheme];
}
