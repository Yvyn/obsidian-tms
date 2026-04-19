# Test Manager System — Documentation

An Obsidian plugin for managing test cases: creating test plans, filtering by attributes, generating test runs, and calculating results.

---

## Contents

1. [Test Plan Structure](#1-test-plan-structure)
2. [Attributes @](#2-attributes-)
3. [Attribute Autocomplete](#3-attribute-autocomplete)
4. [Generating a Test Run](#4-generating-a-test-run)
5. [Running Tests](#5-running-tests)
6. [Calculating Results](#6-calculating-results)
7. [Settings](#7-settings)
8. [Commands and Buttons](#8-commands-and-buttons)

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

## 5. Running Tests

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

## 6. Calculating Results

Open a test run and run the **Results** command. A summary table is appended at the end of the file:

```markdown
## Test Results Statistics

| Status | Count | % |
| --- | --- | --- |
| ✅ Pass | 8 | 61.5% |
| ❌ Fail | 3 | 23.1% |
| ⏭️ Skipped | 2 | 15.4% |
| **Total** | **13** | |
```

The command can be run multiple times — the table updates in place, no duplicates.

---

## 7. Settings

Open **Settings → Test Manager System**.

### Test Run Folder

Set the folder where generated test runs are saved. Leave empty to save in the vault root.

Type the path manually or click **Browse…** to pick a folder.

### Buttons

Each button can be shown or hidden independently:

| Setting | Description |
|---------|-------------|
| Ribbon: Test Run | 🧪 icon on the left sidebar |
| Ribbon: Results | 📊 icon on the left sidebar |
| Status bar: Test Run | `🧪 Test Run` button in the bottom bar |
| Status bar: Results | `📊 Results` button in the bottom bar |

### Hotkeys

Hotkeys are configured via **Settings → Hotkeys**, search for `Test Manager`.

---

## 8. Commands and Buttons

| Method | Test Run | Results |
|--------|----------|---------|
| Command palette (`Cmd/Ctrl+P`) | `Test Manager: Test Run` | `Test Manager: Results` |
| Ribbon (left sidebar) | 🧪 | 📊 |
| Status bar (bottom) | `🧪 Test Run` | `📊 Results` |
| Hotkey | Configurable | Configurable |
