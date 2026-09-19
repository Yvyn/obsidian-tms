// Copies the built plugin files (main.js, manifest.json, styles.css) into a
// local Obsidian vault's plugin folder, so you don't have to do it by hand
// after every fix. The target path is personal (depends on your machine), so
// it lives in deploy.config.json — gitignored, never committed.
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "deploy.config.json");
const FILES_TO_COPY = ["main.js", "manifest.json", "styles.css"];

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(
    `Missing ${CONFIG_PATH}.\n` +
    `Create it with:\n` +
    `  { "targetPath": "/absolute/path/to/YourVault/.obsidian/plugins/your-plugin-folder" }\n`
  );
  process.exit(1);
}

const { targetPath } = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

if (!targetPath || !fs.existsSync(targetPath)) {
  console.error(`targetPath in deploy.config.json does not exist: ${targetPath}`);
  process.exit(1);
}

for (const file of FILES_TO_COPY) {
  const src = path.join(__dirname, file);
  const dest = path.join(targetPath, file);
  fs.copyFileSync(src, dest);
  console.log(`Copied ${file} -> ${dest}`);
}
