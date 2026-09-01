// Cloudflare Pages Functions - VLESS over WebSocket
// 修复版：修正协议解析、Socket API、响应头、订阅格式

import { connect } from "cloudflare:sockets";

// 明码 UUID
const UUID = "62bc5cd25eef4e12b9b324087eff5082";
const VLESS_VERSION = 0;
const CONNECTION_TIMEOUT = 30000; // 30秒连接超时
const READ_TIMEOUT = 120000;      // 120秒读取超时（代理场景不宜过短）

// 订阅配置
const SUBSCRIPTION_CONFIG = {
  nodeName: "VLESS-Proxy",
  wsPath: "/ws",
  security: "tls",
};

/**
 * 错误类型
 */
class VlessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VlessError";
    this.code = code;
  }
}

/**
 * 连接状态
 */
class ConnectionState {
  constructor() {
    this.address = "unknown";
    this.port = 0;
    this.startTime = Date.now();
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this.isConnected = false;
    this.isClosed = false;
    this.responseHeaderSent = false;
  }
  getDuration() {
    return Date.now() - this.startTime;
  }
  getStats() {
    return {
      address: this.address,
      port: this.port,
      duration: this.getDuration(),
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
    };
  }
}

/* ============================================================
 * 订阅链接生成
 * ============================================================ */

function generateVlessLink(hostname, port = 443) {
  const params = new URLSearchParams({
    encryption: "none",
    type: "ws",
    path: SUBSCRIPTION_CONFIG.wsPath,
    security: SUBSCRIPTION_CONFIG.security,
    sni: hostname,
    fp: "chrome",
  });
  return `vless://${UUID}@${hostname}:${port}?${params.toString()}#${encodeURIComponent(SUBSCRIPTION_CONFIG.nodeName)}`;
}

function generateBase64Subscription(hostname) {
  // 标准订阅格式：每行一个节点，整体 Base64
  const vlessLink = generateVlessLink(hostname);
  return btoa(vlessLink + "\n");
}

function generateClashSubscription(hostname) {
  return `proxies:
  - name: "${SUBSCRIPTION_CONFIG.nodeName}"
    type: vless
    server: ${hostname}
    port: 443
    uuid: ${UUID}
    network: ws
    udp: true
    tls: true
    servername: ${hostname}
    skip-cert-verify: false
    client-fingerprint: chrome
    ws-opts:
      path: ${SUBSCRIPTION_CONFIG.wsPath}
      headers:
        Host: ${hostname}

proxy-groups:
  - name: "Proxy"
    type: select
    proxies:
      - "${SUBSCRIPTION_CONFIG.nodeName}"

rules:
  - MATCH,Proxy
`;
}

/* ============================================================
 * 入口路由
 * ============================================================ */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const hostname = url.hostname;
  const pathname = url.pathname;

  try {
    if (pathname === "/" || pathname === "") {
      return handleIndexPage(hostname);
    }
    if (pathname === "/subscribe" || pathname === "/link") {
      return handleVlessLink(hostname);
    }
    if (pathname === "/sub" || pathname === "/subscription") {
      return handleBase64Subscription(hostname);
    }
    if (pathname === "/clash" || pathname === "/clash.yaml") {
      return handleClashSubscription(hostname);
    }

    // WebSocket：仅接受配置的路径
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      if (pathname !== SUBSCRIPTION_CONFIG.wsPath) {
        return new Response("Not Found", { status: 404 });
      }
      return handleWebSocket(request);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("[VLESS] Request error:", error.message);
    return new Response("Internal Server Error", { status: 500 });
  }
}

/* ============================================================
 * HTTP 订阅响应
 * ============================================================ */

