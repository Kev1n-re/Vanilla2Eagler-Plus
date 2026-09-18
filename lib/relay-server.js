import { EventEmitter } from "events";
import net from "net";
import zlib from "zlib";
import WebSocket from "ws";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { writeVarInt, readVarInt } from "./varint.js";
import pngjs from "pngjs";

const { PNG } = pngjs;

const RELAY_VERSION = 1;
const TYPE_SERVER = 0x01;
const PKT_HANDSHAKE = 0x00;
const PKT_ICE_SERVERS = 0x01;
const PKT_NEW_CLIENT = 0x02;
const PKT_ICE_CANDIDATE = 0x03;
const PKT_DESCRIPTION = 0x04;
const PKT_CLIENT_SUCCESS = 0x05;
const PKT_CLIENT_FAILURE = 0x06;
const PKT_DISCONNECT = 0xfe;
const PKT_ERROR = 0xff;
const FRAGMENT_SIZE = 0xff00 - 1;
const COMPRESSION_THRESHOLD = 1024;
const PROTOCOL_1_8 = 47;
const PROTOCOL_1_12 = 335;
const PROTOCOL_1_12_2 = 340;
const PROTOCOL_1_20_6 = 766;
const EAGLER_1_12_2_BRAND_MSB = 0xe37b64d5e7e43bc8n;
const EAGLER_1_12_2_BRAND_LSB = 0xba48feb34d712b72n;
const SKIN_CHANNEL = "EAG|Skins-1.8";
const DEFAULT_WORLD_NAME = "§aVanilla2Eagler Network §c[1.8.8/1.12.2/1.20.6-Web]";

function writeMCString(str) {
  const body = Buffer.from(str || "", "utf8");
  return Buffer.concat([writeVarInt(body.length), body]);
}

function readMCString(buf, off) {
  const len = readVarInt(buf, off);
  off = len.next;
  const end = off + len.value;
  if (end > buf.length) throw new Error("MC string too long");
  return { value: buf.toString("utf8", off, end), next: end };
}

