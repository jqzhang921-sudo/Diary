/**
 * 信匣 / dairy-mcp — 一个私人日记 MCP server。
 *
 * 四个工具：
 *   write_diary   写一篇日记
 *   read_diary    翻日记（按日期范围 / 关键词搜）
 *   leave_letter  留一封信给主人
 *   read_letters  读之前留下的信
 *
 * 传输方式是 Streamable HTTP（无状态模式），可以直接加成 claude.ai 的自定义连接器。
 * 鉴权靠 URL 里的密钥路径：/mcp/<MCP_SECRET>
 *
 * 存储有两套后端，按环境变量自动选：
 *   配了 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → 存 Upstash Redis
 *   没配 → 存本地文件 DATA_DIR/diary.json（本地开发用；Render 免费版重启会丢）
 */

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.MCP_SECRET || '';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai';
const DATA_DIR = resolve(process.env.DATA_DIR || './data');
const MAX_BODY_BYTES = 1_000_000;

const ENTRIES_KEY = 'dairy:entries';
const LETTERS_KEY = 'dairy:letters';

// ---------------------------------------------------------------- 存储

/**
 * 两个后端都实现 load(key) / save(key, array)。
 * Redis 那边 @upstash/redis 会自动 JSON 序列化/反序列化。
 */
function makeStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    // 动态 import：没配 Upstash 时不去加载这个包
    const clientPromise = import('@upstash/redis').then(
      ({ Redis }) => new Redis({ url, token })
    );
    return {
      kind: 'upstash-redis',
      async load(key) {
        const redis = await clientPromise;
        const value = await redis.get(key);
        return Array.isArray(value) ? value : [];
      },
      async save(key, list) {
        const redis = await clientPromise;
        await redis.set(key, list);
      },
    };
  }

  return {
    kind: 'local-file',
    async load(key) {
      try {
        const raw = await readFile(join(DATA_DIR, `${key.replace(/:/g, '-')}.json`), 'utf8');
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value : [];
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async save(key, list) {
      const target = join(DATA_DIR, `${key.replace(/:/g, '-')}.json`);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
      await rename(tmp, target); // 原子替换，写一半断电不会留下坏文件
    },
  };
}

const store = makeStore();

// ---------------------------------------------------------------- 日期

/**
 * 当天日期，按 TIMEZONE 算而不是按服务器时区。
 * Render 跑在 UTC 上，北京时间凌晨一点写的日记否则会被记成前一天。
 */
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // en-CA 输出就是 YYYY-MM-DD
}

function nowLocal() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- 工具

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

