/**
 * test-audit-upgrades.mjs — 验证 #49/#56/#57/#63/#77/#104-#114 及 identity 工具引导清洗回归测试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { ALL_PATCHES, targetFiles } from "../lib/core.js";
import { rewritePromptAssembly } from "../lib/identity.js";

/** 与 core.js stripPurgePatchesFromText 一致地逆序还原文本。 */
function reversePatchText(text, patch) {
  let out = String(text).replace(/\r\n/g, "\n");
  for (const r of [...(patch.replacements || [])].reverse()) {
    if (!r.pattern || typeof r.replace !== "string" || typeof r.pattern !== "string") continue;
    const prev = out.replaceAll(r.replace.replace(/\r\n/g, "\n"), r.pattern.replace(/\r\n/g, "\n"));
    if (prev !== out) out = prev;
  }
  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOST_DSH_NM = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Programs",
  "DeepSeek Harness",
  "resources",
  "app",
  "dsh",
  "node_modules",
);
const HOST_AI_BASE = path.join(HOST_DSH_NM, "@deepseek-ai");
const HAS_HOST = fs.existsSync(HOST_AI_BASE);

/** 与 core.js 一致地执行单条补丁正向替换。 */
function applyPatchText(text, patch) {
  let out = String(text).replace(/\r\n/g, "\n");
  for (const r of patch.replacements || []) {
    if (!r.pattern || typeof r.replace !== "string") continue;
    if (r.pattern instanceof RegExp) {
      out = out.replace(new RegExp(r.pattern.source, r.pattern.flags.includes("g") ? r.pattern.flags : r.pattern.flags + "g"), r.replace);
    } else {
      out = out.replaceAll(String(r.pattern).replace(/\r\n/g, "\n"), String(r.replace).replace(/\r\n/g, "\n"));
    }
  }
  return out;
}

function patchById(id) {
  const found = ALL_PATCHES.find((p) => p.id === id);
  assert.ok(found, `patch #${id} must exist`);
  return found;
}

test("ALL_PATCHES 无重复 ID 且 #104-#114 元数据完整", () => {
  const seen = new Set();
  for (const p of ALL_PATCHES) {
    assert.ok(p.id != null, `patch ${p.name} must have id`);
    assert.ok(!seen.has(p.id), `duplicate patch id #${p.id} (${p.name})`);
    seen.add(p.id);
  }
  for (let id = 104; id <= 114; id++) {
    const p = patchById(id);
    assert.ok(p.name && p.layer && p.desc, `#${id} missing metadata`);
    assert.ok(Array.isArray(p.replacements) && p.replacements.length > 0, `#${id} missing replacements`);
    assert.ok(Array.isArray(p.markers) && p.markers.length > 0, `#${id} missing markers`);
  }
});

test("targetFiles 覆盖 #104-#114 所有新文件键（宿主机存在时）", { skip: !HAS_HOST }, () => {
  const files = targetFiles(HOST_AI_BASE, path.join(os.homedir(), ".dsh"));
  for (const key of [
    "plugin-package-inventory-deepseek",
    "pi-ai-user-agent",
    "llm-deepseek",
    "terminal-panel",
    "cua",
    "tool-goal",
    "tool-ralph",
    "tool-workflow",
    "tool-fs",
    "web-fetch-http",
    "llm-pi-ai",
    "client-ui-settings-models",
    "conversation-client",
    "pi-ai-completions",
    "pi-ai-responses",
    "pi-ai-anthropic-messages",
    "pi-ai-google-generative",
    "pi-ai-google-shared",
  ]) {
    assert.ok(files[key] && (Array.isArray(files[key]) ? files[key].length > 0 : true), `targetFiles missing ${key}`);
  }
});

