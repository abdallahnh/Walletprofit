/**
 * Phase 1 placeholder: sync UI + inject mobile bridge stub.
 * Phase 2+ will bundle db layer with esbuild.
 */
const fs = require("fs");
const path = require("path");

require("./sync-ui.js");

const OUT = path.join(__dirname, "..", "www");
const bridgeStub = path.join(__dirname, "..", "src", "bridge-stub.js");
const indexPath = path.join(OUT, "index.html");

if (!fs.existsSync(indexPath)) {
  console.error("index.html missing after sync.");
  process.exit(1);
}

let html = fs.readFileSync(indexPath, "utf8");
const inject = '<script src="bridge-stub.js"></script>';
if (!html.includes("bridge-stub.js")) {
  html = html.replace("</head>", `  ${inject}\n</head>`);
  fs.writeFileSync(indexPath, html);
}

if (fs.existsSync(bridgeStub)) {
  fs.copyFileSync(bridgeStub, path.join(OUT, "bridge-stub.js"));
}

console.log("mobile/www build complete (UI only — db bridge not wired yet).");
