import { resolveConfig } from './config.js';
import { Store } from './store.js';
import { createBackupGuard, createPostExecute, createTurnStopper } from './gates.js';
import { createInjection } from './inject.js';
import { createTools } from './tools.js';

/**
 * dsh-leno-ledger（账房）
 * 四道口子：改文件前备份、下判断前四问、错误账、收工对账；外加每轮尾部注入。
 * 只依赖 node: 内置模块，不 import @deepseek-ai/*。
 */
export default {
  name: 'dsh-leno-ledger',
  apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    const store = new Store(resolved);
    store.ensureDirs();

    const disposers = [];
    const keep = (disposer) => {
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    };

    // 自动备份后的可见提示，按 exec 对象暂存（guard 与 post-execute 共享）。
    const notes = new WeakMap();

    for (const definition of createTools(store, resolved)) {
      keep(ctx.tools.register(definition));
    }

    keep(ctx.tools.guard(createBackupGuard({ store, config: resolved, notes })));

    if (typeof ctx.systemPrompt?.section === 'function') {
      keep(ctx.systemPrompt.section({
        name: 'leno-ledger',
        // 10300：排在内置后缀（harness 10000 / web 10100 / persona 10200）之后。
        // 本段每轮都可能变化，排前面会让后面三个稳定段跟着失效，放大缓存未命中。
        order: 10300,
        text: createInjection(store),
      }));
    }

    keep(ctx.on('agent/turn-stopping', createTurnStopper({ store, config: resolved })));
    keep(ctx.on('tools/post-execute', createPostExecute(notes)));

    // 停用插件时全部撤销（S25）。
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* 卸载尽最大努力 */ }
      }
    });
  },
};

export { resolveConfig, Store };
