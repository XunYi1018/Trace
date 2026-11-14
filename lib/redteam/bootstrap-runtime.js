/**
 * 点「应用」/宿主启动时把红队数据目录铺好：知识库、工具箱路径、nuclei 模板。
 * Windows 不能跑 setup.sh，所以这里用 Node 做同等的本机适配。
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractZipArchive } from '../zip-extract.js'
import { HAS_FTS5, KNOWLEDGE_DDL, POC_FTS_DDL, migrateKnowledge } from './schema.js'
import {
  loadPlatformConfig, resolveAllTools, savePlatformConfig, scanFolderForTools,
} from './platform-config.js'

const GIT_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates.git',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates.git',
]

const TAR_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.tar.gz',
  'https://codeload.github.com/projectdiscovery/nuclei-templates/tar.gz/refs/heads/main',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.tar.gz',
]

const ZIP_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
  'https://mirror.ghproxy.com/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
]

function collectHomes() {
  const homes = []
  const push = (home) => {
    const dir = String(home || '').trim()
    if (!dir || homes.includes(dir)) return
    homes.push(dir)
  }
  push(process.env.DSH_HOME)
  if (process.platform === 'darwin') {
    push(join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'dsh-home'))
  }
  const fallback = join(homedir(), '.dsh')
  if (existsSync(fallback) || !homes.length) push(fallback)
  return homes.filter((home, i) => i === 0 || existsSync(home))
}

function logLine(root, msg) {
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(join(root, 'bootstrap.log'), new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch { /* 日志失败不挡应用 */ }
}

function countYaml(dir, cap = 80) {
  if (!dir || !existsSync(dir)) return 0
  let n = 0
  const walk = (base, depth) => {
    if (n >= cap || depth > 6) return
    let entries = []
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (n >= cap) return
      const next = join(base, entry.name)
      if (entry.isDirectory()) walk(next, depth + 1)
      else if (/\.ya?ml$/i.test(entry.name)) n += 1
    }
  }
  walk(dir, 0)
  return n
}

function looksLikeTemplates(dir) {
  if (!dir || !existsSync(dir)) return false
  try {
    if (existsSync(join(dir, 'http')) || existsSync(join(dir, 'ssl')) || existsSync(join(dir, 'dns'))) return true
  } catch { /* ignore */ }
  return countYaml(dir, 20) >= 20
}

function discoverTemplates(homes) {
  const extra = [
    join(homedir(), '.local', 'nuclei-templates'),
    join(homedir(), 'nuclei-templates'),
    join(homedir(), 'AppData', 'Local', 'nuclei-templates'),
    '/usr/share/nuclei-templates',
    '/opt/nuclei-templates',
  ]
  const cands = []
  for (const home of homes) {
    const root = join(home, 'redteam')
    cands.push(join(root, 'toolkit', 'nuclei-templates'))
    try {
      const cfg = loadPlatformConfig(root)
      if (cfg.nucleiTemplatesDir) cands.push(cfg.nucleiTemplatesDir)
    } catch { /* ignore */ }
  }
  for (const dir of [...cands, ...extra]) {
    if (looksLikeTemplates(dir)) return dir
  }
  return ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function moveDir(src, dest) {
  if (looksLikeTemplates(dest)) return
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, '..'), { recursive: true })
  try {
    renameSync(src, dest)
  } catch {
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

function innerTemplatesDir(extracted) {
  if (looksLikeTemplates(extracted)) return extracted
  let entries = []
  try { entries = readdirSync(extracted, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const next = join(extracted, entry.name)
    if (looksLikeTemplates(next)) return next
  }
  return ''
}

function tryLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    if (existsSync(lockPath)) {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (Date.now() - Number(raw.at || 0) < 10 * 60 * 1000) return false
      unlinkSync(lockPath)
    }
  } catch {
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch { /* ignore */ }
}

function downloadFile(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const visit = (target, hops) => {
      if (hops > 6) {
        reject(new Error('redirect'))
        return
      }
      const lib = target.startsWith('http:') ? http : https
      const req = lib.get(target, {
        headers: { 'User-Agent': 'dsh-purge-redteam' },
      }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          visit(new URL(res.headers.location, target).href, hops + 1)
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error('HTTP ' + code))
          return
        }
        const out = createWriteStream(dest)
        res.pipe(out)
        out.on('finish', () => resolve(dest))
        out.on('error', reject)
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('timeout'))
      })
      req.on('error', reject)
    }
    visit(url, 0)
  })
}

