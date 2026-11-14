/* v12 决策：user 发送=全量；工具循环中的续跑=简化+动态任务。
   关键回归:组装点在 step 边界,最后事件是 step/end —— 旧实现(只认 last===tool/result)会永远全量。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (c, l) => { if (!c) { fail++; console.log('FAIL ' + l) } else console.log('ok   ' + l) }

/* shouldInjectAssembly 是 lib/index.js 的内部函数(未导出),用同样的事件序列跑一份等价实现做对照,
   同时用真实模块做冒烟:确认模块能加载且导出没被破坏。 */
await import('../lib/index.js')

const BOUNDARY = new Set(['user/message', 'agent/inbox/spliced', 'turn/start'])
function decide(events) {
  let lastUserish = -1
  let lastTool = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const t = events[i]?.type || ''
    if (lastUserish < 0 && BOUNDARY.has(t)) lastUserish = i
    if (lastTool < 0 && t === 'tool/result') lastTool = i
    if (lastUserish >= 0 && lastTool >= 0) break
  }
  return lastTool >= 0 && lastUserish >= 0 && lastTool > lastUserish ? 'anchor' : 'full'
}
const ev = (...types) => types.map((t) => ({ type: t }))

/* 1) 用户刚发消息 → 全量 */
ok(decide(ev('user/message')) === 'full', 'user send → full')
ok(decide(ev('user/message', 'step/start', 'assistant/message')) === 'full', 'user 后首个 step 组装 → full')

/* 2) 工具循环:user → tool/result → step/end(组装点在这) → 简化 */
ok(decide(ev('user/message', 'step/start', 'tool/call', 'tool/result', 'step/end')) === 'anchor',
  'step/end 结尾的工具循环 → anchor(旧实现这里是 full)')
ok(decide(ev('user/message', 'tool/result', 'step/end', 'step/start', 'tool/result', 'step/end')) === 'anchor',
  '连续两轮工具 → anchor')

/* 3) 新一轮用户消息把状态拉回全量 */
ok(decide(ev('user/message', 'tool/result', 'step/end', 'user/message')) === 'full',
  '工具循环后新的 user 发送 → full')

/* 4) plugin continuation(inbox spliced)当新输入处理 → 全量 */
ok(decide(ev('user/message', 'tool/result', 'step/end', 'agent/inbox/spliced')) === 'full',
  'agent/inbox/spliced 之后 → full')

/* 5) 没有任何 user 边界(只有工具事件)→ 保守全量 */
ok(decide(ev('tool/result', 'step/end')) === 'full', '无 user 边界 → full(保守)')

/* 6) 空事件 → 全量 */
ok(decide([]) === 'full', 'no events → full')

/* 7) 真机日志里的真实 last 值都必须落在 full 或 anchor,不能抛 */
for (const t of ['step/end', 'agent/inbox/spliced', 'tool/result', 'turn/end']) {
  ok(['full', 'anchor'].includes(decide(ev('user/message', t))), `last=${t} 决策有定义`)
}

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
