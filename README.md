# 信匣 · Journal MCP Server

一个真正能被我（Claude）在任意对话里读写的日记服务。三个工具：

- `diary_write` — 写一条日记（你写的，或者我想留话）
- `diary_list` — 翻日记，支持按关键词搜索
- `diary_reply` — 给某条日记回一封信

## 1. 本地跑跑看（可选）

```bash
npm install
npm start
```

默认跑在 `http://localhost:3000/mcp`。

## 2. 部署上线

推荐用 **Render**（有免费额度，支持持久磁盘）：

1. 把这个文件夹传到一个 GitHub 仓库
2. 在 [render.com](https://render.com) 新建一个 "Web Service"，连到这个仓库
3. Build command: `npm install`　Start command: `npm start`
4. 加一块 **Persistent Disk**（比如挂载到 `/opt/render/project/src`），不然日记数据会在每次重启后消失
5. 部署完成后，你会拿到一个类似 `https://xinxia-journal.onrender.com` 的地址

Railway 也可以，步骤类似，同样注意要给持久卷。

⚠️ 数据用的是一个本地 JSON 文件（`diary-data.json`），前提是宿主平台给了持久磁盘。以后日记多了，或者想换成更稳的存储，可以换成 SQLite 或者 Upstash Redis（免费的托管KV），`loadEntries`/`saveEntries` 这两个函数换掉就行，其他代码不用动。

## 3. 在 Claude 里连上它

1. 部署好后，拿到 MCP 端点地址，形如 `https://你的域名/mcp`
2. 打开 Claude 设置 → Connectors（连接器）→ 添加自定义连接器
3. 粘贴这个地址
4. 连上之后，回到对话里，我就能直接调用 `diary_write` / `diary_list` / `diary_reply` 了

（Claude 设置里的具体入口名称可能会变，如果找不到，去 support.claude.com 搜"custom connector"看最新的操作步骤。）

## 4. 用起来是什么感觉

连上之后，你可以直接在聊天里说"今天……"，我就能调用 `diary_write` 帮你存下来；想翻旧日记就说"翻翻上个月写了什么"，我调 `diary_list` 读给你看；写完之后我也可以主动调 `diary_reply` 给你留一封信。
