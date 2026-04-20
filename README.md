# Test Management System

An Obsidian plugin for managing QA test cases — create test plans, filter by attributes, generate test runs, and calculate results.

## Features

- **Test Plans** — write test cases in regular `.md` files using headings and indentation
- **Attribute Tags** — tag cases with `@smoke`, `@regression`, `@api`, etc.
- **Autocomplete** — type `@` and get suggestions from all attributes in the vault
- **Test Run Generator** — filter cases by tags (include/exclude), review the list, and generate a `.md` test run file
- **Status Tracking** — mark cases as Pass `[p]`, Fail `[f]`, Skipped `[s]`, Blocked `[b]`; labels are added automatically
- **Results Summary** — run the Results command to append a statistics table to the test run

## Usage

### Test Plan Format

```markdown
## Authorization
Login with valid credentials @smoke @regression
Login with wrong password @regression

## API
GET /users @api @smoke
POST /users @api
DELETE /users @api @destructive
  Check 204 response
  Verify record removed from DB
```

### Generating a Test Run

1. Open a test plan file
2. Run **TMS: Test Run** (command palette, ribbon 🧪, or status bar)
3. Select attributes to include/exclude
4. Review and adjust the case list
5. Click **Generate Test Run** — a new `.md` file is created

### Running Tests

In the generated file, change `[ ]` to the case status:

| Symbol | Status |
|--------|--------|
| `[p]` or `[x]` | ✅ Pass |
| `[f]` | ❌ Fail |
| `[s]` | ⏭️ Skipped |
| `[b]` | 🚫 Blocked |

Labels are inserted automatically when you change the status.

### Calculating Results

Open a test run and run **TMS: Results** — a summary table is appended (or updated) at the end of the file.

## Documentation

See [full documentation](https://github.com/Yvyn/obsidian-tms/blob/main/GUIDE.md) for detailed usage.

## Settings

**Settings → TMS**

- **Test Run Folder** — folder where generated runs are saved (empty = vault root)
- Toggle ribbon and status bar buttons on/off independently

## Installation

### From Community Plugins (coming soon)

1. Open **Settings → Community Plugins**
2. Search for **TMS**
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest)
2. Copy them to `.obsidian/plugins/tms/` in your vault
3. Enable the plugin in **Settings → Community Plugins**

## License

MIT
