# CHANGELOG

## 0.3.0 — 2026-10-26

面向「别人也能装」，不是只在我这台机器上跑。

**新增**

- `config.js` 全量外部化：`dataDir` / `backupRoot` / `sayDir` / `rulesDir` / `beliefsFile` / `inject` / `ignore` / `maxBackupBytes` / `watchRepos` 都能配。
- 忽略清单 `DEFAULT_IGNORE`：`.git`、`node_modules`、`.env`、`*.pem`、`*.key`、`.npmrc`、`credentials.json` 等默认不备份。
- 单文件备份上限 `maxBackupBytes`（默认 10MB，超了不备份也不拦）。
- `matchIgnore()`：极简 glob（子串或 `*`）。
- `systemTimeZone()`：时区默认跟随系统，不再写死 `Asia/Shanghai`。
- `test/config.test.js`：8 项，覆盖默认值、迁移判断、忽略清单、体积上限、`sayDir` 未配置时永不 steer。

**改变（会破坏旧配置的地方）**

- `DEFAULTS.workspaceRoot`：`F:\agent expore` → `''`。**不再指向任何人的目录**。老的个人布局只要显式给 `workspaceRoot` 就还是原行为。
- `DEFAULTS.sayDir` / `rulesDir` → `''`，即**收工闸默认关闭**。不配就不 steer。
- `DEFAULTS.maxSkipsPerDay`：`1` → `3`。
- `DEFAULTS.timeZone`：`'Asia/Shanghai'` → `null`（跟随系统）。
- `dataDir` 新增：`<dshHome>` 根上已有 `whale-*.jsonl` 时**留在根上**（不搬账），否则用 `<dshHome>/ledger`。
- 包名 `dsh-leno-ledger` → `dsh-ledger`；版本 `0.2.0` → `0.3.0`。
- `package.json` 补 `repository` / `bugs` / `homepage` / `author` / `files`。

**文档**

- `README.md` 重写：第一节就是「做什么 / 不做什么」（含「不拦 shell」「备份是明文」「零网络」）。
- `LICENSE`（MIT）、CI 双平台工作流。

## 0.2.0 — 2026-10-26

- `order` 9500 → 10300（排在内置后缀之后，避免每轮变化的段把稳定段拖下水）。
- 新增 `reconcileLegacy()`：把旧的平铺备份账 `backup/_manifest.jsonl` 补进本 manifest（对 `.bak` 重算 sha256，旧的 16 位 sha 不能直接用）。幂等。
- 新增 `brokenBackups()`：manifest 指向的 `.bak` 已不存在时能在 `ledger_today` 里看到。
- 新增 `plugin/tools/import-legacy-backups.mjs`（`--dry` / `--json`）与 `test/legacy.test.js`（8 项）。
- `counts()`：`改` 改为「当日去重路径数」，导入的 backup 行也贡献路径。

## 0.1.0

- 首版：备份闸、收工闸、7 个工具、每轮尾部注入、判据 / 错误 / 未做 / 分歧四类账。