function buildMcpServer() {
  const server = new McpServer(
    { name: 'dairy', version: '1.0.0' },
    {
      instructions:
        '这是主人的私人日记本。write_diary 记日记，read_diary 翻旧日记，' +
        'leave_letter 给主人留一封信，read_letters 读之前留下的信。' +
        '涉及日记内容时优先查一下这里，而不是凭记忆猜。',
    }
  );

  server.registerTool(
    'write_diary',
    {
      title: '写日记',
      description:
        '往日记本里写一篇日记。date 不填就记成今天（按 ' +
        TIMEZONE +
        ' 的日期）。同一天可以写多篇。',
      inputSchema: {
        content: z.string().min(1).describe('日记正文'),
        date: z.string().regex(DATE_RE).optional().describe('这篇日记对应的日子，YYYY-MM-DD'),
        mood: z.string().optional().describe('心情，一两个词，可不填'),
      },
    },
    async ({ content, date, mood }) => {
      const entries = await store.load(ENTRIES_KEY);
      const entry = {
        id: randomUUID(),
        date: date || today(),
        content,
        mood: mood || null,
        createdAt: new Date().toISOString(),
      };
      entries.push(entry);
      entries.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
      await store.save(ENTRIES_KEY, entries);
      return text(`已记下 ${entry.date} 的日记（第 ${entries.length} 篇）。`);
    }
  );

  server.registerTool(
    'read_diary',
    {
      title: '翻日记',
      description:
        '翻日记本。可以按日期范围（from/to）筛，或者用 query 搜正文关键词。' +
        '都不填就返回最近的几篇。',
      inputSchema: {
        query: z.string().optional().describe('在日记正文里搜这个词'),
        from: z.string().regex(DATE_RE).optional().describe('起始日期 YYYY-MM-DD（含）'),
        to: z.string().regex(DATE_RE).optional().describe('结束日期 YYYY-MM-DD（含）'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回几篇，默认 10'),
      },
    },
    async ({ query, from, to, limit }) => {
      const entries = await store.load(ENTRIES_KEY);
      const needle = query?.toLowerCase();

      let hits = entries.filter((e) => {
        if (from && e.date < from) return false;
        if (to && e.date > to) return false;
        if (needle && !e.content.toLowerCase().includes(needle)) return false;
        return true;
      });

      const total = hits.length;
      hits = hits.slice(-(limit ?? 10)); // 取最近的 N 篇

      if (total === 0) {
        return text(
          entries.length === 0 ? '日记本还是空的，一篇都没有。' : '这个条件下没找到日记。'
        );
      }

      const body = hits
        .map((e) => {
          const head = e.mood ? `【${e.date}·${e.mood}】` : `【${e.date}】`;
          return `${head}\n${e.content}`;
        })
        .join('\n\n');

      const header =
        total > hits.length
          ? `共 ${total} 篇符合条件，下面是最近 ${hits.length} 篇：\n\n`
          : `共 ${total} 篇：\n\n`;

      return text(header + body);
    }
  );

  server.registerTool(
    'leave_letter',
    {
      title: '留一封信',
      description:
        '给主人留一封信，主人下次会看到。适合读完日记想说点什么、' +
        '或者想留个只有下次才会被发现的小话的时候用。',
      inputSchema: {
        content: z.string().min(1).describe('信的内容'),
        title: z.string().optional().describe('信的标题，可不填'),
      },
    },
    async ({ content, title }) => {
      const letters = await store.load(LETTERS_KEY);
      letters.push({
        id: randomUUID(),
        title: title || null,
        content,
        createdAt: new Date().toISOString(),
        writtenAtLocal: nowLocal(),
        openedAt: null,
      });
      await store.save(LETTERS_KEY, letters);
      const unread = letters.filter((l) => !l.openedAt).length;
      return text(`信放进匣子里了。现在有 ${unread} 封还没被读过。`);
    }
  );

  server.registerTool(
    'read_letters',
    {
      title: '读信',
      description:
        '读匣子里的信。默认只返回还没读过的；读过之后会被标记，' +
        'include_read 设为 true 可以把读过的也翻出来。',
      inputSchema: {
        include_read: z.boolean().optional().describe('是否也返回已经读过的信，默认 false'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回几封，默认 10'),
      },
    },
    async ({ include_read, limit }) => {
      const letters = await store.load(LETTERS_KEY);
      let hits = include_read ? letters : letters.filter((l) => !l.openedAt);
      const total = hits.length;
      hits = hits.slice(-(limit ?? 10));

      if (total === 0) {
        return text(include_read ? '匣子是空的，还没有信。' : '没有未读的信。');
      }

      const body = hits
        .map((l) => {
          const when = l.writtenAtLocal || l.createdAt;
          const head = l.title ? `${when} · ${l.title}` : when;
          return `—— ${head} ——\n${l.content}`;
        })
        .join('\n\n');

      // 标记为已读。这里改的是 letters 里的同一批对象，直接整体存回去。
      const stamp = new Date().toISOString();
      let touched = false;
      for (const l of hits) {
        if (!l.openedAt) {
          l.openedAt = stamp;
          touched = true;
        }
      }
      if (touched) await store.save(LETTERS_KEY, letters);

      return text(`${total} 封：\n\n${body}`);
    }
  );

  return server;
}

// ---------------------------------------------------------------- HTTP

/** 定长比较，避免用 === 比密钥时泄露前缀信息。 */
function secretMatches(candidate) {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 请求路径对不对：配了密钥就是 /mcp/<secret>，没配就是 /mcp。 */
function isMcpPath(pathname) {
  if (!SECRET) return pathname === '/mcp';
  const prefix = '/mcp/';
  if (!pathname.startsWith(prefix)) return false;
  return secretMatches(pathname.slice(prefix.length));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 日志里绝不能出现密钥：/mcp/<secret> 一律打成 /mcp/*** */
function redactPath(pathname) {
  return pathname.startsWith('/mcp/') ? '/mcp/***' : pathname;
}

/**
 * 每个请求打一行。排查「客户端连不上」时这是唯一能直接看出真相的东西：
 * 对方发的是什么 HTTP 方法、什么 JSON-RPC 方法、Accept 头要什么、最后拿到什么状态码。
 */
function logRequest(req, res, pathname, rpcMethod) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ua = (req.headers['user-agent'] || '-').slice(0, 60);
    console.log(
      `[req] ${req.method} ${redactPath(pathname)} rpc=${rpcMethod || '-'} ` +
        `-> ${res.statusCode} ${Date.now() - startedAt}ms accept="${req.headers.accept || '-'}" ua="${ua}"`
    );
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function rpcError(res, status, code, message) {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message } });
}

const httpServer = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 健康检查：Render 拿它判断服务活着，也可以用来把睡着的实例叫起来。
  if (pathname === '/' || pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dairy-mcp ok\nstore: ${store.kind}\ntimezone: ${TIMEZONE}\n`);
    return;
  }

  if (!isMcpPath(pathname)) {
    logRequest(req, res, pathname);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  // POST 承载 JSON-RPC；GET 是客户端来开通知流的（实测官方 SDK 一定会发一次）；
  // DELETE 是关会话。三个都交给 transport 自己按协议处理 —— 之前这里对 GET 直接回
  // 405，虽然协议允许，但客户端可能据此判定「服务器不可达」。别自己替 SDK 拒。
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
    logRequest(req, res, pathname);
    rpcError(res, 405, -32000, `Method ${req.method} not supported.`);
    return;
  }

  let parsedBody;
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req);
      parsedBody = raw ? JSON.parse(raw) : undefined;
    } catch (err) {
      logRequest(req, res, pathname, 'parse-error');
      rpcError(res, err.statusCode || 400, -32700, `Parse error: ${err.message}`);
      return;
    }
  }

  logRequest(
    req,
    res,
    pathname,
    Array.isArray(parsedBody) ? '(batch)' : parsedBody?.method
  );

  // 每个请求起一套新的 server+transport。无状态模式下这是官方推荐做法：
  // 并发的两个客户端不会撞到同一份请求 id 表。
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // 用 MCP 默认的 SSE 响应模式。原先设了 enableJsonResponse: true（直接回 JSON，
    // 想着过 Render 反代更稳），但 claude.ai 的连接器加不上，报 "Couldn't reach"，
    // 而手工 curl 同一个端点 initialize 返回 200 —— 说明服务器本身没问题，
    // 是响应形态客户端不认。回到默认最兼容的 SSE。
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      rpcError(res, 500, -32603, 'Internal server error');
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`dairy-mcp listening on :${PORT}`);
  console.log(`  store    : ${store.kind}${store.kind === 'local-file' ? ` (${DATA_DIR})` : ''}`);
  console.log(`  timezone : ${TIMEZONE}`);
  if (SECRET) {
    console.log(`  endpoint : POST /mcp/<MCP_SECRET>`);
  } else {
    console.log(`  endpoint : POST /mcp`);
    console.warn(
      '  ⚠️  MCP_SECRET 没设置，这个端点是裸的。部署到公网前一定要设上，' +
        '否则谁拿到网址都能读写你的日记。'
    );
  }
  if (store.kind === 'local-file') {
    console.warn('  ⚠️  正在用本地文件存储。Render 免费版没有持久磁盘，重启会丢数据；' +
      '线上请配 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN。');
  }
});
