import http from "http";
import util from "util";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, extname } from "path";
import { tmpdir } from "os";
import { WebSocketServer } from "ws";
import { saveConfig } from "../config.js";
import { encodeSkinPNG } from "./eagler-skins.js";

const WEBUI_ROOT = globalThis.__WEBUI_ROOT__ || join(dirname(fileURLToPath(import.meta.url)), "..", "webui-dist");
const WEBUI_EMBED = globalThis.__WEBUI_EMBED__ || null;
function readEmbeddedFile(rel) {
  const key = String(rel).split("\\").join("/");
  const f = WEBUI_EMBED && WEBUI_EMBED.find((x) => String(x.rel).split("\\").join("/") === key);
  return f ? Buffer.from(f.data, "base64") : null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

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

export class WebUI {
  constructor(manager, config, options = {}) {
    this.manager = manager;
    this.proxy = manager;
    this.config = config;
    this.httpServer = null;
    this.wsServer = null;
    this.clients = new Set();
    this.recentLogs = [];
    this._consolePatched = false;
    this._originalConsole = null;
    this.localRelay = null;
    this.localRelayLogs = [];

    this._onProcesses = () => this.broadcast({ type: "processes", processes: this.manager.getProcesses() });
    this._onLog = (log) => {
      this.recentLogs.push(log);
      if (this.recentLogs.length > 300) this.recentLogs.shift();
      this.broadcast({ type: "log", log });
    };

    this.manager.on("processes", this._onProcesses);
    this.manager.on("log", this._onLog);
  }

  _baseState() {
    const cfg = this.manager.baseConfig;
    return {
      running: false,
      bindHost: cfg.bindHost,
      bindPort: cfg.bindPort,
      motd: cfg.motd,
      maxPlayers: cfg.maxPlayers,
      forceUsername: cfg.forceUsername,
      skinPreset: cfg.skinPreset ?? 0,
      capePreset: cfg.capePreset ?? 0,
      skinModel: cfg.skinModel ?? 0,
      customSkin: cfg.customSkin ?? null,
      customCape: cfg.customCape ?? null,
      customSkinPacket: cfg.customSkinPacket ?? null,
      customCapePacket: cfg.customCapePacket ?? null,
      customSkinPacketV3: cfg.customSkinPacketV3 ?? null,
      customSkinPacketV4: cfg.customSkinPacketV4 ?? null,
      skinPacketFormat: cfg.skinPacketFormat ?? 2,
      skinPacketABGR: !!cfg.skinPacketABGR,
      debug: !!cfg.debug,
      handshakeTimeout: cfg.handshakeTimeout,
      eagler: { url: cfg.eaglerServer?.url || "" },
      servers: cfg.servers || [],
      relay: {
        enabled: !!cfg.relay?.enabled,
        url: cfg.relay?.url || "",
        code: cfg.relay?.code || "",
        username: cfg.relay?.username || null,
        rejectUnauthorized: cfg.relay?.rejectUnauthorized !== false,
        retryCount: cfg.relay?.retryCount ?? 3
      },
      mineskin: {
        enabled: !!cfg.mineskin?.enabled,
        apiKey: cfg.mineskin?.apiKey || "",
        publicBaseUrl: cfg.mineskin?.publicBaseUrl || "",
        secretSkins: !!cfg.mineskin?.secretSkins
      },
      players: [],
      webuiPort: this.port || null
    };
  }

  async start() {
    const host = this.config.host || "0.0.0.0";
    const preferRandom = this.config.randomPort !== false;
    const port = preferRandom ? 0 : (this.config.port || 3000);

    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this._patchConsole();

    this.wsServer.on("connection", (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: "state", state: this._baseState() }));
      ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
      ws.send(JSON.stringify({ type: "localRelay", running: !!this.localRelay, logs: this.localRelayLogs }));
      for (const log of this.recentLogs) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "log", log }));
      }
      ws.on("close", () => {
        this.clients.delete(ws);
      });
      ws.on("message", (data) => this._handleMessage(ws, data));
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("listening", resolve);
      this.httpServer.once("error", reject);
      this.httpServer.listen(port, host);
    });

    this.port = this.httpServer.address().port;
    console.log(`[Vanilla2Eagler] WebUI listening on ${host}:${this.port}`);
  }

  close() {
    for (const ws of this.clients) {
      try { ws.close(); } catch (_) {}
    }
    this.clients.clear();
    if (this.wsServer) {
      try { this.wsServer.close(); } catch (_) {}
      this.wsServer = null;
    }
    if (this.httpServer) {
      try { this.httpServer.close(); } catch (_) {}
      this.httpServer = null;
    }
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  _patchConsole() {
    if (this._consolePatched) return;
    this._consolePatched = true;
    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
    this._originalConsole = original;

    console.log = (...args) => {
      original.log(...args);
      this._captureConsole("info", args);
    };
    console.warn = (...args) => {
      original.warn(...args);
      this._captureConsole("warn", args);
    };
    console.error = (...args) => {
      original.error(...args);
      this._captureConsole("error", args);
    };
  }

  _captureConsole(level, args) {
    const message = util.format(...args);
    const log = { level, message, time: Date.now() };
    this.recentLogs.push(log);
    if (this.recentLogs.length > 300) this.recentLogs.shift();
    this.broadcast({ type: "log", log });
  }

  async _handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "/index.html") {
      pathname = "/index.html";
    }

    if (pathname === "/player-skin.png") {
      await this._servePlayerSkin(res);
      return;
    }
    if (pathname === "/player-cape.png") {
      await this._servePlayerCape(res);
      return;
    }
    if (pathname.startsWith("/skin/") && pathname.endsWith(".png")) {
      await this._serveCachedSkin(res, pathname);
      return;
    }

    const safePath = join(WEBUI_ROOT, pathname);
    if (!safePath.startsWith(WEBUI_ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      let body;
      if (WEBUI_EMBED) {
        const rel = pathname.replace(/^\//, "").split("/").join("\\");
        body = readEmbeddedFile(rel);
        if (!body) {
          res.writeHead(404).end("Not found");
          return;
        }
      } else {
        body = await readFile(safePath);
      }
      res.writeHead(200, { "Content-Type": MIME[extname(safePath)] || "application/octet-stream" });
      res.end(body);
    } catch (_) {
      res.writeHead(404).end("Not found");
    }
  }

  async _serveCachedSkin(res, pathname) {
    const id = pathname.slice("/skin/".length, -".png".length);
    if (!id || id.length !== 32 || !/^[0-9a-f]+$/.test(id)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const entry = this.manager.sharedSkinCache && this.manager.sharedSkinCache.get(id);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (entry.type === "preset") {
      try {
        let files = [];
        if (WEBUI_EMBED) {
          files = WEBUI_EMBED
            .map((x) => String(x.rel).split("\\").join("/"))
            .filter((r) => r.startsWith("skins/") && r.toLowerCase().endsWith(".png"))
            .map((r) => r.slice("skins/".length))
            .sort();
        } else {
          const dir = join(WEBUI_ROOT, "skins");
          files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".png")).sort();
        }
        if (files.length > 0 && entry.preset >= 0 && entry.preset < files.length) {
          const rel = `skins/${files[entry.preset]}`;
          const body = readEmbeddedFile(rel) || await readFile(join(WEBUI_ROOT, "skins", files[entry.preset]));
          res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
          res.end(body);
          return;
        }
      } catch (_) {}
      res.writeHead(404).end("Not found");
      return;
    }
    if (entry.type === "custom" && entry.v3) {
      const png = encodeSkinPNG(entry.v3);
      console.log(`[Vanilla2Eagler] Serving cached skin ${id} (${png.length} bytes)`);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      res.end(png);
      return;
    }
    res.writeHead(404).end("Not found");
  }

  async _servePlayerSkin(res) {
    const cfg = this.manager.baseConfig;
    if (cfg.customSkin) {
      const buf = this._dataUrlToBuffer(cfg.customSkin);
      if (buf) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        res.end(buf);
        return;
      }
    }
    await this._redirectToPreset(res, "skins", cfg.skinPreset || 0);
  }

  async _servePlayerCape(res) {
    const cfg = this.manager.baseConfig;
    if (cfg.customCape) {
      const buf = this._dataUrlToBuffer(cfg.customCape);
      if (buf) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        res.end(buf);
        return;
      }
    }
    const preset = cfg.capePreset || 0;
    if (preset <= 0) {
      res.writeHead(404).end("No cape");
      return;
    }
    await this._redirectToPreset(res, "capes", preset);
  }

  async _redirectToPreset(res, folder, preset) {
    try {
      const dir = join(WEBUI_ROOT, folder);
      const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".png")).sort();
      if (files.length === 0 || preset < 0 || preset >= files.length) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(302, { Location: `/${folder}/${encodeURIComponent(files[preset])}` });
      res.end();
    } catch (_) {
      res.writeHead(404).end("Not found");
    }
  }

  _dataUrlToBuffer(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return null;
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    try {
      return Buffer.from(dataUrl.slice(comma + 1), "base64");
    } catch (_) {
      return null;
    }
  }

  _startGame(filePath) {
    const p = String(filePath || "").trim();
    if (!p.toLowerCase().endsWith(".html")) {
      console.log("[StartGame/Error] This file isn't an HTML file");
      return;
    }
    if (!existsSync(p)) {
      console.log("[StartGame/Error] File not found: " + p);
      return;
    }
    const url = pathToFileURL(p).href;
    const chromium = findChromium();
    if (chromium) {
      try {
        const profileDir = join(tmpdir(), "vanilla2eagler-game");
        const child = spawn(
          chromium,
          ["--app=" + url, "--user-data-dir=" + profileDir, "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files"],
          { detached: true, stdio: "ignore" }
        );
        child.on("error", () => {});
        child.unref();
        console.log("[StartGame] Launched: " + p);
        return;
      } catch (_) {}
    }
    try {
      if (process.platform === "win32") {
        spawn("rundll32", ["url.dll,FileProtocolHandler", p], { detached: true, stdio: "ignore" }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [p], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [p], { detached: true, stdio: "ignore" }).unref();
      }
      console.log("[StartGame] Launched: " + p);
    } catch (err) {
      console.log("[StartGame/Error] " + err.message);
    }
  }

  _startLocalRelay(ws) {
    if (this.localRelay) {
      this._sendLocalRelay(ws);
      return;
    }
    const appRoot = globalThis.__APP_ROOT__ || join(dirname(fileURLToPath(import.meta.url)), "..");
    const relayDir = join(appRoot, "relay");
    const jar = join(relayDir, "EaglerSPRelay.jar");
    const javaExe = join(appRoot, "java", "jre", "bin", "java.exe");
    if (!existsSync(javaExe)) {
      this._pushLocalRelayLog("error", "[LocalRelay] Built-in Java not found: " + javaExe);
      this._sendLocalRelay(ws);
      return;
    }
    if (!existsSync(jar)) {
      this._pushLocalRelayLog("error", "[LocalRelay] Relay jar not found: " + jar);
      this._sendLocalRelay(ws);
      return;
    }
    this.localRelayLogs = [];
    let child;
    try {
      child = spawn(javaExe, ["-jar", jar, "--debug"], { cwd: relayDir, windowsHide: true });
    } catch (err) {
      this._pushLocalRelayLog("error", "[LocalRelay] " + err.message);
      this._sendLocalRelay(ws);
      return;
    }
    this.localRelay = child;
    this._pushLocalRelayLog("info", "[LocalRelay] Starting built-in relay via " + javaExe);
    const onData = (level) => (d) => {
      const text = d.toString("utf8").replace(/\r/g, "");
      for (const line of text.split("\n")) {
        if (line.length > 0) this._pushLocalRelayLog(level, line);
      }
    };
    child.stdout.on("data", onData("info"));
    child.stderr.on("data", onData("error"));
    child.on("error", (err) => {
      this._pushLocalRelayLog("error", "[LocalRelay] " + err.message);
    });
    child.on("close", (code) => {
      this._pushLocalRelayLog("warn", "[LocalRelay] Stopped (exit code " + code + ")");
      this.localRelay = null;
      this._sendLocalRelay(null);
    });
    this._sendLocalRelay(ws);
  }

  _stopLocalRelay(ws) {
    if (this.localRelay) {
      const child = this.localRelay;
      this.localRelay = null;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGTERM");
        }
      } catch (_) {}
      this._pushLocalRelayLog("warn", "[LocalRelay] Stopping...");
    }
    this._sendLocalRelay(ws);
  }

  _pushLocalRelayLog(level, message) {
    const log = { level, message, time: Date.now() };
    this.localRelayLogs.push(log);
    if (this.localRelayLogs.length > 500) this.localRelayLogs.shift();
    this.broadcast({ type: "localRelayLog", log });
  }

  _sendLocalRelay(ws) {
    const payload = { type: "localRelay", running: !!this.localRelay, logs: this.localRelayLogs };
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    else this.broadcast(payload);
  }

  _pickFile(ws) {
    if (process.platform !== "win32") {
      ws.send(JSON.stringify({ type: "pickedFile", path: null }));
      return;
    }
    const ps = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Filter = 'HTML files (*.html)|*.html|All files (*.*)|*.*'",
      "$d.Title = '选择'",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.WindowState = 'Minimized'",
      "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
      "$owner.Dispose()"
    ].join("; ");
    let out = "";
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-STA", "-Command", ps], { windowsHide: true });
    } catch (_) {
      ws.send(JSON.stringify({ type: "pickedFile", path: null }));
      return;
    }
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", () => {
      ws.send(JSON.stringify({ type: "pickedFile", path: null }));
    });
    child.on("close", () => {
      const picked = out.trim();
      ws.send(JSON.stringify({ type: "pickedFile", path: picked || null }));
    });
  }

  async _handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case "getState":
        ws.send(JSON.stringify({ type: "state", state: this._baseState() }));
        ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        break;
      case "saveServers":
        this.manager.baseConfig.servers = Array.isArray(msg.servers) ? msg.servers : [];
        saveConfig();
        ws.send(JSON.stringify({ type: "state", state: this._baseState() }));
        break;
      case "getProcesses":
        ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        break;
      case "queryMotd":
        try {
          const cfg = this.manager.baseConfig;
          const proxy = new (await import("./proxy.js")).Vanilla2EaglerProxy({ ...cfg, eaglerServer: { ...cfg.eaglerServer, url: msg.url || "" } });
          proxy.eaglerUrl = proxy._buildEaglerUrl({ url: msg.url || "" });
          const info = await proxy._queryEaglerMOTD();
          ws.send(JSON.stringify({ type: "motd", url: msg.url, info }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "motd", url: msg.url, info: null, error: err.message }));
        }
        break;
      case "startProxy":
        try {
          await this.manager.startProxy(msg.config || {});
          ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      case "stopProxy":
        await this.manager.stopProxy(msg.id);
        ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        break;
      case "startWorld":
        try {
          await this.manager.startWorld(msg.config || {});
          ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      case "stopWorld":
        await this.manager.stopWorld(msg.id);
        ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        break;
      case "startGame":
        this._startGame(msg.path);
        break;
      case "pickFile":
        this._pickFile(ws);
        break;
      case "startLocalRelay":
        this._startLocalRelay(ws);
        break;
      case "stopLocalRelay":
        this._stopLocalRelay(ws);
        break;
      case "stopAll":
        this.manager.stopAll();
        ws.send(JSON.stringify({ type: "processes", processes: this.manager.getProcesses() }));
        break;
      case "applyConfig": {
        const cfg = this.manager.baseConfig;
        const patch = msg.config || {};
        if (patch.forceUsername !== undefined) cfg.forceUsername = patch.forceUsername || null;
        if (Number.isInteger(patch.skinPreset)) cfg.skinPreset = patch.skinPreset;
        if (Number.isInteger(patch.capePreset)) cfg.capePreset = patch.capePreset;
        if (Number.isInteger(patch.skinModel)) cfg.skinModel = patch.skinModel;
        if (typeof patch.customSkin === "string" || patch.customSkin === null) cfg.customSkin = patch.customSkin;
        if (typeof patch.customCape === "string" || patch.customCape === null) cfg.customCape = patch.customCape;
        if (typeof patch.customSkinPacket === "string" || patch.customSkinPacket === null) cfg.customSkinPacket = patch.customSkinPacket;
        if (typeof patch.customCapePacket === "string" || patch.customCapePacket === null) cfg.customCapePacket = patch.customCapePacket;
        if (typeof patch.customSkinPacketV3 === "string" || patch.customSkinPacketV3 === null) cfg.customSkinPacketV3 = patch.customSkinPacketV3;
        if (typeof patch.customSkinPacketV4 === "string" || patch.customSkinPacketV4 === null) cfg.customSkinPacketV4 = patch.customSkinPacketV4;
        if (Number.isInteger(patch.skinPacketFormat)) cfg.skinPacketFormat = patch.skinPacketFormat;
        if (typeof patch.skinPacketABGR === "boolean") cfg.skinPacketABGR = patch.skinPacketABGR;
        if (typeof patch.debug === "boolean") cfg.debug = patch.debug;
        if (patch.mineskin) {
          if (typeof patch.mineskin.enabled === "boolean") cfg.mineskin.enabled = patch.mineskin.enabled;
          if (typeof patch.mineskin.apiKey === "string") cfg.mineskin.apiKey = patch.mineskin.apiKey.trim();
          if (typeof patch.mineskin.publicBaseUrl === "string") cfg.mineskin.publicBaseUrl = patch.mineskin.publicBaseUrl.trim().replace(/\/$/, "");
          if (typeof patch.mineskin.secretSkins === "boolean") cfg.mineskin.secretSkins = patch.mineskin.secretSkins;
        }
        if (patch.relay) {
          if (typeof patch.relay.url === "string") cfg.relay.url = patch.relay.url.trim();
        }
        if (patch.eagler) {
          if (typeof patch.eagler.url === "string") cfg.eaglerServer.url = patch.eagler.url.trim();
        }
        saveConfig();
        ws.send(JSON.stringify({ type: "applied", state: this._baseState() }));
        break;
      }
      default:
        break;
    }
  }
}
