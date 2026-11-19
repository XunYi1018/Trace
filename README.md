# dsh-purge（`1.1.85`）

面向 **DeepSeek Harness (`0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.2-rc.5`)** 的宿主策略清洗、提示词注入、多协议/新模型适配与红队演练台维护版插件（支持官方桌面端 `desktop`、官方 Web 端 `web` 及终端 `dsh-tui`）。

---

## 核心升级与增强（`1.1.85` · 适配 `0.2.2-rc.5` + `#104`–`#114`）

### 0. `1.1.85` 升级维护（DeepSeek Harness `0.2.2-rc.5` 适配与重入去重修复）
- **修复 `identity.js` 双重重入导致 `prompt-inject.md` 双份注入与缩进压扁 Bug**：`SystemPrompt.assemble()` 先经 `system-prompt/assemble` 瀑布执行一次 `rewritePromptAssembly`（将 `injectText` 折入 `deployment:persona-prefix`），随后外层 `installAssembleGuard` 对返回值二次调用 `rewritePromptAssembly`。旧逻辑在第 2 次进入时对 `deployment:persona-prefix` 执行了 `stripHarnessPersona()`，将其中的 2+ 连续空格压成单空格，导致 `prior.includes(inject)` 失配并把整份 `prompt-inject.md` 又拼了一遍。现新增 `peelFoldedInject()` 在清洗前剥离已折入的 `injectText`，保证多次重入 **100% 幂等且零格式损耗**。
- **#12 `APPROVAL_ASK_SENTENCE_BYPASS` 适配 `0.2.2-rc.5`**：补充匹配 `0.2.2-rc.5` 新版 `dsh-user-approval` 的 `ASK_SENTENCE`（`"Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed."`）。
- **#71 `LIANGSHEN_IDENTITY_LINE` & #28 `LIANGSHEN_PHASE1_KEEP_INJECT` & #80 `MINIMAL_OFFICIAL_TOOLSET`**：适配新版 `liangshen/agent.cordis.yml` 的 `!!js` 动态 `persona` 变量与 `tool-bootstrap.mjs` 的 `keepTools` 结构，补齐 `#80` `softSettle`，达成本机 **95/95 applied（0 pending, 0 skipped）**。

### 1. 隐私保护与遥测剥离（`#49` / `#104`–`#106`）
- **#49 `ANTHROPIC_OAUTH_CLI_NEUTRAL`**：将 Anthropic OAuth `user-agent` 改为中性 `anthropic-typescript`，消除早先伪装 UA 中包含 `dsh-purge` 字样的自曝风险，并支持逆序无损还原。
- **#104 `INVENTORY_TELEMETRY_DISABLE`**：禁用 `dsh-plugin-package-inventory-deepseek` 扩展清单上报，避免把已安装的本地插件列表回传服务端。
- **#105 `PI_AI_USER_AGENT_NEUTRAL`**：将 `@earendil-works/pi-ai` 默认 `getPiUserAgent()` 简化为 `"pi"`，剥离操作系统平台、内核版本与 CPU 架构指纹。
- **#106 `DEEPSEEK_ADAPTER_UNSHACKLE`**：移除 `dsh-llm-deepseek` 中的 `attributionHeaders()` 与 `x-deepseek-harness-user-id` / `session-id` / `compact` 追踪头；放宽 `capabilitiesOf`、`gateOf` 与 `refuseListedModel` 对新模型的版本/能力拦截。

### 2. 深度破甲与动态提示词净化（`#56` / `#63` / `#77` / `#107`–`#109` + `identity.js`）
- **#56 / #77**：补全 `0.2.2-rc.3` 单行压缩版 `dsh-client-ui-conversation/lib/client.js` 分支切换记录隐藏与消息保留修复。
- **#63 + `identity.js` 运行时清洗**：补齐 `dsh-base/cordis.patch.yml` 中 `plan-mode` 剩余等待切换话术，并在提示词组装阶段自动剥离 `tool:ralph`、`tool:workflow`、`tool:write` 与 `plan-mode` 的硬限制文案（不干扰用户自身注入段）。
- **#107 `SUBAGENT_AND_CUA_GOAL_UNSHACKLE`**：解除 `dsh-terminal-panel`、`dsh-cua`（指针控制与权限弹窗硬拦）与 `dsh-tool-goal`（子代理创建/暂停态恢复限制）。
- **#108 `TOOL_PROMPT_FRICTION_RELAX`**：软化 `dsh-tool-ralph`、`dsh-tool-workflow`、`dsh-tool-fs` 工具声明中的仅直连人类与先读再写说教。
- **#109 `WEB_CROSS_ORIGIN_REDIRECT_ALLOW`**：放行 `dsh-web-fetch-http` 对已校验 URL 的跨源重定向。

