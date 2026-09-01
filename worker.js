// Cloudflare Pages Functions - VLESS over WebSocket
// Production-optimized version with enhanced security, error handling, and validation

// 明码 UUID
const UUID = '62bc5cd25eef4e12b9b324087eff5082';
const VLESS_VERSION = 0;
const CONNECTION_TIMEOUT = 30000; // 30秒连接超时
const READ_TIMEOUT = 60000; // 60秒读取超时
const KEEPALIVE_INTERVAL = 25000; // 25秒心跳间隔

// 订阅配置
const SUBSCRIPTION_CONFIG = {
  nodeName: 'VLESS-Proxy',
  wsPath: '/ws',
  security: 'tls',
};

/**
 * 错误类型定义
 */
class VlessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VlessError';
    this.code = code;
  }
}

/**
 * 连接状态管理
 */
class ConnectionState {
  constructor() {
    this.address = 'unknown';
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

/**
 * 生成 VLESS 订阅链接
 */
function generateVlessLink(hostname, port = 443) {
  const vlessUrl = `vless://${UUID}@${hostname}:${port}?path=${SUBSCRIPTION_CONFIG.wsPath}&security=${SUBSCRIPTION_CONFIG.security}&type=ws#${SUBSCRIPTION_CONFIG.nodeName}`;
  return vlessUrl;
}

/**
 * 生成 Base64 编码的订阅内容
 */
function generateBase64Subscription(hostname) {
  const vlessLink = generateVlessLink(hostname);
  return btoa(vlessLink); // Base64 编码
}

/**
 * 生成 Clash 格式的订阅
 */
function generateClashSubscription(hostname) {
  const vlessLink = generateVlessLink(hostname);
  const clashConfig = `proxies:
  - name: "${SUBSCRIPTION_CONFIG.nodeName}"
    type: vless
    server: ${hostname}
    port: 443
    uuid: ${UUID}
    network: ws
    ws-opts:
      path: ${SUBSCRIPTION_CONFIG.wsPath}
    tls: true

proxy-groups:
  - name: "Proxy"
    type: select
    proxies:
      - "${SUBSCRIPTION_CONFIG.nodeName}"

rules:
  - MATCH,Proxy
`;
  return clashConfig;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const hostname = url.hostname;
  const pathname = url.pathname;

  // 路由处理
  try {
    // 订阅列表页面
    if (pathname === '/' || pathname === '') {
      return handleIndexPage(hostname);
    }

    // 获取原始 VLESS 链接
    if (pathname === '/subscribe' || pathname === '/link') {
      return handleVlessLink(hostname);
    }

    // 获取 Base64 编码的订阅
    if (pathname === '/sub' || pathname === '/subscription') {
      return handleBase64Subscription(hostname);
    }

    // 获取 Clash 格式订阅
    if (pathname === '/clash' || pathname === '/clash.yaml') {
      return handleClashSubscription(hostname);
    }

    // WebSocket 连接处理（原有逻辑）
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return handleWebSocket(request, context);
    }

    // 404 处理
    return new Response('Not Found', { status: 404 });
  } catch (error) {
    console.error('[VLESS] Request handling error:', error.message);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * 处理首页 - 显示可用的订阅格式
 */
function handleIndexPage(hostname) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS 代理订阅</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 600px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            text-align: center;
        }
        .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .subscription-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .subscription-item {
            display: flex;
            align-items: center;
            padding: 16px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #667eea;
            transition: all 0.3s ease;
        }
        .subscription-item:hover {
            background: #e9ecef;
            transform: translateX(4px);
        }
        .subscription-info {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .subscription-title {
            font-weight: 600;
            color: #333;
        }
        .subscription-desc {
            font-size: 13px;
            color: #666;
        }
        .subscription-link {
            font-size: 12px;
            color: #999;
            font-family: monospace;
            word-break: break-all;
        }
        .copy-btn {
            padding: 8px 16px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.3s ease;
            margin-left: 12px;
            white-space: nowrap;
        }
        .copy-btn:hover {
            background: #764ba2;
        }
        .info-box {
            background: #e7f3ff;
            border-left: 4px solid #2196F3;
            padding: 16px;
            border-radius: 4px;
            margin-top: 20px;
            font-size: 13px;
            color: #333;
            line-height: 1.6;
        }
        .info-box strong {
            color: #1976D2;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 VLESS 代理订阅</h1>
        <p class="subtitle">选择一种订阅格式获取节点信息</p>

        <div class="subscription-list">
            <div class="subscription-item" id="link-item">
                <div class="subscription-info">
                    <div class="subscription-title">原始 VLESS 链接</div>
                    <div class="subscription-desc">直接复制粘贴到客户端</div>
                    <div class="subscription-link" id="link-url"></div>
                </div>
                <button class="copy-btn" onclick="copyToClipboard('link-text')">复制</button>
            </div>

            <div class="subscription-item" id="base64-item">
                <div class="subscription-info">
                    <div class="subscription-title">Base64 编码订阅</div>
                    <div class="subscription-desc">用于订阅管理器</div>
                    <div class="subscription-link" id="base64-url"></div>
                </div>
                <button class="copy-btn" onclick="copyToClipboard('base64-text')">复制</button>
            </div>

            <div class="subscription-item" id="clash-item">
                <div class="subscription-info">
                    <div class="subscription-title">Clash YAML 配置</div>
                    <div class="subscription-desc">Clash/Stash 等客户端使用</div>
                    <div class="subscription-link" id="clash-url"></div>
                </div>
                <button class="copy-btn" onclick="copyToClipboard('clash-text')">复制</button>
            </div>
        </div>

        <div class="info-box">
            <strong>📋 使用说明：</strong><br>
            • <strong>原始链接：</strong>适合直接在客户端中添加节点<br>
            • <strong>Base64 订阅：</strong>用于订阅导入功能<br>
            • <strong>Clash 配置：</strong>适合 Clash/Stash/Shadowrocket 等客户端<br>
        </div>
    </div>

    <script>
        const hostname = '${hostname}';
        const port = 443;
        const uuid = '${UUID}';
        const wsPath = '${SUBSCRIPTION_CONFIG.wsPath}';

        // 生成链接
        const vlessLink = \`vless://\${uuid}@\${hostname}:\${port}?path=\${wsPath}&security=tls&type=ws#VLESS-Proxy\`;
        const base64Url = \`https://\${hostname}/sub\`;
        const clashUrl = \`https://\${hostname}/clash\`;

        // 填充链接
        document.getElementById('link-url').textContent = vlessLink;
        document.getElementById('base64-url').textContent = base64Url;
        document.getElementById('clash-url').textContent = clashUrl;

        // 复制到剪贴板
        function copyToClipboard(type) {
            let text = '';
            if (type === 'link-text') {
                text = vlessLink;
            } else if (type === 'base64-text') {
                text = base64Url;
            } else if (type === 'clash-text') {
                text = clashUrl;
            }
            
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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * 处理原始 VLESS 链接请求
 */
function handleVlessLink(hostname) {
  const vlessLink = generateVlessLink(hostname);
  return new Response(vlessLink, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
  });
}

/**
 * 处理 Base64 编码的订阅请求
 */
function handleBase64Subscription(hostname) {
  const base64Sub = generateBase64Subscription(hostname);
  return new Response(base64Sub, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
  });
}

/**
 * 处理 Clash 格式的订阅请求
 */
function handleClashSubscription(hostname) {
  const clashConfig = generateClashSubscription(hostname);
  return new Response(clashConfig, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
  });
}

/**
 * 处理 WebSocket 连接
 */
async function handleWebSocket(request, context) {
  try {
    // 验证连接来源（可选的额外安全性）
    const origin = request.headers.get('Origin');
    if (origin) {
      console.log(`[VLESS] Connection from origin: ${origin}`);
    }

    // 创建 WebSocket 对
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // 接受连接并处理
    server.accept();
    handleConnection(server, context);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (error) {
    console.error('[VLESS] WebSocket initialization error:', error.message);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * 处理 WebSocket 连接
 */
async function handleConnection(ws, context) {
  const state = new ConnectionState();
  let remoteSocket = null;
  let vlessHeader = null;
  let isFirst = true;
  let keepaliveInterval = null;
  let readTimeout = null;
  let connectionTimeout = null;

  const log = (level, message, data = null) => {
    const duration = state.getDuration();
    const logEntry = `[${level}] [${state.address}:${state.port}] [${duration}ms] ${message}`;
    if (data) {
      console.log(logEntry, data);
    } else {
      console.log(logEntry);
    }
  };

  /**
   * 清理资源
   */
  const cleanup = () => {
    if (state.isClosed) return;
    state.isClosed = true;

    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    if (readTimeout) {
      clearTimeout(readTimeout);
      readTimeout = null;
    }
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    if (remoteSocket) {
      try {
        remoteSocket.close();
      } catch (e) {
        log('WARN', 'Error closing remote socket', e.message);
      }
      remoteSocket = null;
    }
  };

  /**
   * 重置读取超时
   */
  const resetReadTimeout = () => {
    if (readTimeout) clearTimeout(readTimeout);
    readTimeout = setTimeout(() => {
      log('WARN', 'Read timeout, closing connection');
      ws.close(1000, 'Read timeout');
      cleanup();
    }, READ_TIMEOUT);
  };

  /**
   * 设置心跳保活
   */
  const setupKeepalive = () => {
    keepaliveInterval = setInterval(() => {
      try {
        // 发送空心跳帧保持连接活跃
        if (state.isConnected && !state.isClosed) {
          ws.send(new Uint8Array(0));
        }
      } catch (e) {
        log('WARN', 'Keepalive error', e.message);
      }
    }, KEEPALIVE_INTERVAL);
  };

  // WebSocket 消息处理
  ws.addEventListener('message', async (event) => {
    try {
      resetReadTimeout();

      const buffer = new Uint8Array(event.data);
      state.bytesReceived += buffer.length;

      if (isFirst) {
        isFirst = false;

        // 设置连接超时
        connectionTimeout = setTimeout(() => {
          log('ERROR', 'Connection timeout during VLESS handshake');
          ws.close(1011, 'Handshake timeout');
          cleanup();
        }, CONNECTION_TIMEOUT);

        // 解析和验证 VLESS 头
        try {
          vlessHeader = parseVlessHeader(buffer);
        } catch (e) {
          log('ERROR', 'Header parsing failed', e.message);
          ws.close(1002, 'Invalid VLESS header');
          cleanup();
          return;
        }

        // UUID 验证
        if (vlessHeader.uuid !== UUID) {
          log('ERROR', 'UUID verification failed', {
            expected: UUID,
            received: vlessHeader.uuid,
          });
          ws.close(1008, 'Invalid UUID');
          cleanup();
          return;
        }

        state.address = vlessHeader.address;
        state.port = vlessHeader.port;

        log('INFO', 'Connecting to remote server');

        // 创建远程连接
        try {
          remoteSocket = new Connect();
          await remoteSocket.connect({
            hostname: vlessHeader.address,
            port: vlessHeader.port,
            timeout: CONNECTION_TIMEOUT,
          });
          log('INFO', 'Remote server connected');
          state.isConnected = true;

          // 清除连接超时
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }

          // 启动心跳保活
          setupKeepalive();
        } catch (e) {
          log('ERROR', 'Failed to connect remote server', e.message);
          ws.close(1011, 'Failed to connect remote server');
          cleanup();
          return;
        }

        // 管道化远程响应到 WebSocket
        try {
          remoteSocket.readable
            .pipeTo(
              new WritableStream({
                write: (chunk) => {
                  try {
                    state.bytesSent += chunk.length;

                    // 第一个响应包含 VLESS 响应头
                    if (!state.responseHeaderSent && vlessHeader.responseHeader) {
                      const responseData = new Uint8Array(
                        vlessHeader.responseHeader.length + chunk.length
                      );
                      responseData.set(vlessHeader.responseHeader, 0);
                      responseData.set(chunk, vlessHeader.responseHeader.length);
                      ws.send(responseData);
                      state.responseHeaderSent = true;
                    } else {
                      ws.send(chunk);
                    }
                  } catch (e) {
                    log('ERROR', 'Error writing to WebSocket', e.message);
                    throw e;
                  }
                },
                close: () => {
                  log('INFO', 'Remote connection closed');
                  ws.close(1000);
                  cleanup();
                },
                abort: (reason) => {
                  log('WARN', 'Remote connection aborted', reason?.message || 'Unknown reason');
                  ws.close(1011);
                  cleanup();
                },
              })
            )
            .catch((e) => {
              log('ERROR', 'Pipe error', e.message);
              ws.close(1011);
              cleanup();
            });
        } catch (e) {
          log('ERROR', 'Pipeline setup error', e.message);
          ws.close(1011);
          cleanup();
          return;
        }

        // 发送 VLESS 头之后的数据
        if (buffer.length > vlessHeader.headerLength) {
          const remainingData = buffer.slice(vlessHeader.headerLength);
          try {
            await remoteSocket.write(remainingData);
          } catch (e) {
            log('ERROR', 'Failed to write initial data', e.message);
            ws.close(1011);
            cleanup();
          }
        }
      } else {
        // 后续消息直接转发
        if (!remoteSocket) {
          log('ERROR', 'Remote socket not available');
          ws.close(1011);
          cleanup();
          return;
        }

        try {
          await remoteSocket.write(buffer);
        } catch (e) {
          log('ERROR', 'Failed to forward data', e.message);
          ws.close(1011);
          cleanup();
        }
      }
    } catch (e) {
      log('ERROR', 'WebSocket message handling error', e.message);
      ws.close(1011);
      cleanup();
    }
  });

  ws.addEventListener('close', () => {
    const stats = state.getStats();
    log(
      'INFO',
      `Connection closed (↓${stats.bytesReceived}B ↑${stats.bytesSent}B)`,
      stats
    );
    cleanup();
  });

  ws.addEventListener('error', (e) => {
    log('ERROR', 'WebSocket error', e.message);
    cleanup();
  });
}

/**
 * 解析 VLESS 协议头
 * 格式: [版本(1B)][UUID(16B)][加密方式长度(1B)][加密方式][端口(2B)][地址类型(1B)][地址][?长度(1B)][?数据]
 */
function parseVlessHeader(buffer) {
  // 最小长度检查：1(版本) + 16(UUID) + 1(加密方式长度) + 2(端口) + 1(地址类型) = 21
  if (buffer.length < 21) {
    throw new VlessError('Buffer too short, invalid VLESS header', 'BUFFER_TOO_SHORT');
  }

  let offset = 0;

  // 读取版本
  const version = buffer[offset++];
  if (version !== VLESS_VERSION) {
    throw new VlessError(`Unsupported VLESS version: ${version}`, 'UNSUPPORTED_VERSION');
  }

  // 读取 UUID (16字节)
  if (offset + 16 > buffer.length) {
    throw new VlessError('Buffer too short to read UUID', 'BUFFER_TOO_SHORT');
  }
  const uuidBytes = buffer.slice(offset, offset + 16);
  offset += 16;
  const uuid = Array.from(uuidBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toLowerCase();

  // 读取加密方式长度
  if (offset >= buffer.length) {
    throw new VlessError('Buffer too short to read cipher length', 'BUFFER_TOO_SHORT');
  }
  const cipherLen = buffer[offset++];
  if (cipherLen > 16) {
    throw new VlessError(`Cipher length too long: ${cipherLen}`, 'INVALID_CIPHER_LEN');
  }

  // 跳过加密方式数据
  if (offset + cipherLen > buffer.length) {
    throw new VlessError('Buffer too short to read cipher', 'BUFFER_TOO_SHORT');
  }
  offset += cipherLen;

  // 读取端口 (大端序，2字节)
  if (offset + 2 > buffer.length) {
    throw new VlessError('Buffer too short to read port', 'BUFFER_TOO_SHORT');
  }
  const port = (buffer[offset] << 8) | buffer[offset + 1];
  offset += 2;

  if (port < 1 || port > 65535) {
    throw new VlessError(`Invalid port number: ${port}`, 'INVALID_PORT');
  }

  // 读取地址类型
  if (offset >= buffer.length) {
    throw new VlessError('Buffer too short to read address type', 'BUFFER_TOO_SHORT');
  }
  const addrType = buffer[offset++];

  let address = '';
  let headerLength = 0;

  // 根据地址类型解析地址
  if (addrType === 1) {
    // IPv4 (4字节)
    if (offset + 4 > buffer.length) {
      throw new VlessError('Buffer too short to read IPv4 address', 'BUFFER_TOO_SHORT');
    }
    address = Array.from(buffer.slice(offset, offset + 4)).join('.');
    offset += 4;
    headerLength = offset;
  } else if (addrType === 2) {
    // 域名 (1字节长度 + 域名数据)
    if (offset >= buffer.length) {
      throw new VlessError('Buffer too short to read domain length', 'BUFFER_TOO_SHORT');
    }
    const domainLen = buffer[offset++];

    if (domainLen === 0 || domainLen > 255) {
      throw new VlessError(`Invalid domain length: ${domainLen}`, 'INVALID_DOMAIN_LEN');
    }

    if (offset + domainLen > buffer.length) {
      throw new VlessError('Buffer too short to read domain', 'BUFFER_TOO_SHORT');
    }

    address = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
    offset += domainLen;
    headerLength = offset;
  } else if (addrType === 3) {
    // IPv6 (16字节)
    if (offset + 16 > buffer.length) {
      throw new VlessError('Buffer too short to read IPv6 address', 'BUFFER_TOO_SHORT');
    }
    const ipv6Parts = [];
    for (let i = 0; i < 16; i += 2) {
      ipv6Parts.push(
        buffer[offset + i].toString(16).padStart(2, '0') +
          buffer[offset + i + 1].toString(16).padStart(2, '0')
      );
    }
    address = ipv6Parts.join(':');
    offset += 16;
    headerLength = offset;
  } else {
    throw new VlessError(`Unsupported address type: ${addrType}`, 'UNSUPPORTED_ADDR_TYPE');
  }

  // 验证地址
  if (!address || address.length === 0) {
    throw new VlessError('Empty address', 'EMPTY_ADDRESS');
  }

  // 构建响应头：[版本(1B)][命令(1B)][长度(1B)]
  // 根据 VLESS 协议，响应头应该包含版本、命令和后续数据长度
  const responseHeader = new Uint8Array([version, 0, 0]);

  return {
    uuid,
    address,
    port,
    headerLength,
    responseHeader,
  };
}

/**
 * Connect 类：管理远程 TCP 连接
 */
class Connect {
  constructor() {
    this.writable = null;
    this.readable = null;
    this.socket = null;
  }

  /**
   * 连接到远程服务器
   */
  async connect(options) {
    try {
      const { hostname, port, timeout = CONNECTION_TIMEOUT } = options;

      this.socket = new Socket({
        hostname,
        port,
      });

      // 设置连接超时
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), timeout)
      );

      // 等待连接打开
      const openedPromise = this.socket.opened ? Promise.resolve(this.socket.opened) : Promise.resolve();

      await Promise.race([openedPromise, timeoutPromise]);

      this.readable = this.socket.readable;
      this.writable = this.socket.writable;

      // 监听关闭事件
      if (this.socket.closed) {
        this.socket.closed.catch((e) => {
          // 连接已关闭，无需处理
        });
      }
    } catch (error) {
      throw new VlessError(`Connection failed: ${error.message}`, 'CONNECT_FAILED');
    }
  }

  /**
   * 写入数据到远程服务器
   */
  async write(data) {
    if (!this.writable) {
      throw new VlessError('Writable stream not available', 'WRITABLE_UNAVAILABLE');
    }

    try {
      const writer = this.writable.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    } catch (error) {
      throw new VlessError(`Write failed: ${error.message}`, 'WRITE_FAILED');
    }
  }

  /**
   * 关闭连接
   */
  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // 关闭时出错，忽略
      }
    }
  }
}
