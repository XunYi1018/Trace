// Pure-source regression: no plugin imports, host discovery, filesystem writes or network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

// Optional first argument checks another installed plugin copy, still read-only.
const root = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2]) + path.sep)
  : new URL("../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n");
const hideSource = read("lib/hide-console.js");
const coreSource = read("lib/core.js");
const indexSource = read("lib/index.js");
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start}`);
  return source.slice(from, to);
}
const proxyCode = between(hideSource, "function ensureLoopbackNoProxy(", "/**\n * 官方 0.2.1")
  .replace(/export function /g, "function ");
const { stripProxyEnv, proxyEnvGuardSource } = vm.runInNewContext(
  `${proxyCode}; ({ stripProxyEnv, proxyEnvGuardSource });`, {}, { timeout: 1000 },
);
const transformCode = between(coreSource, "const HOST_SPAWN_HIDE_MARK", "function locateOfficialDesktopHostIndexes(");
const transform = vm.runInNewContext(`${transformCode}; insertOfficialHostSpawnHide;`, {
  proxyEnvGuardSource,
}, { timeout: 1000 });
const clone = (value) => JSON.parse(JSON.stringify(value));
const proxies = {
  HTTP_PROXY: "http://127.0.0.1:7890",
  HTTPS_PROXY: "http://127.0.0.1:7890",
  ALL_PROXY: "socks5://127.0.0.1:7890",
  http_proxy: "http://proxy.example:8080",
  https_proxy: "http://proxy.example:8080",
  all_proxy: "socks5://proxy.example:1080",
  UNRELATED: "keep-me",
};
const cases = [
  ["empty", {}, "127.0.0.1,localhost,::1"],
  ["partial-loopback", { NO_PROXY: "127.0.0.1" }, "127.0.0.1,localhost,::1"],
  ["no-substring-match", { NO_PROXY: "127.0.0.10" }, "127.0.0.10,127.0.0.1,localhost,::1"],
  ["merge-both-cases", { NO_PROXY: "corp.internal", no_proxy: "other.internal" }, "corp.internal,other.internal,127.0.0.1,localhost,::1"],
  ["case-insensitive-dedup", { NO_PROXY: "LOCALHOST,127.0.0.1,::1,localhost" }, "LOCALHOST,127.0.0.1,::1"],
  ["whitespace-and-domain-port", { no_proxy: " .example.com:443, internal.test\tLOCALHOST " }, ".example.com:443,internal.test,LOCALHOST,127.0.0.1,::1"],
  ["preserve-explicit-wildcard", { NO_PROXY: "*" }, "*,127.0.0.1,localhost,::1"],
  ["preserve-mixed-wildcard", { NO_PROXY: "corp.internal,*" }, "corp.internal,*,127.0.0.1,localhost,::1"],
];
for (const [name, initial, expected] of cases) {
  for (const mode of ["runtime", "gui-generated", "host-generated"]) {
    test(`${mode}: ${name}`, () => {
      const env = { ...proxies, ...initial };
      const run = () => {
        if (mode === "runtime") assert.equal(stripProxyEnv(env), env);
        else vm.runInNewContext(proxyEnvGuardSource(mode === "gui-generated" ? "process.env" : "env"), {
          env, process: { env },
        }, { timeout: 1000 });
      };
      run();
      assert.equal(env.NO_PROXY, expected);
      assert.equal(env.no_proxy, expected);
      for (const [key, value] of Object.entries(proxies)) assert.equal(env[key], value);
      const once = clone(env);
      run();
      assert.deepEqual(env, once);
    });
  }
}
test("invalid and readonly environment inputs remain harmless", () => {
  for (const env of [null, false, "not-an-env", Object.freeze({ HTTP_PROXY: proxies.HTTP_PROXY })]) {
    assert.equal(stripProxyEnv(env), env);
  }
  for (const target of ["env", "process.env"]) {
    const env = Object.freeze({ HTTP_PROXY: proxies.HTTP_PROXY });
    assert.doesNotThrow(() => vm.runInNewContext(proxyEnvGuardSource(target), { env, process: { env } }));
  }
  assert.throws(() => proxyEnvGuardSource("arbitrary.expression"), /Unsupported/);
});
const profileAnchor = 'if (typeof process !== "undefined" && process.env && !process.env.DSH_PROFILE) process.env.DSH_PROFILE = "desktop";';
const bypassValue = "<-loopback>;<local>;localhost;127.0.0.1;::1;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16";
const markedBypass = `// [dsh-purge] proxy bypass loopback\ntry { app.commandLine.appendSwitch("proxy-bypass-list", "${bypassValue}"); } catch {}`;
const guiOld = '// [dsh-purge] gui strip proxy\ntry { for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key]; process.env.NO_PROXY = "*"; process.env.no_proxy = "*"; } catch {}';
const guiPrevious = '// [dsh-purge] gui strip proxy\ntry { const loop = "127.0.0.1,localhost,::1"; const cur = String(process.env.NO_PROXY || process.env.no_proxy || "").trim(); process.env.NO_PROXY = (!cur || cur === "*") ? loop : (cur.includes("127.0.0.1") ? cur : cur + "," + loop); process.env.no_proxy = process.env.NO_PROXY; } catch {}';
const hostOld = '\t// [dsh-purge] host spawn strip proxy\n\tfor (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];';
const hostPrevious = '\t// [dsh-purge] host spawn strip proxy\n\ttry { const cur = env.NO_PROXY || env.no_proxy || ""; const loop = "127.0.0.1,localhost,::1"; env.NO_PROXY = (!cur || cur === "*") ? loop : (cur.includes("127.0.0.1") ? cur : cur + "," + loop); env.no_proxy = env.NO_PROXY; } catch {}';
function hostFixture(stage) {
  return [
    "function desktopNodeEnvironment(executable, bin, environment) {",
    stage === "fresh" ? "\treturn {" : "\tconst env = {",
    "\t\t...environment,",
    '\t\tELECTRON_RUN_AS_NODE: "1",',
    ...(stage === "fresh" ? [] : ['\t\tELECTRON_NO_ATTACH_CONSOLE: "1",']),
    ...(stage === "old" ? ['\t\tNO_PROXY: "*",', '\t\tno_proxy: "*",'] : []),
    "\t\t...bin === void 0 ? {} : {",
    "\t\t\tDSH_DESKTOP_NODE_EXECUTABLE: executable,",
    '\t\t\tPATH: `${bin}${delimiter}${environment.PATH ?? ""}`',
    "\t\t}",
    "\t};",
    ...(stage === "fresh" ? [] : [stage === "old" ? hostOld : hostPrevious, "\treturn env;"]),
    "}",
  ].join("\n");
}
for (const [stage, eol] of ["fresh", "old", "previous"].flatMap(stage => [[stage, "\n"], [stage, "\r\n"]])) {
  test(`desktop proxy migration: ${stage} (${eol === "\n" ? "LF" : "CRLF"})`, () => {
    const fixture = [profileAnchor, ...(stage === "fresh" ? [] : [markedBypass, stage === "old" ? guiOld : guiPrevious]), hostFixture(stage)].join("\n").replace(/\n/g, eol);
    const updated = transform(fixture);
    assert.equal(transform(updated), updated, "migration must be idempotent");
    if (eol === "\r\n") assert.ok(!/(^|[^\r])\n/.test(updated), "preserve CRLF line endings");
    assert.equal((updated.match(/\[dsh-purge\] gui strip proxy/g) || []).length, 1);
    assert.equal((updated.match(/\[dsh-purge\] host spawn strip proxy/g) || []).length, 1);
    assert.ok(!updated.includes("delete env[key]"));
    assert.ok(!updated.includes("delete process.env[key]"));
    assert.ok(!updated.includes('NO_PROXY: "*"'));
    for (const [, initial, expected] of cases) {
      const guiEnv = { ...proxies, ...initial };
      const context = { process: { env: guiEnv }, app: { commandLine: { appendSwitch() {} } }, delimiter: ";" };
      const makeEnv = vm.runInNewContext(`${updated}; desktopNodeEnvironment;`, context, { timeout: 1000 });
      assert.equal(guiEnv.NO_PROXY, expected);
      for (const [key, value] of Object.entries(proxies)) assert.equal(guiEnv[key], value);
      const input = { ...proxies, ...initial, PATH: "original-path" };
      const before = clone(input);
      const result = makeEnv("node.exe", "launcher-bin", input);
      assert.deepEqual(input, before, "caller environment must not change");
      assert.equal(result.NO_PROXY, expected);
      assert.equal(result.no_proxy, expected);
      assert.equal(result.PATH, "launcher-bin;original-path");
      assert.equal(result.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(result.ELECTRON_NO_ATTACH_CONSOLE, "1");
      for (const [key, value] of Object.entries(proxies)) assert.equal(result[key], value);
      assert.equal(makeEnv("node.exe", undefined, input).PATH, "original-path");
    }
  });
}
test("unmatched input preserves original and mixed line endings", () => {
  for (const text of ["", "const a = 1;\n", "const a = 1;\r\n", "const a = 1;\r\nconst b = 2;\n"]) {
    assert.equal(transform(text), text);
  }
});
test("CLI optional runtime guard uses its actual config parameter", () => {
  const commandSource = between(indexSource, "async function handlePurgeCommand(", '    case "revert":');
  const match = commandSource.match(/if \(([^\n]*redteamEnabled[^\n]*)\) \{/);
  assert.ok(match, "optional runtime guard missing");
  for (const config of [undefined, null, {}, { redteamEnabled: false }, { redteamEnabled: "true" }, { redteamEnabled: true }]) {
    const actual = vm.runInNewContext(`Boolean(${match[1]})`, { config }, { timeout: 1000 });
    assert.equal(actual, config?.redteamEnabled === true);
  }
});
test("client overlay does not mount the retired input gate", () => {
  const client = read("client.js");
  assert.ok(client.includes('ctx.slots.inject("shell.overlay"'));
  assert.ok(!/h\(EnvAdaptSendGate\)/.test(client));
});
