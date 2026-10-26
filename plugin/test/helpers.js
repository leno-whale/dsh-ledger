import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';

export const FIXED_NOW = () => new Date('2026-10-26T10:00:00.000Z'); // 上海 2026-10-26 18:00

export function makeEnv(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leno-ledger-'));
  const dshHome = path.join(root, 'dsh');
  const workspaceRoot = path.join(root, 'ws');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, '接口', '说'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, '接口', '规矩'), { recursive: true });
  const config = resolveConfig({
    dshHome,
    workspaceRoot,
    timeZone: 'Asia/Shanghai',
    ...options.config,
  });
  const store = new Store(config, { now: options.now ?? FIXED_NOW });
  store.ensureDirs();
  return {
    root,
    dshHome,
    workspaceRoot,
    config,
    store,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeWorkspaceFile(env, relative, content) {
  const file = path.join(env.workspaceRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export function writeEventFile(env, date, index = '01') {
  return writeWorkspaceFile(env, path.join('接口', '说', `${date}-${index}.md`), '# 场\n');
}

export function mockCtx() {
  const tools = new Map();
  const guards = [];
  const listeners = new Map();
  const sections = [];
  const effects = [];

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      guard(fn) {
        guards.push(fn);
        return () => {
          const index = guards.indexOf(fn);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const index = sections.indexOf(section);
          if (index >= 0) sections.splice(index, 1);
        };
      },
    },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(fn);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
  };

  return {
    ctx,
    tools,
    guards,
    listeners,
    sections,
    effects,
    fire(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
    dispose() {
      for (const fn of effects.splice(0)) {
        const disposer = fn();
        if (typeof disposer === 'function') disposer();
      }
    },
  };
}

export function toolByName(tools, name) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

export function listTmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}
