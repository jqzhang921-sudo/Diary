# 信匣 · diary-mcp

一个私人日记本，做成 MCP server。挂到网上之后，可以在 claude.ai 里加成「自定义连接器」，
这样跟 Claude 聊天的时候它能真的读到你写的日记、也能往里留信——不再是网页里那个跟聊天窗口
互相看不见的独立小程序。

四个工具：

| 工具 | 干什么 |
|---|---|
| `write_diary` | 写一篇日记（可指定日期和心情） |
| `read_diary` | 翻日记：按日期范围筛，或搜正文关键词 |
| `leave_letter` | 留一封信给你 |
| `read_letters` | 读匣子里的信（读过会标记，下次默认只显示未读） |

---

## 先说三件容易踩的事

**1. 这个链接就是钥匙。** claude.ai 的自定义连接器只能填一个网址，加不了自定义请求头，
所以密钥只能藏在网址里：`https://你的域名/mcp/<一长串随机字符>`。谁拿到这个完整网址，
就能读写你的日记。**别往聊天记录、截图、公开仓库里贴它。** 密钥只填在 Render 的环境变量里，
不写进代码。

**2. Render 免费版会休眠。** 大约 15 分钟没人访问就停，下次冷启动要几十秒。表现是：
隔了一阵子第一次用，Claude 那边可能报「连不上」——再试一次通常就好了。想避免这个，
可以先在浏览器里打开一次 `https://你的域名/`（那是健康检查页，纯文本，能把服务叫醒）。

**3. 免费版没有持久磁盘，必须配 Upstash。** 否则服务一重启日记全没。下面第 2 步就是这个。

另外：claude.ai 的自定义连接器是付费 plan 的功能（Pro / Max / Team）。

---

## 部署步骤

### 第 0 步：先生成一个密钥

在电脑上打开 Git Bash（或任意终端），跑：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

会打印一串 32 位左右的随机字符，比如 `k3Jx9_qP2vM8nRtY4wZbA6cLdE0fGhI1`。
**把它复制到记事本先存着**，后面第 3 步和第 5 步都要用。不要写进任何文件。

### 第 1 步：把代码传到 GitHub

你那个 `Diary` 仓库还能用，只是里面的旧文件要换掉。

1. 打开仓库页面，把之前传的 `server.js`、`package.json`、`README.md` 三个文件删掉
   （每个文件点进去 → 右上角垃圾桶图标 → 页面底部 `Commit changes`）
2. 回到仓库首页，点 `Add file` → `Upload files`
3. 打开桌面上的 `diary-mcp` 文件夹，**只选这 5 个东西**拖进去：
   - `server.js`
   - `package.json`
   - `package-lock.json`
   - `README.md`
   - `.gitignore`
4. ⚠️ **不要拖 `node_modules` 文件夹**（几十兆、上千个文件，Render 会自己装）
5. ⚠️ **文件要在仓库根目录，不能套一层文件夹**。传完后仓库首页应该直接看到
   `server.js`，而不是先看到一个文件夹名。上次就是这里出的问题。
6. 页面底部 `Commit changes`

### 第 2 步：开一个免费 Upstash Redis（日记存这里）

1. 打开 <https://console.upstash.com/> ，用 GitHub 账号登录
2. 点 `Create Database`
   - Name：随便填，比如 `diary`
   - Type/Primary Region：选离你近的，比如 `ap-northeast-1 (Tokyo)`
   - 其余保持默认，确认是免费档（Free）
3. 建好后进入数据库详情页，往下找 **REST API** 那一块，会看到两个值：
   - `UPSTASH_REDIS_REST_URL`——形如 `https://xxx-yyy-12345.upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN`——很长一串
4. 两个都复制下来存好。**这两个也是密钥，别外发。**

免费额度对个人日记这种量完全够用。

### 第 3 步：在 Render 建服务

1. <https://dashboard.render.com/> → `New` → `Web Service`
2. 选 `Build and deploy from a Git repository`，连上你的 `Diary` 仓库
3. 各项填：
   - **Name**：`diary-mcp`（会变成域名的一部分）
   - **Language / Runtime**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：`Free`
4. 往下找 **Environment Variables**，点 `Add Environment Variable`，加 **3 条**：

   | Key | Value |
   |---|---|
   | `MCP_SECRET` | 第 0 步生成的那串随机字符 |
   | `UPSTASH_REDIS_REST_URL` | 第 2 步复制的 URL |
   | `UPSTASH_REDIS_REST_TOKEN` | 第 2 步复制的 token |

   > 不用加 `PORT`——Render 会自动注入，代码会读它。加了反而可能冲突。
   > 也不用加 `TIMEZONE`，默认就是 `Asia/Shanghai`。