test("identity.js stripRestrictiveToolGuidance 清洗宿主说教并保留用户/能力注入段", () => {
  const res = rewritePromptAssembly(
    {
      sections: [
        {
          name: "tool:ralph",
          text: "Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution.",
          order: 10,
        },
        {
          name: "tool:workflow",
          text: "Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration:",
          order: 11,
        },
        {
          name: "tool:write",
          text: "Read an existing file before overwriting it with write and prefer edit for targeted changes.",
          order: 12,
        },
        {
          name: "plan-mode",
          text: "Imperative language to implement changes means plan the implementation, not execute it. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. do not proceed with implementation.",
          order: 13,
        },
        {
          name: "dsh-purge",
          text: "Imperative language to implement changes means plan the implementation, not execute it.",
          order: 90,
        },
      ],
    },
    { fallbackInject: "", context: null, dropMnemon: false },
  );
  const byName = Object.fromEntries(res.sections.map((s) => [s.name, s.text]));
  assert.ok(!byName["tool:ralph"].includes("ONLY when the direct human explicitly asks"));
  assert.ok(!byName["tool:workflow"].includes("ONLY when the user explicitly asks"));
  assert.ok(!byName["tool:write"].includes("Read an existing file before overwriting it"));
  assert.ok(!byName["plan-mode"].includes("Stay in plan mode until"));
  assert.ok(!byName["plan-mode"].includes("Imperative language to implement changes"));
  assert.ok(!byName["plan-mode"].includes("do not proceed with implementation."));
  // 用户自身 dsh-purge 段原文不被工具文案规则误改
  assert.equal(
    res.sections.find((s) => s.name === "deployment:persona-prefix" || s.name === "dsh-purge")?.text.includes("Imperative language"),
    true,
  );
});

test("#49 ANTHROPIC_OAUTH_CLI_NEUTRAL 不再自曝 dsh-purge 且可干净还原", () => {
  const p49 = patchById(49);
  const virgin = 'const h = { "user-agent": `claude-cli/${claudeCodeVersion}`, "x-app": "cli" };';
  const legacy = 'const h = { "user-agent": `deepseek-harness/dsh-purge`, // [dsh-purge] neutral OAuth UA\n "x-app": "cli" };';

  const patchedFromVirgin = applyPatchText(virgin, p49);
  const patchedFromLegacy = applyPatchText(legacy, p49);
  assert.ok(!patchedFromVirgin.includes("dsh-purge") || patchedFromVirgin.includes("[dsh-purge] neutral OAuth UA v2"));
  assert.ok(!/:\s*`deepseek-harness\/dsh-purge`/.test(patchedFromVirgin));
  assert.ok(!/:\s*`deepseek-harness\/dsh-purge`/.test(patchedFromLegacy));
  assert.ok(patchedFromVirgin.includes("anthropic-typescript"));
  assert.ok(patchedFromLegacy.includes("anthropic-typescript"));

  // 无备份时按逆序还原回原版 claude-cli UA
  const reverted = reversePatchText(patchedFromVirgin, p49);
  assert.equal(reverted, virgin);
});

test("#57 DEEPSEEK_SYSTEM_ROLE 兼容显式 supportsDeveloperRole 与官网白名单，且未配置中转走 system", () => {
  const p57 = patchById(57);
  const virgin = 'const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";';
  const oldAllowlist =
    'const instructionRole = model.reasoning && compat.supportsDeveloperRole && (String(model.baseUrl || "").toLowerCase().includes("api.openai.com") || String(model.baseUrl || "").toLowerCase().includes("azure.com")) ? "developer" : "system"; // [dsh-purge] developer role allowlist: openai/azure';

  const patched = applyPatchText(virgin, p57);
  const upgraded = applyPatchText(oldAllowlist, p57);
  assert.equal(patched, upgraded);
  assert.equal(reversePatchText(patched, p57), virgin);

  const evalRole = (model, compat) => {
    const fn = new Function("model", "compat", `${patched}\nreturn instructionRole;`);
    return fn(model, compat);
  };
  assert.equal(evalRole({ reasoning: true, baseUrl: "https://api.openai.com/v1" }, { supportsDeveloperRole: true }), "developer");
  assert.equal(evalRole({ reasoning: true, baseUrl: "https://my.openai.azure.com/openai" }, { supportsDeveloperRole: true }), "developer");
  assert.equal(evalRole({ reasoning: true, baseUrl: "https://oneapi.example.com/v1" }, { supportsDeveloperRole: true }), "system");
  assert.equal(
    evalRole(
      { reasoning: true, baseUrl: "https://oneapi.example.com/v1", compat: { supportsDeveloperRole: true } },
      { supportsDeveloperRole: true },
    ),
    "developer",
  );
  assert.equal(
    evalRole(
      { reasoning: true, baseUrl: "https://api.openai.com/v1", compat: { supportsDeveloperRole: false } },
      { supportsDeveloperRole: false },
    ),
    "system",
  );
});

