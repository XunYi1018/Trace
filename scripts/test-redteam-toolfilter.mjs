import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPreset } from "../lib/redteam/index.js"

let fail = 0
const ok = (c, l) => {
  if (!c) {
    fail++
    console.log("FAIL " + l)
  } else {
    console.log("ok   " + l)
  }
}

const OLD = [
  "- id: tool-subagent",
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  "  disabled: false",
  "  config:",
  "    provider: spawn",
  "    toolName: subagent",
  "    maxDepth: 1",
  "    toolFilter:",
  "      deny:",
  "        - subagent_fork",
  "        - workflow",
  "        - ralph",
  "    # keep-me",
  "- id: other",
  "  name: keep",
].join("\n")

const INLINE = [
  "- id: tool-subagent",
  "  name: '@deepseek-ai/dsh-tool-subagent'",
  "  disabled: false",
  "  config:",
  "    maxDepth: 1",
  "    toolFilter: { deny: [ralph] }",
].join("\n")

function heal(src) {
  const root = mkdtempSync(join(tmpdir(), "dsh-purge-138-"))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const presetDir = join(root, ".agent-presets", "redteam")
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, "agent.cordis.yml"), src, "utf8")
    const result = installPreset({ log: () => {} })
    const out = readFileSync(join(presetDir, "agent.cordis.yml"), "utf8")
    return { result, out }
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
}

const template = readFileSync(new URL("../presets/redteam/agent.cordis.yml", import.meta.url), "utf8")
ok(!/^[ \t]*toolFilter:/m.test(template), "bundled template has no toolFilter key")
ok(/maxDepth:\s*1/.test(template), "bundled template keeps maxDepth: 1")

const nested = heal(OLD)
ok(nested.result.action === "repaired", "existing nested toolFilter → repaired")
ok(String(nested.result.repaired).includes("toolFilter"), "repaired tag includes toolFilter")
ok(!/^[ \t]*toolFilter:/m.test(nested.out), "nested toolFilter key gone")
ok(!/subagent_fork/.test(nested.out), "deny list gone with the key")
ok(/maxDepth:\s*1/.test(nested.out), "maxDepth kept")
ok(/# keep-me/.test(nested.out), "sibling comment kept")
ok(/name: keep/.test(nested.out), "following plugin row kept")

const inline = heal(INLINE)
ok(inline.result.action === "repaired", "inline toolFilter → repaired")
ok(!/^[ \t]*toolFilter:/m.test(inline.out), "inline toolFilter key gone")
ok(/maxDepth:\s*1/.test(inline.out), "inline maxDepth kept")

const crlf = heal(OLD.replace(/\n/g, "\r\n"))
ok(!/^[ \t]*toolFilter:/m.test(crlf.out), "CRLF toolFilter key gone")

if (fail) process.exit(1)
console.log("all ok")