function runHidden(file, args, timeoutMs, extra = {}) {
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: timeoutMs,
    ...extra,
  })
}

function gitCloneTemplates(url, dest, timeoutMs) {
  const staging = join(tmpdir(), 'dsh-purge-nuclei-git-' + process.pid)
  rmSync(staging, { recursive: true, force: true })
  runHidden('git', [
    'clone', '--depth', '1', '--single-branch', '--branch', 'main', url, staging,
  ], timeoutMs, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const inner = innerTemplatesDir(staging)
  if (!inner) throw new Error('git clone 里没有模板')
  moveDir(inner, dest)
  if (inner !== staging) rmSync(staging, { recursive: true, force: true })
  if (!looksLikeTemplates(dest)) throw new Error('git clone 不完整')
  return dest
}

function extractArchive(archive, dest, timeoutMs, gzip) {
  mkdirSync(dest, { recursive: true })
  try {
    runHidden('tar', gzip ? ['-xzf', archive, '-C', dest] : ['-xf', archive, '-C', dest], timeoutMs)
    return 'tar'
  } catch {
    if (!gzip) {
      try {
        runHidden(
          'powershell',
          ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:DSH_UPD_ZIP -DestinationPath $env:DSH_UPD_DIR -Force'],
          timeoutMs,
          { env: { ...process.env, DSH_UPD_ZIP: archive, DSH_UPD_DIR: dest } },
        )
        return 'powershell'
      } catch { /* fallback below */ }
      extractZipArchive(archive, dest)
      return 'node'
    }
    throw new Error('tar 解压失败')
  }
}

async function downloadAndExtract(url, dest, timeoutMs, kind) {
  const archive = join(tmpdir(), 'dsh-purge-nuclei-templates.' + (kind === 'tgz' ? 'tgz' : 'zip'))
  const staging = join(tmpdir(), 'dsh-purge-nuclei-' + kind + '-' + process.pid)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await downloadFile(url, archive, timeoutMs)
  extractArchive(archive, staging, timeoutMs, kind === 'tgz')
  const inner = innerTemplatesDir(staging)
  if (!inner) throw new Error(kind + ' 里没有模板')
  moveDir(inner, dest)
  if (inner !== staging) rmSync(staging, { recursive: true, force: true })
  try { unlinkSync(archive) } catch { /* ignore */ }
  if (!looksLikeTemplates(dest)) throw new Error('解压后模板不完整')
  return dest
}

async function pullTemplates(dest, timeoutMs, root) {
  if (looksLikeTemplates(dest)) return dest
  mkdirSync(join(dest, '..'), { recursive: true })
  const started = Date.now()
  const left = () => Math.max(0, timeoutMs - (Date.now() - started))
  let last = ''
  const slice = () => Math.min(90000, left())
  for (const url of GIT_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'git clone ' + url)
      return gitCloneTemplates(url, dest, slice())
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'git fail: ' + last)
    }
  }
  for (const url of TAR_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'tgz ' + url)
      return await downloadAndExtract(url, dest, slice(), 'tgz')
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'tgz fail: ' + last)
    }
  }
  for (const url of ZIP_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'zip ' + url)
      return await downloadAndExtract(url, dest, slice(), 'zip')
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'zip fail: ' + last)
    }
  }
  throw new Error(last || '模板下载失败')
}

async function waitForTemplates(dest, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (looksLikeTemplates(dest)) return dest
    await sleep(1500)
  }
  throw new Error('等待模板超时')
}

function seedKnowledge(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'pocs'), { recursive: true })
  mkdirSync(join(root, 'toolkit'), { recursive: true })
  const db = new DatabaseSync(join(root, 'knowledge.db'))
  try {
    db.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(db)
    return Number(db.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0)
  } finally {
    db.close()
  }
}

