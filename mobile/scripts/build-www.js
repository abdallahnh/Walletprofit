/** Build the shared desktop pages for Capacitor and inject the mobile runtime. */
const fs = require("fs");
const path = require("path");

require("./sync-ui.js");

const OUT = path.join(__dirname, "..", "www");
const mobileSrc = path.join(__dirname, "..", "src");
const root = path.join(__dirname, "..", "..");

for (const file of ["mobile-core.js", "bridge.js", "mobile.css"]) {
  fs.copyFileSync(path.join(mobileSrc, file), path.join(OUT, file));
}

fs.copyFileSync(
  path.join(root, "node_modules", "xlsx", "dist", "xlsx.full.min.js"),
  path.join(OUT, "xlsx.full.min.js")
);
fs.copyFileSync(
  path.join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.js"),
  path.join(OUT, "chart.umd.js")
);

const inject = [
  '<link rel="stylesheet" href="mobile.css" />',
  '<script src="xlsx.full.min.js"></script>',
  '<script src="mobile-core.js"></script>',
  '<script src="bridge.js"></script>',
].join("\n  ");

for (const name of fs.readdirSync(OUT).filter((file) => file.endsWith(".html"))) {
  const filePath = path.join(OUT, name);
  let html = fs.readFileSync(filePath, "utf8");
  html = html.replace(
    /<script\s+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js["']><\/script>/i,
    '<script src="chart.umd.js"></script>'
  );
  if (!html.includes('src="mobile-core.js"')) {
    html = html.replace("</head>", `  ${inject}\n</head>`);
  }
  fs.writeFileSync(filePath, html);
}

for (const obsolete of ["preload.js", "orderDetailsPreload.js", "db.js", "bridge-stub.js"]) {
  fs.rmSync(path.join(OUT, obsolete), { force: true });
}

console.log("mobile/www build complete (shared UI + cloud/offline bridge).");
