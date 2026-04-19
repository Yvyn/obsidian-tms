const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");

async function build() {
  try {
    const ctx = await esbuild.context({
      entryPoints: ["src/main.ts"],
      bundle: true,
      outfile: "main.js",
      external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        "lodash",
        "moment",
      ],
      format: "cjs",
      target: "es2018",
      logLevel: "silent",
      plugins: [esbuildProblemMatcherPlugin, cssCopyPlugin],
    });

    if (production) {
      await ctx.rebuild();
      await ctx.dispose();
      console.log("Production build complete.");
      process.exit(0);
    } else {
      await ctx.watch();
      console.log("Watching for changes...");
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("Build started...");
    });

    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      });
      console.log("Build finished.");
    });
  },
};

const cssCopyPlugin = {
  name: "css-copy",
  setup(build) {
    build.onEnd(() => {
      const src = path.resolve(__dirname, "styles.css");
      const dest = path.resolve(__dirname, "styles.css");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    });
  },
};

build();
