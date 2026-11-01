#!/usr/bin/env node
/**
 * 跑测试前先把临时目录挪到一个「能建、且不在 git 仓里」的地方。
 *
 * 两件事撞在一起，才会整片红：
 *  1) 本机 Temp（`C:\Users\HUAWEI\AppData\Local\Temp`）对 node 进程报
 *     `EPERM: operation not permitted, mkdtemp`（PowerShell 却能在同一个目录建目录），
 *     于是二十多个用例在 `mkdtempSync(os.tmpdir())` 上一起挂。
 *  2) 把 TMP 指到仓库里面会踩 `test/git.test.js` 的「不是 git 仓库：跳过」——
 *     父目录是仓，git 就会数到改动，返回 8 而不是 0。
 *
 * 所以默认放 `~/.dsh/tmp`：可写，且不在任何 git 仓里。想换地方就设 `DSH_TEST_TMP`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = process.env.DSH_TEST_TMP || path.join(os.homedir(), '.dsh', 'tmp');
fs.mkdirSync(tmp, { recursive: true });

const child = spawn(process.execPath, ['--test', 'test/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp },
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
