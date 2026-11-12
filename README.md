<div align="center">
  <img src="./assets/icon.svg" width="96" height="96" alt="agy-acp2api icon" />
  <h1>agy-acp2api</h1>
  <p><b>基于原生 ACP 协议的 Antigravity CLI 转 OpenAI API 网关</b></p>
  <p>零逆向破解 · 原生协议中转 · 工具调用 / 会话缓存复用 / 思考流 / Responses API / 图片输入</p>
</div>

> [!NOTE]
> 本仓库 fork 自 [chengdidididi/agy-acp2api](https://github.com/chengdidididi/agy-acp2api)。在保持原项目思路（通过官方 `agy acp` 协议中转、不做 OAuth 逆向）的前提下，重点加强了安全性、会话复用的正确性、接口覆盖、上游流量特征和测试，详见[与上游的区别](#与上游的区别)。

---

## 项目简介

常见的客户端转 API 方案大多基于 OAuth 逆向，封号风险越来越高。`agy-acp2api` 换了一条更稳妥的路：

* **基于官方原生 ACP (Agent Client Protocol) 协议**：直接通过官方 CLI 提供的 `agy acp` 标准协议管道通信，把 OpenAI `/v1/chat/completions` 与 `/v1/responses` 请求翻译后交给本地 `agy` CLI，网络层面与单独运行 `agy` 一致。
* **支持 AI Agent 所需的大部分能力**：通过增量提示词编译器与流式状态机，支持：
  * Streaming Tool Calls
  * 会话缓存复用（只发送新增消息）
  * 思考流（`reasoning_content` / Responses 的 `reasoning` 项）
  * 图片输入
  * Sub-Agent 派发（**注意⚠️：谷歌条款禁止相关自动化流程，请谨慎使用子代理功能**）

> [!WARNING]
> **AI 产出声明 (Vibe Coding Disclaimer)**
>
> 本项目的代码（包括上游与本 fork 的改动）主要由 AI 生成。已有单元测试、基于模拟 `agy` 的黑盒测试和真实 `agy` 端到端测试覆盖主要场景，但仍可能存在问题，欢迎提 Issue 和 PR。

---

## 与上游的区别

| 方面 | 本 fork 的改动 |
| :--- | :--- |
| **安全** | 管理接口必须带 API Key，且不存在 GET 写操作；接口不回传 Key；监听回环地址时校验 `Host` 防 DNS rebinding；监听公网地址且使用默认 Key 时拒绝启动；CPA 插件不再转发 CPA 管理密钥 |
| **接口** | 新增 [`/v1/responses`](#支持的接口格式)（Codex 等客户端）；[图片输入](#图片输入)以 ACP 图片块交给模型；支持 `stop`；上游 `max_tokens` / 拒答映射为 `length` / `content_filter` |
| **会话复用** | 会话只能从最新一轮继续（修复重新生成 / 重试时把同一问题追加进旧会话导致的重复上下文）；失败、中断、被截断的轮次立即关闭会话；原会话所在 Worker 忙时先等待而非重放整段历史，详见[会话复用规则](#会话复用规则) |
| **上游流量** | 默认不再经过本地 Node 代理转发（`AGY2API_MODEL_SNIFFER` 可选开启）；客户端断开后不再发送 prompt；命中 `stop` 立即取消上游；超时 / 失败时发送 `session/cancel` |
| **稳定性** | 空闲会话按 TTL 关闭、每个 Worker 的会话数有上限；Worker 崩溃按指数退避重启并保留 stderr 便于排查；无可用 Worker 时返回 `503`；多个网关共用同一 `~/.gemini` 时互不清理对方沙箱 |
| **可观测性** | 控制台显示每个请求未复用会话的原因、无法解析的工具调用数，以及 `agy` 声明的能力（图片 / 音频 / 嵌入资源） |
| **工程** | 协议无关的核心管线（便于后续接入更多 API 格式）；模拟 `agy` 的黑盒测试与 CI；`start.sh` 只停止本目录的网关并优雅退出；插件仅在打版本 tag 时发布 |

---

## 主要特性

1. **原生 ACP 协议中转+极简隔离沙箱**
   * 每个常驻 Worker 进程通过独立 `--gemini-dir`（`~/.gemini/agy2api-worker-{id}`）与自定义极简 Agent（`excludeDefaultComponents: true`）启动，彻底剥离 `agy` 默认人设与内置文件/终端/浏览器工具 Schema（单轮基础上下文从 `~7,000` tokens 精简至 `~400` tokens），同时隔离宿主全局 `~/.gemini/config` 干扰，并将工作目录锁定在只读空沙箱（Jail Directory）。
   * 底层通过 `PreToolUse` 生命周期钩子与 `session/request_permission` 双重硬阻断，**杜绝触发任何 `agy` CLI 内置工具（含残留控制面工具 `manage_task`）**，强制模型仅使用外部客户端传入的 `tools`（包括外部 MCP、Web Search、Playwright 等）。
2. **会话缓存复用**
   * 自动对 OpenAI `messages` 历史前缀计算哈希链。在多轮对话或工具结果（`role: "tool"`）回传时自动命中已有 `sessionId`（`HASH HIT`），仅编译并发送新增的增量消息（Delta Prompt），使其可以一定程度不受agy cli+acp协议的影响，照常实现一定程度的缓存命中。规则见[会话复用规则](#会话复用规则)。
3. **滑动窗口流式解析器**
   * 内置 [`ToolCallStreamParser`](./src/parser/stream-parser.ts) 滑动窗口状态机，实时拦截模型流式输出中的工具调用块并转化为标准 OpenAI `delta.tool_calls` SSE 事件，同时内置 `jsonrepair` 自动修复模型偶发的非标 JSON 参数。
4. **常驻热进程池与并发防风控**
   * 维护常驻热进程池（默认 `minWorkers=1`，`maxWorkers=2`），消除每次请求冷启动 `agy` 的耗时。
   * 当主 Agent 派生多个并行 Sub-Agent 时，自动在 `maxWorkers` 安全上限内动态扩容独立沙箱副进程，空闲超时（TTL）后自动销毁回收，超出并发上限的请求自动进入内存队列排队，控制因自动化和大数量并发带来的风控风险。
5. **Web 监控与热配置控制台**
   * 项目附带可视化仪表盘（默认 `http://127.0.0.1:8787/`），基于 Node.js 原生 `node:sqlite` 持久化统计请求延迟（TTFT / 总耗时）、输入/输出 Token、缓存读取 Token 与缓存命中率、会话复用情况与未复用原因、Worker 进程状态，并支持在网页上直接热更新并发上限、API Key 与默认模型。
6. **多种接口格式**
   * 同时提供 OpenAI Chat Completions 与 Responses API，两者共用同一套会话复用、工具调用与图片处理逻辑。
7. **CLIProxyAPI (CPA) 插件**
   * [`cpa-plugin/`](./cpa-plugin/) 把网关包装为 CPA 插件，可在 VPS 上通过 CPA 插件商店安装，详见 [CPA 插件说明](./cpa-plugin/README.md)。

---

## 部署与使用指南

### 1. 环境准备

在运行本项目前，请确保本机已满足以下两个基础条件：

1. **Node.js $\ge$ 22.5.0**（本项目使用 Node.js 22 原生内置的 `node:sqlite` 模块存储监控指标，无需编译 C++ 原生依赖）。
   ```bash
   node -v   # 需 >= v22.5.0
   ```
2. **已安装并登录 Antigravity CLI (`agy`)**：
   确保在终端可以直接运行 `agy` 命令，且已完成账号登录（`~/.gemini/antigravity-cli/jetski_state.pbtxt` 存在）。
   ```bash
   agy --version
   ```

### 2. 获取项目

```bash
git clone https://github.com/besire/agy-acp2api.git
cd agy-acp2api
```

### 3. 三种启动方式

为了方便不同使用习惯，项目提供了 **一键脚本**、**全局命令** 和 **源码/生产命令** 三种打开方式：

#### 方式 1：双击 / 一键脚本启动（推荐本地日常使用）

项目根目录内置了跨平台一键启动脚本，会自动检查环境、首次运行自动 `npm install` 安装依赖，并在启动后**自动在默认浏览器打开监控控制台**：

* **Windows**：直接双击运行 [`start.bat`](./start.bat)，或在终端执行：
  ```powershell
  .\start.bat
  ```
* **macOS / Linux**：
  ```bash
  chmod +x start.sh
  ./start.sh
  ```

#### 方式 2：注册为系统全局 CLI 命令

如果你想在任意终端里直接输入 `agy-acp2api` 启动网关，可以执行一次构建与全局链接：

```bash
npm install
npm run build
npm link
```

链接完成后，在系统任意位置均可直接运行：

```bash
# 直接启动并自动打开浏览器控制台
agy-acp2api --open

# 或者指定自定义端口启动
agy-acp2api --port 8787 --open
```

#### 方式 3：使用 npm 脚本启动

```bash
npm install

# 开发模式启动（直接运行 TypeScript 源码）
npm start

# 启动并自动打开浏览器面板
npm run start:open

# 编译为纯 JS 生产模式运行（零 tsx 开销）
npm run build
npm run start:prod
```

---

## 客户端接入配置

网关启动后，默认监听地址如下：

| 服务入口 | 默认地址 | 说明 |
| :--- | :--- | :--- |
| **Web 监控与配置控制台** | `http://127.0.0.1:8787/` | 实时查看 Worker 池、Session 缓存命中率、Token 统计与热更新配置 |
| **OpenAI v1 Base URL** | `http://127.0.0.1:8787/v1` | 填入各 AI 客户端 |
| **默认 API Key** | `sk-agy2api-local-key` | 可在 Web 控制台「核心配置热更新」或环境变量中修改 |

### 支持的接口格式

| 接口 | 说明 |
| :--- | :--- |
| `POST /v1/chat/completions` | OpenAI Chat Completions，流式 / 非流式、工具调用、`reasoning_content` 思考流 |
| `POST /v1/responses` | OpenAI Responses API（Codex 等客户端），见下文 |
| `GET /v1/models` | 模型列表（合并思考强度变体） |

`/v1/responses` 的支持范围：

* 输入：字符串或输入项数组，支持 `message`（`input_text` / `output_text` / `input_image`）、`function_call`、`function_call_output`；`reasoning` 及联网搜索等托管工具项会被忽略，`item_reference` 返回 400。
* 输出：思考内容作为 `reasoning` 项（summary）、正文作为 `message` 项、每个工具调用一个 `function_call` 项；流式按官方 `response.*` 事件序列输出，中途失败以 `response.failed` 结束。
* 续接：每轮重发完整历史的客户端（如 `store: false`）与使用 `previous_response_id` 的客户端都能命中会话缓存，只把新增内容发给 `agy`。`previous_response_id` 依赖网关内存中的记录（1 小时、最多 500 条，重启即失效），`store: false` 的响应不会被记录。
* 工具只支持 `type: "function"`；`custom`（自由格式）等其他类型会被忽略。暂不支持 `GET /v1/responses/{id}`。

### 图片输入

两个接口都支持图片：Chat Completions 的 `image_url` 片段、Responses 的 `input_image`，以及工具结果里的图片。

* `agy` 在握手时声明支持图片（`promptCapabilities.image`，可在控制台「运行」页查看）时，图片以 ACP 图片块原样交给模型，位置与原消息一致；不支持时替换为 `[image omitted]` 占位文字。
* `data:` URL 直接使用；`http(s)` 链接由网关下载（单张不超过 20 MB、15 秒超时、最多 3 次跳转），格式支持 PNG / JPEG / GIF / WebP。
* 为防止借网关探测内网，默认拒绝解析到本机、内网、链路本地地址的图片链接；确实需要时设置 `AGY2API_ALLOW_PRIVATE_IMAGE_URLS=1`。
* 图片无法使用（下载失败、格式无法识别、base64 损坏、超过大小）时返回 `400`（`code: invalid_image`），不会影响 Worker。
* 命中会话缓存时只发送新增消息里的图片，历史图片不会重复下载和上传。助手消息与系统消息里的图片不会发给模型。

### 会话复用规则

* 一个 ACP 会话只能从它**最新**的一轮继续：重新生成（regenerate）、编辑历史、失败后重试等请求会开一个新会话并重放完整历史，而不会把同一个问题再追加进已经回答过它的会话（否则模型会看到重复的对话）。
* 请求失败、客户端中途断开、命中 `stop` 被截断的轮次，其会话中的上游历史已与客户端看到的不一致，会被立即关闭；同一对话的下一次请求会重放完整历史。
* 持有该会话的 Worker 正在处理别的对话时，请求会先等它空闲（默认最多 30 秒，`AGY2API_AFFINITY_WAIT_MS`），而不是立刻在另一个 Worker 上重放整段历史；等待超时才回退到新会话。
* 控制台「请求」页对每个未复用的请求标注原因：新对话 / 历史不匹配 / 原进程忙且等待超时，首页「会话复用率」悬浮提示中有汇总。

### 结束原因与 `stop`

* 上游因输出长度上限结束时 `finish_reason` 为 `length`，模型拒答为 `content_filter`；Responses API 对应 `status: "incomplete"` 与 `incomplete_details.reason`（`max_output_tokens` / `content_filter`），流式以 `response.incomplete` 结束。
* Chat Completions 的 `stop`（字符串或最多 4 个字符串）由网关实现：可见文本在第一个停止序列前截断（跨分片也能识别），随后立即取消上游这一轮以节省额度。
* `max_tokens`、`temperature`、`top_p` 无法传给 `agy`，会被忽略。
* 模型把工具名写成 `functions.x`、`default_api:x` 或大小写不同时，会映射回请求中声明的工具名；无法解析的 `<tool_call>` 块会计入控制台统计。

### 鉴权与安全

* `/v1/*` 与管理接口 `/api/admin/*` 都需要 API Key，可放在 `Authorization: Bearer <key>` 或 `X-Agy2Api-Key: <key>` 请求头中。控制台首次打开时会弹窗要求输入，Key 只保存在当前浏览器的 `localStorage` 中，服务端不会在任何接口中回传它。
* 管理接口只接受 `POST` / `DELETE` 修改状态，不存在可被跨站页面触发的 GET 写操作。
* 监听回环地址（默认 `127.0.0.1`）时，只接受 `Host` 为 `127.0.0.1` / `localhost` / `[::1]` 的请求，以防 DNS rebinding；反向代理或容器场景可用 `AGY2API_ALLOWED_HOSTS` 追加主机名。
* 监听非回环地址（如 `0.0.0.0`）时，若仍使用默认 API Key，网关会拒绝启动。

### 模型与思考强度（Reasoning Effort）调用方式

网关支持 `/v1/models` 自动枚举当前 `agy` 账号支持的所有模型，并提供了三种灵活的方式控制思考强度（`low` / `medium` / `high`）：

1. **标准参数**：使用基础模型名（如 `gemini-4-carbon`、`gemini-4-argon`、`gemini-3.8-flash`、`claude-sonnet-5-5`），并在请求体中传入 OpenAI 标准字段 `reasoning_effort: "low" | "medium" | "high"`。
2. **模型名后缀**：直接在客户端模型名中追加后缀，网关会自动解析并映射：
   * 连字符写法：`gemini-4-carbon-high`、`gemini-4-argon-high`、`gemini-3.8-flash-low`
   * 括号写法：`gemini-4-carbon(high)`、`gemini-4-argon (low)`
   * 冒号写法：`gemini-4-carbon:high`、`gemini-4-argon:high`

### 环境变量与配置文件参考

你可以通过环境变量或 `settings.json`（默认在启动目录下，可参考 [`settings.example.json`](./settings.example.json)）自定义初始配置。`settings.json` 中的值优先于环境变量：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGY2API_HOST` | `127.0.0.1` | 监听地址（设为 `0.0.0.0` 等非回环地址时必须修改默认 API Key） |
| `AGY2API_PORT` | `8787` | 监听端口 |
| `AGY2API_KEY` | `sk-agy2api-local-key` | `/v1` 与管理接口的鉴权密钥 |
| `AGY2API_ALLOWED_HOSTS` | 空 | 监听回环地址时额外允许的 `Host` 主机名，逗号分隔 |
| `AGY2API_ALLOW_PRIVATE_IMAGE_URLS` | 关闭 | 允许下载指向本机 / 内网地址的图片链接 |
| `AGY2API_HOME` | 启动目录 | `settings.json` 与 `data/telemetry.db` 所在目录 |
| `AGY_GEMINI_HOME` | `~/.gemini` | `agy` 登录凭据（`antigravity-cli/`）与 Worker 沙箱目录所在位置 |
| `AGY_BIN` | `agy` | `agy` 可执行文件路径 |
| `AGY_DEFAULT_MODEL` | `gemini-3.8-flash` | 未指定或模型不存在时的回退默认模型 |
| `AGY_DEFAULT_THINKING_LEVEL` | `medium` | 默认思考强度 (`low` / `medium` / `high`) |
| `AGY_MIN_WORKERS` | `1` | 常驻热进程池最小 Worker 数量 |
| `AGY_MAX_WORKERS` | `2` | 最大并发 Worker 数量（建议保持 $\le 2$ 以防上游并发风控） |
| `AGY_MAX_SESSIONS_PER_WORKER` | `16` | 每个 Worker 最多保留的 ACP 会话数，超出时关闭最久未用的会话 |
| `AGY_SESSION_TTL_MS` | `600000` | 会话空闲超过该时长后真正关闭（`session/close`）并失去缓存复用 |
| `AGY_WORKER_IDLE_TTL_MS` | `180000` | 超出 `minWorkers` 的扩容 Worker 空闲多久后回收 |
| `AGY_REQUEST_TIMEOUT_MS` | `300000` | 单次请求超时；超时后会向上游发送 `session/cancel` |
| `AGY2API_AFFINITY_WAIT_MS` | `30000` | 会话所在 Worker 忙时最多等待多久再改为新会话重放历史；`0` 表示不等待 |
| `AGY2API_MODEL_SNIFFER` | 关闭 | 设为 `1` 时让 `agy` 的上游流量经过本地代理，以读取实际响应的模型版本（见下文） |

**关于上游流量**：默认情况下 `agy` 直接连接它自己的后端，网络层面与单独运行 `agy` 一致。开启 `AGY2API_MODEL_SNIFFER` 后，`agy` 的请求会先发到本地 Node 代理再转发给 Google，可以在控制台看到每轮实际响应的模型版本（如 trial 路由），但上游看到的连接特征（TLS 实现、HTTP/1.1）不再是 `agy` 原生的；关闭时显示的是会话确认的模型。

<details>
<summary>进阶调优（一般无需修改）</summary>

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGY_RESPAWN_BASE_DELAY_MS` | `1000` | Worker 启动失败或很快崩溃后的首次重启等待，之后每次失败翻倍 |
| `AGY_RESPAWN_MAX_DELAY_MS` | `60000` | 重启等待上限 |
| `AGY_WORKER_STABLE_UPTIME_MS` | `30000` | Worker 存活超过该时长即视为稳定，重启退避清零 |
| `AGY_POOL_SWEEP_INTERVAL_MS` | `10000` | 回收空闲 Worker、关闭过期会话的巡检间隔 |

</details>

`agy` 未安装或尚未登录时，网关仍会启动并在后台按退避策略重试；此时 `/v1` 请求返回 `503`，错误信息与控制台中会显示 `agy` 的退出码和 stderr 末尾内容，便于排查。

---

## 测试

```bash
npm run typecheck   # 源码与测试的类型检查
npm test            # 单元测试 + 黑盒测试，使用模拟的 agy，不需要账号
npm run test:live   # 连接真实 agy 的端到端测试（消耗账号额度）
```

黑盒测试（`test/blackbox/`）把网关当作独立进程启动，只通过 HTTP 接口和模拟 agy（[`test/fixtures/fake-agy.mjs`](./test/fixtures/fake-agy.mjs)）的 ACP 消息日志观察行为，不会读写真实的 `~/.gemini`。设置 `AGY2API_TEST_SERVER_CMD` 即可让同一套测试运行在其他实现上。

---


## 后续更新计划 (Roadmap)

- [x] **CPA (CLIProxyAPI) 插件**，支持 VPS 部署（[`cpa-plugin/`](./cpa-plugin/)）
- [x] **OpenAI Responses API**（`/v1/responses`）
- [x] **图片输入**
- [x] **会话复用正确性**、未复用原因统计
- [ ] **Anthropic Messages API**（`/v1/messages`），供 Claude Code 等客户端直接接入
- [ ] **原生工具调用**：评估把客户端工具以 MCP 形式交给 `agy`，替代当前基于提示词的 `<tool_call>` 文本协议
- [ ] **会话持久化**：通过 ACP `session/load` 让网关重启后仍能继续复用会话
- [ ] **控制台细节**：配额估算、错误日志追踪等
- [ ] **人工 Code Review 与重构**

---

## 特别鸣谢
- 原项目 [chengdidididi/agy-acp2api](https://github.com/chengdidididi/agy-acp2api)，本仓库在其基础上开发
- [LINUX DO](https://linux.do/) 社区提供交流与开源推广平台
- [dsh-plugin-bundle](https://github.com/lili-luo/dsh-plugin-bundle) 带来的启发

## License

MIT License