function handleIndexPage(hostname) {
  const vlessLink = generateVlessLink(hostname);
  const base64Url = `https://${hostname}/sub`;
  const clashUrl = `https://${hostname}/clash`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS 代理订阅</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
        .container{background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:600px;width:100%;padding:40px}
        h1{color:#333;margin-bottom:10px;text-align:center}
        .subtitle{color:#666;text-align:center;margin-bottom:30px;font-size:14px}
        .subscription-list{display:flex;flex-direction:column;gap:12px}
        .subscription-item{display:flex;align-items:center;padding:16px;background:#f8f9fa;border-radius:8px;border-left:4px solid #667eea;transition:all .3s ease}
        .subscription-item:hover{background:#e9ecef;transform:translateX(4px)}
        .subscription-info{flex:1;display:flex;flex-direction:column;gap:4px}
        .subscription-title{font-weight:600;color:#333}
        .subscription-desc{font-size:13px;color:#666}
        .subscription-link{font-size:12px;color:#999;font-family:monospace;word-break:break-all}
        .copy-btn{padding:8px 16px;background:#667eea;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-left:12px;white-space:nowrap}
        .copy-btn:hover{background:#764ba2}
        .info-box{background:#e7f3ff;border-left:4px solid #2196F3;padding:16px;border-radius:4px;margin-top:20px;font-size:13px;color:#333;line-height:1.6}
        .info-box strong{color:#1976D2}
    </style>
</head>
<body>
    <div class="container">
        <h1>VLESS 代理订阅</h1>
        <p class="subtitle">选择一种订阅格式获取节点信息</p>
        <div class="subscription-list">
            <div class="subscription-item">
                <div class="subscription-info">
                    <div class="subscription-title">原始 VLESS 链接</div>
                    <div class="subscription-desc">直接复制粘贴到客户端</div>
                    <div class="subscription-link" id="link-url">${vlessLink}</div>
                </div>
                <button class="copy-btn" onclick="copyText('${vlessLink}')">复制</button>
            </div>
            <div class="subscription-item">
                <div class="subscription-info">
                    <div class="subscription-title">Base64 编码订阅</div>
                    <div class="subscription-desc">用于订阅管理器</div>
                    <div class="subscription-link" id="base64-url">${base64Url}</div>
                </div>
                <button class="copy-btn" onclick="copyText('${base64Url}')">复制</button>
            </div>
            <div class="subscription-item">
                <div class="subscription-info">
                    <div class="subscription-title">Clash YAML 配置</div>
                    <div class="subscription-desc">Clash / Stash / Shadowrocket 等客户端</div>
                    <div class="subscription-link" id="clash-url">${clashUrl}</div>
                </div>
                <button class="copy-btn" onclick="copyText('${clashUrl}')">复制</button>
            </div>
        </div>
        <div class="info-box">
            <strong>使用说明：</strong><br>
            • 原始链接：适合直接在客户端中添加节点<br>
            • Base64 订阅：用于订阅导入功能（地址：${base64Url}）<br>
            • Clash 配置：适合 Clash / Stash / Shadowrocket（地址：${clashUrl}）
        </div>
    </div>
    <script>
        function copyText(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('已复制到剪贴板！');
            }).catch(() => {
                alert('复制失败，请手动复制');
            });
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function handleVlessLink(hostname) {
  return new Response(generateVlessLink(hostname), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function handleBase64Subscription(hostname) {
  return new Response(generateBase64Subscription(hostname), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function handleClashSubscription(hostname) {
  return new Response(generateClashSubscription(hostname), {
    headers: { "Content-Type": "text/yaml; charset=utf-8" },
  });
}

/* ============================================================
 * WebSocket 处理
 * ============================================================ */

async function handleWebSocket(request) {
  try {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    handleConnection(server);
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    console.error("[VLESS] WebSocket init error:", error.message);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function handleConnection(ws) {
  const state = new ConnectionState();
  let remote = null;
  let vlessHeader = null;
  let isFirst = true;
  let readTimeout = null;
  let connectionTimeout = null;

  const log = (level, message, data = null) => {
    const entry = `[${level}] [${state.address}:${state.port}] [${state.getDuration()}ms] ${message}`;
    data ? console.log(entry, data) : console.log(entry);
  };

  const cleanup = () => {
    if (state.isClosed) return;
    state.isClosed = true;
    if (readTimeout) { clearTimeout(readTimeout); readTimeout = null; }
    if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
    if (remote) {
      try { remote.close(); } catch (e) { log("WARN", "close remote:", e.message); }
      remote = null;
    }
  };

  const resetReadTimeout = () => {
    if (readTimeout) clearTimeout(readTimeout);
    readTimeout = setTimeout(() => {
      log("WARN", "Read timeout");
      try { ws.close(1000, "Read timeout"); } catch (e) {}
      cleanup();
    }, READ_TIMEOUT);
  };

  ws.addEventListener("message", async (event) => {
    try {
      resetReadTimeout();
      const buffer = new Uint8Array(event.data);
      state.bytesReceived += buffer.length;

      if (isFirst) {
        isFirst = false;

        // 握手超时
        connectionTimeout = setTimeout(() => {
          log("ERROR", "Handshake timeout");
          try { ws.close(1011, "Handshake timeout"); } catch (e) {}
          cleanup();
        }, CONNECTION_TIMEOUT);

        // 解析 VLESS 头
        try {
          vlessHeader = parseVlessHeader(buffer);
        } catch (e) {
          log("ERROR", "Header parse failed:", e.message);
          try { ws.close(1002, "Invalid header"); } catch (e) {}
          cleanup();
          return;
        }

        // UUID 校验
        if (vlessHeader.uuid !== UUID) {
          log("ERROR", "UUID mismatch", { expected: UUID, received: vlessHeader.uuid });
          try { ws.close(1008, "Invalid UUID"); } catch (e) {}
          cleanup();
          return;
        }

        state.address = vlessHeader.address;
        state.port = vlessHeader.port;
        log("INFO", "Connecting to remote");

        // 建立远程 TCP 连接
        try {
          remote = new RemoteConnect();
          await remote.connect({
            hostname: vlessHeader.address,
            port: vlessHeader.port,
            timeout: CONNECTION_TIMEOUT,
          });
          state.isConnected = true;
          log("INFO", "Remote connected");
        } catch (e) {
          log("ERROR", "Remote connect failed:", e.message);
          try { ws.close(1011, "Connect failed"); } catch (e) {}
          cleanup();
          return;
        }

        if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }

        // 远程 -> WebSocket 管道
        remote.readable
          .pipeTo(
            new WritableStream({
              write(chunk) {
                try {
                  state.bytesSent += chunk.length;
                  if (!state.responseHeaderSent) {
                    // 首包前置 VLESS 响应头（2字节）
                    const resp = new Uint8Array(vlessHeader.responseHeader.length + chunk.length);
                    resp.set(vlessHeader.responseHeader, 0);
                    resp.set(chunk, vlessHeader.responseHeader.length);
                    ws.send(resp);
                    state.responseHeaderSent = true;
                  } else {
                    ws.send(chunk);
                  }
                } catch (e) {
                  log("ERROR", "WS write error:", e.message);
                  throw e;
                }
              },
              close() {
                log("INFO", "Remote closed");
                try { ws.close(1000); } catch (e) {}
                cleanup();
              },
              abort(reason) {
                log("WARN", "Remote aborted:", reason?.message || "unknown");
                try { ws.close(1011); } catch (e) {}
                cleanup();
              },
            })
          )
          .catch((e) => {
            log("ERROR", "Pipe error:", e.message);
            try { ws.close(1011); } catch (e) {}
            cleanup();
          });

        // 发送首包中 VLESS 头之后的剩余数据
        if (buffer.length > vlessHeader.headerLength) {
          const remaining = buffer.slice(vlessHeader.headerLength);
          try { await remote.write(remaining); } catch (e) {
            log("ERROR", "Initial write failed:", e.message);
            cleanup();
          }
        }
      } else {
        // 后续数据直接转发
        if (!remote) {
          log("ERROR", "Remote not available");
          try { ws.close(1011); } catch (e) {}
          cleanup();
          return;
        }
        try {
          await remote.write(buffer);
        } catch (e) {
          log("ERROR", "Forward failed:", e.message);
          try { ws.close(1011); } catch (e) {}
          cleanup();
        }
      }
    } catch (e) {
      log("ERROR", "Message handler error:", e.message);
      try { ws.close(1011); } catch (e) {}
      cleanup();
    }
  });

  ws.addEventListener("close", () => {
    const s = state.getStats();
    log("INFO", `Connection closed (↓${s.bytesReceived}B ↑${s.bytesSent}B)`);
    cleanup();
  });

  ws.addEventListener("error", (e) => {
    log("ERROR", "WS error:", e.message);
    cleanup();
  });
}

/* ============================================================
 * VLESS 协议头解析（已修正 Command 字节）
 *
 * 结构：版本(1) + UUID(16) + 附加信息长度(1) + 附加信息(N)
 *      + 命令(1) + 端口(2) + 地址类型(1) + 地址
 * ============================================================ */

function parseVlessHeader(buffer) {
  // 最小长度：1+16+1+0+1+2+1 = 22（地址部分另算）
  if (buffer.length < 22) {
    throw new VlessError("Buffer too short", "BUFFER_TOO_SHORT");
  }

  let offset = 0;

  // 版本
  const version = buffer[offset++];
  if (version !== VLESS_VERSION) {
    throw new VlessError(`Unsupported version: ${version}`, "UNSUPPORTED_VERSION");
  }

  // UUID (16字节)
  if (offset + 16 > buffer.length) throw new VlessError("UUID truncated", "BUFFER_TOO_SHORT");
  const uuid = Array.from(buffer.slice(offset, offset + 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  offset += 16;

  // 附加信息长度
  if (offset >= buffer.length) throw new VlessError("Addons len truncated", "BUFFER_TOO_SHORT");
  const addonsLen = buffer[offset++];
  if (addonsLen > 255) throw new VlessError(`Invalid addons len: ${addonsLen}`, "INVALID_ADDONS_LEN");
  if (offset + addonsLen > buffer.length) throw new VlessError("Addons truncated", "BUFFER_TOO_SHORT");
  offset += addonsLen; // 跳过附加信息（vision flow 等，本实现不支持）

  // 命令（1字节）—— 原代码漏掉的字段
  if (offset >= buffer.length) throw new VlessError("Command truncated", "BUFFER_TOO_SHORT");
  const command = buffer[offset++];
  // 0x01=TCP, 0x02=UDP, 0x03=MUX；本实现仅支持 TCP
  if (command !== 0x01) {
    throw new VlessError(`Unsupported command: ${command}`, "UNSUPPORTED_COMMAND");
  }

  // 端口（大端序，2字节）
  if (offset + 2 > buffer.length) throw new VlessError("Port truncated", "BUFFER_TOO_SHORT");
  const port = (buffer[offset] << 8) | buffer[offset + 1];
  offset += 2;
  if (port < 1 || port > 65535) throw new VlessError(`Invalid port: ${port}`, "INVALID_PORT");

  // 地址类型
  if (offset >= buffer.length) throw new VlessError("Addr type truncated", "BUFFER_TOO_SHORT");
  const addrType = buffer[offset++];

  let address = "";
  if (addrType === 0x01) {
    // IPv4
    if (offset + 4 > buffer.length) throw new VlessError("IPv4 truncated", "BUFFER_TOO_SHORT");
    address = Array.from(buffer.slice(offset, offset + 4)).join(".");
    offset += 4;
  } else if (addrType === 0x02) {
    // 域名
    if (offset >= buffer.length) throw new VlessError("Domain len truncated", "BUFFER_TOO_SHORT");
    const domainLen = buffer[offset++];
    if (domainLen === 0 || domainLen > 255) throw new VlessError(`Invalid domain len: ${domainLen}`, "INVALID_DOMAIN_LEN");
    if (offset + domainLen > buffer.length) throw new VlessError("Domain truncated", "BUFFER_TOO_SHORT");
    address = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
    offset += domainLen;
  } else if (addrType === 0x03) {
    // IPv6
    if (offset + 16 > buffer.length) throw new VlessError("IPv6 truncated", "BUFFER_TOO_SHORT");
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(
        buffer[offset + i].toString(16).padStart(2, "0") +
        buffer[offset + i + 1].toString(16).padStart(2, "0")
      );
    }
    address = parts.join(":");
    offset += 16;
  } else {
    throw new VlessError(`Unsupported addr type: ${addrType}`, "UNSUPPORTED_ADDR_TYPE");
  }

  if (!address) throw new VlessError("Empty address", "EMPTY_ADDRESS");

  // 响应头：版本(1) + 附加信息长度(1) = 2字节（原代码多写了1字节）
  const responseHeader = new Uint8Array([version, 0]);

  return { uuid, address, port, headerLength: offset, responseHeader };
}

/* ============================================================
 * 远程 TCP 连接（使用 Cloudflare 官方 Socket API）
 * ============================================================ */

class RemoteConnect {
  constructor() {
    this.socket = null;
    this.readable = null;
    this.writable = null;
    this._writer = null;
  }

  async connect({ hostname, port, timeout = CONNECTION_TIMEOUT }) {
    this.socket = connect({ hostname, port });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Connection timeout")), timeout)
    );

    await Promise.race([this.socket.opened, timeoutPromise]);

    this.readable = this.socket.readable;
    this.writable = this.socket.writable;
    this._writer = this.writable.getWriter();
  }

  async write(data) {
    if (!this._writer) throw new VlessError("Not connected", "NOT_CONNECTED");
    await this._writer.write(data);
  }

  close() {
    if (this._writer) {
      try { this._writer.releaseLock(); } catch (e) {}
      this._writer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
  }
                  }
