import fs from 'node:fs';
import path from 'node:path';

import { resolveConfig } from './config.js';
import { Store } from './store.js';
import { createBackupGuard, createPostExecute, createTurnStopper } from './gates.js';
import { createInjection } from './inject.js';
import { loadI1 } from './i1.js';
import { createTools } from './tools.js';

/** v0.3：与 package.json 同步；状态文件里也写这一份，便于离线核对。 */
export const VERSION = '0.6.15';

/**
 * 必须先声明 tools 依赖，cordis 才会在 apply 前注入 ctx.tools。
 * 这是 v0.2 六条功能全灭的根因：没有 inject，apply 里访问 ctx.tools 直接 TypeError。
 * 同时保留命名导出，兼容按模块命名空间加载的写法。
 */
export const inject = ['tools'];

const STATE_FILE = 'ledger-state.json';
const LOAD_ERROR_FILE = 'ledger-errors.jsonl';

function appendLoadError(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    /* 连错误账都写不了时只能沉默；状态文件里仍有 segment 失败记录 */
  }
}

/**
 * dsh-ledger（账房）v0.3
 * 四道口子：改文件前备份、下判断前四问、错误账、收工对账；外加每轮尾部注入。
 * 只依赖 node: 内置模块，不 import @deepseek-ai/*。
 *
 * 加载容错（S2/S3）：五段各自 try/catch，一段失败不影响其余；
 * 全部走完写 `<dshHome>/ledger-state.json`，失败段写 `<dshHome>/ledger-errors.jsonl`。
 */
// 自动备份后的可见提示，按 exec 对象暂存（guard 与 post-execute 共享）。
const notes = new WeakMap();

/** 本回合的计数（a 项）：改了 N 个文件、记了 M 笔账。回合结束时由收工闸落盘。 */
function createTurnStats() {
  return { edits: 0, ledger: 0 };
}

export default {
  name: 'dsh-ledger',
  inject,
  apply(ctx, config = {}) {
    let resolved;
    let store;
    try {
      resolved = resolveConfig(config);
      store = new Store(resolved);
    } catch (error) {
      // 配置/构造就失败：连账都建不了，只能尽力留一条痕迹。
      try {
        const home = process.env.DSH_HOME
          || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh');
        appendLoadError(path.join(home, LOAD_ERROR_FILE), {
          t: new Date().toISOString(), type: 'load', segment: 'bootstrap', error: String(error?.message ?? error),
        });
      } catch { /* ignore */ }
      return;
    }

    const stateFile = path.join(resolved.dshHome, STATE_FILE);
    const loadErrorFile = path.join(resolved.dshHome, LOAD_ERROR_FILE);
    const turnStats = createTurnStats();
    const segments = {};
    const disposers = [];
    const keep = (disposer) => {
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    };
    const run = (name, fn) => {
      try {
        fn();
        segments[name] = { ok: true };
      } catch (error) {
        const message = String(error?.message ?? error);
        segments[name] = { ok: false, error: message };
        appendLoadError(loadErrorFile, {
          t: new Date().toISOString(), type: 'load', segment: name, error: message,
        });
      }
    };

    try {
      store.ensureDirs();
    } catch (error) {
      appendLoadError(loadErrorFile, {
        t: new Date().toISOString(), type: 'load', segment: 'store', error: String(error?.message ?? error),
      });
    }

    run('tools', () => {
      if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
        throw new Error('ctx.tools 不可用：插件需要 inject: ["tools"]，或宿主没有提供 tools 服务');
      }
      for (const definition of createTools(store, resolved)) {
        keep(ctx.tools.register(definition));
      }
    });

    run('guard', () => {
      if (!ctx?.tools || typeof ctx.tools.guard !== 'function') {
        throw new Error('ctx.tools.guard 不可用');
      }
      // 自动备份后的可见提示，按 exec 对象暂存（guard 与 post-execute 共享）。
      // 放在这里是为了让 guard 段失败时也不影响 postExecute 段。
      keep(ctx.tools.guard(createBackupGuard({ store, config: resolved, notes })));
    });

    run('injection', () => {
      let systemPrompt;
      // 两行都放进 try：没有 inject 'systemPrompt' 时，`ctx.systemPrompt` 这个属性访问
      // 本身就会抛（cordis 代理的 "cannot get property … without inject"），
      // 漏在 try 外面会让整段注入静默失败。
      try {
        systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined;
        if (!systemPrompt || typeof systemPrompt.section !== 'function') systemPrompt = ctx?.systemPrompt;
      } catch {
        systemPrompt = undefined;
      }
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        throw new Error('systemPrompt 服务不可用（可选依赖，跳过注入）');
      }
      keep(systemPrompt.section({
        name: 'leno-ledger',
        // 10300：排在内置后缀（harness 10000 / web 10100 / persona 10200）之后。
        order: 10300,
        // v0.6.10：注入段要读会话字节，得拿到 dshHome/cwd 这类配置。
        text: createInjection(store, resolved),
      }));
      // 2026-10-29（插件化第 2 步）：I₁ 只在这里注入。
      // 10250 排在账房段之前（注入顺序稳定），读文件失败就整段消失——不注入半截。
      keep(systemPrompt.section({
        name: 'leno-i1',
        order: 10250,
        text: () => loadI1(resolved),
      }));
    });

    run('turnStopping', () => {
      if (typeof ctx?.on !== 'function') throw new Error('ctx.on 不可用');
      keep(ctx.on('agent/turn-stopping', createTurnStopper({ store, config: resolved, stats: turnStats })));
    });


    run('postExecute', () => {
      if (typeof ctx?.on !== 'function') throw new Error('ctx.on 不可用');
      keep(ctx.on('tools/post-execute', createPostExecute(notes, turnStats)));
    });

    // S3：五段都走完（无论成败）写一次状态，离线 status.mjs 只看这个文件。
    try {
      store.atomicWrite(stateFile, `${JSON.stringify({
        version: VERSION,
        loadedAt: new Date().toISOString(),
        pid: process.pid,
        segments,
      }, null, 2)}\n`);
    } catch (error) {
      appendLoadError(loadErrorFile, {
        t: new Date().toISOString(), type: 'load', segment: 'state', error: String(error?.message ?? error),
      });
    }

    // 停用插件时全部撤销（S25 / v0.3 卸载）。
    try {
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* 卸载尽最大努力 */ }
          }
        });
      }
    } catch {
      /* 不能挂 effect 时也保留已注册项，宿主停用会整体丢弃 */
    }
  },
};

export { resolveConfig, Store };
