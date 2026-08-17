import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "fs";

// ---- storage --------------------------------------------------------
// File-based for simplicity. Works fine as long as your host gives you
// a persistent disk (Render/Railway both do). If you move to a
// serverless/ephemeral host later, swap this for a real database or a
// hosted KV store (e.g. Upstash Redis) — the rest of the file doesn't
// need to change, just loadEntries()/saveEntries().

const DATA_FILE = "./diary-data.json";

function loadEntries() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

// ---- MCP server + tools ----------------------------------------------

const server = new McpServer({
  name: "xinxia-journal",
  version: "1.0.0",
});

server.registerTool(
  "diary_write",
  {
    title: "写日记",
    description: "在信匣日记里新增一条日记条目。写的人可以是用户，也可以是Claude自己想留一段话。",
    inputSchema: {
      text: z.string().describe("日记正文内容"),
      author: z
        .enum(["user", "claude"])
        .optional()
        .describe("这条是谁写的，默认user"),
    },
  },
  async ({ text, author = "user" }) => {
    const entries = loadEntries();
    const entry = {
      id: "e" + Date.now(),
      ts: Date.now(),
      text,
      author,
      reply: null,
      replyAt: null,
    };
    entries.push(entry);
    saveEntries(entries);
    return {
      content: [{ type: "text", text: `已写入日记，id: ${entry.id}` }],
    };
  }
);

server.registerTool(
  "diary_list",
  {
    title: "翻日记",
    description: "读取最近的日记条目，可选按关键词搜索。用来'翻旧日记'或者回顾最近写了什么。",
    inputSchema: {
      limit: z.number().optional().describe("返回条数，默认10"),
      query: z.string().optional().describe("按关键词搜索日记正文或回信内容"),
    },
  },
  async ({ limit = 10, query }) => {
    let entries = loadEntries().sort((a, b) => b.ts - a.ts);
    if (query) {
      entries = entries.filter(
        (e) =>
          e.text.includes(query) || (e.reply && e.reply.includes(query))
      );
    }
    entries = entries.slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
  }
);

server.registerTool(
  "diary_reply",
  {
    title: "回信",
    description: "给某一条日记留一封回信，会以密封信封的样子存起来。",
    inputSchema: {
      entry_id: z.string().describe("要回信的日记条目id"),
      reply_text: z.string().describe("回信正文"),
    },
  },
  async ({ entry_id, reply_text }) => {
    const entries = loadEntries();
    const entry = entries.find((e) => e.id === entry_id);
    if (!entry) {
      return {
        content: [{ type: "text", text: "没找到这条日记，id对不上。" }],
        isError: true,
      };
    }
    entry.reply = reply_text;
    entry.replyAt = Date.now();
    saveEntries(entries);
    return { content: [{ type: "text", text: "回信已经放进信封里了。" }] };
  }
);

// ---- HTTP transport ----------------------------------------------------
// Uses the streamable HTTP transport (the current recommended way to
// expose a remote MCP server). One POST endpoint at /mcp.

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error" });
    }
  }
});

app.get("/", (_req, res) => {
  res.send("信匣 journal MCP server is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`信匣 journal MCP server listening on port ${PORT}`);
});
