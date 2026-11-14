import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeLastApply, readLastApply, consumeLastApply } from "../lib/reapply.js";
import { findDshHome } from "../lib/core.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-last-apply-"));
const home = path.join(tmp, ".dsh");
fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), "{\"name\":\"dsh-profile-web\"}\n");
process.env.DSH_HOME = home;

if (findDshHome() !== path.normalize(home) && path.normalize(findDshHome()) !== path.normalize(home)) {
  // pinDshHome 可能记住旧值；writeLastApply 自己 findDshHome
}
writeLastApply({
  ok: true,
  complete: false,
  ask_restart: true,
  ai_base: "/tmp/ai",
  surface: "web",
  applied: 3,
  patches_applied: 3,
});
const got = readLastApply();
if (!got || got.fromApply !== true || got.ask_restart !== true || got.ai_base !== "/tmp/ai") {
  throw new Error("readLastApply missed persisted apply: " + JSON.stringify(got));
}
const consumed = consumeLastApply();
if (!consumed || consumed.ask_restart !== true) throw new Error("consumeLastApply empty");
if (readLastApply()) throw new Error("consumeLastApply did not remove file");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok last-apply");