function writeASCII8(str) {
  const body = Buffer.from(str || "", "latin1");
  if (body.length > 255) throw new Error("ASCII8 string too long");
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function readASCII8(buf, off) {
  const len = buf[off++];
  return { value: buf.toString("latin1", off, off + len), next: off + len };
}

function writeASCII16(str) {
  const body = Buffer.from(str || "", "latin1");
  if (body.length > 65535) throw new Error("ASCII16 string too long");
  const h = Buffer.alloc(2);
  h.writeUInt16BE(body.length, 0);
  return Buffer.concat([h, body]);
}

function readASCII16(buf, off) {
  const len = buf.readUInt16BE(off);
  off += 2;
  return { value: buf.toString("latin1", off, off + len), next: off + len };
}

function writeBytes16(data) {
  const body = Buffer.from(data || []);
  const h = Buffer.alloc(2);
  h.writeUInt16BE(body.length, 0);
  return Buffer.concat([h, body]);
}

function readBytes16(buf, off) {
  const len = buf.readUInt16BE(off);
  off += 2;
  return { value: buf.subarray(off, off + len), next: off + len };
}

function packetHandshake(type, version, code) {
  return Buffer.concat([Buffer.from([PKT_HANDSHAKE, type, version]), writeASCII8(code)]);
}

function packetDescription(peerId, desc) {
  return Buffer.concat([Buffer.from([PKT_DESCRIPTION]), writeASCII8(peerId), writeBytes16(Buffer.from(desc, "utf8"))]);
}

function packetIceCandidate(peerId, candidate) {
  return Buffer.concat([Buffer.from([PKT_ICE_CANDIDATE]), writeASCII8(peerId), writeBytes16(Buffer.from(candidate, "utf8"))]);
}

function packetClientSuccess(peerId) {
  return Buffer.concat([Buffer.from([PKT_CLIENT_SUCCESS]), writeASCII8(peerId)]);
}

function packetClientFailure(peerId) {
  return Buffer.concat([Buffer.from([PKT_CLIENT_FAILURE]), writeASCII8(peerId)]);
}

function sanitizeServerboundPacket(raw) {
  try {
    const pkt = readVarInt(raw, 0);
    if (pkt.value !== 0) return raw;
    const name = readMCString(raw, pkt.next);
    return Buffer.concat([writeVarInt(0), writeMCString(name.value)]);
  } catch (_) {
    return raw;
  }
}

function isMySkinPacket(skin) {
  if (!skin || skin.length < 1) return false;
  if (skin[0] === 0x01) return skin.length === 5;
  if (skin[0] === 0x02) return skin.length === 16386;
  return false;
}

function setAlphaForChest(pixels) {
  if (!pixels || pixels.length !== 16384) return;
  for (let y = 20; y < 32; y++) {
    for (let x = 16; x < 40; x++) {
      pixels[(y << 8) | (x << 2)] = 255;
    }
  }
}

function fallbackPreset(uuidHex) {
  let sum = 0;
  for (let i = 0; i < uuidHex.length; i++) sum += uuidHex.charCodeAt(i);
  return sum & 1;
}

function uuidHexFromBytes(buf, off) {
  return buf.subarray(off, off + 16).toString("hex");
}

function buildPlayerListPacket(action, count, pieces) {
  return Buffer.concat([Buffer.from([0x38]), writeVarInt(action), writeVarInt(count), ...pieces]);
}

function buildPluginMessage(payload) {
  return Buffer.concat([writeVarInt(0x3f), writeMCString(SKIN_CHANNEL), payload]);
}

function decodeSkinPng(buf) {
  let png;
  try {
    png = PNG.sync.read(buf);
  } catch (_) {
    return null;
  }
  if (!png || png.width < 64 || png.height < 32 || png.width > 512 || png.height > 512) return null;
  let width = png.width;
  let height = png.height;
  let data = png.data;
  if (!((width === 64 && height === 64) || (width === 64 && height === 32))) {
    if (width === height) {
      const scaled = resizePng(png, 64, 64);
      if (!scaled) return null;
      data = scaled.data;
      width = 64;
      height = 64;
    } else if (width === height * 2) {
      const scaled = resizePng(png, 64, 32);
      if (!scaled) return null;
      data = scaled.data;
      width = 64;
      height = 32;
    } else {
      return null;
    }
  }
  const out = Buffer.alloc(16384);
  if (width === 64 && height === 64) {
    for (let i = 0; i < 4096; i++) {
      const src = i * 4;
      const dst = i * 4;
      out[dst] = data[src + 3];
      out[dst + 1] = data[src + 2];
      out[dst + 2] = data[src + 1];
      out[dst + 3] = data[src];
    }
  } else {
    out.fill(0);
    for (let i = 0; i < 2048; i++) {
      const src = i * 4;
      const dst = i * 4;
      out[dst] = data[src + 3];
      out[dst + 1] = data[src + 2];
      out[dst + 2] = data[src + 1];
      out[dst + 3] = data[src];
    }
    const copy = (dx, dy, sx, sy, w, h) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const src = ((sy + y) * 64 + sx + x) * 4;
          const dst = ((dy + y) * 64 + dx + x) * 4;
          out[dst] = data[src + 3];
          out[dst + 1] = data[src + 2];
          out[dst + 2] = data[src + 1];
          out[dst + 3] = data[src];
        }
      }
    };
    copy(4, 16, 24, 16, 4, 4);
    copy(8, 16, 28, 16, 4, 4);
    copy(0, 20, 16, 20, 4, 12);
    copy(4, 20, 20, 20, 4, 12);
    copy(8, 20, 24, 20, 4, 12);
    copy(12, 20, 28, 20, 4, 12);
    copy(44, 16, 40, 16, 4, 4);
    copy(48, 16, 44, 16, 4, 4);
    copy(40, 20, 32, 20, 4, 12);
    copy(44, 20, 36, 20, 4, 12);
    copy(48, 20, 40, 20, 4, 12);
    copy(52, 20, 44, 20, 4, 12);
  }
  setAlphaForChest(out);
  return out;
}

function resizePng(png, width, height) {
  try {
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = Math.min(png.width - 1, Math.floor((x * png.width) / width));
        const sy = Math.min(png.height - 1, Math.floor((y * png.height) / height));
        const src = (sy * png.width + sx) * 4;
        const dst = (y * width + x) * 4;
        out[dst] = png.data[src];
        out[dst + 1] = png.data[src + 1];
        out[dst + 2] = png.data[src + 2];
        out[dst + 3] = png.data[src + 3];
      }
    }
    return { width, height, data: out };
  } catch (_) {
    return null;
  }
}

