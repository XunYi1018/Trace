#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWindowsManifestResource, installerManifest } from './windows-manifest.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function prepareDistributionPackage(source) {
  const result = structuredClone(source)
  result.private = true
  delete result.scripts
  delete result.publishConfig
  if (result.dsh) delete result.dsh.install
  return result
}
export function assertNoDistributionSecrets(root) {
  for (const name of walk(root)) {
    if (/issuer-private|\.private\.pem$|(^|\/)\.git(\/|$)/i.test(name)) throw new Error(`禁止打包私钥或 Git 数据：${name}`)
    const data = fs.readFileSync(path.join(root, name))
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(data.toString('latin1'))) throw new Error(`禁止打包私钥内容：${name}`)
  }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function walk(root, prefix = '') {
  const result = []
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name)
    if (item.isSymbolicLink()) throw new Error(`发行目录不能包含软链接：${relative}`)
    if (item.isDirectory()) result.push(...walk(root, relative))
    else if (item.isFile()) result.push(relative)
  }
  return result
}
function optionsFrom(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!['--go', '--out'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--') || result[name]) throw new Error(`未知、重复或缺值参数：${name}`)
    result[name] = argv[i + 1]
  }
  return result
}
export function buildWindowsDistribution(options) {
  const go = options['--go'] || 'go'
  const goRoot = path.join(repoRoot, 'distribution', 'windows')
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const output = path.resolve(options['--out'] || path.join(repoRoot, 'dist', 'windows', `dsh-purge-${pkg.version}-windows-x64-setup.exe`))
  if (path.extname(output).toLowerCase() !== '.exe') throw new Error('输出必须为 .exe 文件')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-release-'))
  const generated = path.join(goRoot, 'cmd', 'setup', 'payload_generated.go')
  const manifestObjects = ['setup', 'setup-cleanup'].map(name => path.join(goRoot, 'cmd', name, 'manifest_windows_amd64.syso'))
  if (fs.existsSync(generated)) throw new Error('存在未清理的发行载荷，请先检查 payload_generated.go')
  if (manifestObjects.some(file => fs.existsSync(file))) throw new Error('存在未清理的安装器资源，请先检查 manifest_windows_amd64.syso')
  const env = { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' }
  const goBuild = (entry, out, extra = '') => execFileSync(go, ['build', '-trimpath', '-ldflags', `-s -w ${extra}`.trim(), '-o', out, entry], { cwd: goRoot, env, stdio: 'inherit', timeout: 180000 })
  try {
    const manifest = createWindowsManifestResource(installerManifest)
    for (const file of manifestObjects) fs.writeFileSync(file, manifest, { flag: 'wx' })
    const cleanup = path.join(stage, 'setup-cleanup.exe')
    goBuild('./cmd/setup-cleanup', cleanup)
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', stage], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 }))
    const raw = path.join(stage, packed[0].filename)
    execFileSync('tar', ['-xzf', raw, '-C', stage], { timeout: 30000 })
    const root = path.join(stage, 'package')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(prepareDistributionPackage(pkg), null, 2) + '\n')
    const runtimeDir = path.join(root, 'lib', 'distribution')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.copyFileSync(cleanup, path.join(runtimeDir, 'setup-cleanup.exe'))
    for (const name of ['build-windows-distribution.mjs', 'windows-manifest.mjs']) {
      fs.rmSync(path.join(root, 'scripts', name), { force: true })
    }
    assertNoDistributionSecrets(root)
    const files = Object.fromEntries(walk(root).map(name => [name, digest(fs.readFileSync(path.join(root, name)))]))
    const receipt = { product: pkg.name, version: pkg.version, files }
    const payloadPath = path.join(stage, 'payload.tgz')
    const receiptPath = path.join(stage, 'receipt.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt))
    const [hostOS, hostArch] = execFileSync(go, ['env', 'GOHOSTOS', 'GOHOSTARCH'], { cwd: goRoot, encoding: 'utf8' }).trim().split(/\r?\n/)
    // Go's portable tar writer excludes AppleDouble/xattrs. The pack command
    // also extracts and verifies the real archive against the full receipt.
    execFileSync(go, ['run', './cmd/payload-pack', root, payloadPath, receiptPath], {
      cwd: goRoot,
      env: { ...process.env, GOOS: hostOS, GOARCH: hostArch, CGO_ENABLED: '0', GOTOOLCHAIN: 'local' },
      stdio: 'inherit',
      timeout: 180000,
    })
    const payload = fs.readFileSync(payloadPath), receiptBytes = Buffer.from(JSON.stringify(receipt))
    fs.writeFileSync(generated, `// Code generated by build-windows-distribution.mjs; DO NOT EDIT.\npackage main\nimport "encoding/base64"\nfunc init(){\n embeddedPayload,_=base64.StdEncoding.DecodeString(${JSON.stringify(payload.toString('base64'))})\n embeddedReceipt,_=base64.StdEncoding.DecodeString(${JSON.stringify(receiptBytes.toString('base64'))})\n payloadDigest=${JSON.stringify(digest(payload))}\n}\n`)
    goBuild('./cmd/setup', output, '-H=windowsgui')
    const header = fs.readFileSync(output).subarray(0, 2)
    if (header.toString('ascii') !== 'MZ') throw new Error('产物不是 Windows PE EXE')
    fs.writeFileSync(output + '.sha256', digest(fs.readFileSync(output)) + '  ' + path.basename(output) + '\n')
    fs.writeFileSync(path.join(path.dirname(output), '使用说明.txt'), `dsh-purge ${pkg.version} Windows x64 安装程序

1. 双击 EXE 并点击「开始安装」。安装器会识别 DSH 安装布局。如缺少 DSH 或桌面插件安装入口，安装器会从官网安装或升级，并校验官方发行签名。
2. 安装器逐步显示进度。需要退出 DSH 时，先保存工作，再按界面提示继续。
3. 安装器从内存解包插件，退出时清理临时目录。安装成功并通过校验后，默认删除外层 EXE，失败时保留。
4. --preflight 输出只读环境诊断。可用 --dsh-cli 和 --dsh-home 指定 CLI 与数据目录，或用 --keep-installer 保留外层 EXE。
5. 如果 Windows 提示需要重启，请保存工作，重启后重新运行安装器。安装器不会强制重启。

安装完成后，打开插件的「清洗」页面，点击「应用」，等待重启。
安装器尚未进行 Authenticode 签名。对外发布前请在真实 Windows 与 DSH 环境中验收。
`)
    return { output, sha256: digest(fs.readFileSync(output)), version: pkg.version, payloadBytes: payload.length, files: Object.keys(files).length }
  } finally {
    fs.rmSync(generated, { force: true })
    for (const file of manifestObjects) fs.rmSync(file, { force: true })
    fs.rmSync(stage, { recursive: true, force: true })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('用法：node scripts/build-windows-distribution.mjs [--go go完整路径] [--out 输出EXE路径]')
  else try { console.log(JSON.stringify(buildWindowsDistribution(optionsFrom(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
