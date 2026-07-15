const { spawnSync } = require("node:child_process");
const electronPath = require("electron");

const result = spawnSync(electronPath, ["--test"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