class LANBridge {
  constructor(peer) {
    this.peer = peer;
    this.socket = null;
    this.closed = false;
    this.compressionEnabled = false;
    this.fragments = [];
    this.handshakeSent = false;
    this.detectedProtocolVersion = -1;
    this.pending = Buffer.alloc(0);
  }

  start() {
    if (this.closed) return;
    const server = this.peer.owner.server;
    const port = server.targetPort || 25565;
    this.socket = net.connect({ host: server.targetHost || "127.0.0.1", port }, () => {
      try {
        if (server.proxyProtocol && this.peer.remoteIp) {
          const srcPort = this.peer.remotePort > 0 ? this.peer.remotePort : 0;
          this.socket.write(`PROXY TCP4 ${this.peer.remoteIp} ${server.targetHost || "127.0.0.1"} ${srcPort} ${port}\r\n`, "ascii");
        }
      } catch (_) {}
      this.readLoop().catch((err) => {
        this.close();
        this.peer.disconnect();
        server.emit("log", { level: "warn", message: `World bridge closed: ${err.message}` });
      });
    });
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
  }

  createHandshake(protocolVersion) {
    const port = this.peer.owner.server.targetPort || 25565;
    return Buffer.concat([
      writeVarInt(0x00),
      writeVarInt(protocolVersion),
      writeMCString(this.peer.owner.server.targetHost || "localhost"),
      Buffer.from([(port >>> 8) & 0xff, port & 0xff]),
      writeVarInt(2)
    ]);
  }

  detectProtocolVersion(raw) {
    try {
      const packetId = readVarInt(raw, 0);
      if (packetId.value !== 0x00) return PROTOCOL_1_8;
      let off = packetId.next;
      const name = readMCString(raw, off);
      off = name.next;
      const remaining = raw.length - off;
      if (remaining <= 0) return PROTOCOL_1_12;
      if (remaining === 16) return PROTOCOL_1_20_6;
      const skin = readVarInt(raw, off);
      off = skin.next;
      if (skin.value < 0 || skin.value > 32768 || skin.value > raw.length - off) return PROTOCOL_1_8;
      off += skin.value;
      if (off < raw.length) {
        const cape = readVarInt(raw, off);
        off = cape.next;
        if (cape.value < 0 || cape.value > 32768 || cape.value > raw.length - off) return PROTOCOL_1_8;
        off += cape.value;
      }
      if (off < raw.length) {
        const protocols = readVarInt(raw, off);
        off = protocols.next;
        if (protocols.value < 0 || protocols.value > 256 || protocols.value > raw.length - off) return PROTOCOL_1_8;
        off += protocols.value;
      }
      if (raw.length - off >= 16) {
        const msb = raw.readBigUInt64BE(off);
        const lsb = raw.readBigUInt64BE(off + 8);
        if (msb === EAGLER_1_12_2_BRAND_MSB && lsb === EAGLER_1_12_2_BRAND_LSB) return PROTOCOL_1_12_2;
      }
      return PROTOCOL_1_8;
    } catch (_) {
      return PROTOCOL_1_8;
    }
  }

  onClientFrame(frame) {
    if (this.closed || !frame || frame.length < 1) return;
    let raw = null;
    const type = frame[0];
    if (type === 0) {
      if (this.fragments.length === 0) {
        raw = frame.subarray(1);
      } else {
        this.fragments.push(frame);
        raw = Buffer.concat(this.fragments.map((f) => f.subarray(1)));
        this.fragments = [];
      }
    } else if (type === 1) {
      this.fragments.push(frame);
    } else {
      this.fragments = [];
    }
    if (!raw) return;
    const server = this.peer.owner.server;
    try {
      const pkt = readVarInt(raw, 0);
      if (pkt.value === 0x17 || pkt.value === 0x3f) {
        const channel = readMCString(raw, pkt.next);
        if (channel.value === SKIN_CHANNEL) {
          server.handleSkinMessage(raw, this.peer);
          return;
        }
      }
    } catch (_) {}
    if (!this.handshakeSent) {
      server.registerLoginSkin(raw, this.peer);
      this.detectedProtocolVersion = this.detectProtocolVersion(raw);
      this.writeRaw(this.createHandshake(this.detectedProtocolVersion), false);
      this.handshakeSent = true;
      if (this.detectedProtocolVersion < 764) {
        raw = sanitizeServerboundPacket(raw);
      }
    }
    this.writeRaw(raw, this.compressionEnabled);
  }