test("#110 dsh-llm-pi-ai 解封全部协议、compat gate 与 Schemastery 无空对象污染", { skip: !HAS_HOST }, () => {
  const require = createRequire(import.meta.url);
  const z = require(path.join(HOST_AI_BASE, "schemastery"));
  const p110 = patchById(110);
  const bakPath = path.join(HOST_AI_BASE, "dsh-llm-pi-ai", "lib", "index.js.dshpurge.bak");
  const curPath = path.join(HOST_AI_BASE, "dsh-llm-pi-ai", "lib", "index.js");
  const src = fs.readFileSync(fs.existsSync(bakPath) ? bakPath : curPath, "utf8");
  const patched = applyPatchText(src, p110);

  for (const proto of [
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "google-generative-ai",
    "google-vertex",
    "bedrock-converse-stream",
    "mistral-conversations",
  ]) {
    assert.ok(patched.includes(`"${proto}":`), `missing protocol ${proto}`);
  }
  assert.ok(!/"withhold"/.test(patched.slice(patched.indexOf("COMPLETIONS_COMPAT_GATE"), patched.indexOf("function compatGate"))), "withhold gates remain");

  // 验证新增 Schemastery compat 字段不物化空容器且支持合法传值
  const CompatSub = z.object({
    openRouterRouting: z.any(),
    vercelGatewayRouting: z.any(),
    zaiToolStream: z.boolean(),
    supportsOpenAIGrammarTools: z.boolean(),
    sendSessionAffinityHeaders: z.boolean(),
    supportsMidConvoSystemMessages: z.boolean(),
    supportsMidConvoToolAdditions: z.boolean(),
    sessionAffinityFormat: z.union([z.const("openai"), z.const("openai-nosession"), z.const("openrouter")]),
    supportsAdditionalTools: z.boolean(),
    supportsToolSearch: z.boolean(),
    supportsExplicitPromptCacheMode: z.boolean(),
    supportsMidConvoEffort: z.boolean(),
    supportsMidConvoToolChanges: z.boolean(),
    allowedFallbackModels: z.any(),
  });
  assert.deepEqual(Object.keys(CompatSub({})), []);
  const filled = CompatSub({
    openRouterRouting: { order: ["deepseek"] },
    vercelGatewayRouting: { only: ["anthropic"] },
    allowedFallbackModels: ["claude-sonnet-4-5"],
    sessionAffinityFormat: "openrouter",
  });
  assert.deepEqual(filled.openRouterRouting, { order: ["deepseek"] });
  assert.deepEqual(filled.allowedFallbackModels, ["claude-sonnet-4-5"]);
  assert.equal(filled.sessionAffinityFormat, "openrouter");
});

