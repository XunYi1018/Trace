/**
 * dsh-purge 演练台自举（host 半侧）
 *
 * 资产库、工具、预设、技能都在本插件目录内。本文件负责：
 *   1. 首次把 `presets/redteam` 落到 `$DSH_HOME/.agent-presets/redteam/`
 *   2. 随包技能落到 `$DSH_HOME/redteam/skills`，预设用 `dshHomePath` 指向它
 *   3. 已有用户预设时只修失效路径 / 旧包名，不整份覆盖
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'
import { clearOwnedSelectedDefault } from '../preset-default.js'

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam'

/** 与梁神一致：不硬依赖 agentPresets，就绪后软取并声明。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
const REDTEAM_PRESET_ID = 'redteam'

/** 插件根目录（lib/redteam → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills', 'redteam'),
    setupScript: join(root, 'scripts', 'redteam-setup.sh'),
  }
}

/** `$DSH_HOME` 可能是插件 env，也可能是 `homedir()/.dsh`。两边都在就都修。 */
function dshHomeCandidates() {
  const out = []
  const push = (p) => {
    if (!p) return
    const n = String(p).replace(/[\\/]+$/, '')
    if (!n || !existsSync(n)) return
    const key = n.replace(/\\/g, '/').toLowerCase()
    if (out.some((x) => x.replace(/\\/g, '/').toLowerCase() === key)) return
    out.push(n)
  }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

/** 环境数据目录（与 store/tools 用的同一份约定）。 */
export function redteamDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * 把随包分发的环境安装脚本落到 `$DSH_HOME/redteam/setup.sh`。
 *
 * 市场包用户装完只有 node_modules，仓库不在盘上；预检若只说"从仓库取脚本"，
 * 用户拿不到脚本、首次引导就断了。所以脚本随包走，启动时落一份可执行的副本。
 * 语义：目标不存在 → 装；已存在但内容不同 → 覆盖（脚本无用户可改状态）；
 *       内容相同 → 不动（避免每次启动都写盘）。
 *
 * @returns `{ action: 'installed'|'updated'|'kept'|'missing', path }`
 */
export function installSetupScript() {
  const paths = packagePaths()
  const primary = join(redteamDataDir(), 'setup.sh')
  if (!existsSync(paths.setupScript)) return { action: 'missing', path: primary }
  let wanted
  try {
    wanted = readFileSync(paths.setupScript, 'utf8')
  } catch {
    return { action: 'missing', path: primary }
  }
  const writeOne = (target) => {
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      let current
      try { current = readFileSync(target, 'utf8') } catch { current = '' }
      if (current === wanted) {
        try { chmodSync(target, 0o755) } catch { /* 忽略 */ }
        return 'kept'
      }
      writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
      return 'updated'
    }
    writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
    return 'installed'
  }
  try {
    const homes = dshHomeCandidates()
    const targets = homes.length
      ? homes.map((home) => join(home, 'redteam', 'setup.sh'))
      : [primary]
    let action = 'kept'
    for (const target of targets) {
      const one = writeOne(target)
      if (one === 'installed' && action === 'kept') action = 'installed'
      if (one === 'updated') action = 'updated'
    }
    return { action, path: primary }
  } catch (error) {
    return { action: 'missing', path: primary, error: error && error.message ? error.message : String(error) }
  }
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 预设模板里技能目录的占位符（build.mjs 写进打包预设，落地时才替换）。
 * 扩展名等都不允许写成别的形式，否则替换会漏。
 */
const SKILLS_PLACEHOLDER = '{{REDTEAM_SKILLS_DIR}}'

/** customSkillDirs 里"像本包 skills/ 目录"的那一行（老的绝对路径 / 占位符都算）。 */
function isSkillsDirLine(line) {
  const text = line.trim().replace(/^-\s*/, '')
  if (text === SKILLS_PLACEHOLDER) return true
  return /[/\\](dsh-redteam-mode|redteam-bundle)[/\\]skills\/?$/.test(text)
    || /[/\\]vendor[/\\]redteam[/\\]skills\/?$/.test(text)
    || /[/\\]skills[/\\]redteam\/?$/.test(text)
}

/** 预设里随包技能那一行。加载时按当前 DSH_HOME 解析，不写本机绝对路径。 */
const BUNDLED_SKILLS_EXPR = "!!js dshHomePath('redteam/skills')"

/**
 * 把占位符或写死的本机路径改成 `dshHomePath('redteam/skills')`。
 *
 * 占位符留在 YAML 里会被解析成对象，整个预设挂不上。写死
 * `profiles/desktop/node_modules/...` 又只在这一台桌面安装上成立，
 * Web、另一台机器、换过安装位置都会指空。技能文件由 installBundledSkills
 * 放到 `$DSH_HOME/redteam/skills`。
 */
function renderSkillsDir(text) {
  if (text.includes(SKILLS_PLACEHOLDER)) {
    return { text: text.split(SKILLS_PLACEHOLDER).join(BUNDLED_SKILLS_EXPR), changed: true, reason: 'placeholder' }
  }
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!isSkillsDirLine(line)) return line
    const indent = /^(\s*)/.exec(line)[1]
    const wanted = indent + '- ' + BUNDLED_SKILLS_EXPR
    if (line === wanted) return line
    changed = true
    return wanted
  }).join('\n')
  return { text: out, changed, reason: changed ? 'stale-path' : 'none' }
}