  writeRaw(raw, compressed) {
    if (this.closed || !this.socket) return;
    const parts = [writeVarInt(compressed ? raw.length + 1 : raw.length)];
    if (compressed) parts.push(writeVarInt(0));
    parts.push(raw);
    this.socket.write(Buffer.concat(parts));
  }

  async readLoop() {
    while (!this.closed) {
      const chunk = await new Promise((resolve, reject) => {
        this.socket.once("data", resolve);
        this.socket.once("error", reject);
        this.socket.once("close", () => reject(new Error("socket closed")));
      });
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      while (!this.closed) {
        if (this.pending.length < 1) break;
        const header = readVarInt(this.pending, 0);
        if (header.value <= 0 || this.pending.length < header.next + header.value) break;
        let packet = this.pending.subarray(header.next, header.next + header.value);
        this.pending = this.pending.subarray(header.next + header.value);
        if (this.compressionEnabled) {
          const dl = readVarInt(packet, 0);
          const body = packet.subarray(dl.next);
          if (dl.value === 0) packet = body;
          else {
            try {
              packet = zlib.inflateSync(body);
            } catch (_) {
              continue;
            }
          }
        }
        if (!this.compressionEnabled && packet.length > 0 && packet[0] === 0x03) {
          this.compressionEnabled = true;
          if (this.detectedProtocolVersion >= 764) continue;
        }
        let outbound = packet;
        if (packet.length > 0 && packet[0] === 0x38 && this.detectedProtocolVersion < 340) {
          outbound = this.peer.owner.server.rewritePlayerList(packet);
        }
        this.peer.sendLanPacket(outbound);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.destroy(); } catch (_) {}
    this.socket = null;
  }
}

class WorldPeer {
  constructor(owner, id) {
    this.owner = owner;
    this.id = id;
    this.username = null;
    this.pc = null;
    this.dc = null;
    this.bridge = null;
    this.disconnected = false;
    this.localCandidates = [];
    this.sentCandidates = false;
    this.flushTimer = null;
    this.flushTrials = 0;
    this.lastSize = 0;
    this.remoteIceReceived = false;
    this.remoteIp = null;
    this.remotePort = 0;
  }

