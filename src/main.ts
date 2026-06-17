import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Plugin,
  Modal,
  Notice,
  TFile,
  TFolder,
  Setting,
  SuggestModal,
  PluginSettingTab,
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
}

type TagState = "neutral" | "include" | "exclude";

// ─── Playwright integration types ────────────────────────────────────────────

interface PwTestResult { status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted" }
interface PwTest { status: string; results: PwTestResult[] }
interface PwSpec { title: string; ok: boolean; tests: PwTest[] }
interface PwSuite { title: string; suites?: PwSuite[]; specs?: PwSpec[] }
interface PwJsonReport { suites: PwSuite[] }

// ─── Constants ───────────────────────────────────────────────────────────────


const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const DASHBOARD_MARKER = "<!-- tms-dashboard -->";

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

  const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
  const tabCount = (leadingWhitespace.match(/\t/g) || []).length;
  const spaceCount = (leadingWhitespace.match(/ /g) || []).length;
  const indent = tabCount + Math.floor(spaceCount / 2);

  const normalized = trimmed
    .replace(/^-\s*\[[^\]]*\]\s*/, "")
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

  return { line: trimmed, name, tags, lineNumber, indent, children: [], hasChildren: false };
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

  return rootItems;
}

function countLeafTestCases(items: TestCase[]): number {
  let count = 0;
  for (const tc of items) {
    if (!tc.isHeading) count++;
    count += countLeafTestCases(tc.children);
  }
  return count;
}

function getAllTags(testCases: TestCase[]): string[] {
  const tagSet = new Set<string>();
  const collect = (items: TestCase[]) => {
    items.forEach((tc) => {
      if (!tc.isHeading) tc.tags.forEach((t) => tagSet.add(t));
      if (tc.children.length > 0) collect(tc.children);
    });
  };
  collect(testCases);
  return Array.from(tagSet).sort();
}

