import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  ItemView,
  Plugin,
  Modal,
  Notice,
  TFile,
  TFolder,
  Setting,
  SuggestModal,
  PluginSettingTab,
  WorkspaceLeaf,
} from "obsidian";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TestCase {
  line: string;
  name: string;
  tags: string[];
  lineNumber: number;
  indent: number;
  children: TestCase[];
  hasChildren: boolean;
  isHeading?: boolean;
  headingLevel?: number;
  isManuallyAdded?: boolean;
  /** True for an actual `- [ ]` checklist line. False for other non-empty,
   *  non-heading lines (plain descriptions) — these are only kept in the
   *  tree when nested under a real checklist item; see pruneOrphanText. */
  hasCheckbox?: boolean;
}

type TagState = "neutral" | "include" | "exclude";

// ─── Playwright integration types ────────────────────────────────────────────

interface PwTestResult { status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted" }
/** `status` is Playwright's own computed outcome (TestCase.outcome()) — use
 *  this, not results[0].status: a genuinely skipped test can have an empty
 *  `results` array (nothing ever ran), so results[0] is undefined while
 *  `status` still correctly reports "skipped". */
interface PwTest { status: "expected" | "unexpected" | "flaky" | "skipped"; results: PwTestResult[] }
interface PwSpec { title: string; ok: boolean; tests: PwTest[] }
interface PwSuite { title: string; suites?: PwSuite[]; specs?: PwSpec[] }
interface PwJsonReport { suites: PwSuite[] }

// ─── Constants ───────────────────────────────────────────────────────────────


const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const DASHBOARD_MARKER = "<!-- tms-dashboard -->";
const PW_PANEL_VIEW_TYPE = "tms-playwright-panel";
const STATS_SECTION_RE = /\n+---\n+## Test Results Statistics[\s\S]*$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTestCase(line: string, lineNumber: number): TestCase | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
  if (headingMatch) {
    const headingLevel = headingMatch[1].length;
    const rawName = headingMatch[2].trim();
    const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
    const tags: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(rawName)) !== null) tags.push(m[1].toLowerCase());
    const firstTagIndex = rawName.search(/@[\p{L}\p{N}_-]+/u);
    const name = firstTagIndex >= 0 ? rawName.slice(0, firstTagIndex).trim() : rawName;
    return { line: trimmed, name, tags, lineNumber, indent: 0, children: [], hasChildren: false, isHeading: true, headingLevel };
  }

  const hasCheckbox = /^-\s*\[[^\]]*\]/.test(trimmed);

  const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
  const tabCount = (leadingWhitespace.match(/\t/g) || []).length;
  const spaceCount = (leadingWhitespace.match(/ /g) || []).length;
  const indent = tabCount + Math.floor(spaceCount / 2);

  const normalized = trimmed
    .replace(/^-\s*\[[^\]]*\]\s*/, "")
    .replace(/^-\s*/, "")
    .replace(/^(✅ Pass|❌ Fail|⏭️ Skipped|🚫 Blocked)\s*\|\s*/, "")
    .replace(/^\*\*(.*?)\*\*(.*)$/, "$1$2");

  const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
  const tags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(normalized)) !== null) {
    tags.push(match[1].toLowerCase());
  }

  const firstTagIndex = normalized.search(/@[\p{L}\p{N}_-]+/u);
  const name = firstTagIndex >= 0 ? normalized.slice(0, firstTagIndex).trim() : normalized;

  return { line: trimmed, name, tags, lineNumber, indent, children: [], hasChildren: false, hasCheckbox };
}

function parseTestCases(content: string): TestCase[] {
  const lines = content.split("\n");
  const allItems: TestCase[] = [];

  lines.forEach((line, idx) => {
    const tc = parseTestCase(line, idx + 1);
    if (tc) allItems.push(tc);
  });

  const rootItems: TestCase[] = [];
  const headingStack: { item: TestCase; level: number }[] = [];
  const indentStack: { item: TestCase; indent: number }[] = [];

  for (const item of allItems) {
    if (item.isHeading) {
      indentStack.length = 0;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= item.headingLevel!) {
        headingStack.pop();
      }
      if (headingStack.length > 0) {
        const parent = headingStack[headingStack.length - 1].item;
        parent.children.push(item);
        parent.hasChildren = true;
      } else {
        rootItems.push(item);
      }
      headingStack.push({ item, level: item.headingLevel! });
    } else {
      while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= item.indent) {
        indentStack.pop();
      }
      if (indentStack.length > 0) {
        const parent = indentStack[indentStack.length - 1].item;
        parent.children.push(item);
        parent.hasChildren = true;
      } else if (headingStack.length > 0) {
        const parent = headingStack[headingStack.length - 1].item;
        parent.children.push(item);
        parent.hasChildren = true;
      } else {
        rootItems.push(item);
      }
      indentStack.push({ item, indent: item.indent });
    }
  }

  return pruneOrphanText(rootItems);
}

/** Drops non-checklist lines (plain descriptions, notes) unless they're
 *  nested under a real `- [ ]` item — those travel with their test into the
 *  Test Run. A stray description with no checklist ancestor is removed, but
 *  any checklist item nested under it is promoted up rather than lost. */
function pruneOrphanText(items: TestCase[]): TestCase[] {
  const result: TestCase[] = [];
  for (const tc of items) {
    if (tc.isHeading) {
      const children = pruneOrphanText(tc.children);
      result.push({ ...tc, children, hasChildren: children.length > 0 });
    } else if (tc.hasCheckbox) {
      result.push(tc);
    } else {
      result.push(...pruneOrphanText(tc.children));
    }
  }
  return result;
}

function countLeafTestCases(items: TestCase[]): number {
  let count = 0;
  for (const tc of items) {
    if (!tc.isHeading && tc.hasCheckbox) count++;
    count += countLeafTestCases(tc.children);
  }
  return count;
}

function getAllTags(testCases: TestCase[]): string[] {
  const tagSet = new Set<string>();
  const collect = (items: TestCase[]) => {
    items.forEach((tc) => {
      if (!tc.isHeading && tc.hasCheckbox) tc.tags.forEach((t) => tagSet.add(t));
      if (tc.children.length > 0) collect(tc.children);
    });
  };
  collect(testCases);
  return Array.from(tagSet).sort();
}

function collectLeafLineNumbers(items: TestCase[]): number[] {
  const result: number[] = [];
  for (const tc of items) {
    if (!tc.isHeading && tc.hasCheckbox) result.push(tc.lineNumber);
    if (tc.children.length > 0) result.push(...collectLeafLineNumbers(tc.children));
  }
  return result;
}

function filterByTags(
  testCases: TestCase[],
  includeTags: string[],
  excludeTags: string[]
): TestCase[] {
  if (includeTags.length === 0 && excludeTags.length === 0) return testCases;

  const filtered: TestCase[] = [];

  for (const tc of testCases) {
    if (tc.isHeading) {
      const filteredChildren = filterByTags(tc.children, includeTags, excludeTags);
      if (filteredChildren.length > 0) {
        filtered.push({ ...tc, children: filteredChildren, hasChildren: true });
      }
      continue;
    }

    if (excludeTags.length > 0 && excludeTags.some((tag) => tc.tags.includes(tag))) continue;

    if (includeTags.length === 0) {
      filtered.push(tc);
    } else {
      const matchesInclude = includeTags.some((tag) => tc.tags.includes(tag));
      if (matchesInclude) {
        filtered.push(tc);
      } else if (tc.hasChildren) {
        const hasMatchingChild = tc.children.some(
          (child) =>
            includeTags.some((tag) => child.tags.includes(tag)) &&
            !excludeTags.some((tag) => child.tags.includes(tag))
        );
        if (hasMatchingChild) filtered.push(tc);
      }
    }
  }

  return filtered;
}

function filterByNames(testCases: TestCase[], names: Set<string>): TestCase[] {
  const result: TestCase[] = [];
  for (const tc of testCases) {
    if (tc.isHeading) {
      const children = filterByNames(tc.children, names);
      if (children.length > 0) result.push({ ...tc, children, hasChildren: true });
    } else if (names.has(tc.name.trim())) {
      result.push(tc);
    }
  }
  return result;
}

function offsetLineNumbers(items: TestCase[], offset: number): TestCase[] {
  return items.map((tc) => ({
    ...tc,
    lineNumber: tc.lineNumber + offset,
    children: offsetLineNumbers(tc.children, offset),
  }));
}

function generateChecklist(
  testCases: TestCase[],
  suiteName: string,
  suiteLinkNames: string[],
  includeTags: string[],
  excludeTags: string[]
): string {
  const timestamp = new Date().toLocaleString();
  let filterLine = "";
  if (includeTags.length > 0)
    filterLine += `\n**Include:** ${includeTags.map((t) => `@${t}`).join(" ")}`;
  if (excludeTags.length > 0)
    filterLine += `\n**Exclude:** ${excludeTags.map((t) => `@${t}`).join(" ")}`;

  let md = `# Test Run: ${suiteName}\n`;
  md += suiteLinkNames.length === 1
    ? `**Test Suite:** [[${suiteLinkNames[0]}]]\n`
    : `**Test Suites:** ${suiteLinkNames.map((n) => `[[${n}]]`).join(", ")}\n`;
  md += `**Date:** ${timestamp}${filterLine}\n`;
  md += `**Total Cases:** ${countLeafTestCases(testCases)}\n\n`;
  md += "---\n\n";

  function renderItems(items: TestCase[], depth: number): string {
    let result = "";
    for (const tc of items) {
      if (tc.isHeading) {
        const hashes = "#".repeat(tc.headingLevel || 2);
        result += `\n${hashes} ${tc.name}\n\n`;
        if (tc.children.length > 0) result += renderItems(tc.children, depth);
        continue;
      }
      const indent = "  ".repeat(depth);
      const tagsStr = tc.tags.map((t) => `@${t}`).join(" ");
      if (depth === 0) {
        result += `- [ ] **${tc.name}** ${tagsStr}\n`;
      } else {
        result += `${indent}- ${tc.name} ${tagsStr}\n`;
      }
      if (tc.children.length > 0) result += renderItems(tc.children, depth + 1);
    }
    return result;
  }

  md += renderItems(testCases, 0);
  md += "\n---\n\n";

  return md;
}

const STATUS_LABEL_MAP: Record<string, string> = {
  p: "✅ Pass", P: "✅ Pass",
  f: "❌ Fail", F: "❌ Fail",
  s: "⏭️ Skipped", S: "⏭️ Skipped",
  b: "🚫 Blocked", B: "🚫 Blocked",
};