  create(iceServers) {
    if (this.disconnected) return;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.onDataChannel.subscribe((dc) => {
      if (this.disconnected || this.dc) {
        try { dc.close(); } catch (_) {}
        return;
      }
      this.dc = dc;
      this.bridge = new LANBridge(this);
      this.bridge.start();
      dc.onMessage.subscribe((data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.bridge?.onClientFrame(buf);
      });
      dc.stateChanged.subscribe((state) => {
        if (state === "closed" || state === "failed") this.disconnect();
      });
    });
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        if (this.remoteIceReceived) this.scheduleFlush();
      } else {
        this.localCandidates.push(candidate.toJSON());
        this.scheduleFlush();
      }
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") this.disconnect();
    });
  }

  scheduleFlush() {
    if (this.flushTimer || this.sentCandidates || this.disconnected) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.sentCandidates || this.disconnected) return;
      if (this.localCandidates.length !== this.lastSize && this.flushTrials < 5) {
        this.lastSize = this.localCandidates.length;
        this.flushTrials++;
        this.scheduleFlush();
        return;
      }
      this.sendCandidates();
    }, 2000);
  }

  sendCandidates() {
    if (this.sentCandidates || this.disconnected) return;
    this.sentCandidates = true;
    this.owner.send(packetIceCandidate(this.id, JSON.stringify(this.localCandidates.splice(0, this.localCandidates.length))));
  }

  async handleDescription(desc) {
    if (this.disconnected || !this.pc) return;
    try {
      const parsed = JSON.parse(desc);
      await this.pc.setRemoteDescription(parsed);
      if (parsed.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.owner.send(packetDescription(this.id, JSON.stringify({ type: answer.type, sdp: answer.sdp })));
        if (this.remoteIceReceived) this.scheduleFlush();
      }
    } catch (_) {
      this.disconnect();
    }
  }

  async handleIceCandidate(candidatesJson) {
    if (this.disconnected || !this.pc) return;
    try {
      const candidates = JSON.parse(candidatesJson);
      const usable = (Array.isArray(candidates) ? candidates : [])
        .filter((c) => c && typeof c.candidate === "string" && !c.candidate.includes(".local"));
      for (const raw of usable) {
        this.captureRemoteCandidate(raw.candidate);
        const init = {
          ...raw,
          sdpMid: raw.sdpMid != null ? String(raw.sdpMid) : "0",
          sdpMLineIndex: raw.sdpMLineIndex != null ? Number(raw.sdpMLineIndex) : 0
        };
        if (!Number.isInteger(init.sdpMLineIndex)) init.sdpMLineIndex = 0;
        await this.pc.addIceCandidate(new RTCIceCandidate(init));
      }
      this.remoteIceReceived = true;
      this.scheduleFlush();
    } catch (_) {
      this.disconnect();
    }
  }

  captureRemoteCandidate(candidateSdp) {
    try {
      const parts = String(candidateSdp || "").trim().split(" ");
      const typIdx = parts.indexOf("typ");
      if (typIdx > 0 && parts.length > typIdx + 1) {
        const type = parts[typIdx + 1];
        if ((type === "srflx" || type === "prflx") && parts.length > 5) {
          const ip = parts[4];
          const port = parseInt(parts[5], 10);
          if (ip.includes(".") && !ip.includes(".local") && Number.isInteger(port) && port > 0) {
            this.remoteIp = ip;
            this.remotePort = port;
          }
        }
      }
    } catch (_) {}
  }

  sendLanPacket(raw) {
    if (this.disconnected || !this.dc || this.dc.readyState !== "open") return;
    const frame = raw.length > COMPRESSION_THRESHOLD ? this.buildCompressedFrame(raw) : Buffer.concat([Buffer.from([0]), raw]);
    let off = 1;
    while (off < frame.length) {
      const len = Math.min(FRAGMENT_SIZE, frame.length - off);
      const last = off + len >= frame.length;
      this.dc.send(Buffer.concat([Buffer.from([last ? frame[0] : 1]), frame.subarray(off, off + len)]));
      off += len;
    }
  }

  buildCompressedFrame(raw) {
    const cmp = zlib.deflateSync(raw);
    const head = Buffer.alloc(5);
    head[0] = 2;
    head.writeUInt32BE(raw.length, 1);
    return Buffer.concat([head, cmp]);
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.bridge?.close();
    this.bridge = null;
    try { this.dc?.close(); } catch (_) {}
    try { this.pc?.close(); } catch (_) {}
    this.owner.peers.delete(this.id);
    this.owner.server.emit("peers");
  }
}

class WorldRoom {
  constructor(server) {
    this.server = server;
    this.name = server.name;
    this.ws = null;
    this.code = null;
    this.ready = false;
    this.closed = true;
    this.iceServers = [];
    this.peers = new Map();
    this.retry = null;
  }