/**
 * 技能同步目标目录（第一个是主目标，其余是"顺手补一份"）。
 *
 * `$DSH_HOME` 有两个可能来源：插件进程的 `process.env.DSH_HOME || homedir()/.dsh`，
 * 与宿主 `dshHomePath()` 解析出的 home。换盘 / 换 profile / `HOME` 为空的机器上两者
 * 会分叉 —— 技能只落到一边，预设指向另一边时就是"装了却列不出来 / 显示不可用"。
 * 所以：主目标必写，另外那个候选 home 只要在本机真实存在就补一份（不凭空造 home）。
 */
function skillSyncTargets() {
  const primary = join(redteamDataDir(), 'skills')
  const dirs = [primary]
  for (const home of dshHomeCandidates()) {
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

function existingRedteamPresetFiles() {
  return dshHomeCandidates()
    .map((home) => join(home, '.agent-presets', 'redteam', 'agent.cordis.yml'))
    .filter((fp) => existsSync(fp))
}

/**
 * 把包内 `skills/redteam/*.md` 同步到 `$DSH_HOME/redteam/skills`（分叉时两个 home 都放一份）。
 * 同名文件按包内内容覆盖。用户自己的副本在 `$DSH_HOME/skills`，不在这里改。
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/** 从独立红队包迁进 dsh-purge 后，预设里的工具行包名要跟着改。 */
function renderToolsPackage(text) {
  if (!text.includes('dsh-redteam-mode/tools')) {
    return { text, changed: false }
  }
  return {
    text: text.split('dsh-redteam-mode/tools').join('dsh-purge/redteam/tools'),
    changed: true,
  }
}

/**
 * 0.2.1 `dsh-tool-subagent` 看见 config.toolFilter 就抛错，整份预设 registered-broken。
 * 只剥这个键及其嵌套 allow/deny，其余预设正文不动。
 */
function stripDeprecatedToolFilter(text) {
  const src = String(text || "")
  const nl = src.includes("\r\n") ? "\r\n" : "\n"
  const lines = src.split(/\r?\n/)
  const out = []
  let skipping = -1
  let changed = false
  for (const line of lines) {
    if (skipping >= 0) {
      if (!line.trim()) continue
      const indent = line.match(/^([ \t]*)/)[1].length
      if (indent > skipping) continue
      skipping = -1
    }
    const key = line.match(/^([ \t]*)toolFilter:[ \t]*(?:#.*)?$/)
    if (key) {
      changed = true
      skipping = key[1].length
      continue
    }
    if (/^[ \t]*toolFilter:[ \t]+[^#\s]/.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  if (!changed) return { text: src, changed: false }
  return { text: out.join(nl), changed: true }
}

/** 0.2 子会话一旦另选 Claude，官方身份在原生槽、注入算越狱。只锁 spawn 叶子，不动 fork。 */
function disableSubagentModelSelection(text) {
  const src = String(text || "")
  const idLine = "- id: tool-subagent"
  let next = src
  let changed = false
  let from = 0
  while (from < next.length) {
    const at = next.indexOf(idLine, from)
    if (at < 0) break
    const endId = at + idLine.length
    const ch = next[endId] || "\n"
    if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
      from = endId
      continue
    }
    const rest = next.slice(endId)
    const endRel = rest.search(/\n[ \t]*- id: /)
    const block = endRel < 0 ? rest : rest.slice(0, endRel)
    if (!/toolName:\s*(?:subagent\b|['"]subagent['"])/.test(block)) {
      from = endId + block.length
      continue
    }
    let patched = block
    if (/modelSelectionSettings:\s*(?:true\b|['"]true['"])/.test(patched)) {
      patched = patched.replace(/modelSelectionSettings:\s*(?:true\b|['"]true['"])/, "modelSelectionSettings: false")
    } else if (!/modelSelectionSettings\s*:/.test(patched)) {
      patched = patched.replace(
        /^([ \t]+)toolName:\s*(?:subagent\b|['"]subagent['"])[^\n]*/m,
        (line, indent) => `${line}\n${indent}modelSelectionSettings: false`,
      )
    }
    if (patched !== block) {
      next = next.slice(0, endId) + patched + next.slice(endId + block.length)
      changed = true
      from = endId + patched.length
      continue
    }
    from = endId + block.length
  }
  return { text: next, changed }
}

/**
 * 自愈：指挥职责标题 + 在 Agent Teams profile 下强制重新启用 classic subagent。
 * 顺手剥掉 0.2.1 已废弃的 toolFilter。不整份覆盖用户预设。
 */
function repairDelegation(text) {
  let next = String(text || "")
  let delegationChanged = false
  if (next.includes("## 你是谁、你不做什么")) {
    next = next.split("## 你是谁、你不做什么").join("## 指挥职责（硬约束）")
    delegationChanged = true
  }
  const mark = "**必须用原生 `subagent` 工具派活**"
  if (next.includes("## 指挥职责") && !next.includes(mark)) {
    const needle = "`redteam_session_info`。"
    const at = next.indexOf(needle)
    if (at >= 0) {
      next =
        next.slice(0, at + needle.length) +
        "\n      " + mark +
        "；不要改用 Agent Teams 的 `spawn_teammate`（红队角色稿 / 并发闸门 / 叶子约束都挂在 `subagent` 路径上）。" +
        next.slice(at + needle.length)
      delegationChanged = true
    }
  }
  for (const id of [
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork",
  ]) {
    const idLine = `- id: ${id}`
    let from = 0
    while (from < next.length) {
      const at = next.indexOf(idLine, from)
      if (at < 0) break
      const endId = at + idLine.length
      const ch = next[endId] || "\n"
      // 避免 tool-subagent 误匹配 tool-subagent-control / fork / codex
      if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
        from = endId
        continue
      }
      const after = endId
      const rest = next.slice(after)
      const endRel = rest.search(/\n[ \t]*- id: /)
      const block = endRel < 0 ? rest : rest.slice(0, endRel)
      if (/disabled:\s*false/.test(block)) break
      if (/disabled:\s*true/.test(block)) {
        const patched = block.replace(/disabled:\s*true/, "disabled: false")
        next = next.slice(0, after) + patched + next.slice(after + block.length)
        delegationChanged = true
        break
      }
      const indentMatch = /\n([ \t]+)name:/.exec(block)
      const indent = indentMatch ? indentMatch[1] : "      "
      next = next.slice(0, after) + `\n${indent}disabled: false` + next.slice(after)
      delegationChanged = true
      break
    }
  }
  const stripped = stripDeprecatedToolFilter(next)
  if (stripped.changed) next = stripped.text
  const locked = disableSubagentModelSelection(next)
  if (locked.changed) next = locked.text
  const composition = repairComposition(next)
  if (composition.changed) next = composition.text
  return {
    text: next,
    changed: delegationChanged || stripped.changed || locked.changed || composition.changed,
    delegationChanged,
    strippedToolFilter: stripped.changed,
    lockedModelSelection: locked.changed,
    compositionChanged: composition.changed,
  }
}

function addRequireCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function hostRequireCandidates() {
  const list = []
  try {
    considerBinRequire(list, process.argv[1])
  } catch { /* ignore */ }
  for (const home of dshHomeCandidates()) {
    addRequireCandidate(list, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default', 'headless']) {
      addRequireCandidate(list, join(home, 'profiles', profile, 'package.json'))
      addRequireCandidate(list, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  addRequireCandidate(list, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addRequireCandidate(list, join('D:', 'DeepseekHarnessDesktop', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return list
}

function considerBinRequire(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addRequireCandidate(list, `${text.slice(0, at + needle.length - 1)}/package.json`)
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addRequireCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  addRequireCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addRequireCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function hostHasPackage(id) {
  for (const pkg of hostRequireCandidates()) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      createRequire(pkg).resolve(id)
      return true
    } catch { /* try next */ }
  }
  try {
    createRequire(import.meta.url).resolve(id)
    return true
  } catch {
    return false
  }
}

let workflowCapCtx = null

/**
 * 红队组合里的 workflow 行一旦缺包 / 缺 ptcRuntime，Cordis 会一直 pending。
 * 宿主 registry.list() 会等每一个预设的 mount，于是标准/PTC/极简也会从下拉里消失。
 */
function detectWorkflowCaps() {
  const ptc = hostHasPackage('@deepseek-ai/dsh-workflow-ptc')
  const runtimePkg = hostHasPackage('@deepseek-ai/dsh-ptc-runtime-node')
    || hostHasPackage('@deepseek-ai/dsh-ptc-runtime')
  const worker = hostHasPackage('@deepseek-ai/dsh-workflow-worker-thread')
  const tool = hostHasPackage('@deepseek-ai/dsh-tool-workflow')
  let runtimeLive = null
  const ctx = workflowCapCtx
  if (ctx && typeof ctx.get === 'function') {
    try { runtimeLive = ctx.get('ptcRuntime') != null } catch { runtimeLive = false }
  }
  const ptcOk = ptc && (runtimeLive === true || (runtimeLive === null && runtimePkg))
  const engine = ptcOk ? 'ptc' : worker ? 'worker' : 'none'
  return {
    ptc: engine === 'ptc',
    worker: engine === 'worker',
    tool: engine !== 'none' && tool,
  }
}

function rowBlockBounds(text, id, from = 0) {
  const idLine = `- id: ${id}`
  const at = text.indexOf(idLine, from)
  if (at < 0) return null
  const endId = at + idLine.length
  const ch = text[endId] || '\n'
  if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') {
    return rowBlockBounds(text, id, endId)
  }
  const rest = text.slice(endId)
  const endRel = rest.search(/\n[ \t]*- id: /)
  const block = endRel < 0 ? rest : rest.slice(0, endRel)
  return { at, endId, block }
}

function setRowDisabled(text, id, disabled) {
  const hit = rowBlockBounds(text, id)
  if (!hit) return { text, changed: false }
  const want = disabled ? 'true' : 'false'
  if (new RegExp(`disabled:\\s*${want}\\b`).test(hit.block)) return { text, changed: false }
  let patched = hit.block
  if (/disabled:\s*(true|false)/.test(patched)) {
    patched = patched.replace(/disabled:\s*(true|false)/, `disabled: ${want}`)
  } else {
    const indentMatch = /\n([ \t]+)name:/.exec(patched)
    const indent = indentMatch ? indentMatch[1] : '      '
    if (/name:/.test(patched)) {
      patched = patched.replace(
        /(name:\s*'[^']+'[^\n]*)/,
        `$1\n${indent}disabled: ${want}`,
      )
    } else {
      patched = `\n${indent}disabled: ${want}` + patched
    }
  }
  if (patched === hit.block) return { text, changed: false }
  return {
    text: text.slice(0, hit.endId) + patched + text.slice(hit.endId + hit.block.length),
    changed: true,
  }
}

function readWorkflowPtcFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return ''
  }
  const start = template.indexOf('    - id: workflow-ptc')
  if (start < 0) return ''
  const rest = template.slice(start)
  const next = rest.slice(1).search(/\n    - id: /)
  return (next < 0 ? rest : rest.slice(0, next + 1)).trimEnd()
}

function insertWorkflowPtcInGroup(text) {
  if (/\bid:\s*workflow-ptc\b/.test(text)) return { text, changed: false }
  const block = readWorkflowPtcFromTemplate()
  if (!block) return { text, changed: false }
  const needle = '- id: tool-workflow'
  const at = text.indexOf(needle)
  if (at < 0) return { text, changed: false }
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const rendered = block.endsWith('\n') ? block : `${block}\n`
  return {
    text: `${text.slice(0, lineStart)}${rendered}\n${text.slice(lineStart)}`,
    changed: true,
  }
}

function repairComposition(text) {
  let next = String(text || '')
  let changed = false
  const caps = detectWorkflowCaps()
  if (caps.ptc) {
    const inserted = insertWorkflowPtcInGroup(next)
    if (inserted.changed) {
      next = inserted.text
      changed = true
    }
  }
  const rows = [
    ['workflow-ptc', !caps.ptc],
    ['workflow-worker-thread', !caps.worker],
    ['tool-workflow', !caps.tool],
    ['tool-ralph', true],
  ]
  for (const [id, disabled] of rows) {
    const patched = setRowDisabled(next, id, disabled)
    if (patched.changed) {
      next = patched.text
      changed = true
    }
  }
  return { text: next, changed }
}

/** 包内锚点门相对预设模板的标记，用来给已有用户预设补一行，不整份覆盖。 */
const ANCHOR_ROW_MARK = '- id: anchor-gate'
const ANCHOR_BLOCK_START = '# 锚点门'
const REDTEAM_TOOLS_MARK = '- id: redteam-tools'

function anchorBlockBounds(ymlText) {
  const start = ymlText.indexOf(ANCHOR_BLOCK_START)
  const end = ymlText.indexOf(REDTEAM_TOOLS_MARK)
  if (start === -1 || end === -1 || start >= end) return null
  return { start, end }
}

function readAnchorBlockFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return null
  }
  const bounds = anchorBlockBounds(template)
  if (!bounds) return null
  return template.slice(bounds.start, bounds.end).trim()
}

/**
 * 锚点门脚本每次用包内副本覆盖（没有用户可改状态）。
 * YAML 里锚点配置块与包内模板不一致时也会替换（bootstrapMaxTokens 等），其余 preset 正文保留。
 * @returns {'inserted'|'updated'|'config-updated'|'kept'|'missing'}
 */
function syncAnchorGate(targetDir) {
  const src = join(packagePaths().presetDir, 'anchor-gate.mjs')
  const dest = join(targetDir, 'anchor-gate.mjs')
  if (!existsSync(src)) return 'missing'
  mkdirSync(targetDir, { recursive: true })
  const wanted = readFileSync(src, 'utf8')
  let current = ''
  try { current = readFileSync(dest, 'utf8') } catch { current = '' }
  let script = 'kept'
  if (current !== wanted) {
    writeFileSync(dest, wanted, 'utf8')
    script = 'updated'
  }
  const presetFile = join(targetDir, 'agent.cordis.yml')
  if (!existsSync(presetFile)) return script
  let text
  try { text = readFileSync(presetFile, 'utf8') } catch { return script }
  const templateBlock = readAnchorBlockFromTemplate()
  if (!templateBlock) return script
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = templateBlock.replace(/\r\n/g, '\n').replace(/\n/g, nl)

  if (text.includes(ANCHOR_ROW_MARK)) {
    const bounds = anchorBlockBounds(text)
    if (!bounds) return script
    const currentBlock = text.slice(bounds.start, bounds.end).trim()
    if (currentBlock === rendered.trim()) return script
    const next = text.slice(0, bounds.start) + rendered + nl + nl + text.slice(bounds.end)
    writeFileSync(presetFile, next, 'utf8')
    return script === 'updated' ? 'updated' : 'config-updated'
  }

  const at = text.indexOf(REDTEAM_TOOLS_MARK)
  const next = at === -1
    ? text.replace(/\s*$/, '') + nl + nl + rendered + nl
    : text.slice(0, at) + rendered + nl + nl + text.slice(at)
  writeFileSync(presetFile, next, 'utf8')
  return 'inserted'
}

function samePath(a, b) {
  return String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase()
}

function repairExistingPresetFile(presetFile, log) {
  let text
  try {
    text = readFileSync(presetFile, 'utf8')
  } catch (error) {
    log(`读取 ${presetFile} 失败：${error && error.message ? error.message : String(error)}`)
    return { action: 'kept', repaired: [] }
  }
  const rendered = renderSkillsDir(text)
  const tools = renderToolsPackage(rendered.text)
  const delegation = repairDelegation(tools.text)
  const notes = []
  if (rendered.changed || tools.changed || delegation.changed) {
    writeFileSync(presetFile, delegation.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
    if (rendered.changed) {
      notes.push(rendered.reason === 'placeholder'
        ? '预设里还留着 ' + SKILLS_PLACEHOLDER + '（会导致整个预设挂载失败），已改为 dshHomePath(\'redteam/skills\')'
        : '预设里的技能目录写成了本机绝对路径，已改为 dshHomePath(\'redteam/skills\')')
    }
    if (tools.changed) notes.push('工具包名已改为 dsh-purge/redteam/tools')
    if (delegation.strippedToolFilter) notes.push('已移除 0.2.1 已废弃的 toolFilter')
    if (delegation.lockedModelSelection) notes.push('子代理已锁成父模型')
    if (delegation.compositionChanged) notes.push('已按本机宿主开关 workflow 引擎（缺包就关掉，避免模式下拉被抽空）')
    if (delegation.delegationChanged) notes.push('已修复指挥派活约束 / 重新启用 subagent')
    if (notes.length) log(`${presetFile}：${notes.join('；')}`)
  }
  const targetDir = dirname(presetFile)
  const anchor = syncAnchorGate(targetDir)
  if (anchor === 'inserted') log(`已把锚点门补进现有预设 ${targetDir}（其余内容保留）`)
  else if (anchor === 'updated') log(`已更新锚点门脚本 ${targetDir}`)
  else if (anchor === 'config-updated') log(`已同步锚点门配置 ${targetDir}`)
  const repaired = [
    rendered.changed ? rendered.reason : null,
    tools.changed ? 'tools-package' : null,
    delegation.strippedToolFilter ? 'toolFilter' : null,
    delegation.lockedModelSelection ? 'model-lock' : null,
    delegation.compositionChanged ? 'composition' : null,
    delegation.delegationChanged ? 'delegation' : null,
    anchor === 'inserted' ? 'anchor-gate' : null,
    anchor === 'updated' ? 'anchor-script' : null,
    anchor === 'config-updated' ? 'anchor-config' : null,
  ].filter(Boolean)
  return { action: repaired.length > 0 ? 'repaired' : 'kept', repaired }
}

function writePresetTemplate(target, log, skillCount, bundledPath) {
  const paths = packagePaths()
  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    let rendered = renderToolsPackage(renderSkillsDir(text).text).text
    if (/\.ya?ml$/i.test(file)) rendered = repairDelegation(rendered).text
    rendered = rendered.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    writeFileSync(join(target, file), rendered, 'utf8')
  }
  syncAnchorGate(target)
  log(`预设已安装到 ${target}（随包技能 ${skillCount} 个，目录 ${bundledPath}）`)
}

/**
 * 把包内预设落地到用户 preset 根。
 *
 * `$DSH_HOME` 与 `homedir()/.dsh` 会分叉。只修一边，另一边的 toolFilter /
 * modelSelectionSettings 会在下次启动原样复发。已有副本全部就地自愈，
 * 只把完整模板写到当前进程的主 home。
 *
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept'|'repaired', dir, skillsDir, skills, repaired? }`
 */
export function installPreset(options = {}) {
  const prevCapCtx = workflowCapCtx
  if (Object.prototype.hasOwnProperty.call(options, 'ctx')) workflowCapCtx = options.ctx || null
  try {
    return installPresetBody(options)
  } finally {
    workflowCapCtx = prevCapCtx
  }
}

function installPresetBody(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const primaryDir = join(userPresetRoot(), 'redteam')
  const primaryFile = join(primaryDir, 'agent.cordis.yml')
  const existing = existingRedteamPresetFiles()
  const uniqueTags = (rows) => [...new Set(rows.flatMap((row) => row.repaired))]

  if (options.force === true) {
    writePresetTemplate(primaryDir, log, skillCount, bundled.path)
    const others = existing
      .filter((fp) => !samePath(fp, primaryFile))
      .map((fp) => repairExistingPresetFile(fp, log))
    const repaired = uniqueTags(others)
    return {
      action: 'installed',
      dir: primaryDir,
      skillsDir: bundled.path,
      skills: skillCount,
      ...(repaired.length ? { repaired: repaired.join('+') } : {}),
    }
  }

  if (existing.length > 0) {
    const rows = existing.map((fp) => repairExistingPresetFile(fp, log))
    if (!existsSync(primaryFile)) {
      writePresetTemplate(primaryDir, log, skillCount, bundled.path)
      const repaired = uniqueTags(rows)
      return {
        action: 'installed',
        dir: primaryDir,
        skillsDir: bundled.path,
        skills: skillCount,
        ...(repaired.length ? { repaired: repaired.join('+') } : {}),
      }
    }
    const repaired = uniqueTags(rows)
    if (repaired.length > 0) {
      return {
        action: 'repaired',
        dir: primaryDir,
        skillsDir: bundled.path,
        skills: skillCount,
        repaired: repaired.join('+'),
      }
    }
    log(`已存在用户自己的预设 ${primaryDir}，保留不动（要覆盖：REDTEAM_PRESET_REFRESH=1 启动一次）`)
    return { action: 'kept', dir: primaryDir, skillsDir: bundled.path, skills: skillCount }
  }

  writePresetTemplate(primaryDir, log, skillCount, bundled.path)
  return { action: 'installed', dir: primaryDir, skillsDir: bundled.path, skills: skillCount }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1',
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
      ctx,
    })
  } catch (error) {
    ctx.logger?.error?.('redteam-mode: 预设安装失败：%s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: join(redteamDataDir(), 'skills'), skills: 0 }
  }
  let setupResult
  try {
    setupResult = installSetupScript()
  } catch (error) {
    setupResult = { action: 'missing', error: error && error.message ? error.message : String(error) }
  }
  if (setupResult.action === 'installed' || setupResult.action === 'updated') {
    ctx.logger?.info?.('redteam-mode: 环境安装脚本已就位 %s（%s）', setupResult.path, setupResult.action)
  }
  void import('./bootstrap-runtime.js').then((mod) => (
    mod.ensureRedteamRuntime({ download: true, background: true })
  )).then((rt) => {
    ctx.logger?.info?.('redteam-mode: 运行时知识库 %s，nuclei 模板 %s', rt.knowledgePath, rt.templates)
  }).catch((error) => {
    ctx.logger?.warn?.('redteam-mode: 运行时适配失败：%s', error && error.message ? error.message : String(error))
  })

  /*
   * Web 0.1.7+ 模式下拉只认 agent-preset registry.register()，
   * 扫磁盘 .agent-presets 不会出现在下拉里（梁神同款）。
   */
  const statusFile = join(redteamDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(redteamDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('redteam-mode: undeclare failed: %s', error?.message || String(error))
    }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), 'redteam')
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {}, ctx })
    }
    const readyDir = existsSync(join(userPresetRoot(), 'redteam', 'agent.cordis.yml'))
      ? join(userPresetRoot(), 'redteam')
      : paths.presetDir
    return readPresetDefinition(REDTEAM_PRESET_ID, readyDir)
  }
  const registerOnce = (registry) => {
    let definition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('redteam-mode: read preset failed: %s', error?.message || String(error))
      return
    }
    writeStatus({
      ok: false,
      phase: 'registering',
      id: definition.id,
      name: definition.name,
      plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
    })
    Promise.resolve()
      .then(async () => {
        let broken = null
        let current = definition
        for (let round = 0; round < 2; round += 1) {
          if (round === 1) {
            try { installPreset({ force: false, log: () => {}, ctx }) } catch { /* 再自愈一次 */ }
            current = buildDefinition()
          }
          await undeclare()
          releaseDeclared = await registry.register(current)
          broken = null
          try {
            const row = (await registry.list()).find((p) => p.id === REDTEAM_PRESET_ID)
            broken = row?.broken || null
          } catch { /* ignore */ }
          if (!broken) break
        }
        writeStatus({
          ok: !broken,
          phase: broken ? 'registered-broken' : 'registered',
          id: current.id,
          name: current.name,
          plugins: Array.isArray(current.plugins) ? current.plugins.length : -1,
          broken,
        })
        if (broken) ctx.logger?.warn?.('redteam-mode: declared but broken: %s', broken)
        else ctx.logger?.info?.('redteam-mode: declared for mode dropdown: %s', current.name || REDTEAM_PRESET_ID)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('redteam-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
      try { clearOwnedSelectedDefault({ ctx }) } catch { /* 清默认失败不挡停用 */ }
    }
  }, 'dsh-purge-redteam: declare agent preset')

  ctx.provide('redteamMode', Object.freeze({ paths, preset: result, setup: setupResult }))
  ctx.logger?.info?.(
    'redteam-mode: 就绪（数据目录默认 $DSH_HOME/redteam；预设 %s；技能目录 %s）',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