const EXISTING_LABEL_RE = /^(✅ Pass|❌ Fail|⏭️ Skipped|🚫 Blocked|🟢 Pass|🔴 Fail|🟡 Skipped|🟣 Blocked)( 📅 \d{4}-\d{2}-\d{2})? \| /;

/** Right-click context menu options for setting the status of every checklist
 *  line inside the current selection at once. Both the checkbox character and
 *  its ✅/❌/etc. label are stamped in one edit (see applyStatusLabel below),
 *  so it's a single undo step and doesn't race the vault "modify" handler. */
const BULK_STATUS_OPTIONS: Array<{ label: string; char: string; icon: string }> = [
  { label: "Pass", char: "p", icon: "check" },
  { label: "Fail", char: "f", icon: "x" },
  { label: "Skipped", char: "s", icon: "skip-forward" },
  { label: "Blocked", char: "b", icon: "ban" },
  { label: "Not Run", char: " ", icon: "square" },
];

function applyStatusLabel(line: string): string {
  const match = line.match(/^(- \[([^\]]+)\] )([^]*)/);
  if (!match) return line;

  const [, cbPart, statusChar, rest] = match;
  const newLabel = STATUS_LABEL_MAP[statusChar];

  const existingMatch = rest.match(EXISTING_LABEL_RE);
  const existingLabel = existingMatch?.[1];

  if (existingLabel === newLabel) return line;

  const cleanRest = rest.replace(EXISTING_LABEL_RE, "").replace(/\s+$/, "");

  if (!newLabel) {
    return `${cbPart}${cleanRest}`;
  }

  return `${cbPart}${newLabel} | ${cleanRest}`;
}

const STATUS_EMOJI: Record<string, string> = {
  pass: "✅", fail: "❌", skipped: "⏭️", blocked: "🚫", notrun: "⬜",
};

const STATUS_PATTERNS: Array<{ regex: RegExp; key: string; label: string }> = [
  { regex: /^- \[[xXpP]\]/, key: "pass",    label: "Pass"    },
  { regex: /^- \[[fF]\]/,   key: "fail",    label: "Fail"    },
  { regex: /^- \[[sS]\]/,   key: "skipped", label: "Skipped" },
  { regex: /^- \[[bB]\]/,   key: "blocked", label: "Blocked" },
  { regex: /^- \[ \]/,      key: "notrun",  label: "Not Run" },
];

function calculateResults(content: string): string {
  const counts: Record<string, number> = { pass: 0, fail: 0, skipped: 0, blocked: 0, notrun: 0 };

  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    for (const s of STATUS_PATTERNS) {
      if (s.regex.test(trimmed)) { counts[s.key]++; break; }
    }
  });

  const total = (Object.keys(counts) as string[]).reduce((a, k) => a + counts[k], 0);
  if (total === 0) return "";

  const entries = STATUS_PATTERNS
    .filter((s) => counts[s.key] > 0)
    .map((s) => `    "${STATUS_EMOJI[s.key]} ${s.label} (${counts[s.key]})" : ${counts[s.key]}`)
    .join("\n");

  let cleaned = content.replace(STATS_SECTION_RE, "");
  cleaned = cleaned.replace(/\s+$/, "");

  return cleaned + `\n\n---\n\n## Test Results Statistics\n\n\`\`\`mermaid\npie title Test Results (Total: ${total})\n${entries}\n\`\`\`\n`;
}

function extractBugNames(content: string): string[] {
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    // Strip inline code and bold to avoid matching [[Bug - ...]] in descriptions/examples
    const stripped = line.replace(/`[^`]+`/g, "").replace(/\*\*[^*]+\*\*/g, "");
    const regex = /\[\[Bug - ([^\]|#]+)/g;
    let m;
    while ((m = regex.exec(stripped)) !== null) {
      seen.add(`Bug - ${m[1].trim()}`);
    }
  }
  return Array.from(seen);
}

function parseDateLabel(filename: string): string {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (!match) return filename.replace(/\.md$/, "");
  return `${MONTHS[parseInt(match[2]) - 1]} ${parseInt(match[3])} ${match[4]}:${match[5]}`;
}

/** Numeric-aware compare so "2 Foo" sorts before "10 Bar" — matches Obsidian's
 *  own file-explorer ordering instead of plain lexicographic sort. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Parses the newline-separated "Test Run ignore" setting into individual
 *  patterns (blank lines and comments starting with # are dropped). */
function parseIgnorePatterns(raw: string): string[] {
  return raw
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
}

/** True when `path` matches an ignore pattern: a bare folder/file path
 *  matches itself or anything nested under it, and `*` acts as a wildcard
 *  matching any run of characters (e.g. "Drafts/*", "*.wip.md"). */
function matchesIgnorePattern(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\/+$/, "");
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`, "i").test(path);
  }
  return (
    path.toLowerCase() === normalizedPattern.toLowerCase() ||
    path.toLowerCase().startsWith(normalizedPattern.toLowerCase() + "/")
  );
}

function isPathIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesIgnorePattern(path, pattern));
}

function parseSortKey(filename: string): string {
  const match = filename.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

/** Default run file name: short and date-based so it never hits OS filename
 *  length limits, regardless of how many source files were selected. */
function defaultRunFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `Test Run ${timestamp}`;
}

/** Strips characters illegal in file names and caps length as a safety net
 *  for user-edited run names. */
function sanitizeRunFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  const capped = cleaned.length > 150 ? cleaned.slice(0, 150).trim() : cleaned;
  return capped || defaultRunFileName();
}

/** Extracts every Txxx id from parenthesized groups in text, e.g. both ids
 *  from "(T386, T387)" as well as the single id from "(T01)". A plain
 *  /\(T(\d+)\)/ (no comma support) only matches when a group holds exactly
 *  one id, silently dropping every id in a multi-id group. */
function extractTmsIdsFromText(text: string): string[] {
  const ids: string[] = [];
  const groupRe = /\(([^)]*)\)/g;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(text)) !== null) {
    const idRe = /T(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(g[1])) !== null) ids.push(`T${m[1]}`);
  }
  return ids;
}

function extractTmsIds(content: string): string[] {
  return Array.from(new Set(extractTmsIdsFromText(content)));
}

function parsePwJsonReport(report: PwJsonReport): Map<string, string> {
  const map = new Map<string, string>();
  function walk(suite: PwSuite) {
    for (const spec of suite.specs ?? []) {
      const ids = extractTmsIdsFromText(spec.title);
      if (ids.length === 0) continue;
      const outcome = spec.tests[0]?.status;
      const status = outcome === "skipped" ? "skipped" : outcome === "expected" || outcome === "flaky" ? "passed" : "failed";
      for (const id of ids) map.set(id, status);
    }
    for (const sub of suite.suites ?? []) walk(sub);
  }
  for (const s of report.suites) walk(s);
  return map;
}

function applyPlaywrightResults(content: string, resultMap: Map<string, string>): { updated: string; count: number } {
  const charMap: Record<string, string> = { passed: "p", failed: "f", skipped: "s" };
  let count = 0;
  const updated = content.split("\n").map(line => {
    const ids = extractTmsIdsFromText(line);
    if (ids.length === 0) return line;
    const status = ids.map((id) => resultMap.get(id)).find((s): s is string => !!s);
    if (!status || !charMap[status]) return line;
    const newLine = line.replace(/^(\s*- \[)[^\]]*(\].*)$/, `$1${charMap[status]}$2`);
    if (newLine !== line) count++;
    return newLine;
  }).join("\n");
  return { updated, count };
}

// ─── Playwright Panel View ───────────────────────────────────────────────────

class PlaywrightPanelView extends ItemView {
  private statusEl!: HTMLElement;
  private outputEl!: HTMLPreElement;
  private intervalId: number | null = null;
  private startTime = Date.now();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return PW_PANEL_VIEW_TYPE; }
  getDisplayText() { return "Playwright Tests"; }
  getIcon() { return "test-tube"; }

  async onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("qa-pw-panel");
    contentEl.createEl("h4", { text: "Playwright Tests", cls: "qa-pw-panel-title" });
    this.statusEl = contentEl.createEl("p", { text: "Ready", cls: "qa-pw-status" });
    this.outputEl = contentEl.createEl("pre", { cls: "qa-pw-output" });
    this.outputEl.style.flex = "1";
    this.outputEl.style.overflow = "auto";
  }

  startRun(ids: string[], command: string) {
    this.render();
    this.startTime = Date.now();
    const idsEl = this.contentEl.createEl("p", { cls: "qa-pw-ids" });
    idsEl.textContent = `IDs: ${ids.join(", ")}`;
    this.contentEl.insertBefore(idsEl, this.statusEl);
    const cmdEl = this.contentEl.createEl("code", { text: command, cls: "qa-pw-command" });
    cmdEl.style.cssText = "display:block;margin:4px 0 8px;padding:4px 8px;background:var(--background-secondary);border-radius:4px;word-break:break-all;font-size:11px;";
    this.contentEl.insertBefore(cmdEl, this.statusEl);
    this.statusEl.textContent = "Running... 0s";
    this.statusEl.style.color = "";
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      if (this.statusEl.textContent?.startsWith("Running")) {
        this.statusEl.textContent = `Running... ${elapsed}s`;
      }
    }, 1000);
  }

  appendOutput(text: string) {
    this.outputEl.textContent += text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  setDone(message: string, success = true) {
    if (this.intervalId !== null) { window.clearInterval(this.intervalId); this.intervalId = null; }
    this.statusEl.textContent = message;
    this.statusEl.style.color = success ? "var(--color-green)" : "var(--color-red)";
  }

  async onClose() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.contentEl.empty();
  }
}

// ─── Modals ──────────────────────────────────────────────────────────────────

class FolderSuggestModal extends SuggestModal<TFolder> {
  constructor(app: App, private callback: (path: string) => void) {
    super(app);
    this.setPlaceholder("Type to search folders…");
  }

  getSuggestions(query: string): TFolder[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(query.toLowerCase()));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement) {
    el.createEl("div", { text: folder.path || "/" });
  }

  onChooseSuggestion(folder: TFolder) {
    this.callback(folder.path);
  }
}

class FileSuggestModal extends SuggestModal<TFile> {
  constructor(app: App, private callback: (path: string) => void) {
    super(app);
    this.setPlaceholder("Type to search markdown files…");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(q));
  }

  renderSuggestion(file: TFile, el: HTMLElement) {
    el.createEl("div", { text: file.path });
  }

  onChooseSuggestion(file: TFile) {
    this.callback(file.path);
  }
}

class FileSelectModal extends Modal {
  private selected: Set<string> = new Set();