  connect() {
    this.closed = false;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const handshakeName = `${this.name}${this.server.hidden ? ";1" : ";0"}`;
    const headers = { "User-Agent": "Vanilla2Eagler/1.0" };
    if (this.server.websocketOrigin) headers.Origin = this.server.websocketOrigin;
    const ws = new WebSocket(this.server.relayUrl, {
      rejectUnauthorized: this.server.rejectUnauthorized !== false,
      headers
    });
    this.ws = ws;
    ws.on("open", () => {
      try { ws.send(packetHandshake(TYPE_SERVER, RELAY_VERSION, handshakeName)); } catch (_) {}
    });
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 2 && buf[0] === 0xfc) {
        if (!this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null;
            if (!this.closed) this.connect();
          }, this.server.rateLimitRetryDelaySeconds * 1000);
        }
        return;
      }
      try {
        this.handlePacket(buf);
      } catch (_) {
        this.scheduleRetry();
      }
    });
    ws.on("close", () => {
      if (!this.closed) this.scheduleRetry();
    });
    ws.on("error", () => {
      if (!this.closed) this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.ws = null;
    this.ready = false;
    const oldCode = this.code;
    this.code = null;
    if (oldCode) this.server.emit("state");
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) this.connect();
    }, this.server.reconnectDelaySeconds * 1000);
  }

  handlePacket(buf) {
    const id = buf[0];
    if (id === PKT_HANDSHAKE) {
      const code = readASCII8(buf, 3);
      this.code = code.value;
      this.server.emit("log", { level: "info", message: `World ${this.name} published with code ${this.code}` });
      this.server.emit("state");
      return;
    }
    if (id === PKT_ICE_SERVERS) {
      this.iceServers = this.parseIceServers(buf);
      this.ready = true;
      this.server.emit("state");
      return;
    }
    let off = 1;
    if (id === PKT_NEW_CLIENT) {
      const peerId = readASCII8(buf, off);
      this.createPeer(peerId.value);
      return;
    }
    if (id === PKT_ICE_CANDIDATE || id === PKT_DESCRIPTION) {
      const peer = readASCII8(buf, off); off = peer.next;
      const data = readBytes16(buf, off);
      const p = this.peers.get(peer.value);
      if (p) {
        if (id === PKT_DESCRIPTION) p.handleDescription(data.value.toString("utf8"));
        else p.handleIceCandidate(data.value.toString("utf8"));
      }
      return;
    }
    if (id === PKT_CLIENT_SUCCESS) {
      const peer = readASCII8(buf, off);
      this.peers.get(peer.value);
      return;
    }
    if (id === PKT_CLIENT_FAILURE) {
      const peer = readASCII8(buf, off);
      this.peers.get(peer.value)?.disconnect();
      return;
    }
    if (id === PKT_DISCONNECT) {
      const peer = readASCII8(buf, off); off = peer.next;
      this.peers.get(peer.value)?.disconnect();
      return;
    }
    if (id === PKT_ERROR) {
      const code = buf[off++];
      const desc = readASCII16(buf, off);
      this.server.emit("log", { level: "warn", message: `Relay error ${code}: ${desc.value}` });
      return;
    }
  }

  parseIceServers(buf) {
    let off = 1;
    const count = buf.readUInt16BE(off); off += 2;
    const servers = [];
    for (let i = 0; i < count; i++) {
      const type = String.fromCharCode(buf[off++]);
      const address = readASCII16(buf, off); off = address.next;
      const username = readASCII8(buf, off); off = username.next;
      const password = readASCII8(buf, off); off = password.next;
      const server = { urls: address.value };
      if (type === "T") {
        server.username = username.value;
        server.credential = password.value;
      }
      servers.push(server);
    }
    return servers;
  }

  createPeer(id) {
    const peer = new WorldPeer(this, id);
    this.peers.set(id, peer);
    peer.create(this.iceServers);
    this.server.emit("peers");
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(payload); } catch (_) {}
    }
  }

  stop() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const peer of [...this.peers.values()]) peer.disconnect();
    this.peers.clear();
    try { this.ws?.close(); } catch (_) {}
    this.ws = null;
    this.ready = false;
    this.code = null;
  }
}

