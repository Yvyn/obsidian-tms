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
  default: () => QAChecklistPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
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
  const tagRegex = /@([\p{L}\p{N}_-]+)/gu;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(trimmed)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  const firstTagIndex = trimmed.search(/@[\p{L}\p{N}_-]+/u);
  const name = firstTagIndex >= 0 ? trimmed.slice(0, firstTagIndex).trim() : trimmed;
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
  const stack = [];
  for (const item of allItems) {
    if (item.isHeading) {
      rootItems.push(item);
      stack.length = 0;
      stack.push({ item, indent: -1 });
    } else {
      while (stack.length > 0 && stack[stack.length - 1].indent >= item.indent) {
        stack.pop();
      }
      if (stack.length > 0) {
        stack[stack.length - 1].item.children.push(item);
        stack[stack.length - 1].item.hasChildren = true;
      } else {
        rootItems.push(item);
      }
      stack.push({ item, indent: item.indent });
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
function generateChecklist(testCases, projectName, includeTags, excludeTags) {
  const timestamp = new Date().toLocaleString();
  let filterLine = "";
  if (includeTags.length > 0)
    filterLine += `
**Include:** ${includeTags.map((t) => `@${t}`).join(" ")}`;
  if (excludeTags.length > 0)
    filterLine += `
**Exclude:** ${excludeTags.map((t) => `@${t}`).join(" ")}`;
  let md = `# Test Run: ${projectName}
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
  const rows = STATUS_PATTERNS.filter((s) => counts[s.key] > 0).map((s) => {
    const pct = `${(counts[s.key] / total * 100).toFixed(1)}%`;
    return `| ${STATUS_EMOJI[s.key]} ${s.label} | ${counts[s.key]} | ${pct} |`;
  }).join("\n");
  let cleaned = content.replace(/\n+---\n+## Test Results Statistics[\s\S]*$/, "");
  cleaned = cleaned.replace(/\s+$/, "");
  return cleaned + `

---

## Test Results Statistics

| Status | Count | % |
| --- | --- | --- |
${rows}
| **Total** | **${total}** | |
`;
}
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
  constructor(app, allTags, projectName, callback, initialIncludeTags = [], initialExcludeTags = []) {
    super(app);
    this.allTags = allTags;
    this.projectName = projectName;
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Select Attributes: ${this.projectName}` });
    contentEl.createEl("p", {
      text: "Click once: include (green)  \xB7  twice: exclude (red)  \xB7  three times: reset",
      cls: "mod-note"
    });
    const controlsDiv = contentEl.createDiv({ cls: "qa-tag-controls" });
    new import_obsidian.Setting(controlsDiv).addButton((btn) => btn.setButtonText("Include All").onClick(() => this.setAll("include"))).addButton((btn) => btn.setButtonText("Reset All").onClick(() => this.setAll("neutral")));
    const tagsContainer = contentEl.createDiv({ cls: "qa-tags-container" });
    this.allTags.forEach((tag) => {
      const chip = tagsContainer.createEl("span", { text: `@${tag}`, cls: "qa-tag-chip" });
      this.chipElements.set(tag, chip);
      this.updateChip(tag);
      chip.addEventListener("click", () => this.cycleTagState(tag));
    });
    if (this.allTags.length === 0) {
      contentEl.createEl("p", { text: "No attributes found in this project.", cls: "mod-note" });
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
  constructor(app, projectName, allTestCases, filteredTestCases, includeTags, excludeTags, onConfirm, onBack) {
    super(app);
    this.projectName = projectName;
    this.allTestCases = allTestCases;
    this.includeTags = includeTags;
    this.excludeTags = excludeTags;
    this.onConfirm = onConfirm;
    this.onBack = onBack;
    this.checkedItems = /* @__PURE__ */ new Set();
    this.checkboxRefs = [];
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Review Tests: ${this.projectName}` });
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
    const renderTree = (items, container, isCheckable, childDepth) => {
      items.forEach((tc) => {
        if (tc.isHeading) {
          const headingEl = container.createDiv({ cls: "qa-review-section-heading" });
          const level = Math.min(tc.headingLevel || 2, 6);
          headingEl.createEl(`h${level}`, { text: tc.name, cls: "qa-review-heading-text" });
          if (tc.children.length > 0)
            renderTree(tc.children, container, true, 0);
          return;
        }
        const itemEl = container.createDiv({ cls: "qa-review-item" });
        itemEl.style.paddingLeft = `${12 + childDepth * 20}px`;
        if (isCheckable) {
          const cb = itemEl.createEl("input", { attr: { type: "checkbox" } });
          cb.checked = this.checkedItems.has(tc.lineNumber);
          cb.addEventListener("change", () => {
            if (cb.checked)
              this.checkedItems.add(tc.lineNumber);
            else
              this.checkedItems.delete(tc.lineNumber);
            updateCounter();
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
          const labelEl = itemEl.createEl("label");
          labelEl.style.cursor = "pointer";
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
          childrenEl.style.display = "none";
          container.appendChild(childrenEl);
          renderTree(tc.children, childrenEl, false, childDepth + 1);
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
    renderTree(this.allTestCases, listEl, true, 0);
    new import_obsidian.Setting(contentEl).addButton(
      (btn) => btn.setButtonText("\u2190 Back").onClick(() => {
        this.close();
        this.onBack();
      })
    ).addButton(
      (btn) => btn.setButtonText("Generate Test Run").setCta().onClick(() => {
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
        const selected = collectSelected(this.allTestCases);
        if (countLeafTestCases(selected) === 0) {
          new import_obsidian.Notice("No test cases selected.");
          return;
        }
        this.onConfirm(selected);
        this.close();
      })
    );
  }
  countDescendants(tc) {
    let count = tc.children.length;
    tc.children.forEach((child) => count += this.countDescendants(child));
    return count;
  }
  onClose() {
    this.contentEl.empty();
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
    for (const file of this.app.vault.getMarkdownFiles()) {
      await this.updateFile(file);
    }
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
  showRibbonTestRun: true,
  showRibbonResults: true,
  showStatusBarTestRun: true,
  showStatusBarResults: true
};
var QAChecklistPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.ribbonTestRun = null;
    this.ribbonResults = null;
    this.statusBarTestRun = null;
    this.statusBarResults = null;
    this.processingFiles = /* @__PURE__ */ new Set();
  }
  async onload() {
    const loadedData = await this.loadData();
    if (loadedData) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    }
    this.addCommand({
      id: "generate-test-run-current",
      name: "Test Run",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return false;
        if (checking)
          return true;
        this.generateTestRun(file);
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
    this.ribbonTestRun = this.addRibbonIcon("test-tube", "Test Run", () => {
      const file = this.app.workspace.getActiveFile();
      if (file)
        this.generateTestRun(file);
      else
        new import_obsidian.Notice("No active file open.");
    });
    this.ribbonResults = this.addRibbonIcon("bar-chart", "Results", () => {
      this.calculateTestResults();
    });
    this.applyVisibility();
    this.addSettingTab(new QAChecklistSettingTab(this.app, this));
    this.registerEditorSuggest(new AttributeSuggest(this));
    this.registerEvent(
      this.app.vault.on("modify", async (abstractFile) => {
        if (!(abstractFile instanceof import_obsidian.TFile) || abstractFile.extension !== "md")
          return;
        if (this.processingFiles.has(abstractFile.path))
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
    this.statusBarTestRun = this.addStatusBarItem();
    this.statusBarTestRun.addClass("qa-status-bar-btn");
    this.statusBarTestRun.setAttribute("title", "Test Run");
    this.statusBarTestRun.textContent = "\u{1F9EA} Test Run";
    this.statusBarTestRun.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (file)
        this.generateTestRun(file);
      else
        new import_obsidian.Notice("No active file open.");
    });
    this.statusBarResults = this.addStatusBarItem();
    this.statusBarResults.addClass("qa-status-bar-btn");
    this.statusBarResults.setAttribute("title", "Results");
    this.statusBarResults.textContent = "\u{1F4CA} Results";
    this.statusBarResults.addEventListener("click", () => this.calculateTestResults());
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
    toggle(this.statusBarTestRun, this.settings.showStatusBarTestRun);
    toggle(this.statusBarResults, this.settings.showStatusBarResults);
  }
  /** Main flow: parse → select tags (3-state) → review with checkboxes → create test run. */
  async generateTestRun(file) {
    const content = await this.app.vault.read(file);
    const testCases = parseTestCases(content);
    if (testCases.length === 0) {
      new import_obsidian.Notice("No test cases found in this file.");
      return;
    }
    const allTags = getAllTags(testCases);
    const projectName = file.basename;
    const openTagSelect = (prevInclude = [], prevExclude = []) => {
      new TagSelectModal(this.app, allTags, projectName, (includeTags, excludeTags) => {
        const filtered = filterByTags(testCases, includeTags, excludeTags);
        new TestReviewModal(
          this.app,
          projectName,
          testCases,
          filtered,
          includeTags,
          excludeTags,
          async (selectedCases) => {
            const checklist = generateChecklist(selectedCases, projectName, includeTags, excludeTags);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const newFileName = `${projectName} - Test Run ${timestamp}.md`;
            const folder = this.settings.defaultTestRunFolder.trim().replace(/\/+$/, "");
            const filePath = folder ? `${folder}/${newFileName}` : newFileName;
            if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
              await this.app.vault.createFolder(folder);
            }
            const newFile = await this.app.vault.create(filePath, checklist);
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(newFile);
            new import_obsidian.Notice(`Test Run created: ${filePath}`);
          },
          () => openTagSelect(includeTags, excludeTags)
        ).open();
      }, prevInclude, prevExclude).open();
    };
    openTagSelect();
  }
  async calculateTestResults() {
    const file = this.app.workspace.getActiveFile();
    if (!file)
      return;
    const content = await this.app.vault.read(file);
    const updatedContent = calculateResults(content);
    if (!updatedContent) {
      new import_obsidian.Notice("No checklist items found in this file.");
      return;
    }
    await this.app.vault.modify(file, updatedContent);
    new import_obsidian.Notice("Test results calculated!");
  }
};
var QAChecklistSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Test Manager Settings" });
    containerEl.createEl("h3", { text: "Storage" });
    new import_obsidian.Setting(containerEl).setName("Test Run folder").setDesc("Folder where generated test runs are saved. Leave empty for vault root.").addText((text) => {
      text.setPlaceholder("e.g. Test Runs").setValue(this.plugin.settings.defaultTestRunFolder);
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
    containerEl.createEl("h3", { text: "Buttons" });
    const toggles = [
      { name: "Ribbon: Test Run", key: "showRibbonTestRun" },
      { name: "Ribbon: Results", key: "showRibbonResults" },
      { name: "Status bar: Test Run", key: "showStatusBarTestRun" },
      { name: "Status bar: Results", key: "showStatusBarResults" }
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
    containerEl.createEl("h3", { text: "Hotkeys" });
    const desc = containerEl.createEl("p", { cls: "mod-note" });
    desc.appendText("To set keyboard shortcuts for ");
    desc.createEl("strong", { text: "Test Run" });
    desc.appendText(" and ");
    desc.createEl("strong", { text: "Results" });
    desc.appendText(" commands, go to ");
    desc.createEl("strong", { text: "Settings \u2192 Hotkeys" });
    desc.appendText(' and search for "Test Manager".');
  }
};
