# Test Manager System — Documentation

An Obsidian plugin for managing test cases: creating test plans, filtering by attributes, generating test runs, and calculating results.

---

## Contents

1. [Test Plan Structure](#1-test-plan-structure)
2. [Attributes @](#2-attributes-)
3. [Attribute Autocomplete](#3-attribute-autocomplete)
4. [Generating a Test Run](#4-generating-a-test-run)
5. [Re-running from an Existing Test Run](#5-re-running-from-an-existing-test-run)
6. [Running Tests](#6-running-tests)
7. [Calculating Results](#7-calculating-results)
8. [Bugs](#8-bugs)
9. [Dashboard](#9-dashboard)
10. [Playwright Integration](#10-playwright-integration)
11. [Settings](#11-settings)
12. [Commands and Buttons](#12-commands-and-buttons)

---

## 1. Test Plan Structure

A test plan is a regular `.md` file in Obsidian. The plugin reads its structure and turns it into a test run.

### Section Headings

Lines starting with `#`, `##`, `###`, etc. (without indentation) are **sections**, not test cases. They group cases and appear as headings in the test run.

```
## Authorization
Login with valid credentials
Login with wrong password
Password recovery

## User Profile
Edit name
Upload avatar
```

> A heading is included in the test run only if at least one test case under it is selected.

### Test Cases

Any line that is not a heading is a test case. Nesting is determined by indentation (tab or 2 spaces).

```
## Cart
Add item to cart
  Check counter
  Check total
Remove item
Place order
```

> A heading with indentation (`	## something`) is treated as a nested test case, not a section.

### Full File Example

```markdown
## Authorization
Login with valid credentials @smoke @regression
Login with wrong password @regression
Login via Google @oauth

## API
GET /users @api @smoke
POST /users @api
DELETE /users @api @destructive
  Check 204 response
  Verify record removed from DB
```

---

## 2. Attributes @

Attributes are tags in the format `@name` added at the end of a test case line. They are used for filtering when generating a test run.

```
Login with valid credentials @smoke @regression
GET /users @api @smoke
```

**Rules:**
- Start with `@`
- Can contain letters, digits, `_`, `-`
- Case-insensitive (`@Smoke` = `@smoke`)
- Multiple attributes on one line — separated by spaces

---

## 3. Attribute Autocomplete

When you type `@` in any `.md` file, a suggestion list appears with all attributes found across all files in the vault.

**Navigation:**
- `↑` / `↓` — move through the list
- `Enter` — insert the selected attribute
- `Esc` — close the suggestion

---

## 4. Generating a Test Run

Open a test plan and run the **Test Run** command (via command palette, ribbon, or status bar).

### Step 1 — Select Attributes

A modal opens with all attributes found in the file.

| Action | State | Color |
|--------|-------|-------|
| One click | Include | Green |
| Two clicks | Exclude | Red |
| Three clicks | Neutral | Grey |

- **Include All** — mark all attributes as include
- **Reset All** — reset all to neutral
- **Search field** — type to filter the visible attribute chips by name

**Filter logic:**
- Include: OR — a case is included if it has at least one of the included attributes
- Exclude: a case is dropped if it has at least one of the excluded attributes
- No filter (all neutral) — all cases are selected

### Step 2 — Review Tests

A list of all test cases with sections. Cases matching the filter are pre-checked.

- Manually check or uncheck any case
- Cases with nested items have a `▶` button to expand
- Counter shows `N / Total selected`
- **← Back** — return to attribute selection
- **Generate Test Run** — create the test run file

**Section checkboxes:** each heading (`#`, `##`, `###`, etc.) has a checkbox that selects or deselects all test cases under it at once.

| Checkbox state | Meaning |
|----------------|---------|
| Checked ✓ | All cases in the section are selected |
| Indeterminate — | Some cases are selected |
| Unchecked | No cases in the section are selected |

Headings are visually highlighted with a colored left border and bold text, scaled by level (`#` largest, `######` smallest).

### Step 3 — Result

A new `.md` file is created in the configured folder with the name:
```
{File name} - Test Run {date-time}.md
```

File structure:
```markdown
# Test Run: Project Name
**Date:** 04/18/2026, 12:00:00
**Include:** @smoke @api
**Total Cases:** 5

---

## Authorization

- [ ] **Login with valid credentials** @smoke @regression
- [ ] **GET /users** @api @smoke

---
```

---

## 5. Re-running from an Existing Test Run

You can start a new test run directly from an existing test run file — no need to go back to the test suite.

**How:** open any test run file and press **Test Run** (command palette, ribbon, or status bar).

The plugin will:
1. Detect that the current file is a test run (it's inside a `* Test Runs` folder)
2. Find the original test suite automatically
3. Open the Review modal with the **same test cases pre-selected** as in the current run

You can then add or remove cases before generating the new run.

> If the original suite file cannot be found, a notice will appear asking you to open it directly.

---

## 6. Running Tests

In the generated test run, replace `[ ]` with the case status:

| Symbol | Status | Label |
|--------|--------|-------|
| `[x]` or `[p]` | Pass | ✅ Pass |
| `[f]` | Fail | ❌ Fail |
| `[s]` | Skipped | ⏭️ Skipped |
| `[b]` | Blocked | 🚫 Blocked |
| `[ ]` | Not Run | — |

The label (`✅ Pass |`, `❌ Fail |`, etc.) is **added automatically** when the status changes — no manual input needed.

**Example:**
```markdown
- [p] ✅ Pass | **Login with valid credentials** @smoke
- [f] ❌ Fail | **GET /users** @api
- [s] ⏭️ Skipped | **DELETE /users** @api
```

---

## 7. Calculating Results

Open a test run and run the **Results** command. A summary chart is appended at the end of the file.

The command can be run multiple times — the section updates in place, no duplicates.

---

## 8. Bugs

### Creating a bug with `!`

In any test run file, type `!` at the start of a line (or after `- `). A **Bug** suggestion appears. Select it — the line is replaced with `[[Bug - ]]` and your cursor is placed inside so you can type the name.

```
- [f] ❌ Fail | Login test
  [[Bug - Login button is broken]]
```

When you run the **Results** command, the plugin:
- Scans for all `[[Bug - ...]]` links in the checklist
- Creates a bug file for each one that doesn't exist yet
- Appends a **Bugs** table at the end of the results

### Bug table

The Bugs table appears in the results only when bugs are referenced:

- If **at least one bug has a status** set in its frontmatter → table shows with a Status column
- If **no bugs have a status** → table shows with only the Bug column (no Status column)

### Bug template

Set a template for new bug files in **Settings → Bug template**. Use `{{title}}` as a placeholder for the bug name:

```
---
status: New
tags: [Bug]
---

# {{title}}

## Description

## Steps to Reproduce
```

When a bug file is created (via `!`, clicking an unresolved link, or the Results command), the template is applied automatically.

### Insert Bug Template command

To apply the bug template to any open file manually:

`Cmd/Ctrl+P` → **Test Manager: Insert Bug Template**

The template is inserted at the cursor position. If the file is named `Bug - Something`, `{{title}}` is replaced with `Something`.

> If no template is configured, a notice appears with a link to settings.

### Bugs folder

Set a dedicated folder for bug files in **Settings → Bugs folder**. When a bug file is created, it is automatically moved there regardless of where the link was clicked.

---

## 9. Dashboard

The Dashboard is a summary page that auto-generates inside the test runs folder.

### What it contains

- **Test Runs table** — all runs for the suite, newest first, with pass/fail/skip/blocked/not-run counts
- **Bugs table** — all bugs referenced across all runs, with their current status

### Auto-refresh

The Dashboard refreshes automatically every time you open it. You can also refresh it manually via the **Dashboard** command (command palette, ribbon, or status bar).

### Hidden bug statuses

In **Settings → Hidden bug statuses**, enter a comma-separated list of statuses to exclude from the Bugs table (e.g. `done, closed, wontfix`). Default: `done`.

### Enable / disable

The Dashboard can be fully disabled in **Settings → Enable Dashboard**. When disabled, no Dashboard file is created and the Dashboard buttons are hidden.

---

## 10. Playwright Integration

Run automated Playwright tests alongside manual ones in the same test run. Results sync back automatically — manual tests are never touched.

### How it works

The plugin matches test cases by ID: `(T001)` in Obsidian ↔ `(T001)` in the Playwright test title.

When you click **⚡ Run with Automated Tests**, the plugin:
1. Extracts all `(Txxx)` IDs from the test run
2. Runs Playwright with a grep filter for those IDs
3. Shows real-time output in a progress modal
4. Maps results back into the test run file
5. Automatically runs **Results** to update the statistics

### Setup — 4 steps

**Step 1.** In your Obsidian test suite, add `(T001)` at the end of each automated test case:

```
- [ ] Login with valid credentials (T001)
- [ ] Invalid password (T002)
- [ ] Check UI on mobile          ← manual, no ID, never modified
```

**Step 2.** In your Playwright test file, add the same ID to the test **title**:

```ts
test('Login with valid credentials (T001)', async ({ page }) => {
  // ...
});

test('Invalid password (T002)', async ({ page }) => {
  // ...
});
```

**Step 3.** In plugin settings → **Playwright project path** — set the absolute path to the folder containing `playwright.config.ts`:

```
/Users/you/my-project
```

**Step 4.** Open your test suite → **Test Run** → in the review window click **⚡ Run with Automated Tests**.

### Result mapping

| Playwright | Obsidian |
|------------|----------|
| `passed` | `[p] ✅ Pass` |
| `failed` | `[f] ❌ Fail` |
| `skipped` | `[s] ⏭️ Skipped` |

### Example — test run after sync

```
- [p] ✅ Pass | Login with valid credentials (T001)
- [f] ❌ Fail | Invalid password (T002)
- [ ] Check UI on mobile          ← unchanged
- [ ] Check email layout          ← unchanged
```

---

## 11. Settings

Open **Settings → Test Management System**.

### Storage

| Setting | Description |
|---------|-------------|
| Base folder for test runs | Folder where `{Suite} Test Runs/` folders are created. Leave empty for vault root. |
| Bugs folder | Folder where bug files are saved. Leave empty to save next to the test run. |
| Bug template | Template applied to new bug files. Use `{{title}}` for the bug name. Leave empty for a blank file. |

### Dashboard

| Setting | Description |
|---------|-------------|
| Enable Dashboard | Auto-creates and refreshes the Dashboard page in each test runs folder. |
| Hidden bug statuses | Comma-separated statuses to hide from the Bugs table (e.g. `done, closed`). |

### Buttons

Each button can be shown or hidden independently:

| Setting | Description |
|---------|-------------|
| Ribbon: Test Run | 🧪 icon on the left sidebar |
| Ribbon: Results | 📊 icon on the left sidebar |
| Ribbon: Dashboard | 📈 icon on the left sidebar |
| Status bar: Test Run | `🧪 Test Run` in the bottom bar |
| Status bar: Results | `📊 Results` in the bottom bar |
| Status bar: Dashboard | `📈 Dashboard` in the bottom bar |

### Playwright Integration

| Setting | Description |
|---------|-------------|
| Playwright project path | Absolute path to the folder containing `playwright.config.ts` |
| Run command | Command used to run Playwright. Default: `npx playwright test` |

---

## 12. Commands and Buttons

| Command | Palette | Ribbon | Status bar |
|---------|---------|--------|------------|
| Test Run | `Test Manager: Test Run` | 🧪 | `🧪 Test Run` |
| Results | `Test Manager: Results` | 📊 | `📊 Results` |
| Dashboard | `Test Manager: Dashboard` | 📈 | `📈 Dashboard` |
| Insert Bug Template | `Test Manager: Insert Bug Template` | — | — |

Hotkeys for all commands can be configured via **Settings → Hotkeys**, search for `Test Manager`.