export class EaglerRelayServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.relayUrl = options.relayUrl || "";
    this.name = options.name || DEFAULT_WORLD_NAME;
    this.hidden = !!options.hidden;
    this.targetPort = Number(options.targetPort) || 25565;
    this.targetHost = String(options.targetHost || "").trim() || "127.0.0.1";
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.enableSelfTest = !!options.enableSelfTest;
    this.reconnectDelaySeconds = Math.min(Math.max(Number(options.reconnectDelaySeconds) || 10, 1), 300);
    this.rateLimitRetryDelaySeconds = Math.min(Math.max(Number(options.rateLimitRetryDelaySeconds) || 60, 5), 3600);
    this.websocketOrigin = String(options.websocketOrigin || "");
    this.proxyProtocol = !!options.proxyProtocol;
    this.skinsByName = new Map();
    this.namesByUuid = new Map();
    this.downloadedByUuid = new Map();
    this.rooms = [];
    this.running = false;
    this.room = null;
  }

  registerLoginSkin(raw, peer) {
    try {
      const pkt = readVarInt(raw, 0);
      if (pkt.value !== 0x00) return;
      const name = readMCString(raw, pkt.next);
      const username = name.value;
      peer.username = username;
      const skin = readVarInt(raw, name.next);
      if (skin.value <= 0 || skin.value > raw.length - skin.next) return;
      const skinPacket = Buffer.from(raw.subarray(skin.next, skin.next + skin.value));
      if (isMySkinPacket(skinPacket)) {
        this.skinsByName.set(username.toLowerCase(), skinPacket);
        this.emit("log", { level: "info", message: `Registered Eagler skin for ${username}` });
      }
    } catch (_) {}
  }

  handleSkinMessage(raw, peer) {
    try {
      const pkt = readVarInt(raw, 0);
      if (pkt.value !== 0x17 && pkt.value !== 0x3f) return;
      const channel = readMCString(raw, pkt.next);
      if (channel.value !== SKIN_CHANNEL) return;
      const data = raw.subarray(channel.next);
      if (data.length < 1) return;
      const type = data[0];
      if (type === 0x01 || type === 0x02) {
        if (peer.username && isMySkinPacket(data)) {
          this.skinsByName.set(peer.username.toLowerCase(), Buffer.from(data));
        }
        return;
      }
      if (type === 0x03 && data.length === 17) {
        const uuidHex = uuidHexFromBytes(data, 1);
        this.resolveSkin(peer, uuidHex, null);
        return;
      }
      if (type === 0x06 && data.length >= 20) {
        const uuidHex = uuidHexFromBytes(data, 1);
        const urlLen = data.readUInt16BE(17);
        if (urlLen > 0 && urlLen <= 1024 && data.length >= 19 + urlLen) {
          const url = data.toString("latin1", 19, 19 + urlLen);
          this.downloadSkin(peer, uuidHex, url);
        }
      }
    } catch (_) {}
  }

  resolveSkin(peer, uuidHex, forcedUrl) {
    const cached = this.downloadedByUuid.get(uuidHex);
    if (cached) {
      peer.sendLanPacket(buildPluginMessage(cached));
      return;
    }
    const name = this.namesByUuid.get(uuidHex);
    const skinPacket = name ? this.skinsByName.get(name.toLowerCase()) : null;
    if (isMySkinPacket(skinPacket)) {
      const payload = this.makeSkinResponse(uuidHex, skinPacket);
      if (payload) peer.sendLanPacket(buildPluginMessage(payload));
      return;
    }
    if (forcedUrl) {
      this.downloadSkin(peer, uuidHex, forcedUrl);
      return;
    }
    this.lookupMojangSkin(peer, uuidHex);
  }

  makeSkinResponse(uuidHex, skinPacket) {
    const uuid = Buffer.from(uuidHex, "hex");
    if (skinPacket[0] === 0x01) {
      const response = Buffer.alloc(21);
      response[0] = 0x04;
      uuid.copy(response, 1);
      response.writeUInt32BE(skinPacket.readUInt32BE(1) >>> 0, 17);
      return response;
    }
    if (skinPacket[0] === 0x02 && skinPacket.length === 16386) {
      const pixels = Buffer.from(skinPacket.subarray(2));
      setAlphaForChest(pixels);
      const response = Buffer.alloc(1 + 16 + 1 + 16384);
      response[0] = 0x05;
      uuid.copy(response, 1);
      response[17] = skinPacket[1] === 1 ? 1 : 0;
      pixels.copy(response, 18);
      return response;
    }
    return null;
  }

  async lookupMojangSkin(peer, uuidHex) {
    try {
      const resp = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuidHex}?unsigned=false`, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const json = await resp.json();
        const prop = Array.isArray(json.properties) && json.properties.find((p) => p.name === "textures");
        if (prop && prop.value) {
          const tex = JSON.parse(Buffer.from(prop.value, "base64").toString("utf8"));
          const skin = tex && tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
          if (skin) {
            await this.downloadSkin(peer, uuidHex, skin);
            return;
          }
        }
      }
    } catch (_) {}
    this.sendFallback(peer, uuidHex);
  }

  sendFallback(peer, uuidHex) {
    const uuid = Buffer.from(uuidHex, "hex");
    const response = Buffer.alloc(21);
    response[0] = 0x04;
    uuid.copy(response, 1);
    response.writeUInt32BE(fallbackPreset(uuidHex), 17);
    peer.sendLanPacket(buildPluginMessage(response));
  }

  async downloadSkin(peer, uuidHex, url) {
    try {
      if (!/^https?:\/\//i.test(url) || url.length > 1024) {
        this.sendFallback(peer, uuidHex);
        return;
      }
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) {
        this.sendFallback(peer, uuidHex);
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) {
        this.sendFallback(peer, uuidHex);
        return;
      }
      const pixels = decodeSkinPng(buf);
      if (!pixels) {
        this.sendFallback(peer, uuidHex);
        return;
      }
      const uuid = Buffer.from(uuidHex, "hex");
      const response = Buffer.alloc(1 + 16 + 1 + 16384);
      response[0] = 0x05;
      uuid.copy(response, 1);
      response[17] = 0;
      pixels.copy(response, 18);
      this.downloadedByUuid.set(uuidHex, response);
      peer.sendLanPacket(buildPluginMessage(response));
    } catch (_) {
      this.sendFallback(peer, uuidHex);
    }
  }

  rewritePlayerList(raw) {
    try {
      let off = 1;
      const action = readVarInt(raw, off);
      off = action.next;
      if (action.value !== 0) return raw;
      const count = readVarInt(raw, off);
      off = count.next;
      const pieces = [];
      let touched = false;
      for (let i = 0; i < count.value; i++) {
        if (off + 16 > raw.length) return raw;
        const uuid = raw.subarray(off, off + 16);
        const uuidHex = uuid.toString("hex");
        off += 16;
        const name = readMCString(raw, off);
        off = name.next;
        this.namesByUuid.set(uuidHex, name.value);
        pieces.push(uuid);
        pieces.push(writeMCString(name.value));
        const propCount = readVarInt(raw, off);
        off = propCount.next;
        const props = [];
        let hasEagler = false;
        for (let p = 0; p < propCount.value; p++) {
          const pName = readMCString(raw, off); off = pName.next;
          const pValue = readMCString(raw, off); off = pValue.next;
          const hasSig = raw[off++];
          let sig = null;
          if (hasSig !== 0) {
            const s = readMCString(raw, off); off = s.next;
            sig = s.value;
          }
          props.push({ name: pName.value, value: pValue.value, sig });
          if (pName.value === "isEaglerPlayer") hasEagler = true;
        }
        if (!hasEagler && this.skinsByName.has(name.value.toLowerCase())) {
          props.push({ name: "isEaglerPlayer", value: "true", sig: null });
          touched = true;
        }
        pieces.push(writeVarInt(props.length));
        for (const prop of props) {
          pieces.push(writeMCString(prop.name));
          pieces.push(writeMCString(prop.value));
          pieces.push(Buffer.from([prop.sig != null ? 1 : 0]));
          if (prop.sig != null) pieces.push(writeMCString(prop.sig));
        }
        const gm = readVarInt(raw, off); off = gm.next;
        pieces.push(writeVarInt(gm.value));
        const ping = readVarInt(raw, off); off = ping.next;
        pieces.push(writeVarInt(ping.value));
        const hasDisplay = raw[off++];
        pieces.push(Buffer.from([hasDisplay]));
        if (hasDisplay !== 0) {
          const display = readMCString(raw, off); off = display.next;
          pieces.push(writeMCString(display.value));
        }
      }
      if (!touched) return raw;
      return buildPlayerListPacket(action.value, count.value, pieces);
    } catch (_) {
      return raw;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.room = new WorldRoom(this);
    this.rooms = [this.room];
    this.room.connect();
  }

  getState() {
    const room = this.room;
    return {
      relayUrl: this.relayUrl,
      name: this.name,
      hidden: this.hidden,
      targetPort: this.targetPort,
      targetHost: this.targetHost,
      enableSelfTest: this.enableSelfTest,
      reconnectDelaySeconds: this.reconnectDelaySeconds,
      rateLimitRetryDelaySeconds: this.rateLimitRetryDelaySeconds,
      websocketOrigin: this.websocketOrigin,
      proxyProtocol: this.proxyProtocol,
      rooms: room ? [{ name: room.name, code: room.code, ready: room.ready, peers: room.peers.size }] : []
    };
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.room) this.room.stop();
    this.room = null;
    this.rooms = [];
    this.emit("state");
  }
}