function collectLeafLineNumbers(items: TestCase[]): number[] {
  const result: number[] = [];
  for (const tc of items) {
    if (!tc.isHeading) result.push(tc.lineNumber);
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

function generateChecklist(
  testCases: TestCase[],
  suiteName: string,
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
  md += `**Test Suite:** [[${suiteName}]]\n`;
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

  let cleaned = content.replace(/\n+---\n+## Test Results Statistics[\s\S]*$/, "");
  cleaned = cleaned.replace(/\s+$/, "");

  return cleaned + `\n\n---\n\n## Test Results Statistics\n\n\`\`\`mermaid\npie title Test Results (Total: ${total})\n${entries}\n\`\`\`\n`;
}

function extractBugNames(content: string): string[] {
  const regex = /\[\[Bug - ([^\]|#]+)/g;
  const seen = new Set<string>();
  let m;
  while ((m = regex.exec(content)) !== null) {
    seen.add(`Bug - ${m[1].trim()}`);
  }
  return Array.from(seen);
}

function parseDateLabel(filename: string): string {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (!match) return filename.replace(/\.md$/, "");
  return `${MONTHS[parseInt(match[2]) - 1]} ${parseInt(match[3])} ${match[4]}:${match[5]}`;
}

function parseSortKey(filename: string): string {
  const match = filename.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function extractTmsIds(content: string): string[] {
  const seen = new Set<string>();
  const regex = /\(T(\d+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) seen.add(`T${m[1]}`);
  return Array.from(seen);
}

function parsePwJsonReport(report: PwJsonReport): Map<string, string> {
  const map = new Map<string, string>();
  function walk(suite: PwSuite) {
    for (const spec of suite.specs ?? []) {
      const m = spec.title.match(/\(T(\d+)\)/i);
      if (!m) continue;
      const resultStatus = spec.tests[0]?.results[0]?.status ?? "failed";
      const status = resultStatus === "passed" ? "passed" : resultStatus === "skipped" ? "skipped" : "failed";
      map.set(`T${m[1]}`, status);
    }
    for (const sub of suite.suites ?? []) walk(sub);
  }
  for (const s of report.suites) walk(s);
  return map;
}

function applyPlaywrightResults(content: string, resultMap: Map<string, string>): { updated: string; count: number } {
  const charMap: Record<string, string> = { passed: "x", failed: "f", skipped: "s" };
  let count = 0;
  const updated = content.split("\n").map(line => {
    const m = line.match(/\(T(\d+)\)\s*$/i);
    if (!m) return line;
    const status = resultMap.get(`T${m[1]}`);
    if (!status || !charMap[status]) return line;
    const newLine = line.replace(/^(\s*- \[)[^\]]*(\].*)$/, `$1${charMap[status]}$2`);
    if (newLine !== line) count++;
    return newLine;
  }).join("\n");
  return { updated, count };
}

// ─── Playwright Progress Modal ───────────────────────────────────────────────

class PlaywrightProgressModal extends Modal {
  private statusEl!: HTMLElement;
  private outputEl!: HTMLPreElement;
  private closeBtn!: HTMLButtonElement;
  private intervalId: number | null = null;
  private startTime = Date.now();

  constructor(app: App, private ids: string[], private command: string) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Running Playwright Tests" });
    contentEl.createEl("p", { text: `IDs: ${this.ids.join(", ")}` });

    const cmdEl = contentEl.createEl("code", { text: this.command, cls: "qa-pw-command" });
    cmdEl.style.display = "block";
    cmdEl.style.margin = "8px 0 12px";
    cmdEl.style.padding = "6px 10px";
    cmdEl.style.background = "var(--background-secondary)";
    cmdEl.style.borderRadius = "4px";
    cmdEl.style.wordBreak = "break-all";
    cmdEl.style.fontSize = "12px";

    this.statusEl = contentEl.createEl("p", { text: "Running... 0s", cls: "qa-pw-status" });

    this.outputEl = contentEl.createEl("pre", { cls: "qa-pw-output" });

    new Setting(contentEl).addButton(btn => {
      this.closeBtn = btn.buttonEl;
      btn.setButtonText("Close").setDisabled(true).onClick(() => this.close());
    });

    this.intervalId = window.setInterval(() => {
      if (!this.closeBtn?.disabled) return;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.statusEl.textContent = `Running... ${elapsed}s`;
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
    if (this.closeBtn) this.closeBtn.disabled = false;
  }

  onClose() {
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

class TagSelectModal extends Modal {
  private tagStates: Map<string, TagState> = new Map();
  private chipElements: Map<string, HTMLElement> = new Map();

  constructor(
    app: App,
    private allTags: string[],
    private suiteName: string,
    private callback: (includeTags: string[], excludeTags: string[]) => void,
    initialIncludeTags: string[] = [],
    initialExcludeTags: string[] = []
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

    new Setting(contentEl).addButton((btn) =>
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

  constructor(
    app: App,
    private suiteName: string,
    private allTestCases: TestCase[],
    filteredTestCases: TestCase[],
    private includeTags: string[],
    private excludeTags: string[],
    private onConfirm: (selectedCases: TestCase[]) => void,
    private onBack: () => void
  ) {
    super(app);
    const addChecked = (items: TestCase[]) => {
      for (const tc of items) {
        if (!tc.isHeading) this.checkedItems.add(tc.lineNumber);
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

    const totalTestCount = countLeafTestCases(this.allTestCases);
    const counterEl = contentEl.createEl("p", { cls: "qa-review-counter" });
    const updateCounter = () => {
      counterEl.textContent = `${this.checkedItems.size} / ${totalTestCount} tests selected`;
    };
    updateCounter();

    const listEl = contentEl.createDiv({ cls: "qa-review-list" });
    this.checkboxRefs = [];

    const renderTree = (items: TestCase[], container: HTMLElement, isCheckable: boolean, childDepth: number, parentHeadingLevel: number = 0) => {
      items.forEach((tc: TestCase) => {
        if (tc.isHeading) {
          const headingEl = container.createDiv({ cls: "qa-review-section-heading" });
          headingEl.style.paddingLeft = `${(tc.headingLevel! - 1) * 20 + 10}px`;
          const leafLineNumbers = collectLeafLineNumbers(tc.children);
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
          });
          this.checkboxRefs.push({ lineNumber: tc.lineNumber, cb });
        } else {
          const bullet = itemEl.createEl("span");
          bullet.style.marginRight = "6px";
          bullet.style.color = "var(--text-faint)";
          bullet.textContent = "·";
        }

        if (tc.hasChildren) {
          const childrenEl = document.createElement("div");

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
      });
    };

    renderTree(this.allTestCases, listEl, true, 0, 0);

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("← Back").onClick(() => {
          this.close();
          this.onBack();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Generate Test Run")
          .setCta()
          .onClick(() => {
            const collectSelected = (items: TestCase[]): TestCase[] => {
              const result: TestCase[] = [];
              for (const tc of items) {
                if (tc.isHeading) {
                  const selectedChildren = collectSelected(tc.children);
                  if (selectedChildren.length > 0) result.push({ ...tc, children: selectedChildren, hasChildren: true });
                } else if (this.checkedItems.has(tc.lineNumber)) {
                  result.push({ ...tc, children: collectSelected(tc.children) });
                }
              }
              return result;
            };
            const selected = collectSelected(this.allTestCases);
            if (countLeafTestCases(selected) === 0) {
              new Notice("No test cases selected.");
              return;
            }
            this.onConfirm(selected);
            this.close();
          })
      );
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
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.updateFile(file);
    }
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
  bugTemplate: string;
  enableDashboard: boolean;
  dashboardHiddenStatuses: string;
  showRibbonTestRun: boolean;
  showRibbonResults: boolean;
  showRibbonDashboard: boolean;
  showRibbonAutoRun: boolean;
  showStatusBarTestRun: boolean;
  showStatusBarResults: boolean;
  showStatusBarDashboard: boolean;
  showStatusBarAutoRun: boolean;
  playwrightProjectPath: string;
  playwrightCommand: string;
}

const DEFAULT_SETTINGS: TMSSettings = {
  defaultTestRunFolder: "",
  bugsFolder: "",
  bugTemplate: "",
  enableDashboard: true,
  dashboardHiddenStatuses: "done",
  showRibbonTestRun: true,
  showRibbonResults: true,
  showRibbonDashboard: true,
  showRibbonAutoRun: true,
  showStatusBarTestRun: true,
  showStatusBarResults: true,
  showStatusBarDashboard: true,
  showStatusBarAutoRun: true,
  playwrightProjectPath: "",
  playwrightCommand: "npx playwright test",
};

// ─── Main Plugin ─────────────────────────────────────────────────────────────

export default class TMSPlugin extends Plugin {
  settings: TMSSettings = Object.assign({}, DEFAULT_SETTINGS);
  private ribbonTestRun: HTMLElement | null = null;
  private ribbonResults: HTMLElement | null = null;
  private ribbonDashboard: HTMLElement | null = null;
  private ribbonAutoRun: HTMLElement | null = null;
  private statusBarTestRun: HTMLElement | null = null;
  private statusBarResults: HTMLElement | null = null;
  private statusBarDashboard: HTMLElement | null = null;
  private statusBarAutoRun: HTMLElement | null = null;
  private processingFiles = new Set<string>();
  private dashboardRefreshing = false;

  async onload() {
    const loadedData = await this.loadData();
    if (loadedData) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    }
    await this.ensureStatusPropertyType();

    this.addCommand({
      id: "generate-test-run-current",
      name: "Manual Test Run",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.generateTestRun(file);
        return true;
      },
    });

    this.addCommand({
      id: "run-with-automated-tests",
      name: "Run with Automated Tests",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!this.settings.playwrightProjectPath.trim()) return false;
        if (checking) return true;
        this.runWithAutomatedTests(file);
        return true;
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
    this.ribbonTestRun = this.addRibbonIcon("test-tube", "Manual Test Run", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.generateTestRun(file);
      else new Notice("No active file open.");
    });
    this.ribbonAutoRun = this.addRibbonIcon("zap", "Run with Automated Tests", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.runWithAutomatedTests(file);
      else new Notice("No active file open.");
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
        await new Promise((r) => setTimeout(r, 50));
        const current = await this.app.vault.read(abstractFile);
        if (current.trim() !== "") return; // Already has content
        const title = abstractFile.basename.replace(/^Bug - /, "");
        await this.app.vault.modify(abstractFile, this.bugTemplate(title));

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
    this.statusBarTestRun.setAttribute("title", "Manual Test Run");
    this.statusBarTestRun.textContent = "🧪 Manual";
    this.statusBarTestRun.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.generateTestRun(file);
      else new Notice("No active file open.");
    });

    this.statusBarAutoRun = this.addStatusBarItem();
    this.statusBarAutoRun.addClass("qa-status-bar-btn");
    this.statusBarAutoRun.setAttribute("title", "Run with Automated Tests");
    this.statusBarAutoRun.textContent = "⚡ Auto Run";
    this.statusBarAutoRun.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.runWithAutomatedTests(file);
      else new Notice("No active file open.");
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
    const hasPlaywright = !!this.settings.playwrightProjectPath.trim();
    toggle(this.ribbonTestRun,      this.settings.showRibbonTestRun);
    toggle(this.ribbonAutoRun,      this.settings.showRibbonAutoRun && hasPlaywright);
    toggle(this.ribbonResults,      this.settings.showRibbonResults);
    toggle(this.ribbonDashboard,    this.settings.showRibbonDashboard && this.settings.enableDashboard);
    toggle(this.statusBarTestRun,   this.settings.showStatusBarTestRun);
    toggle(this.statusBarAutoRun,   this.settings.showStatusBarAutoRun && hasPlaywright);
    toggle(this.statusBarResults,   this.settings.showStatusBarResults);
    toggle(this.statusBarDashboard, this.settings.showStatusBarDashboard && this.settings.enableDashboard);
  }

  // ─── Playwright: run automated tests ──────────────────────────────────────

  private async runWithAutomatedTests(file: TFile) {
    const content = await this.app.vault.read(file);
    const testCases = parseTestCases(content);

    if (testCases.length === 0) {
      new Notice("No test cases found in this file.");
      return;
    }

    const allTags = getAllTags(testCases);
    const suiteName = file.basename;

    const openTagSelect = (prevInclude: string[] = [], prevExclude: string[] = []) => {
      new TagSelectModal(this.app, allTags, suiteName, (includeTags, excludeTags) => {
        const filtered = filterByTags(testCases, includeTags, excludeTags);

        new TestReviewModal(
          this.app, suiteName, testCases, filtered, includeTags, excludeTags,
          async (selectedCases: TestCase[]) => {
            const checklist = generateChecklist(selectedCases, suiteName, includeTags, excludeTags);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const runFileName = `${suiteName} - Test Run ${timestamp}.md`;
            const runsFolder = this.getRunsFolder(suiteName);

            await this.ensureFolder(runsFolder);

            const dashPath = `${runsFolder}/Dashboard.md`;
            if (this.settings.enableDashboard && !this.app.vault.getAbstractFileByPath(dashPath)) {
              await this.app.vault.create(dashPath, this.buildEmptyDashboard(suiteName));
            }

            const runPath = `${runsFolder}/${runFileName}`;
            const runFile = await this.app.vault.create(runPath, checklist);

            if (this.settings.enableDashboard) {
              const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
              if (dashFile instanceof TFile) await this.regenerateDashboard(dashFile);
            }

            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(runFile);
            new Notice(`Test Run created: ${runPath}`);

            const ids = extractTmsIds(checklist);
            if (ids.length === 0) {
              new Notice("No TMS IDs (Txxx) found in test run — skipping automated run.");
              return;
            }

            this.runPlaywrightTests(runFile, ids);
          },
          () => openTagSelect(includeTags, excludeTags)
        ).open();
      }, prevInclude, prevExclude).open();
    };

    openTagSelect();
  }

  private runPlaywrightTests(runFile: TFile, ids: string[]) {
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

    const tmpResults = path.join(os.tmpdir(), "tms-playwright-results.json");
    const grep = ids.map(id => `\\(${id}\\)`).join("|");

    const parts = baseCommand.split(/\s+/);
    const cmd = parts[0];
    const baseArgs = parts.slice(1);
    const args = [...baseArgs, "--grep", grep, "--reporter=json"];

    const displayCmd = `${baseCommand} --grep "${ids.map(id => `(${id})`).join("|")}" --reporter=json`;
    const modal = new PlaywrightProgressModal(this.app, ids, displayCmd);
    modal.open();

    const proc = spawn(cmd, args, {
      cwd: projectPath,
      shell: true,
      env: { ...process.env },
    });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => modal.appendOutput(chunk.toString()));

    proc.on("close", async (code: number | null) => {
      try {
        const report = JSON.parse(stdout) as PwJsonReport;
        const resultMap = parsePwJsonReport(report);

        const currentContent = await this.app.vault.read(runFile);
        const { updated, count } = applyPlaywrightResults(currentContent, resultMap);
        if (count > 0) await this.app.vault.modify(runFile, updated);

        const passed  = Array.from(resultMap.values()).filter(s => s === "passed").length;
        const failed  = Array.from(resultMap.values()).filter(s => s === "failed").length;
        const skipped = Array.from(resultMap.values()).filter(s => s === "skipped").length;

        modal.setDone(
          `Done. ${passed} passed, ${failed} failed, ${skipped} skipped. ${count} test(s) updated.`,
          code === 0
        );
        new Notice(`Playwright sync: ${count} test(s) updated.`);
      } catch (err) {
        modal.appendOutput(`\nFailed to parse results: ${(err as Error).message}\n`);
        modal.setDone("Error parsing Playwright results. Check output above.", false);
      }
      // clean up temp file
      try { fs.unlinkSync(tmpResults); } catch { /* ignore */ }
    });

    proc.on("error", (err: Error) => {
      modal.appendOutput(`\nFailed to start process: ${err.message}\n`);
      modal.setDone("Failed to run Playwright. Check project path in settings.", false);
    });
  }

  // ─── Folder helpers ────────────────────────────────────────────────────────

  private getRunsFolder(suiteName: string): string {
    const base = this.settings.defaultTestRunFolder.trim().replace(/\/+$/, "");
    return base ? `${base}/${suiteName} Test Runs` : `${suiteName} Test Runs`;
  }

  private getBugFilePath(bugName: string, sourceFilePath: string): string {
    const configured = this.settings.bugsFolder.trim().replace(/\/+$/, "");
    if (configured) return `${configured}/${bugName}.md`;
    const folder = sourceFilePath.includes("/")
      ? sourceFilePath.substring(0, sourceFilePath.lastIndexOf("/"))
      : "";
    return folder ? `${folder}/${bugName}.md` : `${bugName}.md`;
  }

  private async ensureFolder(path: string) {
    if (!path) return;
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private bugTemplate(title: string): string {
    const tpl = this.settings.bugTemplate.trim();
    if (tpl) {
      return tpl.replace(/\{\{title\}\}/g, title);
    }
    return `# ${title}\n`;
  }

  private getBugStatus(bugName: string): string {
    const file = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
    if (!file) return "UNKNOWN";
    const cache = this.app.metadataCache.getFileCache(file);
    return (cache?.frontmatter?.status as string) ?? "New";
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

  private async generateTestRun(file: TFile) {
    const content = await this.app.vault.read(file);
    const testCases = parseTestCases(content);

    if (testCases.length === 0) {
      new Notice("No test cases found in this file.");
      return;
    }

    const allTags = getAllTags(testCases);
    const suiteName = file.basename;

    const openTagSelect = (prevInclude: string[] = [], prevExclude: string[] = []) => {
      new TagSelectModal(this.app, allTags, suiteName, (includeTags, excludeTags) => {
        const filtered = filterByTags(testCases, includeTags, excludeTags);

        new TestReviewModal(
          this.app,
          suiteName,
          testCases,
          filtered,
          includeTags,
          excludeTags,
          async (selectedCases: TestCase[]) => {
            const checklist = generateChecklist(selectedCases, suiteName, includeTags, excludeTags);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const runFileName = `${suiteName} - Test Run ${timestamp}.md`;
            const runsFolder = this.getRunsFolder(suiteName);

            await this.ensureFolder(runsFolder);

            // Create and refresh Dashboard (if enabled)
            const dashPath = `${runsFolder}/Dashboard.md`;
            if (this.settings.enableDashboard) {
              if (!this.app.vault.getAbstractFileByPath(dashPath)) {
                await this.app.vault.create(dashPath, this.buildEmptyDashboard(suiteName));
              }
            }

            const runPath = `${runsFolder}/${runFileName}`;
            const newFile = await this.app.vault.create(runPath, checklist);

            if (this.settings.enableDashboard) {
              const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
              if (dashFile instanceof TFile) {
                await this.regenerateDashboard(dashFile);
              }
            }

            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(newFile);
            new Notice(`Test Run created: ${runPath}`);
          },
          () => openTagSelect(includeTags, excludeTags)
        ).open();
      }, prevInclude, prevExclude).open();
    };

    openTagSelect();
  }

  private async calculateTestResults() {
    const file = this.app.workspace.getActiveFile();
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
          await this.app.vault.create(filePath, this.bugTemplate(title));
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
    const preStatsContent = content.replace(/\n+---\n+## Test Results Statistics[\s\S]*$/, "");
    const bugNames = extractBugNames(preStatsContent);
    let newFilesCreated = false;
    for (const bugName of bugNames) {
      const title = bugName.replace(/^Bug - /, "");
      const existingFile = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
      if (!existingFile) {
        const filePath = this.getBugFilePath(bugName, file.path);
        const folder = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
        if (folder) await this.ensureFolder(folder);
        await this.app.vault.create(filePath, this.bugTemplate(title));
        new Notice(`Bug created: ${bugName}`);
        newFilesCreated = true;
      }
    }
    if (newFilesCreated) await new Promise((r) => setTimeout(r, 300));

    let finalContent = statsContent;
    if (bugNames.length > 0) {
      const rows = bugNames.map((bugName) => {
        const status = this.getBugStatus(bugName);
        return `| [[${bugName}]] | ${status} |`;
      });
      finalContent += `\n## Bugs\n\n| Bug | Status |\n| --- | --- |\n${rows.join("\n")}\n`;
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

    // In a Test Runs folder — go to its Dashboard
    if (file.parent?.name.endsWith(" Test Runs")) {
      const dashPath = `${file.parent.path}/Dashboard.md`;
      const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
      if (dashFile instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(dashFile);
        return;
      }
    }

    // On a test suite file — navigate to its runs folder Dashboard
    const suiteName = file.basename;
    const runsFolder = this.getRunsFolder(suiteName);
    const dashPath = `${runsFolder}/Dashboard.md`;
    const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
    if (dashFile instanceof TFile) {
      await this.app.workspace.getLeaf().openFile(dashFile);
    } else {
      new Notice("No dashboard found. Create a test run first.");
    }
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  private buildEmptyDashboard(suiteName: string): string {
    return `${DASHBOARD_MARKER}\n# ${suiteName} - Dashboard\n\n> Auto-refreshes when opened.\n\n*No test runs yet. Create your first test run to see statistics.*\n`;
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
    const runFiles: TFile[] = folder.children
      .filter(
        (f): f is TFile =>
          f instanceof TFile &&
          f.name !== "Dashboard.md" &&
          f.name.includes("- Test Run ")
      )
      .sort((a, b) => parseSortKey(a.name).localeCompare(parseSortKey(b.name)));

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

    for (const runFile of runFiles) {
      const content = await this.app.vault.cachedRead(runFile);
      const counts: Record<string, number> = { pass: 0, fail: 0, skipped: 0, blocked: 0, notrun: 0 };
      content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        for (const s of STATUS_PATTERNS) {
          if (s.regex.test(trimmed)) { counts[s.key]++; break; }
        }
      });
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
      const preStats = content.replace(/\n+---\n+## Test Results Statistics[\s\S]*$/, "");
      for (const bugName of extractBugNames(preStats)) {
        allBugNames.add(bugName);
      }
    }

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

    const visibleBugs = Array.from(allBugNames).filter(
      (bugName) => !hiddenStatuses.includes(this.getBugStatus(bugName).toLowerCase())
    );

    if (visibleBugs.length > 0) {
      md += `## Bugs\n\n`;
      md += `| Bug | Status |\n`;
      md += `|-----|--------|\n`;
      for (const bugName of visibleBugs) {
        const status = this.getBugStatus(bugName);
        md += `| [[${bugName}]] | ${status} |\n`;
      }
    } else {
      md += `*No active bugs.*\n`;
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
      .setDesc("Test runs are saved inside '{Base folder}/{Suite name} Test Runs/'. Leave empty for vault root.")
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
      .setDesc("Template for new bug pages. Use {{title}} as a placeholder for the bug title. Leave empty for a plain heading only.")
      .addTextArea((ta) => {
        ta.setPlaceholder(
          "---\nstatus: New\ntags: [Bug]\n---\n\n# {{title}}\n\n## Description\n\n## Steps to Reproduce"
        ).setValue(this.plugin.settings.bugTemplate);
        ta.inputEl.style.width = "320px";
        ta.inputEl.style.height = "140px";
        ta.inputEl.style.fontFamily = "monospace";
        ta.onChange(async (value) => {
          this.plugin.settings.bugTemplate = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    // ── Dashboard ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Dashboard" });

    new Setting(containerEl)
      .setName("Enable Dashboard")
      .setDesc("Auto-creates a Dashboard page in the test runs folder and refreshes it on open.")
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
      { name: "Ribbon: Manual Test Run",      key: "showRibbonTestRun"      },
      { name: "Ribbon: Auto Run",             key: "showRibbonAutoRun"      },
      { name: "Ribbon: Results",              key: "showRibbonResults"      },
      { name: "Ribbon: Dashboard",            key: "showRibbonDashboard"    },
      { name: "Status bar: Manual Test Run",  key: "showStatusBarTestRun"   },
      { name: "Status bar: Auto Run",         key: "showStatusBarAutoRun"   },
      { name: "Status bar: Results",          key: "showStatusBarResults"   },
      { name: "Status bar: Dashboard",        key: "showStatusBarDashboard" },
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

    // ── Playwright Setup Guide ────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Playwright Setup Guide" });

    const guide = containerEl.createDiv({ cls: "qa-pw-guide" });

    guide.createEl("p", { text: "Follow these steps once to connect your Playwright tests to TMS:" });

    const steps = guide.createEl("ol", { cls: "qa-pw-steps" });

    const s1 = steps.createEl("li");
    s1.appendText("Add the TMS ID inside parentheses at the end of each automated test title:");
    s1.createEl("pre", { cls: "qa-pw-code",
      text: "test('Login with valid credentials (T01)', async ({ page }) => {\n  // ...\n});\n\ntest('Invalid password (T02)', async ({ page }) => {\n  // ...\n});" });

    const s2 = steps.createEl("li");
    s2.appendText("Set the ");
    s2.createEl("strong", { text: "Playwright project path" });
    s2.appendText(" above — the folder that contains ");
    s2.createEl("code", { text: "playwright.config.ts" });
    s2.appendText(".");

    const s3 = steps.createEl("li");
    s3.appendText("In your Obsidian test suite file, add the same ID at the end of each automated test case:");
    s3.createEl("pre", { cls: "qa-pw-code",
      text: "- [ ] Login with valid credentials (T01)\n- [ ] Invalid password (T02)\n- [ ] Check email layout   ← manual, no ID, never touched by automation" });

    const s4 = steps.createEl("li");
    s4.appendText("Click ");
    s4.createEl("strong", { text: "⚡ Run with Automated Tests" });
    s4.appendText(" (ribbon or status bar). The plugin will:");
    const s4ul = s4.createEl("ul");
    s4ul.createEl("li", { text: "Create a test run from the current suite" });
    s4ul.createEl("li", { text: "Extract all (Txxx) IDs from the test run" });
    s4ul.createEl("li", { text: "Run only matching Playwright tests" });
    s4ul.createEl("li", { text: "Write pass / fail / skipped results back into the test run" });
    s4ul.createEl("li", { text: "Manual tests (no ID) are never modified" });

    const s5 = steps.createEl("li");
    s5.appendText("Results are mapped as: ");
    s5.createEl("code", { text: "passed → [x]" });
    s5.appendText("  ");
    s5.createEl("code", { text: "failed → [f]" });
    s5.appendText("  ");
    s5.createEl("code", { text: "skipped → [s]" });

    // ── Hotkeys ───────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Hotkeys" });
    const desc = containerEl.createEl("p", { cls: "mod-note" });
    desc.appendText("To set keyboard shortcuts, go to ");
    desc.createEl("strong", { text: "Settings → Hotkeys" });
    desc.appendText(' and search for "Test Management System".');

    // ── Bug creation tip ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Creating Bugs" });
    const bugTip = containerEl.createEl("p", { cls: "mod-note" });
    bugTip.appendText("In a test run, add an indented line starting with ");
    bugTip.createEl("code", { text: "!" });
    bugTip.appendText(" under a test case to create a bug page:");
    containerEl.createEl("pre", {
      text: "- [f] ❌ Fail | Test case name\n  ! Bug title here",
      cls: "mod-note",
    });
    containerEl.createEl("p", {
      text: "Плагін створює сторінку бага. За замовчуванням — лише заголовок. Додайте шаблон вище щоб автоматично наповнювати бага статусом, тегами тощо. Статуси які приховувати на дашборді — налаштовуються у полі «Hidden bug statuses».",
      cls: "mod-note",
    });
  }
}
