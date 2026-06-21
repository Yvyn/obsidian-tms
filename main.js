var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TMSPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DASHBOARD_MARKER = "<!-- tms-dashboard -->";
var PW_PANEL_VIEW_TYPE = "tms-playwright-panel";
var STATS_SECTION_RE = /\n+---\n+## Test Results Statistics[\s\S]*$/;
function parseTestCase(line, lineNumber) {
  var _a;
  const trimmed = line.trim();
  if (!trimmed)
    return null;
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
  if (headingMatch) {
    const headingLevel = headingMatch[1].length;
    const rawName = headingMatch[2].trim();
    const tagRegex2 = /@([\p{L}\p{N}_-]+)/gu;
    const tags2 = [];
    let m;
    while ((m = tagRegex2.exec(rawName)) !== null)
      tags2.push(m[1].toLowerCase());
    const firstTagIndex2 = rawName.search(/@[\p{L}\p{N}_-]+/u);
    const name2 = firstTagIndex2 >= 0 ? rawName.slice(0, firstTagIndex2).trim() : rawName;
    return { line: trimmed, name: name2, tags: tags2, lineNumber, indent: 0, children: [], hasChildren: false, isHeading: true, headingLevel };
  }
  const leadingWhitespace = ((_a = line.match(/^(\s*)/)) == null ? void 0 : _a[1]) || "";
  const tabCount = (leadingWhitespace.match(/\t/g) || []).length;
  const spaceCount = (leadingWhitespace.match(/ /g) || []).length;
  const indent = tabCount + Math.floor(spaceCount / 2);
  const normalized = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, "").replace(/^(✅ Pass|❌ Fail|⏭️ Skipped|🚫 Blocked)\s*\|\s*/, "").replace(/^\*\*(.*?)\*\*(.*)$/, "$1$2");
  const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(normalized)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  const firstTagIndex = normalized.search(/@[\p{L}\p{N}_-]+/u);
  const name = firstTagIndex >= 0 ? normalized.slice(0, firstTagIndex).trim() : normalized;
  return { line: trimmed, name, tags, lineNumber, indent, children: [], hasChildren: false };
}
function parseTestCases(content) {
  const lines = content.split("\n");
  const allItems = [];
  lines.forEach((line, idx) => {
    const tc = parseTestCase(line, idx + 1);
    if (tc)
      allItems.push(tc);
  });
  const rootItems = [];
  const headingStack = [];
  const indentStack = [];
  for (const item of allItems) {
    if (item.isHeading) {
      indentStack.length = 0;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= item.headingLevel) {
        headingStack.pop();
      }
      if (headingStack.length > 0) {
        const parent = headingStack[headingStack.length - 1].item;
        parent.children.push(item);
        parent.hasChildren = true;
      } else {
        rootItems.push(item);
      }
      headingStack.push({ item, level: item.headingLevel });
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
function countLeafTestCases(items) {
  let count = 0;
  for (const tc of items) {
    if (!tc.isHeading)
      count++;
    count += countLeafTestCases(tc.children);
  }
  return count;
}
function getAllTags(testCases) {
  const tagSet = /* @__PURE__ */ new Set();
  const collect = (items) => {
    items.forEach((tc) => {
      if (!tc.isHeading)
        tc.tags.forEach((t) => tagSet.add(t));
      if (tc.children.length > 0)
        collect(tc.children);
    });
  };
  collect(testCases);
  return Array.from(tagSet).sort();
}
function collectLeafLineNumbers(items) {
  const result = [];
  for (const tc of items) {
    if (!tc.isHeading)
      result.push(tc.lineNumber);
    if (tc.children.length > 0)
      result.push(...collectLeafLineNumbers(tc.children));
  }
  return result;
}
function filterByTags(testCases, includeTags, excludeTags) {
  if (includeTags.length === 0 && excludeTags.length === 0)
    return testCases;
  const filtered = [];
  for (const tc of testCases) {
    if (tc.isHeading) {
      const filteredChildren = filterByTags(tc.children, includeTags, excludeTags);
      if (filteredChildren.length > 0) {
        filtered.push({ ...tc, children: filteredChildren, hasChildren: true });
      }
      continue;
    }
    if (excludeTags.length > 0 && excludeTags.some((tag) => tc.tags.includes(tag)))
      continue;
    if (includeTags.length === 0) {
      filtered.push(tc);
    } else {
      const matchesInclude = includeTags.some((tag) => tc.tags.includes(tag));
      if (matchesInclude) {
        filtered.push(tc);
      } else if (tc.hasChildren) {
        const hasMatchingChild = tc.children.some(
          (child) => includeTags.some((tag) => child.tags.includes(tag)) && !excludeTags.some((tag) => child.tags.includes(tag))
        );
        if (hasMatchingChild)
          filtered.push(tc);
      }
    }
  }
  return filtered;
}
function filterByNames(testCases, names) {
  const result = [];
  for (const tc of testCases) {
    if (tc.isHeading) {
      const children = filterByNames(tc.children, names);
      if (children.length > 0)
        result.push({ ...tc, children, hasChildren: true });
    } else if (names.has(tc.name.trim())) {
      result.push(tc);
    }
  }
  return result;
}
function generateChecklist(testCases, suiteName, includeTags, excludeTags) {
  const timestamp = new Date().toLocaleString();
  let filterLine = "";
  if (includeTags.length > 0)
    filterLine += `
**Include:** ${includeTags.map((t) => `@${t}`).join(" ")}`;
  if (excludeTags.length > 0)
    filterLine += `
**Exclude:** ${excludeTags.map((t) => `@${t}`).join(" ")}`;
  let md = `# Test Run: ${suiteName}
`;
  md += `**Test Suite:** [[${suiteName}]]
`;
  md += `**Date:** ${timestamp}${filterLine}
`;
  md += `**Total Cases:** ${countLeafTestCases(testCases)}

`;
  md += "---\n\n";
  function renderItems(items, depth) {
    let result = "";
    for (const tc of items) {
      if (tc.isHeading) {
        const hashes = "#".repeat(tc.headingLevel || 2);
        result += `
${hashes} ${tc.name}

`;
        if (tc.children.length > 0)
          result += renderItems(tc.children, depth);
        continue;
      }
      const indent = "  ".repeat(depth);
      const tagsStr = tc.tags.map((t) => `@${t}`).join(" ");
      if (depth === 0) {
        result += `- [ ] **${tc.name}** ${tagsStr}
`;
      } else {
        result += `${indent}- ${tc.name} ${tagsStr}
`;
      }
      if (tc.children.length > 0)
        result += renderItems(tc.children, depth + 1);
    }
    return result;
  }
  md += renderItems(testCases, 0);
  md += "\n---\n\n";
  return md;
}
var STATUS_LABEL_MAP = {
  p: "\u2705 Pass",
  P: "\u2705 Pass",
  f: "\u274C Fail",
  F: "\u274C Fail",
  s: "\u23ED\uFE0F Skipped",
  S: "\u23ED\uFE0F Skipped",
  b: "\u{1F6AB} Blocked",
  B: "\u{1F6AB} Blocked"
};
var EXISTING_LABEL_RE = /^(✅ Pass|❌ Fail|⏭️ Skipped|🚫 Blocked|🟢 Pass|🔴 Fail|🟡 Skipped|🟣 Blocked)( 📅 \d{4}-\d{2}-\d{2})? \| /;
function applyStatusLabel(line) {
  const match = line.match(/^(- \[([^\]]+)\] )([^]*)/);
  if (!match)
    return line;
  const [, cbPart, statusChar, rest] = match;
  const newLabel = STATUS_LABEL_MAP[statusChar];
  const existingMatch = rest.match(EXISTING_LABEL_RE);
  const existingLabel = existingMatch == null ? void 0 : existingMatch[1];
  if (existingLabel === newLabel)
    return line;
  const cleanRest = rest.replace(EXISTING_LABEL_RE, "").replace(/\s+$/, "");
  if (!newLabel) {
    return `${cbPart}${cleanRest}`;
  }
  return `${cbPart}${newLabel} | ${cleanRest}`;
}
var STATUS_EMOJI = {
  pass: "\u2705",
  fail: "\u274C",
  skipped: "\u23ED\uFE0F",
  blocked: "\u{1F6AB}",
  notrun: "\u2B1C"
};
var STATUS_PATTERNS = [
  { regex: /^- \[[xXpP]\]/, key: "pass", label: "Pass" },
  { regex: /^- \[[fF]\]/, key: "fail", label: "Fail" },
  { regex: /^- \[[sS]\]/, key: "skipped", label: "Skipped" },
  { regex: /^- \[[bB]\]/, key: "blocked", label: "Blocked" },
  { regex: /^- \[ \]/, key: "notrun", label: "Not Run" }
];
function calculateResults(content) {
  const counts = { pass: 0, fail: 0, skipped: 0, blocked: 0, notrun: 0 };
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    for (const s of STATUS_PATTERNS) {
      if (s.regex.test(trimmed)) {
        counts[s.key]++;
        break;
      }
    }
  });
  const total = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
  if (total === 0)
    return "";
  const entries = STATUS_PATTERNS.filter((s) => counts[s.key] > 0).map((s) => `    "${STATUS_EMOJI[s.key]} ${s.label} (${counts[s.key]})" : ${counts[s.key]}`).join("\n");
  let cleaned = content.replace(STATS_SECTION_RE, "");
  cleaned = cleaned.replace(/\s+$/, "");
  return cleaned + `

---

## Test Results Statistics

\`\`\`mermaid
pie title Test Results (Total: ${total})
${entries}
\`\`\`
`;
}
function extractBugNames(content) {
  const seen = /* @__PURE__ */ new Set();
  for (const line of content.split("\n")) {
    const stripped = line.replace(/`[^`]+`/g, "").replace(/\*\*[^*]+\*\*/g, "");
    const regex = /\[\[Bug - ([^\]|#]+)/g;
    let m;
    while ((m = regex.exec(stripped)) !== null) {
      seen.add(`Bug - ${m[1].trim()}`);
    }
  }
  return Array.from(seen);
}
function parseDateLabel(filename) {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (!match)
    return filename.replace(/\.md$/, "");
  return `${MONTHS[parseInt(match[2]) - 1]} ${parseInt(match[3])} ${match[4]}:${match[5]}`;
}
function parseSortKey(filename) {
  const match = filename.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}
function extractTmsIds(content) {
  const seen = /* @__PURE__ */ new Set();
  const regex = /\(T(\d+)\)/gi;
  let m;
  while ((m = regex.exec(content)) !== null)
    seen.add(`T${m[1]}`);
  return Array.from(seen);
}
function parsePwJsonReport(report) {
  const map = /* @__PURE__ */ new Map();
  function walk(suite) {
    var _a, _b, _c, _d, _e;
    for (const spec of (_a = suite.specs) != null ? _a : []) {
      const m = spec.title.match(/\(T(\d+)\)/i);
      if (!m)
        continue;
      const resultStatus = (_d = (_c = (_b = spec.tests[0]) == null ? void 0 : _b.results[0]) == null ? void 0 : _c.status) != null ? _d : "failed";
      const status = resultStatus === "passed" ? "passed" : resultStatus === "skipped" ? "skipped" : "failed";
      map.set(`T${m[1]}`, status);
    }
    for (const sub of (_e = suite.suites) != null ? _e : [])
      walk(sub);
  }
  for (const s of report.suites)
    walk(s);
  return map;
}
function applyPlaywrightResults(content, resultMap) {
  const charMap = { passed: "p", failed: "f", skipped: "s" };
  let count = 0;
  const updated = content.split("\n").map((line) => {
    const m = line.match(/\(T(\d+)\)/i);
    if (!m)
      return line;
    const status = resultMap.get(`T${m[1]}`);
    if (!status || !charMap[status])
      return line;
    const newLine = line.replace(/^(\s*- \[)[^\]]*(\].*)$/, `$1${charMap[status]}$2`);
    if (newLine !== line)
      count++;
    return newLine;
  }).join("\n");
  return { updated, count };
}
var PlaywrightPanelView = class extends import_obsidian.ItemView {
  constructor(leaf) {
    super(leaf);
    this.intervalId = null;
    this.startTime = Date.now();
  }
  getViewType() {
    return PW_PANEL_VIEW_TYPE;
  }
  getDisplayText() {
    return "Playwright Tests";
  }
  getIcon() {
    return "test-tube";
  }
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
  startRun(ids, command) {
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
    if (this.intervalId !== null)
      window.clearInterval(this.intervalId);
    this.intervalId = window.setInterval(() => {
      var _a;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1e3);
      if ((_a = this.statusEl.textContent) == null ? void 0 : _a.startsWith("Running")) {
        this.statusEl.textContent = `Running... ${elapsed}s`;
      }
    }, 1e3);
  }
  appendOutput(text) {
    this.outputEl.textContent += text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
  setDone(message, success = true) {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.statusEl.textContent = message;
    this.statusEl.style.color = success ? "var(--color-green)" : "var(--color-red)";
  }
  async onClose() {
    if (this.intervalId !== null)
      window.clearInterval(this.intervalId);
    this.contentEl.empty();
  }
};
var FolderSuggestModal = class extends import_obsidian.SuggestModal {
  constructor(app, callback) {
    super(app);
    this.callback = callback;
    this.setPlaceholder("Type to search folders\u2026");
  }
  getSuggestions(query) {
    return this.app.vault.getAllLoadedFiles().filter((f) => f instanceof import_obsidian.TFolder && f.path.toLowerCase().includes(query.toLowerCase()));
  }
  renderSuggestion(folder, el) {
    el.createEl("div", { text: folder.path || "/" });
  }
  onChooseSuggestion(folder) {
    this.callback(folder.path);
  }
};
var TagSelectModal = class extends import_obsidian.Modal {
  constructor(app, allTags, suiteName, callback, initialIncludeTags = [], initialExcludeTags = []) {
    super(app);
    this.allTags = allTags;
    this.suiteName = suiteName;
    this.callback = callback;
    this.tagStates = /* @__PURE__ */ new Map();
    this.chipElements = /* @__PURE__ */ new Map();
    allTags.forEach((tag) => {
      if (initialIncludeTags.includes(tag))
        this.tagStates.set(tag, "include");
      else if (initialExcludeTags.includes(tag))
        this.tagStates.set(tag, "exclude");
      else
        this.tagStates.set(tag, "neutral");
    });
  }
  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Select Attributes: ${this.suiteName}` });
    contentEl.createEl("p", {
      text: "Click once: include (green)  \xB7  twice: exclude (red)  \xB7  three times: reset",
      cls: "mod-note"
    });
    const controlsDiv = contentEl.createDiv({ cls: "qa-tag-controls" });
    new import_obsidian.Setting(controlsDiv).addButton((btn) => btn.setButtonText("Include All").onClick(() => this.setAll("include"))).addButton((btn) => btn.setButtonText("Reset All").onClick(() => this.setAll("neutral")));
    const searchInput = contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Search tags\u2026" },
      cls: "qa-tag-search"
    });
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase().trim();
      this.allTags.forEach((tag) => {
        const chip = this.chipElements.get(tag);
        if (!chip)
          return;
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
    new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("Next: Review Tests \u2192").setCta().onClick(() => {
        const includeTags = this.allTags.filter((t) => this.tagStates.get(t) === "include");
        const excludeTags = this.allTags.filter((t) => this.tagStates.get(t) === "exclude");
        this.callback(includeTags, excludeTags);
        this.close();
      })
    );
  }
  cycleTagState(tag) {
    var _a;
    const current = (_a = this.tagStates.get(tag)) != null ? _a : "neutral";
    const next = current === "neutral" ? "include" : current === "include" ? "exclude" : "neutral";
    this.tagStates.set(tag, next);
    this.updateChip(tag);
  }
  setAll(state) {
    this.allTags.forEach((tag) => {
      this.tagStates.set(tag, state);
      this.updateChip(tag);
    });
  }
  updateChip(tag) {
    const chip = this.chipElements.get(tag);
    if (!chip)
      return;
    chip.removeClass("included", "excluded");
    const state = this.tagStates.get(tag);
    if (state === "include")
      chip.addClass("included");
    else if (state === "exclude")
      chip.addClass("excluded");
  }
  onClose() {
    this.contentEl.empty();
  }
};
var TestReviewModal = class extends import_obsidian.Modal {
  constructor(app, suiteName, allTestCases, filteredTestCases, includeTags, excludeTags, onManual, onBack, onAuto = null) {
    super(app);
    this.suiteName = suiteName;
    this.allTestCases = allTestCases;
    this.includeTags = includeTags;
    this.excludeTags = excludeTags;
    this.onManual = onManual;
    this.onBack = onBack;
    this.onAuto = onAuto;
    this.checkedItems = /* @__PURE__ */ new Set();
    this.checkboxRefs = [];
    this.headingCheckboxRefs = [];
    const addChecked = (items) => {
      for (const tc of items) {
        if (!tc.isHeading)
          this.checkedItems.add(tc.lineNumber);
        if (tc.children.length > 0)
          addChecked(tc.children);
      }
    };
    addChecked(filteredTestCases);
  }
  onOpen() {
    this.modalEl.addClass("qa-large-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Review Tests: ${this.suiteName}` });
    const filterParts = [];
    if (this.includeTags.length > 0)
      filterParts.push(`Include: ${this.includeTags.map((t) => `@${t}`).join(" ")}`);
    if (this.excludeTags.length > 0)
      filterParts.push(`Exclude: ${this.excludeTags.map((t) => `@${t}`).join(" ")}`);
    if (filterParts.length > 0) {
      const summary = contentEl.createDiv({ cls: "qa-summary" });
      filterParts.forEach((p) => summary.createEl("p", { text: p }));
    } else {
      contentEl.createEl("p", { text: "No tag filter \u2014 all test cases shown.", cls: "mod-note" });
    }
    const totalTestCount = countLeafTestCases(this.allTestCases);
    const counterEl = contentEl.createEl("p", { cls: "qa-review-counter" });
    const updateCounter = () => {
      counterEl.textContent = `${this.checkedItems.size} / ${totalTestCount} tests selected`;
    };
    updateCounter();
    const listEl = contentEl.createDiv({ cls: "qa-review-list" });
    this.checkboxRefs = [];
    const renderTree = (items, container, isCheckable, childDepth, parentHeadingLevel = 0) => {
      items.forEach((tc) => {
        if (tc.isHeading && tc.name === "__manually_added_separator__") {
          const sep = container.createDiv({ cls: "qa-review-separator" });
          sep.style.cssText = "border-top:1px dashed var(--color-base-40);margin:12px 0 8px;padding-top:8px;";
          sep.createEl("span", { text: "Added manually", cls: "qa-review-separator-label" }).style.cssText = "font-size:11px;color:var(--color-base-50);text-transform:uppercase;letter-spacing:.05em;padding-left:10px;";
          return;
        }
        if (tc.isHeading) {
          const headingEl = container.createDiv({ cls: "qa-review-section-heading" });
          if (tc.isManuallyAdded)
            headingEl.style.borderLeftColor = "var(--color-orange)";
          headingEl.style.paddingLeft = `${(tc.headingLevel - 1) * 20 + 10}px`;
          const leafLineNumbers = collectLeafLineNumbers(tc.children);
          if (leafLineNumbers.length > 0) {
            const headingCb = headingEl.createEl("input", { attr: { type: "checkbox" } });
            headingCb.addClass("qa-heading-checkbox");
            const updateHeadingCb = () => {
              const n = leafLineNumbers.filter((ln) => this.checkedItems.has(ln)).length;
              headingCb.indeterminate = n > 0 && n < leafLineNumbers.length;
              headingCb.checked = n === leafLineNumbers.length;
            };
            updateHeadingCb();
            this.headingCheckboxRefs.push({ lineNumbers: leafLineNumbers, cb: headingCb, update: updateHeadingCb });
            headingCb.addEventListener("change", () => {
              if (headingCb.checked)
                leafLineNumbers.forEach((ln) => this.checkedItems.add(ln));
              else
                leafLineNumbers.forEach((ln) => this.checkedItems.delete(ln));
              this.checkboxRefs.forEach((ref) => {
                if (leafLineNumbers.includes(ref.lineNumber))
                  ref.cb.checked = this.checkedItems.has(ref.lineNumber);
              });
              updateCounter();
              this.headingCheckboxRefs.forEach((ref) => ref.update());
            });
          }
          const level = Math.min(tc.headingLevel || 2, 6);
          headingEl.createEl(`h${level}`, { text: tc.name, cls: "qa-review-heading-text" });
          if (tc.children.length > 0)
            renderTree(tc.children, container, true, 0, tc.headingLevel);
          return;
        }
        const itemEl = container.createDiv({ cls: "qa-review-item" });
        itemEl.style.paddingLeft = `${parentHeadingLevel * 20 + 12 + childDepth * 16}px`;
        if (isCheckable) {
          const cb = itemEl.createEl("input", { attr: { type: "checkbox" } });
          cb.checked = this.checkedItems.has(tc.lineNumber);
          cb.addEventListener("change", () => {
            if (cb.checked)
              this.checkedItems.add(tc.lineNumber);
            else
              this.checkedItems.delete(tc.lineNumber);
            updateCounter();
            this.headingCheckboxRefs.forEach((ref) => {
              if (ref.lineNumbers.includes(tc.lineNumber))
                ref.update();
            });
          });
          this.checkboxRefs.push({ lineNumber: tc.lineNumber, cb });
        } else {
          const bullet = itemEl.createEl("span");
          bullet.style.marginRight = "6px";
          bullet.style.color = "var(--text-faint)";
          bullet.textContent = "\xB7";
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
            toggle.textContent = "\u25B6";
            toggle.addEventListener("click", (e) => {
              e.stopPropagation();
              expanded = !expanded;
              toggle.textContent = expanded ? "\u25BC" : "\u25B6";
              childrenEl.style.display = expanded ? "" : "none";
            });
            childrenEl.style.display = "none";
          }
          const labelEl = itemEl.createEl("label");
          labelEl.style.cursor = isCheckable ? "pointer" : "default";
          labelEl.createSpan({ text: tc.name });
          if (tc.tags.length > 0) {
            labelEl.createEl("span", {
              text: "  " + tc.tags.map((t) => `@${t}`).join(" "),
              cls: "qa-review-item-tags"
            });
          }
          if (isCheckable) {
            labelEl.addEventListener("click", () => {
              var _a;
              const cb = (_a = this.checkboxRefs.find((r) => r.lineNumber === tc.lineNumber)) == null ? void 0 : _a.cb;
              if (cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event("change"));
              }
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
              text: "  " + tc.tags.map((t) => `@${t}`).join(" "),
              cls: "qa-review-item-tags"
            });
          }
          if (isCheckable) {
            labelEl.addEventListener("click", () => {
              var _a;
              const cb = (_a = this.checkboxRefs.find((r) => r.lineNumber === tc.lineNumber)) == null ? void 0 : _a.cb;
              if (cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event("change"));
              }
            });
          }
        }
      });
    };
    renderTree(this.allTestCases, listEl, true, 0, 0);
    const collectSelected = (items) => {
      const result = [];
      for (const tc of items) {
        if (tc.isHeading) {
          const selectedChildren = collectSelected(tc.children);
          if (selectedChildren.length > 0)
            result.push({ ...tc, children: selectedChildren, hasChildren: true });
        } else if (this.checkedItems.has(tc.lineNumber)) {
          result.push({ ...tc, children: collectSelected(tc.children) });
        }
      }
      return result;
    };
    const setting = new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("\u2190 Back").onClick(() => {
        this.close();
        this.onBack();
      })
    ).addButton(
      (btn) => btn.setButtonText("Manual Test Run").onClick(() => {
        const selected = collectSelected(this.allTestCases);
        if (countLeafTestCases(selected) === 0) {
          new import_obsidian.Notice("No test cases selected.");
          return;
        }
        this.onManual(selected);
        this.close();
      })
    );
    if (this.onAuto !== null) {
      setting.addButton((btn) => {
        btn.setButtonText("Run Auto-tests").setCta();
        btn.onClick(() => {
          const selected = collectSelected(this.allTestCases);
          if (countLeafTestCases(selected) === 0) {
            new import_obsidian.Notice("No test cases selected.");
            return;
          }
          this.onAuto(selected);
          this.close();
        });
        return btn;
      });
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var BugCreateSuggest = class extends import_obsidian.EditorSuggest {
  constructor(app) {
    super(app);
  }
  onTrigger(cursor, editor, _file) {
    const upToCursor = editor.getLine(cursor.line).substring(0, cursor.ch);
    if (!upToCursor.match(/^(\s*)(?:-\s)?!$/))
      return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - 1 },
      end: cursor,
      query: ""
    };
  }
  getSuggestions(_ctx) {
    return ["New Bug"];
  }
  renderSuggestion(_value, el) {
    el.createEl("div", { text: "Bug" });
  }
  selectSuggestion(_value, _evt) {
    var _a, _b;
    const { editor, start } = this.context;
    const fullLine = editor.getLine(start.line);
    const indent = (_b = (_a = fullLine.match(/^(\s*)/)) == null ? void 0 : _a[1]) != null ? _b : "";
    const placeholder = "[[Bug - ]]";
    editor.replaceRange(
      indent + placeholder,
      { line: start.line, ch: 0 },
      { line: start.line, ch: fullLine.length }
    );
    editor.setCursor({ line: start.line, ch: indent.length + "[[Bug - ".length });
  }
};
var AttributeSuggest = class extends import_obsidian.EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.index = /* @__PURE__ */ new Set();
    this.buildIndex();
    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => {
        if (file instanceof import_obsidian.TFile && file.extension === "md")
          this.updateFile(file);
      })
    );
  }
  async buildIndex() {
    await Promise.all(this.app.vault.getMarkdownFiles().map((file) => this.updateFile(file)));
  }
  async updateFile(file) {
    const content = await this.app.vault.cachedRead(file);
    const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
    let m;
    while ((m = tagRegex.exec(content)) !== null)
      this.index.add(m[1].toLowerCase());
  }
  onTrigger(cursor, editor, _file) {
    const sub = editor.getLine(cursor.line).substring(0, cursor.ch);
    const match = sub.match(/@([\p{L}\p{N}_-]*)$/u);
    if (!match)
      return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[1]
    };
  }
  getSuggestions(context) {
    const query = context.query.toLowerCase();
    return Array.from(this.index).filter((t) => t.startsWith(query) && t !== query).sort();
  }
  renderSuggestion(value, el) {
    el.createEl("span", { text: `@${value}` });
  }
  selectSuggestion(value) {
    const { editor, start, end } = this.context;
    editor.replaceRange(`@${value}`, start, end);
  }
};
var DEFAULT_SETTINGS = {
  defaultTestRunFolder: "",
  bugsFolder: "",
  bugTemplate: "",
  enableDashboard: true,
  dashboardHiddenStatuses: "done",
  showRibbonTestRun: true,
  showRibbonResults: true,
  showRibbonDashboard: true,
  showStatusBarTestRun: true,
  showStatusBarResults: true,
  showStatusBarDashboard: true,
  playwrightProjectPath: "",
  playwrightCommand: "npx playwright test"
};
var TMSPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.ribbonTestRun = null;
    this.ribbonResults = null;
    this.ribbonDashboard = null;
    this.statusBarTestRun = null;
    this.statusBarResults = null;
    this.statusBarDashboard = null;
    this.processingFiles = /* @__PURE__ */ new Set();
    this.dashboardRefreshing = false;
  }
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
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return false;
        if (checking)
          return true;
        this.openTestRunFlow(file);
        return true;
      }
    });
    this.addCommand({
      id: "calculate-test-results",
      name: "Results",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return false;
        if (file.extension !== "md")
          return false;
        if (checking)
          return true;
        this.calculateTestResults();
        return true;
      }
    });
    this.addCommand({
      id: "insert-bug-template",
      name: "Insert Bug Template",
      editorCallback: (editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return;
        const title = file.basename.startsWith("Bug - ") ? file.basename.replace(/^Bug - /, "") : file.basename;
        const templateContent = this.bugTemplate(title);
        if (!templateContent) {
          new import_obsidian.Notice("No bug template configured. Set one in plugin settings.");
          return;
        }
        editor.replaceSelection(templateContent);
      }
    });
    this.addCommand({
      id: "open-dashboard",
      name: "Dashboard",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return false;
        if (checking)
          return true;
        this.openOrRefreshDashboard();
        return true;
      }
    });
    this.ribbonTestRun = this.addRibbonIcon("test-tube", "Test Run", () => {
      const file = this.app.workspace.getActiveFile();
      if (file)
        this.openTestRunFlow(file);
      else
        new import_obsidian.Notice("No active file open.");
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
    this.registerEvent(
      this.app.vault.on("create", async (abstractFile) => {
        var _a;
        if (!(abstractFile instanceof import_obsidian.TFile) || abstractFile.extension !== "md")
          return;
        if (!abstractFile.basename.startsWith("Bug - "))
          return;
        await new Promise((r) => setTimeout(r, 100));
        const current = await this.app.vault.read(abstractFile);
        const autoHeading = `# ${abstractFile.basename}`;
        const hasUserContent = current.trim() !== "" && current.trim() !== autoHeading;
        if (hasUserContent)
          return;
        const title = abstractFile.basename.replace(/^Bug - /, "");
        const templateContent = this.bugTemplate(title);
        if (!templateContent && current.trim() === "")
          return;
        await this.app.vault.modify(abstractFile, templateContent);
        const activeFile = this.app.workspace.getActiveFile();
        const sourcePath = (_a = activeFile == null ? void 0 : activeFile.path) != null ? _a : abstractFile.path;
        const targetPath = this.getBugFilePath(abstractFile.basename, sourcePath);
        if (abstractFile.path !== targetPath) {
          const folderPath = targetPath.includes("/") ? targetPath.substring(0, targetPath.lastIndexOf("/")) : "";
          if (folderPath)
            await this.ensureFolder(folderPath);
          await this.app.vault.rename(abstractFile, targetPath);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", async (abstractFile) => {
        if (!(abstractFile instanceof import_obsidian.TFile) || abstractFile.extension !== "md")
          return;
        if (this.processingFiles.has(abstractFile.path))
          return;
        if (abstractFile.name === "Dashboard.md")
          return;
        const content = await this.app.vault.cachedRead(abstractFile);
        if (!content.includes("- ["))
          return;
        const updated = content.split("\n").map((l) => applyStatusLabel(l)).join("\n");
        if (updated === content)
          return;
        this.processingFiles.add(abstractFile.path);
        await this.app.vault.modify(abstractFile, updated);
        setTimeout(() => this.processingFiles.delete(abstractFile.path), 300);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        if (!this.settings.enableDashboard)
          return;
        const file = this.app.workspace.getActiveFile();
        if (file instanceof import_obsidian.TFile && file.name === "Dashboard.md") {
          await this.regenerateDashboard(file);
        }
      })
    );
    this.statusBarTestRun = this.addStatusBarItem();
    this.statusBarTestRun.addClass("qa-status-bar-btn");
    this.statusBarTestRun.setAttribute("title", "Test Run");
    this.statusBarTestRun.textContent = "\u{1F9EA} Test Run";
    this.statusBarTestRun.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (file)
        this.openTestRunFlow(file);
      else
        new import_obsidian.Notice("No active file open.");
    });
    this.statusBarResults = this.addStatusBarItem();
    this.statusBarResults.addClass("qa-status-bar-btn");
    this.statusBarResults.setAttribute("title", "Results");
    this.statusBarResults.textContent = "\u{1F4CA} Results";
    this.statusBarResults.addEventListener("click", () => this.calculateTestResults());
    this.statusBarDashboard = this.addStatusBarItem();
    this.statusBarDashboard.addClass("qa-status-bar-btn");
    this.statusBarDashboard.setAttribute("title", "Dashboard");
    this.statusBarDashboard.textContent = "\u{1F4C8} Dashboard";
    this.statusBarDashboard.addEventListener("click", () => this.openOrRefreshDashboard());
    this.applyVisibility();
  }
  applyVisibility() {
    const toggle = (el, show) => {
      if (!el)
        return;
      el.style.display = show ? "" : "none";
    };
    toggle(this.ribbonTestRun, this.settings.showRibbonTestRun);
    toggle(this.ribbonResults, this.settings.showRibbonResults);
    toggle(this.ribbonDashboard, this.settings.showRibbonDashboard && this.settings.enableDashboard);
    toggle(this.statusBarTestRun, this.settings.showStatusBarTestRun);
    toggle(this.statusBarResults, this.settings.showStatusBarResults);
    toggle(this.statusBarDashboard, this.settings.showStatusBarDashboard && this.settings.enableDashboard);
  }
  // ─── Playwright: run automated tests ──────────────────────────────────────
  async getPlaywrightPanel() {
    const existing = this.app.workspace.getLeavesOfType(PW_PANEL_VIEW_TYPE);
    if (existing.length > 0)
      return existing[0].view;
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf)
      throw new Error("Could not get a workspace leaf for Playwright panel.");
    await leaf.setViewState({ type: PW_PANEL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }
  async runPlaywrightTests(runFile, ids) {
    var _a, _b;
    const projectPath = this.settings.playwrightProjectPath.trim();
    const baseCommand = this.settings.playwrightCommand.trim() || "npx playwright test";
    const { spawn } = require("child_process");
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const grep = ids.map((id) => `\\(${id}\\)`).join("|");
    const tmpResults = path.join(os.tmpdir(), `tms-pw-${Date.now()}.json`);
    const displayCmd = `${baseCommand} --grep "${ids.map((id) => `(${id})`).join("|")}" --reporter=list`;
    const panel = await this.getPlaywrightPanel();
    panel.startRun(ids, displayCmd);
    const fullCmd = `${baseCommand} --grep "${grep}" --reporter=list,json`;
    const proc = spawn("/bin/zsh", ["-l", "-c", fullCmd], {
      cwd: projectPath,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: tmpResults }
    });
    (_a = proc.stdout) == null ? void 0 : _a.on("data", (chunk) => panel.appendOutput(chunk.toString()));
    (_b = proc.stderr) == null ? void 0 : _b.on("data", (chunk) => panel.appendOutput(chunk.toString()));
    proc.on("close", async (code) => {
      try {
        const jsonContent = fs.readFileSync(tmpResults, "utf-8");
        const report = JSON.parse(jsonContent);
        const resultMap = parsePwJsonReport(report);
        const currentContent = await this.app.vault.read(runFile);
        const { updated, count } = applyPlaywrightResults(currentContent, resultMap);
        if (count > 0)
          await this.app.vault.modify(runFile, updated);
        const passed = Array.from(resultMap.values()).filter((s) => s === "passed").length;
        const failed = Array.from(resultMap.values()).filter((s) => s === "failed").length;
        const skipped = Array.from(resultMap.values()).filter((s) => s === "skipped").length;
        panel.setDone(
          `Done. ${passed} passed, ${failed} failed, ${skipped} skipped. ${count} test(s) updated.`,
          code === 0
        );
        new import_obsidian.Notice(`Playwright sync: ${count} test(s) updated.`);
        if (count > 0)
          await this.calculateTestResults(runFile);
      } catch (err) {
        panel.appendOutput(`
Failed to parse results: ${err.message}
`);
        panel.setDone("Error parsing Playwright results. Check output above.", false);
      } finally {
        try {
          fs.unlinkSync(tmpResults);
        } catch (e) {
        }
      }
    });
    proc.on("error", (err) => {
      panel.appendOutput(`
Failed to start process: ${err.message}
`);
      panel.setDone("Failed to run Playwright. Check project path in settings.", false);
    });
  }
  // ─── Folder helpers ────────────────────────────────────────────────────────
  getRunsFolder(suiteName) {
    const base = this.settings.defaultTestRunFolder.trim().replace(/\/+$/, "");
    return base ? `${base}/${suiteName} Test Runs` : `${suiteName} Test Runs`;
  }
  getFolderPath(filePath) {
    return filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
  }
  countTestStatuses(content) {
    const counts = { pass: 0, fail: 0, skipped: 0, blocked: 0, notrun: 0 };
    content.split("\n").forEach((line) => {
      const trimmed = line.trim();
      for (const s of STATUS_PATTERNS) {
        if (s.regex.test(trimmed)) {
          counts[s.key]++;
          break;
        }
      }
    });
    return counts;
  }
  getBugFilePath(bugName, sourceFilePath) {
    const configured = this.settings.bugsFolder.trim().replace(/\/+$/, "");
    if (configured)
      return `${configured}/${bugName}.md`;
    return this.getFolderPath(sourceFilePath) ? `${this.getFolderPath(sourceFilePath)}/${bugName}.md` : `${bugName}.md`;
  }
  async ensureFolder(path) {
    if (!path)
      return;
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
  bugTemplate(title) {
    const tpl = this.settings.bugTemplate.trim();
    if (tpl) {
      return tpl.replace(/\{\{title\}\}/g, title);
    }
    return "";
  }
  async createBugFile(bugName, sourceFilePath) {
    const filePath = this.getBugFilePath(bugName, sourceFilePath);
    if (this.app.vault.getAbstractFileByPath(filePath))
      return;
    const folder = this.getFolderPath(filePath);
    if (folder)
      await this.ensureFolder(folder);
    const title = bugName.replace(/^Bug - /, "");
    await this.app.vault.create(filePath, this.bugTemplate(title));
    new import_obsidian.Notice(`Bug created: ${bugName}`);
  }
  getBugStatus(bugName) {
    var _a;
    const file = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
    if (!file)
      return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const status = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a.status;
    return status != null && status !== "" ? status : null;
  }
  async ensureStatusPropertyType() {
    try {
      const configPath = `${this.app.vault.configDir}/types.json`;
      const adapter = this.app.vault.adapter;
      let data = { types: {} };
      try {
        const raw = await adapter.read(configPath);
        data = JSON.parse(raw);
        if (!data.types)
          data.types = {};
      } catch (e) {
      }
      if (data.types["status"] === "text")
        return;
      data.types["status"] = "text";
      await adapter.write(configPath, JSON.stringify(data, null, 2));
    } catch (e) {
    }
  }
  // ─── Core flows ───────────────────────────────────────────────────────────
  async openTestRunFlow(file) {
    var _a;
    let suiteFile = file;
    let preselectedNames = null;
    let runCasesAll = [];
    let runTree = [];
    if ((_a = file.parent) == null ? void 0 : _a.name.endsWith(" Test Runs")) {
      const suiteName2 = file.parent.name.replace(/ Test Runs$/, "");
      const found = this.app.vault.getFiles().find(
        (f) => f.basename === suiteName2 && f.extension === "md"
      );
      if (!found) {
        new import_obsidian.Notice(`Suite "${suiteName2}.md" not found. Open the test suite file directly.`);
        return;
      }
      suiteFile = found;
      const runContent = await this.app.vault.read(file);
      const runBody = runContent.replace(/^[\s\S]*?(?=\n- \[)/, "").replace(STATS_SECTION_RE, "");
      runTree = parseTestCases(runBody);
      const flattenLeaves = (items, result) => {
        for (const tc of items) {
          if (!tc.isHeading && tc.line.trim().match(/^-\s*\[/))
            result.push(tc);
          flattenLeaves(tc.children, result);
        }
      };
      flattenLeaves(runTree, runCasesAll);
      preselectedNames = /* @__PURE__ */ new Set();
      for (const tc of runCasesAll)
        preselectedNames.add(tc.name.trim());
    }
    const content = await this.app.vault.read(suiteFile);
    let testCases = parseTestCases(content);
    if (preselectedNames && runCasesAll.length > 0) {
      const suiteNames = /* @__PURE__ */ new Set();
      const collectSuiteNames = (items) => {
        for (const tc of items) {
          if (!tc.isHeading)
            suiteNames.add(tc.name.trim());
          collectSuiteNames(tc.children);
        }
      };
      collectSuiteNames(testCases);
      let extraIdx = 9e4;
      const buildExtrasTree = (items) => {
        const result = [];
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
        const collectExtrasFlat = (items) => {
          for (const tc of items) {
            if (!tc.isHeading)
              preselectedNames.add(tc.name.trim());
            collectExtrasFlat(tc.children);
          }
        };
        collectExtrasFlat(extrasTree);
        const separator = {
          line: "",
          name: "__manually_added_separator__",
          tags: [],
          lineNumber: 89998,
          indent: 0,
          children: [],
          hasChildren: false,
          isHeading: true,
          headingLevel: 2,
          isManuallyAdded: true
        };
        testCases = [...testCases, separator, ...extrasTree];
      }
    }
    if (testCases.length === 0) {
      new import_obsidian.Notice("No test cases found in this file.");
      return;
    }
    const allTags = getAllTags(testCases);
    const suiteName = suiteFile.basename;
    const hasPlaywright = !!this.settings.playwrightProjectPath.trim();
    const createRunFile = async (selectedCases, includeTags, excludeTags) => {
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
        if (dashFile instanceof import_obsidian.TFile)
          await this.regenerateDashboard(dashFile);
      }
      const leaf = this.app.workspace.getLeaf();
      if (!leaf) {
        new import_obsidian.Notice("Could not open file.");
        return { runFile, checklist };
      }
      await leaf.openFile(runFile);
      new import_obsidian.Notice(`Test Run created: ${runPath}`);
      return { runFile, checklist };
    };
    const openTagSelect = (prevInclude = [], prevExclude = []) => {
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
          async (selectedCases) => {
            await createRunFile(selectedCases, includeTags, excludeTags);
          },
          () => openTagSelect(includeTags, excludeTags),
          hasPlaywright ? async (selectedCases) => {
            const { runFile, checklist } = await createRunFile(selectedCases, includeTags, excludeTags);
            const ids = extractTmsIds(checklist);
            if (ids.length === 0) {
              new import_obsidian.Notice("No TMS IDs (Txxx) found in test run \u2014 skipping automated run.");
              return;
            }
            this.runPlaywrightTests(runFile, ids);
          } : null
        ).open();
      }, prevInclude, prevExclude).open();
    };
    openTagSelect();
  }
  async calculateTestResults(targetFile) {
    const file = targetFile != null ? targetFile : this.app.workspace.getActiveFile();
    if (!file)
      return;
    let content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const newLines = [];
    const bugsToCreate = [];
    let bugsChanged = false;
    for (const line of lines) {
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
          const folder = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
          if (folder)
            await this.ensureFolder(folder);
          await this.app.vault.create(filePath, this.bugTemplate(title));
          new import_obsidian.Notice(`Bug created: ${name}`);
        }
      }
      content = newLines.join("\n");
      await new Promise((r) => setTimeout(r, 300));
    }
    const statsContent = calculateResults(content);
    if (!statsContent) {
      if (bugsChanged)
        await this.app.vault.modify(file, content);
      new import_obsidian.Notice("No checklist items found in this file.");
      return;
    }
    const preStatsContent = content.replace(STATS_SECTION_RE, "");
    const bugNames = extractBugNames(preStatsContent);
    let newFilesCreated = false;
    for (const bugName of bugNames) {
      const title = bugName.replace(/^Bug - /, "");
      const existingFile = this.app.metadataCache.getFirstLinkpathDest(bugName, "");
      if (!existingFile) {
        const filePath = this.getBugFilePath(bugName, file.path);
        const folder = this.getFolderPath(filePath);
        if (folder)
          await this.ensureFolder(folder);
        await this.app.vault.create(filePath, this.bugTemplate(title));
        new import_obsidian.Notice(`Bug created: ${bugName}`);
        newFilesCreated = true;
      }
    }
    if (newFilesCreated)
      await new Promise((r) => setTimeout(r, 300));
    let finalContent = statsContent;
    if (bugNames.length > 0) {
      const bugStatuses = bugNames.map((bugName) => ({ bugName, status: this.getBugStatus(bugName) }));
      const hasAnyStatus = bugStatuses.some((b) => b.status !== null);
      if (hasAnyStatus) {
        const rows = bugStatuses.map(({ bugName, status }) => `| [[${bugName}]] | ${status != null ? status : ""} |`);
        finalContent += `
## Bugs

| Bug | Status |
| --- | --- |
${rows.join("\n")}
`;
      } else {
        const rows = bugStatuses.map(({ bugName }) => `| [[${bugName}]] |`);
        finalContent += `
## Bugs

| Bug |
| --- |
${rows.join("\n")}
`;
      }
    }
    await this.app.vault.modify(file, finalContent);
    new import_obsidian.Notice("Test results calculated!");
  }
  async openOrRefreshDashboard() {
    var _a;
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new import_obsidian.Notice("No active file.");
      return;
    }
    if (file.name === "Dashboard.md") {
      await this.regenerateDashboard(file);
      new import_obsidian.Notice("Dashboard refreshed.");
      return;
    }
    if ((_a = file.parent) == null ? void 0 : _a.name.endsWith(" Test Runs")) {
      const dashPath2 = `${file.parent.path}/Dashboard.md`;
      const dashFile2 = this.app.vault.getAbstractFileByPath(dashPath2);
      if (dashFile2 instanceof import_obsidian.TFile) {
        const leaf1 = this.app.workspace.getLeaf();
        if (!leaf1) {
          new import_obsidian.Notice("Could not open file.");
          return;
        }
        await leaf1.openFile(dashFile2);
        return;
      }
    }
    const suiteName = file.basename;
    const runsFolder = this.getRunsFolder(suiteName);
    const dashPath = `${runsFolder}/Dashboard.md`;
    const dashFile = this.app.vault.getAbstractFileByPath(dashPath);
    if (dashFile instanceof import_obsidian.TFile) {
      const leaf2 = this.app.workspace.getLeaf();
      if (!leaf2) {
        new import_obsidian.Notice("Could not open file.");
        return;
      }
      await leaf2.openFile(dashFile);
    } else {
      new import_obsidian.Notice("No dashboard found. Create a test run first.");
    }
  }
  // ─── Dashboard ────────────────────────────────────────────────────────────
  buildEmptyDashboard(suiteName) {
    return `${DASHBOARD_MARKER}
# ${suiteName} - Dashboard

> Auto-refreshes when opened.

*No test runs yet. Create your first test run to see statistics.*
`;
  }
  async regenerateDashboard(dashFile) {
    if (this.dashboardRefreshing)
      return;
    this.dashboardRefreshing = true;
    try {
      const content = await this.app.vault.cachedRead(dashFile);
      if (!content.includes(DASHBOARD_MARKER))
        return;
      const folder = dashFile.parent;
      if (!folder)
        return;
      const suiteName = folder.name.replace(/ Test Runs$/, "");
      const newContent = await this.buildDashboardContent(folder, suiteName);
      if (content !== newContent) {
        await this.app.vault.modify(dashFile, newContent);
      }
    } finally {
      this.dashboardRefreshing = false;
    }
  }
  async buildDashboardContent(folder, suiteName) {
    const runFiles = folder.children.filter(
      (f) => f instanceof import_obsidian.TFile && f.name !== "Dashboard.md" && f.name.includes("- Test Run ")
    ).sort((a, b) => parseSortKey(a.name).localeCompare(parseSortKey(b.name)));
    const runs = [];
    const allBugNames = /* @__PURE__ */ new Set();
    for (const runFile of runFiles) {
      const content = await this.app.vault.cachedRead(runFile);
      const counts = this.countTestStatuses(content);
      const total = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
      runs.push({
        file: runFile,
        dateLabel: parseDateLabel(runFile.name),
        pass: counts.pass,
        fail: counts.fail,
        skipped: counts.skipped,
        blocked: counts.blocked,
        notrun: counts.notrun,
        total
      });
      const preStats = content.replace(STATS_SECTION_RE, "");
      for (const bugName of extractBugNames(preStats)) {
        allBugNames.add(bugName);
      }
    }
    let md = `${DASHBOARD_MARKER}
# ${suiteName} - Dashboard

`;
    md += `> Auto-refreshes when opened.

`;
    if (runs.length === 0) {
      md += `*No test runs yet. Create your first test run to see statistics.*
`;
      return md;
    }
    md += `## Test Runs

`;
    md += `| Run | \u2705 Pass | \u274C Fail | \u23ED\uFE0F Skip | \u{1F6AB} Blocked | \u2B1C Not Run | Total |
`;
    md += `|-----|--------|--------|--------|-----------|-----------|-------|
`;
    for (const run of [...runs].reverse()) {
      md += `| [[${run.file.basename}]] | ${run.pass} | ${run.fail} | ${run.skipped} | ${run.blocked} | ${run.notrun} | ${run.total} |
`;
    }
    md += "\n";
    const hiddenStatuses = this.settings.dashboardHiddenStatuses.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const visibleBugs = Array.from(allBugNames).filter((bugName) => {
      const status = this.getBugStatus(bugName);
      return !hiddenStatuses.includes((status != null ? status : "").toLowerCase());
    });
    const visibleBugStatuses = visibleBugs.map((bugName) => ({ bugName, status: this.getBugStatus(bugName) }));
    const hasAnyStatus = visibleBugStatuses.some((b) => b.status !== null);
    if (visibleBugStatuses.length > 0) {
      md += `## Bugs

`;
      if (hasAnyStatus) {
        md += `| Bug | Status |
`;
        md += `|-----|--------|
`;
        for (const { bugName, status } of visibleBugStatuses) {
          md += `| [[${bugName}]] | ${status != null ? status : ""} |
`;
        }
      } else {
        md += `| Bug |
`;
        md += `|-----|
`;
        for (const { bugName } of visibleBugStatuses) {
          md += `| [[${bugName}]] |
`;
        }
      }
    }
    return md;
  }
};
var TMSSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Test Management System Settings" });
    containerEl.createEl("h3", { text: "Storage" });
    new import_obsidian.Setting(containerEl).setName("Base folder for test runs").setDesc("Test runs are saved inside '{Base folder}/{Suite name} Test Runs/'. Leave empty for vault root.").addText((text) => {
      text.setPlaceholder("e.g. QA").setValue(this.plugin.settings.defaultTestRunFolder);
      text.inputEl.style.width = "200px";
      text.onChange(async (value) => {
        this.plugin.settings.defaultTestRunFolder = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    }).addButton(
      (btn) => btn.setButtonText("Browse\u2026").onClick(() => {
        new FolderSuggestModal(this.app, async (path) => {
          this.plugin.settings.defaultTestRunFolder = path;
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }).open();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Bugs folder").setDesc("Where bug pages are created. Leave empty to save bugs in the same folder as the test run.").addText((text) => {
      text.setPlaceholder("e.g. Bugs").setValue(this.plugin.settings.bugsFolder);
      text.inputEl.style.width = "200px";
      text.onChange(async (value) => {
        this.plugin.settings.bugsFolder = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    }).addButton(
      (btn) => btn.setButtonText("Browse\u2026").onClick(() => {
        new FolderSuggestModal(this.app, async (path) => {
          this.plugin.settings.bugsFolder = path;
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }).open();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Bug template").setDesc("Template for new bug pages. Use {{title}} as a placeholder for the bug title. Leave empty to create a blank file (Obsidian shows the filename as title).").addTextArea((ta) => {
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
    containerEl.createEl("h3", { text: "Dashboard" });
    new import_obsidian.Setting(containerEl).setName("Enable Dashboard").setDesc("Auto-creates a Dashboard page in the test runs folder and refreshes it on open.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableDashboard).onChange(async (value) => {
        this.plugin.settings.enableDashboard = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.applyVisibility();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Hidden bug statuses").setDesc("Comma-separated list of bug statuses to hide from the Dashboard bugs section. Default: done").addText((text) => {
      text.setPlaceholder("e.g. done, closed, wontfix").setValue(this.plugin.settings.dashboardHiddenStatuses);
      text.inputEl.style.width = "260px";
      text.onChange(async (value) => {
        this.plugin.settings.dashboardHiddenStatuses = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
    containerEl.createEl("h3", { text: "Buttons" });
    const toggles = [
      { name: "Ribbon: Test Run", key: "showRibbonTestRun" },
      { name: "Ribbon: Results", key: "showRibbonResults" },
      { name: "Ribbon: Dashboard", key: "showRibbonDashboard" },
      { name: "Status bar: Test Run", key: "showStatusBarTestRun" },
      { name: "Status bar: Results", key: "showStatusBarResults" },
      { name: "Status bar: Dashboard", key: "showStatusBarDashboard" }
    ];
    for (const { name, key } of toggles) {
      new import_obsidian.Setting(containerEl).setName(name).addToggle(
        (toggle) => toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyVisibility();
        })
      );
    }
    containerEl.createEl("h3", { text: "Playwright Integration" });
    new import_obsidian.Setting(containerEl).setName("Playwright project path").setDesc("Absolute path to the folder containing playwright.config.ts. Required to use automated test runs.").addText((text) => {
      text.setPlaceholder("/Users/you/my-project").setValue(this.plugin.settings.playwrightProjectPath);
      text.inputEl.style.width = "300px";
      text.onChange(async (value) => {
        this.plugin.settings.playwrightProjectPath = value.trim();
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.applyVisibility();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Run command").setDesc("Command used to run Playwright tests. Default: npx playwright test").addText((text) => {
      text.setPlaceholder("npx playwright test").setValue(this.plugin.settings.playwrightCommand);
      text.inputEl.style.width = "260px";
      text.onChange(async (value) => {
        this.plugin.settings.playwrightCommand = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
  }
};