function writeConfig(root, templatesDir) {
  const prev = loadPlatformConfig(root)
  const toolkit = prev.toolkitDir && existsSync(prev.toolkitDir) ? prev.toolkitDir : join(root, 'toolkit')
  mkdirSync(toolkit, { recursive: true })
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(tools)) {
    if (path && !existsSync(path)) tools[id] = ''
  }
  let assigned = {}
  try {
    assigned = scanFolderForTools(toolkit).assigned || {}
  } catch { assigned = {} }
  for (const [id, path] of Object.entries(assigned)) {
    if (path && existsSync(path) && !tools[id]) tools[id] = path
  }
  try {
    for (const item of resolveAllTools({ root, config: Object.assign({}, prev, { toolkitDir: toolkit, tools }) })) {
      if (item.path && existsSync(item.path) && !tools[item.id]) tools[item.id] = item.path
    }
  } catch { /* PATH 扫描失败不挡 */ }
  const keptNuclei = looksLikeTemplates(prev.nucleiTemplatesDir) ? prev.nucleiTemplatesDir : ''
  const nuclei = keptNuclei
    || (looksLikeTemplates(templatesDir) ? templatesDir : (prev.nucleiTemplatesDir || ''))
  const foundAny = Object.values(tools).some((path) => path && existsSync(path))
  savePlatformConfig({
    toolkitDir: toolkit,
    nucleiTemplatesDir: nuclei,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: prev.envAdaptSkip || !foundAny,
  }, root)
  if (keptNuclei) return
  try { unlinkSync(join(root, 'pocs', '.nuclei-index.json')) } catch { /* 下次检索重建 */ }
}

/**
 * @param options {{ download?: boolean, background?: boolean, timeoutMs?: number }}
 */
export async function ensureRedteamRuntime(options = {}) {
  const download = options.download !== false
  const background = options.background === true
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000
  const homes = collectHomes()
  const primaryHome = homes[0]
  const primaryRoot = join(primaryHome, 'redteam')
  mkdirSync(primaryRoot, { recursive: true })
  logLine(primaryRoot, 'ensure start download=' + download + ' background=' + background)

  let pocs = 0
  try { pocs = seedKnowledge(primaryRoot) } catch (error) {
    logLine(primaryRoot, 'kb fail: ' + String(error && error.message ? error.message : error))
  }

  let templatesDir = discoverTemplates(homes)
  let templatesDownloaded = false
  let templatesError = ''
  const dest = templatesDir || join(primaryRoot, 'toolkit', 'nuclei-templates')
  const lockPath = join(primaryRoot, 'toolkit', '.nuclei-templates.lock')

  if (!looksLikeTemplates(dest) && download) {
    const runPull = async () => {
      const got = await pullTemplates(dest, timeoutMs, primaryRoot)
      logLine(primaryRoot, 'templates ready ' + got)
      return got
    }
    if (background) {
      templatesDir = dest
      templatesError = 'downloading'
      void (async () => {
        if (!tryLock(lockPath)) return
        try { await runPull() } catch (error) {
          logLine(primaryRoot, 'bg fail: ' + String(error && error.message ? error.message : error))
        } finally {
          releaseLock(lockPath)
          try { writeConfig(primaryRoot, dest) } catch { /* ignore */ }
        }
      })()
    } else if (!tryLock(lockPath)) {
      try {
        templatesDir = await waitForTemplates(dest, timeoutMs)
      } catch (error) {
        templatesError = String(error && error.message ? error.message : error)
        templatesDir = dest
      }
    } else {
      try {
        templatesDir = await runPull()
        templatesDownloaded = looksLikeTemplates(templatesDir)
      } catch (error) {
        templatesError = String(error && error.message ? error.message : error)
        templatesDir = dest
        logLine(primaryRoot, 'pull fail: ' + templatesError)
      } finally {
        releaseLock(lockPath)
      }
    }
  }

  for (const home of homes) {
    const root = join(home, 'redteam')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'toolkit'), { recursive: true })
    mkdirSync(join(root, 'pocs'), { recursive: true })
    if (root !== primaryRoot) {
      try { seedKnowledge(root) } catch { /* ignore */ }
    }
    try { writeConfig(root, templatesDir) } catch (error) {
      logLine(primaryRoot, 'config fail ' + root + ': ' + String(error && error.message ? error.message : error))
    }
  }

  const report = {
    root: primaryRoot,
    knowledgePath: join(primaryRoot, 'knowledge.db'),
    pocs,
    templatesDir,
    templates: countYaml(templatesDir, 500),
    templatesDownloaded,
    templatesError,
  }
  logLine(primaryRoot, 'ensure done templates=' + report.templates + ' err=' + (templatesError || 'none'))
  return report
}