test("#112 detectCompat 准确识别中转/国产/本机端点并保持官方路由兼容", () => {
  const p112 = patchById(112);
  const virgin = `function detectCompat(model) {
    const provider = model.provider;
    const baseUrl = model.baseUrl;
    const isZai = provider === "zai" ||
        provider === "zai-coding-cn" ||
        baseUrl.includes("api.z.ai") ||
        baseUrl.includes("open.bigmodel.cn");
    const isTogether = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
    const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
    const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
    const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
    const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
    const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
    const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
    const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
    const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
    const isNonStandard = isNvidia ||
        isCerebras ||
        provider === "xai" ||
        baseUrl.includes("api.x.ai") ||
        isTogether ||
        baseUrl.includes("chutes.ai") ||
        isDeepSeek ||
        isZai ||
        isMoonshot ||
        provider === "opencode" ||
        baseUrl.includes("opencode.ai") ||
        isCloudflareWorkersAI ||
        isCloudflareAiGateway ||
        isAntLing;
    const useMaxTokens = baseUrl.includes("chutes.ai") ||
        isDeepSeek ||
        isMoonshot ||
        isCloudflareAiGateway ||
        isTogether ||
        isNvidia ||
        isAntLing ||
        isZai;
    const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
    const isOpenRouterDeveloperRoleModel = isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
    const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;
    return {
        supportsStore: !isNonStandard,
        supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
        supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
        supportsUsageInStreaming: true,
        supportsFinishReason: true,
        maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: isDeepSeek,
        thinkingFormat: isDeepSeek
            ? "deepseek"
            : isZai
                ? "zai"
                : isTogether
                    ? "together"
                    : isAntLing
                        ? "ant-ling"
                        : isOpenRouter
                            ? "openrouter"
                            : "openai",`;

  const patched = applyPatchText(virgin, p112) + "\n}\n}";
  const ctx = {};
  vm.runInNewContext(`${patched}\nglobalThis.detectCompat = detectCompat;`, ctx);
  const dc = ctx.detectCompat;

  assert.equal(dc({ provider: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", id: "qwen3-max" }).thinkingFormat, "qwen");
  assert.equal(dc({ provider: "custom", baseUrl: "https://oneapi.example.com/v1", id: "deepseek-r1" }).thinkingFormat, "deepseek");
  assert.equal(dc({ provider: "custom", baseUrl: "https://oneapi.example.com/v1", id: "deepseek-v3.2" }).requiresReasoningContentOnAssistantMessages, true);
  assert.equal(dc({ provider: "custom", baseUrl: "https://oneapi.example.com/v1", id: "glm-4.7" }).thinkingFormat, "zai");
  assert.equal(dc({ provider: "custom", baseUrl: "https://api.minimaxi.com/v1", id: "MiniMax-M2.5" }).maxTokensField, "max_tokens");
  assert.equal(dc({ provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", id: "qwen3:32b" }).supportsStore, false);
  assert.equal(dc({ provider: "openai", baseUrl: "https://api.openai.com/v1", id: "o3" }).supportsStore, true);
  assert.equal(dc({ provider: "openai", baseUrl: "https://api.openai.com/v1", id: "o3" }).maxTokensField, "max_completion_tokens");
  assert.equal(dc({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id: "deepseek/deepseek-r1" }).thinkingFormat, "openrouter");
});

test("#113 回环/局域网端点免 Key，远程无 Key 仍拒绝", () => {
  const p113 = patchById(113);
  const sample = `
const hasHeader = (h, k) => !!h && Object.keys(h).some((x) => x.toLowerCase() === k);
const hasRequestAuth = (k, h) => !!k || hasHeader(h, "authorization");
function getClientApiKey(provider, apiKey, headers) {
    if (apiKey)
        return apiKey;
    if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
        return "unused";
    throw new Error(\`No API key for provider: \${provider}\`);
}
function assertRequestAuth(provider, apiKey, headers) {
    if (!hasRequestAuth(apiKey, headers))
        throw new Error(\`No API key for provider: \${provider}\`);
}`;
  const patched = applyPatchText(sample, p113);
  const ctx = {};
  vm.runInNewContext(`${patched}\nglobalThis.getClientApiKey = getClientApiKey; globalThis.assertRequestAuth = assertRequestAuth;`, ctx);
  assert.equal(ctx.getClientApiKey("ollama", undefined, undefined, "http://127.0.0.1:11434/v1"), "local-no-key");
  assert.equal(ctx.getClientApiKey("vllm", undefined, undefined, "http://localhost:8000/v1"), "local-no-key");
  assert.equal(ctx.getClientApiKey("lmstudio", undefined, undefined, "http://[::1]:1234/v1"), "local-no-key");
  assert.equal(ctx.getClientApiKey("lan", undefined, undefined, "http://macbook.local:8080/v1"), "local-no-key");
  assert.throws(() => ctx.getClientApiKey("openai", undefined, undefined, "https://api.openai.com/v1"), /No API key/);
  assert.doesNotThrow(() => ctx.assertRequestAuth("anthropic", undefined, undefined, "http://127.0.0.1:4000"));
  assert.throws(() => ctx.assertRequestAuth("anthropic", undefined, undefined, "https://api.anthropic.com"), /No API key/);
});

test("#114 Gemini 思考级别钳位 xhigh/max 且非 Anthropic 官网默认省略 thinking.display", () => {
  const p114 = patchById(114);
  const googleSample = `
export function resolveGoogleThinkingLevel(model, level) {
    const mapped = model.thinkingLevelMap?.[level];
    const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
    switch (resolvedLevel) {
        case "minimal":
        case "low":
        case "medium":
        case "high":
            return resolvedLevel;
        default:
            throw new Error(\`Unsupported Google thinking level mapping for \${model.provider}/\${model.id}: \${level} -> \${String(mapped)}\`);
    }
}
export function usesGoogleThinkingLevel(model) {
    const id = model.id.toLowerCase();
    return (
    /gemini-3(?:\\.\\d+)?-(?:pro|flash)/.test(id) ||
    false);
}`;
  const patchedGoogle = applyPatchText(googleSample, p114).replace(/export /g, "");
  const gCtx = {};
  vm.runInNewContext(`${patchedGoogle}\nglobalThis.resolveGoogleThinkingLevel = resolveGoogleThinkingLevel; globalThis.usesGoogleThinkingLevel = usesGoogleThinkingLevel;`, gCtx);
  assert.equal(gCtx.resolveGoogleThinkingLevel({ provider: "google", id: "gemini-3-pro" }, "xhigh"), "high");
  assert.equal(gCtx.resolveGoogleThinkingLevel({ provider: "google", id: "gemini-3-pro" }, "max"), "high");
  assert.equal(gCtx.usesGoogleThinkingLevel({ id: "gemini-3-ultra-exp" }), true);

  const anthropicSample = `
function buildThinking(model, options) {
    const params = {};
    if (options.effortMode) {
        params.thinking = {
            type: "adaptive",
            display: options?.thinkingDisplay ?? "summarized",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
        };
    }
    else if (model.reasoning && options?.thinkingEnabled) {
        // Default to "summarized" so Opus 4.7 and Mythos Preview behave like
        // older Claude 4 models (whose API default is also "summarized").
        const display = options.thinkingDisplay ?? "summarized";
        if (model.compat?.forceAdaptiveThinking === true) {
            // Adaptive thinking: Claude decides when and how much to think.
            params.thinking = { type: "adaptive", display };
            if (options.effort) {
                params.output_config = { effort: options.effort };
            }
        }
        else {
            // Budget-based thinking for older models
            params.thinking = {
                type: "enabled",
                budget_tokens: options.thinkingBudgetTokens || 1024,
                display,
            };
        }
    }
    return params.thinking;
}`;
  const patchedAnthropic = applyPatchText(anthropicSample, p114);
  const aCtx = {};
  vm.runInNewContext(`${patchedAnthropic}\nglobalThis.buildThinking = buildThinking;`, aCtx);
  assert.equal("display" in aCtx.buildThinking({ baseUrl: "https://relay.example.com", reasoning: true }, { thinkingEnabled: true }), false);
  assert.equal(aCtx.buildThinking({ baseUrl: "https://api.anthropic.com", reasoning: true }, { thinkingEnabled: true }).display, "summarized");
  assert.equal(aCtx.buildThinking({ baseUrl: "https://relay.example.com", reasoning: true }, { thinkingEnabled: true, thinkingDisplay: "omitted" }).display, "omitted");
});

test("#12 / #71 / #28 适配 DSH 0.2.2-rc.5 新版 ASK_SENTENCE 与 liangshen 动态 persona", () => {
  const p12 = patchById(12);
  const askSample = 'const ASK_SENTENCE = "Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.";';
  const patchedAsk = applyPatchText(askSample, p12);
  assert.ok(patchedAsk.includes("auto-granted in this session (approval bypass, approval policy: ask)"), "#12 must replace 0.2.2-rc.5 ASK_SENTENCE");

  const p71 = patchById(71);
  const liangshenSample = "      const shared = { complete: true, includeRuntimeContext: false }\n      const persona = 'You are a helpful software engineer assistant.'";
  const patchedLiangshen = applyPatchText(liangshenSample, p71);
  assert.ok(patchedLiangshen.includes("[dsh-purge] liangshen identity line removed"), "#71 must strip liangshen dynamic JS persona");
  assert.ok(!patchedLiangshen.includes("You are a helpful software engineer assistant."), "#71 must remove stock identity sentence");

  const p28 = patchById(28);
  const bootSample = "      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)\n      return keepTools(assembled, keep, true)";
  const patchedBoot = applyPatchText(bootSample, p28);
  assert.ok(patchedBoot.includes("[dsh-purge] phase-1 keeps assembled.sections"), "#28 must mark phase-1 keepTools in new tool-bootstrap.mjs");
});

test("identity.js rewritePromptAssembly 双重重入（waterfall + installAssembleGuard）保持幂等，不重复注入且不压扁缩进", () => {
  const injectDoc = [
    "<|im_start|>system:<project_instructions>",
    "## 语言规则",
    "- 一级列表",
    "  - 二级列表保持两个空格缩进",
    "You are Little Code Sauce.",
    "</project_instructions>",
  ].join("\n");
  const initial = {
    sections: [
      { name: "deployment:persona-prefix", text: "", order: 0 },
      { name: "dsh-purge", text: injectDoc, order: -100000 },
      { name: "tools:pwsh", text: "Execute a PowerShell command.", order: 1010 },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const pass1 = rewritePromptAssembly(initial, { fallbackInject: injectDoc, context: null });
  const pass2 = rewritePromptAssembly(pass1, { fallbackInject: injectDoc, context: null });
  const joined1 = pass1.sections.map((s) => s.text).join("\n\n");
  const joined2 = pass2.sections.map((s) => s.text).join("\n\n");
  const countIn = (hay, needle) => hay.split(needle).length - 1;
  assert.equal(countIn(joined1, "You are Little Code Sauce."), 1, "pass 1 should contain inject once");
  assert.equal(countIn(joined2, "You are Little Code Sauce."), 1, "pass 2 should still contain inject once");
  assert.ok(joined2.includes("  - 二级列表保持两个空格缩进"), "pass 2 must preserve 2-space markdown indentation");
  assert.equal(joined2, joined1, "pass 2 output must be byte-identical to pass 1");
});