  constructor(
    app: App,
    private candidates: TFile[],
    preselected: TFile[],
    private onSubmit: (files: TFile[]) => void,
    private onGoBack: (() => void) | null = null
  ) {
    super(app);
    const candidatePaths = new Set(candidates.map((f) => f.path));
    for (const f of preselected) {
      if (candidatePaths.has(f.path)) this.selected.add(f.path);
    }
  }

  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Select Test Files" });
    contentEl.createEl("p", {
      text: "Choose one or more files to include in this test run.",
      cls: "mod-note",
    });

    const searchInput = contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Search files…" },
      cls: "qa-tag-search",
    }) as HTMLInputElement;

    const counterEl = contentEl.createEl("p", { cls: "qa-review-counter" });
    const updateCounter = () => {
      counterEl.textContent = `${this.selected.size} file(s) selected`;
    };
    updateCounter();

    const listEl = contentEl.createDiv({ cls: "qa-review-list" });
    const fileRows: Array<{ file: TFile; row: HTMLElement; cb: HTMLInputElement }> = [];
    const folderGroups: Array<{ wrapper: HTMLElement; fileRows: HTMLElement[] }> = [];
    const folderCheckboxes: Array<{ cb: HTMLInputElement; filePaths: string[] }> = [];

    // Build a folder tree so a whole folder (with all its nested subfolders)
    // can be selected at once, instead of only picking individual files.
    interface FolderNode {
      name: string;
      folders: Map<string, FolderNode>;
      files: TFile[];
    }
    const root: FolderNode = { name: "", folders: new Map(), files: [] };
    for (const file of this.candidates) {
      const parts = file.parent?.path ? file.parent.path.split("/") : [];
      let node = root;
      for (const part of parts) {
        let child = node.folders.get(part);
        if (!child) {
          child = { name: part, folders: new Map(), files: [] };
          node.folders.set(part, child);
        }
        node = child;
      }
      node.files.push(file);
    }

    const collectFiles = (node: FolderNode, out: TFile[] = []): TFile[] => {
      out.push(...node.files);
      for (const child of node.folders.values()) collectFiles(child, out);
      return out;
    };

    const updateAllFolderCheckboxes = () => {
      for (const { cb, filePaths } of folderCheckboxes) {
        const checkedCount = filePaths.filter((p) => this.selected.has(p)).length;
        cb.indeterminate = checkedCount > 0 && checkedCount < filePaths.length;
        cb.checked = filePaths.length > 0 && checkedCount === filePaths.length;
      }
    };

    const renderFile = (file: TFile, container: HTMLElement, depth: number) => {
      const row = container.createDiv({ cls: "qa-review-item" });
      row.style.paddingLeft = `${depth * 16 + 24}px`;
      const cb = row.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
      cb.checked = this.selected.has(file.path);
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(file.path);
        else this.selected.delete(file.path);
        updateAllFolderCheckboxes();
        updateCounter();
      });

      const label = row.createEl("label");
      label.style.cursor = "pointer";
      label.style.marginLeft = "6px";
      label.createSpan({ text: file.basename });
      label.addEventListener("click", (e) => {
        e.preventDefault();
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });

      fileRows.push({ file, row, cb });
    };

    const renderNode = (node: FolderNode, container: HTMLElement, depth: number) => {
      const subfolders = Array.from(node.folders.values()).sort((a, b) => naturalCompare(a.name, b.name));
      const files = [...node.files].sort((a, b) => naturalCompare(a.basename, b.basename));

      for (const sub of subfolders) {
        const wrapper = container.createDiv();
        const header = wrapper.createDiv({ cls: "qa-review-section-heading" });
        header.style.paddingLeft = `${depth * 16 + 10}px`;
        header.style.display = "flex";
        header.style.alignItems = "center";

        const folderCb = header.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;

        const toggle = header.createEl("span", { text: "▼" });
        toggle.style.cursor = "pointer";
        toggle.style.userSelect = "none";
        toggle.style.margin = "0 4px";
        toggle.style.color = "var(--text-muted)";

        const label = header.createEl("span", { text: sub.name, cls: "qa-review-heading-text" });
        label.style.cursor = "pointer";

        const childrenEl = wrapper.createDiv();
        let expanded = true;
        const toggleExpanded = () => {
          expanded = !expanded;
          toggle.textContent = expanded ? "▼" : "▶";
          childrenEl.style.display = expanded ? "" : "none";
        };
        toggle.addEventListener("click", toggleExpanded);
        label.addEventListener("click", toggleExpanded);

        const startIdx = fileRows.length;
        renderNode(sub, childrenEl, depth + 1);
        const descendantRows = fileRows.slice(startIdx).map((r) => r.row);
        folderGroups.push({ wrapper, fileRows: descendantRows });

        const allFiles = collectFiles(sub);
        const allFilePaths = allFiles.map((f) => f.path);
        folderCb.addEventListener("change", () => {
          if (folderCb.checked) allFiles.forEach((f) => this.selected.add(f.path));
          else allFiles.forEach((f) => this.selected.delete(f.path));
          fileRows.forEach((ref) => {
            if (allFilePaths.includes(ref.file.path)) ref.cb.checked = this.selected.has(ref.file.path);
          });
          updateAllFolderCheckboxes();
          updateCounter();
        });
        folderCheckboxes.push({ cb: folderCb, filePaths: allFilePaths });
      }

      for (const file of files) {
        renderFile(file, container, depth);
      }
    };

    renderNode(root, listEl, 0);
    updateAllFolderCheckboxes();

    if (this.candidates.length === 0) {
      contentEl.createEl("p", { text: "No markdown files found in vault.", cls: "mod-note" });
    }

    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase().trim();
      fileRows.forEach(({ file, row }) => {
        row.style.display = !query || file.path.toLowerCase().includes(query) ? "" : "none";
      });
      folderGroups.forEach(({ wrapper, fileRows: rowsInFolder }) => {
        const anyVisible = rowsInFolder.some((r) => r.style.display !== "none");
        wrapper.style.display = anyVisible ? "" : "none";
      });
    });

    const setting = new Setting(contentEl);
    if (this.onGoBack) {
      setting.addButton((btn) => btn.setButtonText("← Back").onClick(() => {
        this.close();
        this.onGoBack!();
      }));
    }
    setting.addButton((btn) =>
      btn
        .setButtonText("Next: Select Attributes →")
        .setCta()
        .onClick(() => {
          if (this.selected.size === 0) {
            new Notice("Select at least one file.");
            return;
          }
          // Use the tree's render order (folders then files, matching what's
          // shown on screen) rather than this.candidates' flat alphabetical-
          // by-path order, so the generated run's file groups match the
          // folder order the user just picked from.
          const chosen = fileRows
            .filter(({ file }) => this.selected.has(file.path))
            .map(({ file }) => file);
          this.close();
          this.onSubmit(chosen);
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TagSelectModal extends Modal {
  private tagStates: Map<string, TagState> = new Map();
  private chipElements: Map<string, HTMLElement> = new Map();

  constructor(
    app: App,
    private allTags: string[],
    private suiteName: string,
    private callback: (includeTags: string[], excludeTags: string[]) => void,
    initialIncludeTags: string[] = [],
    initialExcludeTags: string[] = [],
    private onBack: (() => void) | null = null
  ) {
    super(app);
    allTags.forEach((tag) => {
      if (initialIncludeTags.includes(tag)) this.tagStates.set(tag, "include");
      else if (initialExcludeTags.includes(tag)) this.tagStates.set(tag, "exclude");
      else this.tagStates.set(tag, "neutral");
    });
  }

  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: `Select Attributes: ${this.suiteName}` });
    contentEl.createEl("p", {
      text: "Click once: include (green)  ·  twice: exclude (red)  ·  three times: reset",
      cls: "mod-note",
    });

    const controlsDiv = contentEl.createDiv({ cls: "qa-tag-controls" });
    new Setting(controlsDiv)
      .addButton((btn) => btn.setButtonText("Include All").onClick(() => this.setAll("include")))
      .addButton((btn) => btn.setButtonText("Reset All").onClick(() => this.setAll("neutral")));

    const searchInput = contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Search tags…" },
      cls: "qa-tag-search",
    }) as HTMLInputElement;
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase().trim();
      this.allTags.forEach((tag) => {
        const chip = this.chipElements.get(tag);
        if (!chip) return;
        chip.style.display = !query || tag.includes(query) ? "" : "none";
      });
    });

    const tagsContainer = contentEl.createDiv({ cls: "qa-tags-container" });
    this.allTags.forEach((tag) => {
      const chip = tagsContainer.createEl("span", { text: `@${tag}`, cls: "qa-tag-chip" });
      this.chipElements.set(tag, chip);
      this.updateChip(tag);
      chip.addEventListener("click", () => this.cycleTagState(tag));
    });

    if (this.allTags.length === 0) {
      contentEl.createEl("p", { text: "No attributes found in this test suite.", cls: "mod-note" });
    }

    const bottomSetting = new Setting(contentEl);
    if (this.onBack) {
      bottomSetting.addButton((btn) => btn.setButtonText("← Back").onClick(() => {
        this.close();
        this.onBack!();
      }));
    }
    bottomSetting.addButton((btn) =>
      btn
        .setButtonText("Next: Review Tests →")
        .setCta()
        .onClick(() => {
          const includeTags = this.allTags.filter((t) => this.tagStates.get(t) === "include");
          const excludeTags = this.allTags.filter((t) => this.tagStates.get(t) === "exclude");
          this.callback(includeTags, excludeTags);
          this.close();
        })
    );
  }

  private cycleTagState(tag: string) {
    const current = this.tagStates.get(tag) ?? "neutral";
    const next: TagState =
      current === "neutral" ? "include" : current === "include" ? "exclude" : "neutral";
    this.tagStates.set(tag, next);
    this.updateChip(tag);
  }

  private setAll(state: TagState) {
    this.allTags.forEach((tag) => {
      this.tagStates.set(tag, state);
      this.updateChip(tag);
    });
  }

  private updateChip(tag: string) {
    const chip = this.chipElements.get(tag);
    if (!chip) return;
    chip.removeClass("included", "excluded");
    const state = this.tagStates.get(tag);
    if (state === "include") chip.addClass("included");
    else if (state === "exclude") chip.addClass("excluded");
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TestReviewModal extends Modal {
  private checkedItems: Set<number> = new Set();
  private checkboxRefs: Array<{ lineNumber: number; cb: HTMLInputElement }> = [];
  private headingCheckboxRefs: Array<{ lineNumbers: number[]; cb: HTMLInputElement; update: () => void }> = [];
  private itemRowRefs: Array<{ lineNumber: number; els: HTMLElement[] }> = [];
  private headingRowRefs: Array<{ lineNumbers: number[]; el: HTMLElement }> = [];
  private viewMode: "all" | "selected" = "all";

  constructor(
    app: App,
    private suiteName: string,
    private allTestCases: TestCase[],
    filteredTestCases: TestCase[],
    private includeTags: string[],
    private excludeTags: string[],
    private onManual: (selectedCases: TestCase[], runName: string) => void,
    private onBack: () => void,
    private onAuto: ((selectedCases: TestCase[], runName: string) => void) | null = null
  ) {
    super(app);
    const addChecked = (items: TestCase[]) => {
      for (const tc of items) {
        if (!tc.isHeading && tc.hasCheckbox) this.checkedItems.add(tc.lineNumber);
        if (tc.children.length > 0) addChecked(tc.children);
      }
    };
    addChecked(filteredTestCases);
  }

  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: `Review Tests: ${this.suiteName}` });

    const filterParts: string[] = [];
    if (this.includeTags.length > 0)
      filterParts.push(`Include: ${this.includeTags.map((t) => `@${t}`).join(" ")}`);
    if (this.excludeTags.length > 0)
      filterParts.push(`Exclude: ${this.excludeTags.map((t) => `@${t}`).join(" ")}`);

    if (filterParts.length > 0) {
      const summary = contentEl.createDiv({ cls: "qa-summary" });
      filterParts.forEach((p) => summary.createEl("p", { text: p }));
    } else {
      contentEl.createEl("p", { text: "No tag filter — all test cases shown.", cls: "mod-note" });
    }

    let runName = defaultRunFileName();
    new Setting(contentEl)
      .setName("Test run file name")
      .setDesc("Defaults to the date. Edit it if you'd like a different name.")
      .addText((text) => {
        text.setValue(runName);
        text.inputEl.style.width = "100%";
        text.onChange((value) => { runName = value; });
      });

    const totalTestCount = countLeafTestCases(this.allTestCases);
    const counterEl = contentEl.createEl("p", { cls: "qa-review-counter" });
    const updateCounter = () => {
      counterEl.textContent = `${this.checkedItems.size} / ${totalTestCount} tests selected`;
    };
    updateCounter();

    const viewToggleEl = contentEl.createDiv({ cls: "qa-view-toggle" });

    const listEl = contentEl.createDiv({ cls: "qa-review-list" });
    this.checkboxRefs = [];
    this.itemRowRefs = [];
    this.headingRowRefs = [];

    const renderTree = (items: TestCase[], container: HTMLElement, isCheckable: boolean, childDepth: number, parentHeadingLevel: number = 0) => {
      items.forEach((tc: TestCase) => {
        if (tc.isHeading && tc.name === "__manually_added_separator__") {
          const sep = container.createDiv({ cls: "qa-review-separator" });
          sep.style.cssText = "border-top:1px dashed var(--color-base-40);margin:12px 0 8px;padding-top:8px;";
          sep.createEl("span", { text: "Added manually", cls: "qa-review-separator-label" }).style.cssText = "font-size:11px;color:var(--color-base-50);text-transform:uppercase;letter-spacing:.05em;padding-left:10px;";
          return;
        }
        if (tc.isHeading) {
          const headingEl = container.createDiv({ cls: "qa-review-section-heading" });
          if (tc.isManuallyAdded) headingEl.style.borderLeftColor = "var(--color-orange)";
          headingEl.style.paddingLeft = `${(tc.headingLevel! - 1) * 20 + 10}px`;
          const leafLineNumbers = collectLeafLineNumbers(tc.children);
          this.headingRowRefs.push({ lineNumbers: leafLineNumbers, el: headingEl });
          if (leafLineNumbers.length > 0) {
            const headingCb = headingEl.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
            headingCb.addClass("qa-heading-checkbox");
            const updateHeadingCb = () => {
              const n = leafLineNumbers.filter(ln => this.checkedItems.has(ln)).length;
              headingCb.indeterminate = n > 0 && n < leafLineNumbers.length;
              headingCb.checked = n === leafLineNumbers.length;
            };
            updateHeadingCb();
            this.headingCheckboxRefs.push({ lineNumbers: leafLineNumbers, cb: headingCb, update: updateHeadingCb });
            headingCb.addEventListener("change", () => {
              if (headingCb.checked) leafLineNumbers.forEach(ln => this.checkedItems.add(ln));
              else leafLineNumbers.forEach(ln => this.checkedItems.delete(ln));
              this.checkboxRefs.forEach(ref => {
                if (leafLineNumbers.includes(ref.lineNumber)) ref.cb.checked = this.checkedItems.has(ref.lineNumber);
              });
              updateCounter();
              this.headingCheckboxRefs.forEach(ref => ref.update());
              applyViewFilter();
            });
          }
          const level = Math.min(tc.headingLevel || 2, 6) as 1|2|3|4|5|6;
          headingEl.createEl(`h${level}`, { text: tc.name, cls: "qa-review-heading-text" });
          if (tc.children.length > 0) renderTree(tc.children, container, true, 0, tc.headingLevel!);
          return;
        }

        const itemEl = container.createDiv({ cls: "qa-review-item" });
        itemEl.style.paddingLeft = `${parentHeadingLevel * 20 + 12 + childDepth * 16}px`;

        if (isCheckable) {
          const cb = itemEl.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
          cb.checked = this.checkedItems.has(tc.lineNumber);
          cb.addEventListener("change", () => {
            if (cb.checked) this.checkedItems.add(tc.lineNumber);
            else this.checkedItems.delete(tc.lineNumber);
            updateCounter();
            this.headingCheckboxRefs.forEach(ref => {
              if (ref.lineNumbers.includes(tc.lineNumber)) ref.update();
            });
            applyViewFilter();
          });
          this.checkboxRefs.push({ lineNumber: tc.lineNumber, cb });
        } else {
          const bullet = itemEl.createEl("span");
          bullet.style.marginRight = "6px";
          bullet.style.color = "var(--text-faint)";
          bullet.textContent = "·";
        }

        let childrenElRef: HTMLElement | null = null;
        if (tc.hasChildren) {
          const childrenEl = document.createElement("div");
          childrenElRef = childrenEl;

          if (isCheckable) {
            let expanded = false;
            const toggle = itemEl.createEl("span");
            toggle.style.cursor = "pointer";
            toggle.style.marginRight = "4px";
            toggle.style.userSelect = "none";
            toggle.style.color = "var(--text-muted)";
            toggle.textContent = "▶";
            toggle.addEventListener("click", (e) => {
              e.stopPropagation();
              expanded = !expanded;
              toggle.textContent = expanded ? "▼" : "▶";
              childrenEl.style.display = expanded ? "" : "none";
            });
            childrenEl.style.display = "none";
          }

          const labelEl = itemEl.createEl("label");
          labelEl.style.cursor = isCheckable ? "pointer" : "default";
          labelEl.createSpan({ text: tc.name });
          if (tc.tags.length > 0) {
            labelEl.createEl("span", {
              text: "  " + tc.tags.map((t: string) => `@${t}`).join(" "),
              cls: "qa-review-item-tags",
            });
          }
          if (isCheckable) {
            labelEl.addEventListener("click", () => {
              const cb = this.checkboxRefs.find((r) => r.lineNumber === tc.lineNumber)?.cb;
              if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
            });
          }

          container.appendChild(childrenEl);
          renderTree(tc.children, childrenEl, false, childDepth + 1, parentHeadingLevel);
        } else {
          const labelEl = itemEl.createEl("label");
          labelEl.style.cursor = isCheckable ? "pointer" : "default";
          labelEl.createSpan({ text: tc.name });
          if (tc.tags.length > 0) {
            labelEl.createEl("span", {
              text: "  " + tc.tags.map((t: string) => `@${t}`).join(" "),
              cls: "qa-review-item-tags",
            });
          }
          if (isCheckable) {
            labelEl.addEventListener("click", () => {
              const cb = this.checkboxRefs.find((r) => r.lineNumber === tc.lineNumber)?.cb;
              if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
            });
          }
        }

        if (isCheckable) {
          this.itemRowRefs.push({
            lineNumber: tc.lineNumber,
            els: childrenElRef ? [itemEl, childrenElRef] : [itemEl],
          });
        }
      });
    };

    renderTree(this.allTestCases, listEl, true, 0, 0);

    const applyViewFilter = () => {
      const showAll = this.viewMode === "all";
      this.itemRowRefs.forEach(({ lineNumber, els }) => {
        const visible = showAll || this.checkedItems.has(lineNumber);
        els.forEach((el) => { el.style.display = visible ? "" : "none"; });
      });
      this.headingRowRefs.forEach(({ lineNumbers, el }) => {
        const visible = showAll || lineNumbers.some((ln) => this.checkedItems.has(ln));
        el.style.display = visible ? "" : "none";
      });
    };

    const allViewBtn = viewToggleEl.createEl("button", { text: "All", cls: "qa-view-toggle-btn" });
    const selectedViewBtn = viewToggleEl.createEl("button", { text: "Selected only", cls: "qa-view-toggle-btn" });
    const updateViewToggleButtons = () => {
      allViewBtn.toggleClass("is-active", this.viewMode === "all");
      selectedViewBtn.toggleClass("is-active", this.viewMode === "selected");
    };
    updateViewToggleButtons();
    allViewBtn.addEventListener("click", () => {
      this.viewMode = "all";
      updateViewToggleButtons();
      applyViewFilter();
    });
    selectedViewBtn.addEventListener("click", () => {
      this.viewMode = "selected";
      updateViewToggleButtons();
      applyViewFilter();
    });

    const collectSelected = (items: TestCase[]): TestCase[] => {
      const result: TestCase[] = [];
      for (const tc of items) {
        if (tc.isHeading) {
          const selectedChildren = collectSelected(tc.children);
          if (selectedChildren.length > 0) result.push({ ...tc, children: selectedChildren, hasChildren: true });
        } else if (!tc.hasCheckbox || this.checkedItems.has(tc.lineNumber)) {
          // Non-checkbox descriptive children always travel with their real
          // test — they have no checkbox of their own to be excluded via.
          result.push({ ...tc, children: collectSelected(tc.children) });
        }
      }
      return result;
    };

    const setting = new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("← Back").onClick(() => {
          this.close();
          this.onBack();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Manual Test Run")
          .onClick(() => {
            const selected = collectSelected(this.allTestCases);
            if (countLeafTestCases(selected) === 0) {
              new Notice("No test cases selected.");
              return;
            }
            this.onManual(selected, sanitizeRunFileName(runName));
            this.close();
          })
      );

    if (this.onAuto !== null) {
      setting.addButton((btn) => {
        btn.setButtonText("Run Auto-tests").setCta();
        btn.onClick(() => {
          const selected = collectSelected(this.allTestCases);
          if (countLeafTestCases(selected) === 0) {
            new Notice("No test cases selected.");
            return;
          }
          this.onAuto!(selected, sanitizeRunFileName(runName));
          this.close();
        });
        return btn;
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Bug Create Suggest ──────────────────────────────────────────────────────

class BugCreateSuggest extends EditorSuggest<string> {
  constructor(app: App) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile): EditorSuggestTriggerInfo | null {
    const upToCursor = editor.getLine(cursor.line).substring(0, cursor.ch);
    // Trigger only when the line so far is: optional whitespace + optional "- " + "!"
    if (!upToCursor.match(/^(\s*)(?:-\s)?!$/)) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - 1 },
      end: cursor,
      query: "",
    };
  }

  getSuggestions(_ctx: EditorSuggestContext): string[] {
    return ["New Bug"];
  }

  renderSuggestion(_value: string, el: HTMLElement) {
    el.createEl("div", { text: "Bug" });
  }

  selectSuggestion(_value: string, _evt: MouseEvent | KeyboardEvent) {
    const { editor, start } = this.context!;
    const fullLine = editor.getLine(start.line);
    const indent = fullLine.match(/^(\s*)/)?.[1] ?? "";
    const placeholder = "[[Bug - ]]";
    editor.replaceRange(
      indent + placeholder,
      { line: start.line, ch: 0 },
      { line: start.line, ch: fullLine.length }
    );
    // Position cursor inside [[Bug - |]]
    editor.setCursor({ line: start.line, ch: indent.length + "[[Bug - ".length });
  }
}

// ─── Attribute Autocomplete ──────────────────────────────────────────────────

class AttributeSuggest extends EditorSuggest<string> {
  private index: Set<string> = new Set();

  constructor(plugin: TMSPlugin) {
    super(plugin.app);
    this.buildIndex();
    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") this.updateFile(file);
      })
    );
  }

  private async buildIndex() {
    await Promise.all(this.app.vault.getMarkdownFiles().map(file => this.updateFile(file)));
  }

  private async updateFile(file: TFile) {
    const content = await this.app.vault.cachedRead(file);
    const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(content)) !== null) this.index.add(m[1].toLowerCase());
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile): EditorSuggestTriggerInfo | null {
    const sub = editor.getLine(cursor.line).substring(0, cursor.ch);
    const match = sub.match(/@([\p{L}\p{N}_-]*)$/u);
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[1],
    };
  }

  getSuggestions(context: EditorSuggestContext): string[] {
    const query = context.query.toLowerCase();
    return Array.from(this.index)
      .filter((t) => t.startsWith(query) && t !== query)
      .sort();
  }

  renderSuggestion(value: string, el: HTMLElement) {
    el.createEl("span", { text: `@${value}` });
  }

  selectSuggestion(value: string) {
    const { editor, start, end } = this.context!;
    editor.replaceRange(`@${value}`, start, end);
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface TMSSettings {
  defaultTestRunFolder: string;
  bugsFolder: string;
  bugTemplatePath: string;
  testRunIgnorePaths: string;
  enableDashboard: boolean;
  dashboardHiddenStatuses: string;
  showRibbonTestRun: boolean;
  showRibbonResults: boolean;
  showRibbonDashboard: boolean;
  showStatusBarTestRun: boolean;
  showStatusBarResults: boolean;
  showStatusBarDashboard: boolean;
  playwrightProjectPath: string;
  playwrightCommand: string;
}

const DEFAULT_SETTINGS: TMSSettings = {
  defaultTestRunFolder: "",
  bugsFolder: "",
  bugTemplatePath: "",
  testRunIgnorePaths: "",
  enableDashboard: true,
  dashboardHiddenStatuses: "done",
  showRibbonTestRun: true,
  showRibbonResults: true,
  showRibbonDashboard: true,
  showStatusBarTestRun: true,
  showStatusBarResults: true,
  showStatusBarDashboard: true,
  playwrightProjectPath: "",
  playwrightCommand: "npx playwright test",
};

// ─── Main Plugin ─────────────────────────────────────────────────────────────

export default class TMSPlugin extends Plugin {
  settings: TMSSettings = Object.assign({}, DEFAULT_SETTINGS);
  private ribbonTestRun: HTMLElement | null = null;
  private ribbonResults: HTMLElement | null = null;
  private ribbonDashboard: HTMLElement | null = null;
  private statusBarTestRun: HTMLElement | null = null;
  private statusBarResults: HTMLElement | null = null;
  private statusBarDashboard: HTMLElement | null = null;
  private processingFiles = new Set<string>();
  private dashboardRefreshing = false;

  async onload() {
    const loadedData = await this.loadData();
    if (loadedData) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    }
    await this.ensureStatusPropertyType();

    this.registerView(PW_PANEL_VIEW_TYPE, (leaf) => new PlaywrightPanelView(leaf));

    this.addCommand({
      id: "generate-test-run-current",
      name: "Test Run",
      callback: () => {
        this.openTestRunEntry(this.app.workspace.getActiveFile());
      },
    });

    this.addCommand({
      id: "calculate-test-results",
      name: "Results",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (file.extension !== "md") return false;
        if (checking) return true;
        this.calculateTestResults();
        return true;
      },
    });

    this.addCommand({
      id: "insert-bug-template",
      name: "Insert Bug Template",
      editorCallback: async (editor: Editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const title = file.basename.startsWith("Bug - ")
          ? file.basename.replace(/^Bug - /, "")
          : file.basename;
        const templateContent = await this.bugTemplate(title);
        if (!templateContent) {
          new Notice("No bug template configured. Set one in plugin settings.");
          return;
        }
        editor.replaceSelection(templateContent);
      },
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Dashboard",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.openOrRefreshDashboard();
        return true;
      },
    });

    // Ribbon icons
    this.ribbonTestRun = this.addRibbonIcon("test-tube", "Test Run", () => {
      this.openTestRunEntry(this.app.workspace.getActiveFile());
    });
    this.ribbonResults = this.addRibbonIcon("bar-chart", "Results", () => {
      this.calculateTestResults();
    });
    this.ribbonDashboard = this.addRibbonIcon("layout-dashboard", "Dashboard", () => {
      this.openOrRefreshDashboard();
    });

    this.addSettingTab(new TMSSettingTab(this.app, this));
    this.registerEditorSuggest(new BugCreateSuggest(this.app));
    this.registerEditorSuggest(new AttributeSuggest(this));

    // When Obsidian creates an empty "Bug - ..." file (user clicked unresolved link),
    // fill it with the bug template and move it to the configured bugsFolder.
    this.registerEvent(
      this.app.vault.on("create", async (abstractFile) => {
        if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") return;
        if (!abstractFile.basename.startsWith("Bug - ")) return;
        // Brief delay — Obsidian writes the file async after the create event
        await new Promise((r) => setTimeout(r, 100));
        const current = await this.app.vault.read(abstractFile);
        // Allow overwriting only if file is empty or contains only Obsidian's auto-generated heading
        const autoHeading = `# ${abstractFile.basename}`;
        const hasUserContent = current.trim() !== "" && current.trim() !== autoHeading;
        if (hasUserContent) return;
        const title = abstractFile.basename.replace(/^Bug - /, "");
        const templateContent = await this.bugTemplate(title);
        // Skip if there's nothing to write and file is already empty
        if (!templateContent && current.trim() === "") return;
        await this.app.vault.modify(abstractFile, templateContent);

        // Move to the configured bugs folder if the file landed elsewhere
        const activeFile = this.app.workspace.getActiveFile();
        const sourcePath = activeFile?.path ?? abstractFile.path;
        const targetPath = this.getBugFilePath(abstractFile.basename, sourcePath);
        if (abstractFile.path !== targetPath) {
          const folderPath = targetPath.includes("/")
            ? targetPath.substring(0, targetPath.lastIndexOf("/"))
            : "";
          if (folderPath) await this.ensureFolder(folderPath);
          await this.app.vault.rename(abstractFile, targetPath);
        }
      })
    );

    // Auto-stamp status labels only (bug creation happens on Results command)
    this.registerEvent(
      this.app.vault.on("modify", async (abstractFile) => {
        if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") return;
        if (this.processingFiles.has(abstractFile.path)) return;
        if (abstractFile.name === "Dashboard.md") return;

        const content = await this.app.vault.cachedRead(abstractFile);
        if (!content.includes("- [")) return;

        const updated = content.split("\n").map((l) => applyStatusLabel(l)).join("\n");
        if (updated === content) return;

        this.processingFiles.add(abstractFile.path);
        await this.app.vault.modify(abstractFile, updated);
        setTimeout(() => this.processingFiles.delete(abstractFile.path), 300);
      })
    );

    // Right-click on a selection spanning checklist lines — set all their
    // statuses at once instead of clicking each checkbox individually.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!file || file.name === "Dashboard.md") return;

        const selections = editor.listSelections();
        const hasSelection = selections.some(
          (s) => s.anchor.line !== s.head.line || s.anchor.ch !== s.head.ch
        );
        if (!hasSelection) return;

        // Union of line numbers actually spanned by the selections — not
        // just the outer min/max, since a multi-selection can be
        // discontinuous (e.g. Cmd/Ctrl-selecting lines 1 and 3 but not 2).
        const selectedLineSet = new Set<number>();
        for (const s of selections) {
          const from = Math.min(s.anchor.line, s.head.line);
          const to = Math.max(s.anchor.line, s.head.line);
          for (let i = from; i <= to; i++) selectedLineSet.add(i);
        }

        const checklistLineRe = /^(\s*- )\[[^\]]*\](.*)$/;
        const targetLines = Array.from(selectedLineSet)
          .filter((i) => checklistLineRe.test(editor.getLine(i)))
          .sort((a, b) => a - b);
        if (targetLines.length === 0) return;

        menu.addSeparator();
        for (const opt of BULK_STATUS_OPTIONS) {
          menu.addItem((item) =>
            item
              .setTitle(`Set status: ${opt.label}`)
              .setIcon(opt.icon)
              .onClick(() => {
                // One transaction covering only the target lines (not a
                // blanket line-range replace) so lines between two
                // discontinuous selections are left untouched, and it's
                // still a single undo step. The label is stamped inline
                // (applyStatusLabel) instead of being left for the vault
                // "modify" handler to add a moment later: that second,
                // separate write became its own undo step and fought
                // Ctrl+Z — undoing seemed to "revert" for an instant, then
                // the status reappeared once the delayed write landed.
                editor.transaction({
                  changes: targetLines.map((i) => {
                    const line = editor.getLine(i);
                    const match = line.match(checklistLineRe)!;
                    const newLine = applyStatusLabel(`${match[1]}[${opt.char}]${match[2]}`);
                    return {
                      from: { line: i, ch: 0 },
                      to: { line: i, ch: line.length },
                      text: newLine,
                    };
                  }),
                });
              })
          );
        }
      })
    );

    // Auto-refresh Dashboard when opened
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        if (!this.settings.enableDashboard) return;
        const file = this.app.workspace.getActiveFile();
        if (file instanceof TFile && file.name === "Dashboard.md") {
          await this.regenerateDashboard(file);
        }
      })
    );

    // Status bar buttons
    this.statusBarTestRun = this.addStatusBarItem();
    this.statusBarTestRun.addClass("qa-status-bar-btn");
    this.statusBarTestRun.setAttribute("title", "Test Run");
    this.statusBarTestRun.textContent = "🧪 Test Run";
    this.statusBarTestRun.addEventListener("click", () => {
      this.openTestRunEntry(this.app.workspace.getActiveFile());
    });

    this.statusBarResults = this.addStatusBarItem();
    this.statusBarResults.addClass("qa-status-bar-btn");
    this.statusBarResults.setAttribute("title", "Results");
    this.statusBarResults.textContent = "📊 Results";
    this.statusBarResults.addEventListener("click", () => this.calculateTestResults());

    this.statusBarDashboard = this.addStatusBarItem();
    this.statusBarDashboard.addClass("qa-status-bar-btn");
    this.statusBarDashboard.setAttribute("title", "Dashboard");
    this.statusBarDashboard.textContent = "📈 Dashboard";
    this.statusBarDashboard.addEventListener("click", () => this.openOrRefreshDashboard());

    this.applyVisibility();
  }

  applyVisibility() {
    const toggle = (el: HTMLElement | null, show: boolean) => {
      if (!el) return;
      el.style.display = show ? "" : "none";
    };
    toggle(this.ribbonTestRun,      this.settings.showRibbonTestRun);
    toggle(this.ribbonResults,      this.settings.showRibbonResults);
    toggle(this.ribbonDashboard,    this.settings.showRibbonDashboard && this.settings.enableDashboard);
    toggle(this.statusBarTestRun,   this.settings.showStatusBarTestRun);
    toggle(this.statusBarResults,   this.settings.showStatusBarResults);
    toggle(this.statusBarDashboard, this.settings.showStatusBarDashboard && this.settings.enableDashboard);
  }

  // ─── Playwright: run automated tests ──────────────────────────────────────

  private async getPlaywrightPanel(): Promise<PlaywrightPanelView> {
    const existing = this.app.workspace.getLeavesOfType(PW_PANEL_VIEW_TYPE);
    if (existing.length > 0) return existing[0].view as PlaywrightPanelView;
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error("Could not get a workspace leaf for Playwright panel.");
    await leaf.setViewState({ type: PW_PANEL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view as PlaywrightPanelView;
  }

  private async runPlaywrightTests(runFile: TFile, ids: string[]) {
    const projectPath = this.settings.playwrightProjectPath.trim();
    const baseCommand = this.settings.playwrightCommand.trim() || "npx playwright test";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require("os") as typeof import("os");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path") as typeof import("path");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");

    // Word-boundary match, not "\(Txxx\)" — a spec whose title groups several
    // ids in one set of parens, e.g. "(T380, T381, T382)", doesn't have any
    // individual id immediately wrapped in its own "(" ")" pair, so a strict
    // parens-adjacent pattern would never select that test to run at all.
    const grep = ids.map(id => `\\b${id}\\b`).join("|");
    const tmpResults = path.join(os.tmpdir(), `tms-pw-${Date.now()}.json`);
    const displayCmd = `${baseCommand} --grep "${ids.map(id => `\\b${id}\\b`).join("|")}" --reporter=list`;

    const panel = await this.getPlaywrightPanel();
    panel.startRun(ids, displayCmd);

    // list → real-time progress in panel; json → written to file via env var
    const fullCmd = `${baseCommand} --grep "${grep}" --reporter=list,json`;

    const proc = spawn("/bin/zsh", ["-l", "-c", fullCmd], {
      cwd: projectPath,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: tmpResults },
    });

    proc.stdout?.on("data", (chunk: Buffer) => panel.appendOutput(chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => panel.appendOutput(chunk.toString()));

    proc.on("close", async (code: number | null) => {
      try {
        const jsonContent = fs.readFileSync(tmpResults, "utf-8");
        const report = JSON.parse(jsonContent) as PwJsonReport;
        const resultMap = parsePwJsonReport(report);

        const currentContent = await this.app.vault.read(runFile);
        const { updated, count } = applyPlaywrightResults(currentContent, resultMap);
        if (count > 0) await this.app.vault.modify(runFile, updated);

        const passed  = Array.from(resultMap.values()).filter(s => s === "passed").length;
        const failed  = Array.from(resultMap.values()).filter(s => s === "failed").length;
        const skipped = Array.from(resultMap.values()).filter(s => s === "skipped").length;

        panel.setDone(
          `Done. ${passed} passed, ${failed} failed, ${skipped} skipped. ${count} test(s) updated.`,
          code === 0
        );
        new Notice(`Playwright sync: ${count} test(s) updated.`);

        if (count > 0) await this.calculateTestResults(runFile);
      } catch (err) {
        panel.appendOutput(`\nFailed to parse results: ${(err as Error).message}\n`);
        panel.setDone("Error parsing Playwright results. Check output above.", false);
      } finally {
        try { fs.unlinkSync(tmpResults); } catch { /* ignore */ }
      }
    });

    proc.on("error", (err: Error) => {
      panel.appendOutput(`\nFailed to start process: ${err.message}\n`);
      panel.setDone("Failed to run Playwright. Check project path in settings.", false);
    });
  }

  // ─── Folder helpers ────────────────────────────────────────────────────────

  /** Where to save a new test run / find its dashboard. No suite-specific
   *  subfolder is auto-created: use the configured Base folder, or fall back
   *  to Obsidian's own "default location for new notes" setting. */
  private getRunsFolder(sourcePath: string): string {
    const base = this.settings.defaultTestRunFolder.trim().replace(/\/+$/, "");
    if (base) return base;
    try {
      const folder = this.app.fileManager.getNewFileParent(sourcePath);
      return folder.isRoot() ? "" : folder.path;
    } catch {
      return "";
    }
  }

  private getFolderPath(filePath: string): string {
    return filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
  }

  /** Joins a folder + filename without producing a leading slash when folder is "" or "/" (vault root). */
  private joinPath(folder: string, name: string): string {
    const normalized = folder.replace(/^\/+|\/+$/g, "");
    return normalized ? `${normalized}/${name}` : name;
  }

  private countTestStatuses(content: string): Record<string, number> {
    const counts: Record<string, number> = { pass: 0, fail: 0, skipped: 0, blocked: 0, notrun: 0 };
    content.split("\n").forEach((line) => {
      const trimmed = line.trim();
      for (const s of STATUS_PATTERNS) {
        if (s.regex.test(trimmed)) { counts[s.key]++; break; }
      }
    });
    return counts;
  }

  private getBugFilePath(bugName: string, sourceFilePath: string): string {
    const configured = this.settings.bugsFolder.trim().replace(/\/+$/, "");
    if (configured) return `${configured}/${bugName}.md`;
    return this.getFolderPath(sourceFilePath)
      ? `${this.getFolderPath(sourceFilePath)}/${bugName}.md`
      : `${bugName}.md`;
  }

  private async ensureFolder(path: string) {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    if (!normalized) return;
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async bugTemplate(title: string): Promise<string> {
    const path = this.settings.bugTemplatePath.trim();
    if (!path) return "";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Bug template not found: ${path}`);
      return "";
    }
    const content = await this.app.vault.cachedRead(file);
    return content.replace(/\{\{title\}\}/g, title);
  }

  async createBugFile(bugName: string, sourceFilePath: string): Promise<void> {
    const filePath = this.getBugFilePath(bugName, sourceFilePath);
    if (this.app.vault.getAbstractFileByPath(filePath)) return;
    const folder = this.getFolderPath(filePath);
    if (folder) await this.ensureFolder(folder);
    const title = bugName.replace(/^Bug - /, "");
    await this.app.vault.create(filePath, await this.bugTemplate(title));
    new Notice(`Bug created: ${bugName}`);
  }

  private getBugStatus(bugName: string): string | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const status = cache?.frontmatter?.status as string | undefined;
    return status != null && status !== "" ? status : null;
  }

  private async ensureStatusPropertyType() {
    try {
      const configPath = `${this.app.vault.configDir}/types.json`;
      const adapter = this.app.vault.adapter;
      let data: { types?: Record<string, string> } = { types: {} };
      try {
        const raw = await adapter.read(configPath);
        data = JSON.parse(raw);
        if (!data.types) data.types = {};
      } catch { /* file may not exist yet */ }

      if (data.types!["status"] === "text") return;
      data.types!["status"] = "text";
      await adapter.write(configPath, JSON.stringify(data, null, 2));
    } catch { /* ignore — types.json inaccessible */ }
  }

  // ─── Core flows ───────────────────────────────────────────────────────────

  /** Entry point for the Test Run button/command/ribbon — decides between the
   *  single-file re-run flow (unchanged) and the multi-file selection flow. */
  private async openTestRunEntry(activeFile: TFile | null) {
    if (activeFile?.parent?.name.endsWith(" Test Runs")) {
      await this.openTestRunFlow([activeFile]);
      return;
    }

    this.showFileSelectModal(activeFile ? [activeFile] : [], (selectedFiles) => this.openTestRunFlow(selectedFiles));
  }

  private showFileSelectModal(
    preselected: TFile[],
    onChosen: (files: TFile[]) => void,
    onGoBack: (() => void) | null = null
  ) {
    const ignorePatterns = parseIgnorePatterns(this.settings.testRunIgnorePaths);
    const candidates = this.app.vault.getMarkdownFiles()
      .filter((f) => !isPathIgnored(f.path, ignorePatterns))
      .sort((a, b) => a.path.localeCompare(b.path));
    new FileSelectModal(this.app, candidates, preselected, onChosen, onGoBack).open();
  }

  private async openTestRunFlow(files: TFile[]) {
    let preselectedNames: Set<string> | null = null;
    let testCases: TestCase[];
    let suiteName: string;
    let suiteLinkNames: string[];

    if (files.length === 1) {
      // If opened from a test run file — find the original suite and pre-select existing cases
      const file = files[0];
      let suiteFile = file;
      let runCasesAll: TestCase[] = [];
      let runTree: TestCase[] = [];

      if (file.parent?.name.endsWith(" Test Runs")) {
        const suiteNameFromFolder = file.parent.name.replace(/ Test Runs$/, "");
        const found = this.app.vault.getFiles().find(
          (f) => f.basename === suiteNameFromFolder && f.extension === "md"
        );
        if (!found) {
          new Notice(`Suite "${suiteNameFromFolder}.md" not found. Open the test suite file directly.`);
          return;
        }
        suiteFile = found;

        // Parse the run body (strip header and stats section)
        const runContent = await this.app.vault.read(file);
        const runBody = runContent
          .replace(/^[\s\S]*?(?=\n- \[)/, "")
          .replace(STATS_SECTION_RE, "");
        runTree = parseTestCases(runBody);

        // Collect only actual checklist items
        const flattenLeaves = (items: TestCase[], result: TestCase[]) => {
          for (const tc of items) {
            if (!tc.isHeading && tc.line.trim().match(/^-\s*\[/)) result.push(tc);
            flattenLeaves(tc.children, result);
          }
        };
        flattenLeaves(runTree, runCasesAll);

        preselectedNames = new Set<string>();
        for (const tc of runCasesAll) preselectedNames.add(tc.name.trim());
      }

      const content = await this.app.vault.read(suiteFile);
      testCases = parseTestCases(content);

      // If opening from a run, find extras (cases in the run not in the suite) and append them
      if (preselectedNames && runCasesAll.length > 0) {
        const suiteNames = new Set<string>();
        const collectSuiteNames = (items: TestCase[]) => {
          for (const tc of items) {
            if (!tc.isHeading && tc.hasCheckbox) suiteNames.add(tc.name.trim());
            collectSuiteNames(tc.children);
          }
        };
        collectSuiteNames(testCases);

        let extraIdx = 90000;
        const buildExtrasTree = (items: TestCase[]): TestCase[] => {
          const result: TestCase[] = [];
          for (const tc of items) {
            if (tc.isHeading) {
              const extraChildren = buildExtrasTree(tc.children);
              if (extraChildren.length > 0) {
                result.push({ ...tc, children: extraChildren, hasChildren: true, lineNumber: extraIdx++, isManuallyAdded: true });
              }
            } else if (!suiteNames.has(tc.name.trim()) && tc.line.trim().match(/^-\s*\[/)) {
              result.push({ ...tc, lineNumber: extraIdx++, isManuallyAdded: true });
            }
          }
          return result;
        };
        const extrasTree = buildExtrasTree(runTree);
        if (extrasTree.length > 0) {
          // Add extras' names to preselectedNames
          const collectExtrasFlat = (items: TestCase[]) => {
            for (const tc of items) {
              if (!tc.isHeading) preselectedNames!.add(tc.name.trim());
              collectExtrasFlat(tc.children);
            }
          };
          collectExtrasFlat(extrasTree);

          const separator: TestCase = {
            line: "",
            name: "__manually_added_separator__",
            tags: [],
            lineNumber: 89998,
            indent: 0,
            children: [],
            hasChildren: false,
            isHeading: true,
            headingLevel: 2,
            isManuallyAdded: true,
          };
          testCases = [...testCases, separator, ...extrasTree];
        }
      }

      if (testCases.length === 0) {
        new Notice("No test cases found in this file.");
        return;
      }

      suiteName = suiteFile.basename;
      suiteLinkNames = [suiteName];
    } else {
      // Multiple files selected — group each file's cases under a heading named after the file,
      // so the source file names stay visible in the review modal and the generated run.
      const grouped: TestCase[] = [];
      const namesUsed: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const content = await this.app.vault.read(f);
        const parsed = parseTestCases(content);
        if (parsed.length === 0) continue;

        const offset = (i + 1) * 1_000_000;
        grouped.push({
          line: "",
          name: f.basename,
          tags: [],
          lineNumber: offset,
          indent: 0,
          children: offsetLineNumbers(parsed, offset),
          hasChildren: true,
          isHeading: true,
          headingLevel: 2,
        });
        namesUsed.push(f.basename);
      }

      if (grouped.length === 0) {
        new Notice("No test cases found in the selected files.");
        return;
      }

      testCases = grouped;
      suiteLinkNames = namesUsed;
      suiteName = namesUsed.join(" + ");
    }

    const allTags = getAllTags(testCases);
    const hasPlaywright = !!this.settings.playwrightProjectPath.trim();

    const createRunFile = async (selectedCases: TestCase[], includeTags: string[], excludeTags: string[], runName: string) => {
      try {
        const checklist = generateChecklist(selectedCases, suiteName, suiteLinkNames, includeTags, excludeTags);
        const runsFolder = this.getRunsFolder(files[0].path);

        await this.ensureFolder(runsFolder);

        // Dashboard is created only on demand (Dashboard button/command) —
        // not automatically here. If one already exists for this folder, it
        // still gets refreshed below so it reflects the new run.
        const dashPath = this.joinPath(runsFolder, "Dashboard.md");

        let runPath = this.joinPath(runsFolder, `${runName}.md`);
        if (this.app.vault.getAbstractFileByPath(runPath)) {
          let n = 2;
          while (this.app.vault.getAbstractFileByPath(this.joinPath(runsFolder, `${runName} (${n}).md`))) n++;
          runPath = this.joinPath(runsFolder, `${runName} (${n}).md`);
        }
        const runFile = await this.app.vault.create(runPath, checklist);

        if (this.settings.enableDashboard) {
          const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
          if (dashFile instanceof TFile) await this.regenerateDashboard(dashFile);
        }

        const leaf = this.app.workspace.getLeaf();
        if (!leaf) { new Notice("Could not open file."); return { runFile, checklist }; }
        await leaf.openFile(runFile);
        new Notice(`Test Run created: ${runPath}`);

        return { runFile, checklist };
      } catch (err) {
        new Notice(`Failed to create Test Run: ${(err as Error).message}`);
        throw err;
      }
    };

    const openTagSelect = (prevInclude: string[] = [], prevExclude: string[] = []) => {
      new TagSelectModal(this.app, allTags, suiteName, (includeTags, excludeTags) => {
        const filtered = filterByTags(testCases, includeTags, excludeTags);
        const preSelected = preselectedNames ? filterByNames(filtered, preselectedNames) : filtered;

        new TestReviewModal(
          this.app,
          suiteName,
          testCases,
          preSelected,
          includeTags,
          excludeTags,
          async (selectedCases: TestCase[], runName: string) => {
            await createRunFile(selectedCases, includeTags, excludeTags, runName);
          },
          () => openTagSelect(includeTags, excludeTags),
          hasPlaywright
            ? async (selectedCases: TestCase[], runName: string) => {
                const { runFile, checklist } = await createRunFile(selectedCases, includeTags, excludeTags, runName);
                const ids = extractTmsIds(checklist);
                if (ids.length === 0) {
                  new Notice("No TMS IDs (Txxx) found in test run — skipping automated run.");
                  return;
                }
                this.runPlaywrightTests(runFile, ids);
              }
            : null
        ).open();
      }, prevInclude, prevExclude, () => {
        this.showFileSelectModal(files, (newFiles) => this.openTestRunFlow(newFiles));
      }).open();
    };

    openTagSelect();
  }

  private async calculateTestResults(targetFile?: TFile) {
    const file = targetFile ?? this.app.workspace.getActiveFile();
    if (!file) return;

    let content = await this.app.vault.read(file);

    // Process any unresolved "! Bug title" markers before calculating stats
    const lines = content.split("\n");
    const newLines: string[] = [];
    const bugsToCreate: Array<{ name: string; filePath: string }> = [];
    let bugsChanged = false;

    for (const line of lines) {
      // Match: optional whitespace + optional "- " (Obsidian auto-list) + "! " + title
      const bugMatch = line.match(/^(\s*)(?:-\s+)?!\s+(.+)$/);
      if (bugMatch) {
        const indent = bugMatch[1];
        const title = bugMatch[2].trim();
        const bugName = `Bug - ${title}`;
        bugsToCreate.push({ name: bugName, filePath: this.getBugFilePath(bugName, file.path) });
        newLines.push(`${indent}[[${bugName}]]`);
        bugsChanged = true;
      } else {
        newLines.push(line);
      }
    }

    if (bugsChanged) {
      for (const { name, filePath } of bugsToCreate) {
        if (!this.app.vault.getAbstractFileByPath(filePath)) {
          const title = name.replace(/^Bug - /, "");
          const folder = filePath.includes("/")
            ? filePath.substring(0, filePath.lastIndexOf("/"))
            : "";
          if (folder) await this.ensureFolder(folder);
          await this.app.vault.create(filePath, await this.bugTemplate(title));
          new Notice(`Bug created: ${name}`);
        }
      }
      content = newLines.join("\n");
      // Small delay so metadataCache indexes the newly created bug files
      await new Promise((r) => setTimeout(r, 300));
    }

    const statsContent = calculateResults(content);
    if (!statsContent) {
      if (bugsChanged) await this.app.vault.modify(file, content);
      new Notice("No checklist items found in this file.");
      return;
    }

    // Extract bugs only from the main checklist content (before the auto-generated stats section)
    const preStatsContent = content.replace(STATS_SECTION_RE, "");
    const bugNames = extractBugNames(preStatsContent);
    let newFilesCreated = false;
    for (const bugName of bugNames) {
      const title = bugName.replace(/^Bug - /, "");
      const existingFile = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
      if (!existingFile) {
        const filePath = this.getBugFilePath(bugName, file.path);
        const folder = this.getFolderPath(filePath);
        if (folder) await this.ensureFolder(folder);
        await this.app.vault.create(filePath, await this.bugTemplate(title));
        new Notice(`Bug created: ${bugName}`);
        newFilesCreated = true;
      }
    }
    if (newFilesCreated) await new Promise((r) => setTimeout(r, 300));

    let finalContent = statsContent;
    if (bugNames.length > 0) {
      const bugStatuses = bugNames.map((bugName) => ({ bugName, status: this.getBugStatus(bugName) }));
      const hasAnyStatus = bugStatuses.some((b) => b.status !== null);
      if (hasAnyStatus) {
        const rows = bugStatuses.map(({ bugName, status }) => `| [[${bugName}]] | ${status ?? ""} |`);
        finalContent += `\n## Bugs\n\n| Bug | Status |\n| --- | --- |\n${rows.join("\n")}\n`;
      } else {
        const rows = bugStatuses.map(({ bugName }) => `| [[${bugName}]] |`);
        finalContent += `\n## Bugs\n\n| Bug |\n| --- |\n${rows.join("\n")}\n`;
      }
    }

    await this.app.vault.modify(file, finalContent);
    new Notice("Test results calculated!");
  }

  private async openOrRefreshDashboard() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active file."); return; }

    if (file.name === "Dashboard.md") {
      await this.regenerateDashboard(file);
      new Notice("Dashboard refreshed.");
      return;
    }

    const folderPath = file.parent?.name.endsWith(" Test Runs")
      ? file.parent.path
      : this.getRunsFolder(file.path);

    const dashFile = await this.getOrCreateDashboard(folderPath);
    const leaf = this.app.workspace.getLeaf();
    if (!leaf) { new Notice("Could not open file."); return; }
    await leaf.openFile(dashFile);
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  private buildEmptyDashboard(suiteName: string): string {
    return `${DASHBOARD_MARKER}\n# ${suiteName} - Dashboard\n\n> Auto-refreshes when opened.\n\n*No test runs yet. Create your first test run to see statistics.*\n`;
  }

  private dashboardSuiteName(folderPath: string): string {
    if (!folderPath) return this.app.vault.getName();
    return (folderPath.split("/").pop() || folderPath).replace(/ Test Runs$/, "");
  }

  /** Dashboards are only created on demand (Dashboard button/command), never
   *  as a side effect of generating a test run — see createRunFile above. */
  private async getOrCreateDashboard(folderPath: string): Promise<TFile> {
    const dashPath = this.joinPath(folderPath, "Dashboard.md");
    const existing = this.app.vault.getAbstractFileByPath(dashPath);
    if (existing instanceof TFile) return existing;

    await this.ensureFolder(folderPath);
    const created = await this.app.vault.create(dashPath, this.buildEmptyDashboard(this.dashboardSuiteName(folderPath)));
    await this.regenerateDashboard(created);
    return created;
  }

  async regenerateDashboard(dashFile: TFile) {
    if (this.dashboardRefreshing) return;
    this.dashboardRefreshing = true;
    try {
      const content = await this.app.vault.cachedRead(dashFile);
      if (!content.includes(DASHBOARD_MARKER)) return;

      const folder = dashFile.parent;
      if (!folder) return;

      const suiteName = folder.name.replace(/ Test Runs$/, "");
      const newContent = await this.buildDashboardContent(folder, suiteName);

      if (content !== newContent) {
        await this.app.vault.modify(dashFile, newContent);
      }
    } finally {
      this.dashboardRefreshing = false;
    }
  }

  private async buildDashboardContent(folder: TFolder, suiteName: string): Promise<string> {
    // Run files can be renamed by the user (see the editable file name field when
    // creating a run), so they're identified by their content header rather than
    // by matching a fixed filename pattern.
    const candidateFiles: TFile[] = folder.children.filter(
      (f): f is TFile => f instanceof TFile && f.extension === "md" && f.name !== "Dashboard.md"
    );

    type RunData = {
      file: TFile;
      dateLabel: string;
      pass: number;
      fail: number;
      skipped: number;
      blocked: number;
      notrun: number;
      total: number;
    };

    const runs: RunData[] = [];
    const allBugNames = new Set<string>();

    for (const runFile of candidateFiles) {
      const content = await this.app.vault.cachedRead(runFile);
      if (!content.startsWith("# Test Run:")) continue;

      const counts = this.countTestStatuses(content);
      const total = (Object.keys(counts) as string[]).reduce((a, k) => a + counts[k], 0);
      runs.push({
        file: runFile,
        dateLabel: parseDateLabel(runFile.name),
        pass: counts.pass,
        fail: counts.fail,
        skipped: counts.skipped,
        blocked: counts.blocked,
        notrun: counts.notrun,
        total,
      });

      // Extract bugs only from main checklist content (before auto-generated stats)
      const preStats = content.replace(STATS_SECTION_RE, "");
      for (const bugName of extractBugNames(preStats)) {
        allBugNames.add(bugName);
      }
    }

    runs.sort((a, b) => parseSortKey(a.file.name).localeCompare(parseSortKey(b.file.name)));

    let md = `${DASHBOARD_MARKER}\n# ${suiteName} - Dashboard\n\n`;
    md += `> Auto-refreshes when opened.\n\n`;

    if (runs.length === 0) {
      md += `*No test runs yet. Create your first test run to see statistics.*\n`;
      return md;
    }

    // Test runs table, newest first
    md += `## Test Runs\n\n`;
    md += `| Run | ✅ Pass | ❌ Fail | ⏭️ Skip | 🚫 Blocked | ⬜ Not Run | Total |\n`;
    md += `|-----|--------|--------|--------|-----------|-----------|-------|\n`;
    for (const run of [...runs].reverse()) {
      md += `| [[${run.file.basename}]] | ${run.pass} | ${run.fail} | ${run.skipped} | ${run.blocked} | ${run.notrun} | ${run.total} |\n`;
    }
    md += "\n";

    // Bugs — filter out statuses the user wants to hide
    const hiddenStatuses = this.settings.dashboardHiddenStatuses
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const visibleBugs = Array.from(allBugNames).filter((bugName) => {
      const status = this.getBugStatus(bugName);
      return !hiddenStatuses.includes((status ?? "").toLowerCase());
    });

    const visibleBugStatuses = visibleBugs.map((bugName) => ({ bugName, status: this.getBugStatus(bugName) }));
    const hasAnyStatus = visibleBugStatuses.some((b) => b.status !== null);

    if (visibleBugStatuses.length > 0) {
      md += `## Bugs\n\n`;
      if (hasAnyStatus) {
        md += `| Bug | Status |\n`;
        md += `|-----|--------|\n`;
        for (const { bugName, status } of visibleBugStatuses) {
          md += `| [[${bugName}]] | ${status ?? ""} |\n`;
        }
      } else {
        md += `| Bug |\n`;
        md += `|-----|\n`;
        for (const { bugName } of visibleBugStatuses) {
          md += `| [[${bugName}]] |\n`;
        }
      }
    }

    return md;
  }
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class TMSSettingTab extends PluginSettingTab {
  plugin: TMSPlugin;

  constructor(app: App, plugin: TMSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Test Management System Settings" });

    // ── Storage ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Storage" });

    new Setting(containerEl)
      .setName("Base folder for test runs")
      .setDesc("All test runs and their Dashboard are saved directly in this folder. Leave empty to use Obsidian's default location for new notes.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. QA")
          .setValue(this.plugin.settings.defaultTestRunFolder);
        text.inputEl.style.width = "200px";
        text.onChange(async (value) => {
          this.plugin.settings.defaultTestRunFolder = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(() => {
          new FolderSuggestModal(this.app, async (path) => {
            this.plugin.settings.defaultTestRunFolder = path;
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Bugs folder")
      .setDesc("Where bug pages are created. Leave empty to save bugs in the same folder as the test run.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Bugs")
          .setValue(this.plugin.settings.bugsFolder);
        text.inputEl.style.width = "200px";
        text.onChange(async (value) => {
          this.plugin.settings.bugsFolder = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(() => {
          new FolderSuggestModal(this.app, async (path) => {
            this.plugin.settings.bugsFolder = path;
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Bug template")
      .setDesc("Path to a note used as the template for new bug pages. Edit that note like any other Obsidian file. Use {{title}} inside it as a placeholder for the bug title. Leave empty to create a blank file (Obsidian shows the filename as title).")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Templates/Bug Report.md")
          .setValue(this.plugin.settings.bugTemplatePath);
        text.inputEl.style.width = "200px";
        text.onChange(async (value) => {
          this.plugin.settings.bugTemplatePath = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(() => {
          new FileSuggestModal(this.app, async (path) => {
            this.plugin.settings.bugTemplatePath = path;
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          }).open();
        })
      );

    // ── Test Run ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Test Run" });

    new Setting(containerEl)
      .setName("Ignored paths")
      .setDesc("Folders or files to hide from the Test Run file picker (one per line). Matches the path itself and anything nested under it; use * as a wildcard. Handy for excluding drafts/WIP notes. Example: Drafts, WIP/*")
      .addTextArea((text) => {
        text
          .setPlaceholder("Drafts\nWIP/*")
          .setValue(this.plugin.settings.testRunIgnorePaths);
        text.inputEl.rows = 4;
        text.inputEl.style.width = "260px";
        text.onChange(async (value) => {
          this.plugin.settings.testRunIgnorePaths = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    // ── Dashboard ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Dashboard" });

    new Setting(containerEl)
      .setName("Enable Dashboard")
      .setDesc("Keeps the Dashboard page (created on demand via the Dashboard button/command) up to date on open and after each new test run.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableDashboard).onChange(async (value) => {
          this.plugin.settings.enableDashboard = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Hidden bug statuses")
      .setDesc("Comma-separated list of bug statuses to hide from the Dashboard bugs section. Default: done")
      .addText((text) => {
        text
          .setPlaceholder("e.g. done, closed, wontfix")
          .setValue(this.plugin.settings.dashboardHiddenStatuses);
        text.inputEl.style.width = "260px";
        text.onChange(async (value) => {
          this.plugin.settings.dashboardHiddenStatuses = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    // ── Buttons ───────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Buttons" });

    const toggles: Array<{ name: string; key: keyof TMSSettings }> = [
      { name: "Ribbon: Test Run",       key: "showRibbonTestRun"      },
      { name: "Ribbon: Results",        key: "showRibbonResults"      },
      { name: "Ribbon: Dashboard",      key: "showRibbonDashboard"    },
      { name: "Status bar: Test Run",   key: "showStatusBarTestRun"   },
      { name: "Status bar: Results",    key: "showStatusBarResults"   },
      { name: "Status bar: Dashboard",  key: "showStatusBarDashboard" },
    ];

    for (const { name, key } of toggles) {
      new Setting(containerEl)
        .setName(name)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings[key] as boolean).onChange(async (value) => {
            (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.applyVisibility();
          })
        );
    }

    // ── Playwright Integration ────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Playwright Integration" });

    new Setting(containerEl)
      .setName("Playwright project path")
      .setDesc("Absolute path to the folder containing playwright.config.ts. Required to use automated test runs.")
      .addText(text => {
        text.setPlaceholder("/Users/you/my-project").setValue(this.plugin.settings.playwrightProjectPath);
        text.inputEl.style.width = "300px";
        text.onChange(async value => {
          this.plugin.settings.playwrightProjectPath = value.trim();
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyVisibility();
        });
      });

    new Setting(containerEl)
      .setName("Run command")
      .setDesc("Command used to run Playwright tests. Default: npx playwright test")
      .addText(text => {
        text.setPlaceholder("npx playwright test").setValue(this.plugin.settings.playwrightCommand);
        text.inputEl.style.width = "260px";
        text.onChange(async value => {
          this.plugin.settings.playwrightCommand = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

  }
}