### 3. 全协议解锁、国产/中转及本地模型兼容（`#57` / `#110`–`#114`）
- **#57 `DEEPSEEK_SYSTEM_ROLE`**：未显式配置的中转默认使用 `"system"` 角色，防止被强制传 `"developer"` 报错；当模型显式声明 `compat.supportsDeveloperRole === true` 或接入官方 OpenAI/Azure 时正常使用 `"developer"`。
- **#110 `PI_AI_PROTOCOLS_AND_COMPAT_UNSEAL`**：在 `dsh-llm-pi-ai` 解封全部 9 个 `@earendil-works/pi-ai` 协议（新增 `azure-openai-responses`、`openai-codex-responses`、`google-vertex`、`bedrock-converse-stream`、`mistral-conversations`），将所有 `"withhold"` compat 开关解锁为 `"offer"`，并补齐 Schemastery `compatProfile` 缺失字段（复合字段采用 `z.any()` 避免空容器默认值污染）。
- **#111 `UI_MODEL_PROTOCOLS_AND_REASONING_LEVELS`**：模型设置面板新增 5 个解封协议的友好名称映射，并为 Gemini 思考档位扩展 `xhigh` / `max`。
- **#112 `PI_AI_RELAY_AND_CN_DETECT_COMPAT`**：增强 `pi-ai` `detectCompat(model)`，自动识别 DashScope（Qwen3）、火山引擎 Ark、硅基流动、智谱 BigModel（GLM-4.x/5）、Moonshot（Kimi K2）、MiniMax M2、中转 DeepSeek-R1/V3 及本地网关（`localhost`/`127.0.0.1`/`[::1]`/`*.local`）。
- **#113 `PI_AI_LOOPBACK_KEYLESS_ALLOW`**：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` 四条链路均放行回环与 `.local` 本地大模型免填 API Key。
- **#114 `PI_AI_THINKING_GEMINI_AND_PROXY_COMPAT`**：将 Google `xhigh`/`max` 思考级别安全钳位为 `high` 并放宽 `gemini-3` 匹配；非 `api.anthropic.com` 第三方 Anthropic 代理默认省略 `thinking.display` 字段（显式指定时仍保留）。

---

## 目录结构

| 路径 | 说明 |
| :--- | :--- |
| `lib/` | 核心补丁引擎 `core.js`、提示词装配守卫 `identity.js`、宿主控制（Desktop / Web）及更新同步逻辑 |
| `lib/redteam/` | 红队演练台后端与本地代理池工具集 |
| `presets/redteam/` | 红队模式智能体预设与锚点门控 |
| `skills/redteam/` | 红队演练技能包 |
| `scripts/` | 构建、嵌入与回归测试脚本 |
| `client.js` | 前端右侧栏控制台（清洗面板 + 红队演练台 UI） |
| `bin/dsh-purge.js` | 命令行工具（`--status`、`--apply`、`--revert`） |
| `cordis.patch.yml` | Profile 级插件挂载补丁 |
| `cordis.legacy-redteam.patch.yml` | 停用旧版独立红队包的可选叠加层 |

---

## 本地部署、维护与测试

### 1. 目录映射与 Profile 挂载

- 本地插件目录：`~/.dsh/plugins/dsh-purge`
- 各 Profile（`desktop` / `web` / `dsh-tui`）的 `package.json` 依赖指向 `"file:../../plugins/dsh-purge"`（或复制到对应 `node_modules/dsh-purge`），且 `"dsh-purge"` 置于 `dsh.profile.bundles` 数组末尾。

### 2. 常用 CLI 命令

```powershell
# 查看当前桌面端宿主补丁状态（Windows 独立 CLI 需指定 desktop）
$env:DSH_SURFACE = "desktop"
node ~/.dsh/plugins/dsh-purge/bin/dsh-purge.js --status

# 应用宿主清洗补丁
$env:DSH_SURFACE = "desktop"
node ~/.dsh/plugins/dsh-purge/bin/dsh-purge.js --apply

# 还原宿主备份
$env:DSH_SURFACE = "desktop"
node ~/.dsh/plugins/dsh-purge/bin/dsh-purge.js --revert
```

### 3. 回归测试

```powershell
# 核心回归套件（#49-#114 升级与维护回归）
npm test

# 其余模块化回归脚本
node scripts/test-anchor-decision.mjs
node scripts/test-fold-inject.mjs
node scripts/test-last-apply.mjs
node scripts/test-redteam-toolfilter.mjs
```
