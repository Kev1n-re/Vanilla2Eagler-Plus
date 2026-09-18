import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { config } from "./config.js";
import { ProxyManager } from "./lib/proxy-manager.js";
import { WebUI } from "./lib/webui.js";

function findChromium() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";
  let candidates;
  if (process.platform === "win32") {
    candidates = [
      join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    ];
  } else if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
  } else {
    candidates = ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
  }
  for (const c of candidates) {
    try {
      if (c.includes("/") || c.includes("\\")) {
        if (existsSync(c)) return c;
      } else {
        return c;
      }
    } catch (_) {}
  }
  return null;
}

function openDefaultBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (_) {}
}

function openBrowser(url) {
  const chromium = findChromium();
  if (chromium) {
    try {
      const profileDir = join(tmpdir(), "vanilla2eagler-app");
      const child = spawn(
        chromium,
        [`--app=${url}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"],
        { stdio: "ignore" }
      );
      child.on("error", () => {});
      return child;
    } catch (_) {}
  }
  openDefaultBrowser(url);
  return null;
}

async function main() {
  const manager = new ProxyManager(config);

  let webui = null;
  let appChild = null;
  function shutdown() {
    try { appChild?.kill(); } catch (_) {}
    try { webui?.close(); } catch (_) {}
    try { manager.stopAll(); } catch (_) {}
    process.exit(0);
  }

  if (config.webui?.enabled) {
    webui = new WebUI(manager, config.webui);
    await webui.start();
    appChild = openBrowser(`http://127.0.0.1:${webui.port || 3000}`);
    if (appChild && config.webui.exitOnUiClose) {
      const grace = Number.isFinite(config.webui.exitGraceMs) ? config.webui.exitGraceMs : 0;
      appChild.once("exit", () => {
        setTimeout(shutdown, grace);
      });
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
