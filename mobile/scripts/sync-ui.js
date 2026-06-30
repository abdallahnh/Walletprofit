/**
 * Copies desktop UI assets into mobile/www for Capacitor.
 * Does not modify ../src — read-only copy.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const RENDER = path.join(ROOT, "src", "render");
const OUT = path.join(__dirname, "..", "www");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

if (!fs.existsSync(RENDER)) {
  console.error("Missing src/render — run from repo root.");
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(RENDER, OUT);
console.log(`Synced UI: ${RENDER} → ${OUT}`);
