# dsh-leno-ledger · 账房

> 一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的本地账本插件：
> **改文件前先备份、发帖前先给依据、收工对账**，把「改了什么 / 没做什么」变成可查的纯文本账。
> 零依赖、零网络、不碰你的 Git 仓库。

> **v0.3 必读：升级后请重启一次 DSH。** 工具/备份闸/收工闸是在 DSH 加载插件时注册的，
> 已经开着的会话不会热挂。装完先跑 `node plugin/tools/status.mjs`：
> `segments: tools=ok guard=ok injection=ok turnStopping=ok postExecute=ok` 且退出码 0，才算真的生效；
> 否则看 `~/.dsh/ledger-state.json` 与 `~/.dsh/ledger-errors.jsonl`（`type:"load"`）。
> 完整的安装/升级/CLI/数据格式/限制见仓库根 `README.md`。

---

## 一、它做什么，不做什么（先看这一屏）

**做什么**

1. **备份闸**：模型调 `write` / `edit` 改一个**已存在**的文件之前，先把原件抄一份到 `backup/<日期>/`，并记一行指纹（sha256）。
2. **记账**：`change`（新建）、`edit`（改动）、`backup`（备份）三类记录，追加写，永不改写。
3. **收工对账**（可关）：回合结束时如果**今天账上一笔都没有**（改/备/判断/错误/冲突任一即算有），用 `steer` 把一句话塞回来提醒你；同一轮最多一次，两次之间默认隔 1 小时（`minIntervalMs`）。不再以「发没发帖」为准。
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
npm i -D dsh-leno-ledger          # 或从本地路径 link
```

在你的 profile（`<DSH_HOME>/profiles/<名字>/package.json`）里加两处：

```jsonc
{
  "dependencies": { "dsh-leno-ledger": "link:F:/path/to/dsh-ledger/plugin" },
  "dsh": { "profile": { "bundles": ["dsh-leno-ledger"] } }
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
| `sayDir` | `''`（关） | 发帖记录目录；只用于「今日事件」提示，不再决定收工闸 |
| `rulesDir` | `''`（关） | 规矩清单目录 |
| `workspaceRoot` | `''`（关） | 老式布局：给了就按 `<root>/接口/说`、`<root>/接口/规矩` 推 |
| `watchRepos` | `[]` | 从这里列的 git 仓库独立核对改动（见下节）。空＝不核对 |
| `backupKeepDays` | `30` | 备份保留天数，`0`＝不按时间清理 |
| `backupMaxTotalMb` | `500` | 备份总量上限（MB），`0`＝不按容量清理 |

> **迁移**：如果你 `~/.dsh` 根上已经有 `whale-*.jsonl` 这类老账，插件会**继续用根目录**，不会把账搬走；新装的人才会用到 `~/.dsh/ledger/`。

---

## 三、账在哪、怎么看、怎么关

```
~/.dsh/
├── ledger/
│   ├── ledger-manifest.jsonl    每行一次改动/备份（追加写）
│   ├── ledger-errors.jsonl      错误账
│   ├── ledger-criteria/         判据（一条一个 md）
│   ├── whale-undone.jsonl       未做账（你自己的本子，保持原名）
│   ├── ledger-conflicts.jsonl   分歧账
│   └── ledger-prune-log.jsonl   备份清理记录（只记数，不记路径）
└── backup/
    └── 2026-01-02/
        └── 文件名.bak
```

> **v0.3 的老文件名**（`whale-backup-manifest.jsonl`、`whale-error-ledger.jsonl`、`whale-criteria/`、`whale-rule-usage.json`、`whale-criteria-log.jsonl`、`whale-conflicts.jsonl`、`whale-inject-state.json`）在启动时**自动搬到新名字**。两边同名文件都在时不合并、不删除，只在错误账里记一条 `migration`，等人来看。`whale-beliefs.md`、`whale-beliefs-log.jsonl`、`whale-undone.jsonl` 是你自己的本子，**不改名**。

**8 个工具**：`ledger_today`（一行汇总）、`ledger_undone`、`ledger_conflict`、`ledger_judge`、`ledger_belief`、`ledger_backup`、`ledger_error`、`ledger_prune`（看/清备份，默认只算不删）。

**手动看**：

```
ledger_today
→ 改3 备3 | 判断0 记0 | 冲突0 | 今日事件：有
```

**关掉**：把 `bundles` 里那一项删掉、重启即可。它不写 profile，不改别人的文件。
**只留备份**：`inject:false`、不配 `sayDir`。
**全关但留数据**：卸载插件，`~/.dsh/ledger/` 和 `~/.dsh/backup/` 都还在，随时能删。

---

## 四、`watchRepos`：让 git 当第二个证人

账本只能看见经过它的改动。`pwsh` 里 `Set-Content`、`node` 脚本写文件、`git checkout`，它一概不知道——于是「改了 9 个文件、只备份 3 个」这种账，插件自己算不出来。

配了 `watchRepos` 之后，`ledger_today` 会去这些 git 仓库里看 `git status` 和今天的提交，把**账本没记到**的改动补进「改N」，并且单独报一行：

```
改9 备3 | 判断0 记0 | 冲突0 | 今日事件：有
⚠有改没备份：记录.md 主人语气.md 等5个
```

```jsonc
{ "watchRepos": ["F:/agent expore/接口", "F:/agent expore/本子游戏"] }
```

- **只对 git 仓库有效**，非仓库的路径会被跳过（`skipped`，不报错）。
- **新建未跟踪的文件**（`??`）只算「改」，不算「有改没备份」——它本来就没有原件可备。
- 结果缓存 60 秒，多个 repo 串行查，单次超时 8 秒。
- 它**不拦**任何东西，只让账变真。

---

## 五、备份清理

备份会一直长，所以有 `ledger_prune`（默认**只算不删**）：

```
ledger_prune                     # 看：多少文件、多少 MB、能删几个
ledger_prune {"dryRun": false}   # 真删
ledger_prune {"keep_days": 7}    # 7 天前的可以删
ledger_prune {"max_total_mb": 200}  # 总量超 200MB 就从最老的删
```

两条政策（`backupKeepDays` 默认 30 天、`backupMaxTotalMb` 默认 500MB）之外，有一条硬规则：**每个源文件的最新一份永远保留**——旧版本可以清，最后那份副本不清。所以清理跑多久，都不会出现「改之前无原件可查」。

清完会往 `ledger-prune-log.jsonl` 记一行（删了几个、释放多少字节、用的什么政策），不记路径。

---

## 六、已知问题（先说，省得你踩）

1. **闸看不见 shell**（最重要，见第一节）。这一点 v0.4 也没解决，只能靠下面的 `watchRepos` 事后对账。
2. **`watchRepos` 是事后核对，不是拦**：它每 60 秒最多查一次，且只对「git 仓库里的文件」有效。
3. **备份不会无限长**：`ledger_prune` 可以按天数/容量清（默认只算不删，要显式 `dryRun:false`）。目前**不会自动跑**，需要你（或模型）想起来调一次。
4. **多进程**：v0.4 起写 JSONL 走 `<dataDir>/.lock` 独占锁；进程崩了留下的锁超过 30 秒会被抢过来，不会卡死。
5. **数据文件名**：v0.4 起插件自己的账改叫 `ledger-*`，启动时自动从 `whale-*` 搬过来；你自己的本子（`whale-beliefs.md` / `whale-beliefs-log.jsonl` / `whale-undone.jsonl`）保持原名。
6. **旧会话不热挂**：升级后必须重启 DSH；插件无法给已经存在的会话补注册工具/闸。用 `status.mjs` 确认，不要靠猜。

---

## 六点五、离线 CLI（工具没生效时也能对账）

```bash
node tools/status.mjs                 # 自检：模块/state/最近一条账/备份数/今日行；全 ok 退出 0
node tools/status.mjs --json
node tools/today.mjs                  # 纯文件复算 ledger_today 首行
node tools/backfill.mjs --repo F:\work\proj            # dry-run：列出今天改了但没备份的文件
node tools/backfill.mjs --repo F:\work\proj --apply    # 补 backup + change(source:"backfill")
```

公共参数：`--home <DSH_HOME>`（测试隔离/多账本）、`--workspace`、`--repo`（可重复）、
`--now <ISO>`（按指定时刻复算）、`--json`。全部零依赖，不需要模型上下文。

---

## 七、开发

```bash
npm test          # 91 项，node --test，无需网络
```

CI 在 Windows 与 Ubuntu、Node 22/24 上各跑一遍（见 `.github/workflows/ci.yml`）。

---

## English

`dsh-leno-ledger` is a local-only ledger plugin for the DeepSeek Harness: it snapshots a file before the model edits it, records every change in append-only JSONL, and can nudge the agent at turn end if today has no "spoken" record. **It only guards the `write`/`edit` tools — shell writes bypass it.** No deps, no network, no telemetry. MIT.

## License

MIT © leno
