# dsh-ledger · 账房

> 一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的本地账本插件：
> **改文件前先备份、发帖前先给依据、收工对账**，把「改了什么 / 没做什么」变成可查的纯文本账。
> 零依赖、零网络、不碰你的 Git 仓库。

---

## 一、它做什么，不做什么（先看这一屏）

**做什么**

1. **备份闸**：模型调 `write` / `edit` 改一个**已存在**的文件之前，先把原件抄一份到 `backup/<日期>/`，并记一行指纹（sha256）。
2. **记账**：`change`（新建）、`edit`（改动）、`backup`（备份）三类记录，追加写，永不改写。
3. **收工对账**（可关）：回合结束时如果今天还没有「说」的记录，用 `steer` 把一句话塞回来提醒你——**只在你自己配置了事件目录时才启用**。
4. **判断依据**（可选）：`ledger_judge` 要求先点名一条判据（`A1`/`B3`…）或写「猜」，再下结论。
5. **错误账 / 未做账 / 分歧账**：三本小账，配 `ledger_today` 一行汇总。
6. **每轮注入**（可关）：把一行「改N 备M | 今日事件：有/无」放进系统提示**尾部**，不污染稳定前缀。

**不做什么（重要，别误会）**

- ❌ **不拦 shell**。闸只在 `write` / `edit` 这两个模型级工具上生效。`pwsh`、`Set-Content`、`node` 脚本、`git checkout` 写进去的东西**完全不经过它**。
- ❌ **不加密**。备份是**明文副本**，等于把你的文件又存了一份。含密钥的文件请放进忽略清单（默认已跳过 `.env`、`*.pem`、`*.key`、`.npmrc`、`node_modules`）。
- ❌ **不联网**。没有任何网络请求，没有遥测。
- ❌ **不改你的文件内容**，只读。唯一会写的地方是 `<DSH_HOME>/ledger/` 和 `<DSH_HOME>/backup/`。
- ❌ **不判断对错**。它只记账，判断仍然是你（或你的 agent）的事。

---

## 二、装

```bash
npm i -D dsh-ledger          # 或从本地路径 link
```

在你的 profile（`<DSH_HOME>/profiles/<名字>/package.json`）里加两处：

```jsonc
{
  "dependencies": { "dsh-ledger": "link:F:/path/to/dsh-ledger/plugin" },
  "dsh": { "profile": { "bundles": ["dsh-ledger"] } }
}
```

重启桌面端。**改 JSON 前先备份，改完确认没有 BOM**（带 BOM 会让宿主启动失败，报 `Unexpected token '﻿'`）。

### 最小配置＝不配置

不给任何配置时，它只做「备份 + 记账」，**不会 steer、不会拦回合**。默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `~/.dsh` | 也可用环境变量 `DSH_HOME` |
| `dataDir` | 有老账时 `~/.dsh`，否则 `~/.dsh/ledger` | 账本目录（自动判断，见下） |
| `backupRoot` | `~/.dsh/backup` | 备份放这儿 |
| `autoBackup` | `true` | `true`＝先备份再放行；`false`＝没备份就**硬拒** |
| `maxBackupBytes` | `10485760`（10MB） | 超过就不备份（也不拦） |
| `ignore` | 见上 | 子串或 `*` 通配 |
| `maxSkipsPerDay` | `3` | 「今天确实不记账」每天可跳几次 |
| `timeZone` | 跟随系统 | 可用 `TZ` 环境变量覆盖 |
| `inject` | `true` | 关掉后只能用 `ledger_today` 手动查 |
| `sayDir` | `''`（关） | 收工闸看的事件目录 |
| `rulesDir` | `''`（关） | 规矩清单目录 |
| `workspaceRoot` | `''`（关） | 老式布局：给了就按 `<root>/接口/说`、`<root>/接口/规矩` 推 |
| `watchRepos` | `[]` | 预留：从 git 独立核对「改了没备份」 |

> **迁移**：如果你 `~/.dsh` 根上已经有 `whale-*.jsonl` 这类老账，插件会**继续用根目录**，不会把账搬走；新装的人才会用到 `~/.dsh/ledger/`。

---

## 三、账在哪、怎么看、怎么关

```
~/.dsh/
├── ledger/
│   ├── whale-backup-manifest.jsonl   每行一次改动/备份（追加写）
│   ├── whale-error-ledger.jsonl      错误账
│   ├── whale-criteria/               判据（一条一个 md）
│   ├── whale-undone.jsonl            未做账
│   └── whale-conflicts.jsonl         分歧账
└── backup/
    └── 2026-01-02/
        └── 文件名.bak
```

**7 个工具**：`ledger_today`（一行汇总）、`ledger_undone`、`ledger_conflict`、`ledger_judge`、`ledger_belief`、`ledger_backup`、`ledger_error`。

**手动看**：

```
ledger_today
→ 改3 备3 | 判断0 记0 | 冲突0 | 今日事件：有
```

**关掉**：把 `bundles` 里那一项删掉、重启即可。它不写 profile，不改别人的文件。
**只留备份**：`inject:false`、不配 `sayDir`。
**全关但留数据**：卸载插件，`~/.dsh/ledger/` 和 `~/.dsh/backup/` 都还在，随时能删。

---

## 四、已知问题（先说，省得你踩）

1. **闸看不见 shell**（最重要，见第一节）。
2. **`改N` 是从备份账推出来的**，不是从「实际改了什么」推的——所以它天然看不见「改了但没备份」。v0.4 会用 `watchRepos` 从 git 独立核对。
3. **备份目录会变大**。目前没有自动清理，需要你自己定期删 `backup/<旧日期>/`。
4. **多进程同时写**同一个 JSONL 没做文件锁（DSH 一般单会话，但同一台机器开两个 profile 就会撞）。
5. 数据文件名暂时还带 `whale-` 前缀（v0.4 改名并做一次迁移）。

---

## 五、开发

```bash
npm test          # 63 项，node --test，无需网络
```

CI 在 Windows 与 Ubuntu、Node 22/24 上各跑一遍（见 `.github/workflows/ci.yml`）。

---

## English

`dsh-ledger` is a local-only ledger plugin for the DeepSeek Harness: it snapshots a file before the model edits it, records every change in append-only JSONL, and can nudge the agent at turn end if today has no "spoken" record. **It only guards the `write`/`edit` tools — shell writes bypass it.** No deps, no network, no telemetry. MIT.

## License

MIT © leno