5. 点 `Deploy Web Service`，等日志跑完（大概一两分钟）

部署成功的日志末尾应该长这样：

```
diary-mcp listening on :10000
  store    : upstash-redis
  timezone : Asia/Shanghai
  endpoint : POST /mcp/<MCP_SECRET>
```

**`store` 必须是 `upstash-redis`。** 如果显示 `local-file`，说明那两个 Upstash 环境变量
没生效（拼错了或者没保存），日记会在重启时丢——回去检查第 4 项。

### 第 4 步：验一下服务活着

浏览器打开 `https://dairy-mcp-xxxx.onrender.com/`（你的实际域名，Render 页面顶部有）。
应该看到三行纯文本：

```
diary-mcp ok
store: upstash-redis
timezone: Asia/Shanghai
```

看到这个就说明服务起来了。（这个页面本身不含密钥，可以放心打开。）

### 第 5 步：加到 claude.ai

1. claude.ai → 左下角头像 → `Settings` → `Connectors`
2. `Add custom connector`
3. 名字填 `信匣`，URL 填：

   ```
   https://diary-mcp-xxxx.onrender.com/mcp/你第0步生成的密钥
   ```

   注意 `/mcp/` 后面直接跟密钥，中间没有别的东西。
4. 保存。连上之后应该能看到四个工具：`write_diary`、`read_diary`、
   `leave_letter`、`read_letters`

然后就可以直接在聊天里说「帮我记一下今天……」或者「翻翻上周的日记」了。

---

## 出问题的时候怎么查

| 症状 | 大概是什么 |
|---|---|
| 连接器加的时候报连不上 | 八成是 Render 休眠了。先在浏览器打开一次 `https://域名/`，等它返回 `dairy-mcp ok`，再回来加 |
| 打开 `https://域名/` 是 502 / 「Bad Gateway」 | 服务没起来。去 Render 的 `Logs` 标签页看报错 |
| 打开根路径正常，但连接器还是加不上 | 检查 URL 里的密钥有没有抄错、有没有多余空格。密钥错了服务会返回 404 |
| 日志里 `store: local-file` | Upstash 那两个环境变量没生效。Render → `Environment` 里检查拼写，改完要 `Save` 并重新部署 |
| 日记写进去了，过两天全没了 | 同上，是在用本地文件存储 |
| Render 日志里 `Cannot find module` | 传文件的时候漏了 `package.json` 或 `package-lock.json`，或者文件没在仓库根目录 |

Render 的 `Logs` 页面是主要的排查入口。把报错整段发我，我帮你看。

---

## 本地跑（想改代码的时候）

```bash
cd Desktop/diary-mcp
npm install
node server.js
```

不设 `MCP_SECRET` 时端点是 `POST http://localhost:3000/mcp`（会打一行警告），
不配 Upstash 时日记存在 `./data/` 下面的 json 文件里。两者都只适合本地。

想在本地也用 Upstash 的数据，把那两个环境变量带上：

```bash
MCP_SECRET=随便一个字符串 \
UPSTASH_REDIS_REST_URL=https://... \
UPSTASH_REDIS_REST_TOKEN=... \
node server.js
```

---

## 环境变量一览

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MCP_SECRET` | 公网部署必填 | 空 | URL 路径里的密钥。空着的话端点是裸的 `/mcp` |
| `UPSTASH_REDIS_REST_URL` | 公网部署必填 | 空 | Upstash REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | 公网部署必填 | 空 | Upstash REST token |
| `TIMEZONE` | 否 | `Asia/Shanghai` | 「今天」按哪个时区算。Render 跑在 UTC 上，不设的话半夜写的日记会记成前一天 |
| `DATA_DIR` | 否 | `./data` | 本地文件后端的存放目录 |
| `PORT` | 否 | `3000` | Render 会自动注入，别手动设 |

---

## 技术细节

- 传输：MCP Streamable HTTP，**无状态模式**（`sessionIdGenerator: undefined`），
  每个请求新建一套 server + transport。这样实例重启或者被换掉都不影响可用性。
- `enableJsonResponse: true`——直接返回 JSON 而不是开 SSE 长连接，过 Render 的反向代理更稳。
- 只接受 `POST`；`GET`/`DELETE` 返回 405（无状态模式用不上服务端推送和会话关闭）。
- 密钥用 `timingSafeEqual` 定长比较。
- 请求体上限 1MB。
- 存储层是可换的：配了 Upstash 走 Redis，没配走本地文件（原子重命名写入）。
  两个 key 分开存（`diary:entries` / `diary:letters`），写日记不会重写信。
