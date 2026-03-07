const fs = require("fs");
const path = require("path");

let logFilePath = null;

function setLogFile(baseDir, filename = "wallet-profit.log") {
  try {
    if (!baseDir) return;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    logFilePath = path.join(baseDir, filename);
  } catch {
    logFilePath = null;
  }
}

function writeLine(level, message, extra) {
  const ts = new Date().toISOString();
  const line =
    `[${ts}] [${level}] ${message}` +
    (extra ? ` ${JSON.stringify(extra)}` : "") +
    "\n";

  // Always log to console
  if (level === "ERROR") {
    // eslint-disable-next-line no-console
    console.error(line.trim());
  } else {
    // eslint-disable-next-line no-console
    console.log(line.trim());
  }

  if (!logFilePath) return;

  try {
    fs.appendFileSync(logFilePath, line, "utf8");
  } catch {
    // ignore file logging errors
  }
}

function info(msg, extra) {
  writeLine("INFO", msg, extra);
}

function error(msg, extra) {
  writeLine("ERROR", msg, extra);
}

module.exports = {
  setLogFile,
  info,
  error,
};

