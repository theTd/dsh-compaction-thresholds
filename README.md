# dsh-compaction-thresholds

**English** · [中文](#中文)

Per-model **auto-compaction trigger in tokens** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `pi-ai` providers, edited
from **Settings → Models** instead of YAML.

`dsh-compaction-basic` only accepts a *ratio* of the context window, and its effective
threshold is `floor(min(W × ratio, W − O − headroomTokens))` — so a ratio you think you tuned
can be silently capped, and a fixed ratio means a different token budget on every model. This
plugin lets you type the token number you actually care about, converts it to the exact ratio,
and writes it into every agent-preset row as `modelPolicies`.

```
Settings → Models → <provider> card → Compaction trigger / 自动压缩触发点
   [ 320000 ] tokens   [Save] [Clear]
        │
        │ browser writes THIS plugin's volatile namespace (settings.mutate)
        ▼
compaction-thresholds { models: [...], managed: [...], report: {...} }
        │
        │ host reconciles every 1500 ms, then projects with ctx.configEditor.edit()
        ▼
preset-* row → plugins[compaction] → config[compaction-basic].config.modelPolicies
   { provider: "clay", model: "deepseek-flash", thresholdRatio: 0.305176… }
        │
        │ the outcome is published back into the same namespace as `report`
        ▼
card shows "Synced 4/4 · 12:34" or "Not synced 1/4: preset-standard (…)"
```

## Why two hops

Agent-preset rows are Loader rows, not settings entries: `dsh-agent-preset`'s `Config`
declares no `.volatile()` field, so `settings.describe()` omits them and `settings.mutate()`
refuses them. The browser can only write volatile namespaces, so this plugin owns one
(`compaction-thresholds`, its own row id) and performs the preset edit on the host. No new
Remote/RPC surface is added — `dsh-api-remotes` fixes that namespace set at build time.

The consequence worth knowing: **the namespace is the source of truth, the preset rows are a
projection.** The panel shows the table, not a read-back of the presets; what it can show
honestly is the host's projection report (`synced` / `failed` / `notes`), which `report` carries.

## The three volatile fields

| field | owner | meaning |
|---|---|---|
| `models` | the user (settings page) | the table: `{provider, model, compactAtTokens, retainTokens?}` |
| `managed` | the host | keys this plugin has written, used to prune only its own policies |
| `report` | the host | `{at, synced[], failed[{preset,message}], notes[]}` from the last projection; `at` moves only when the outcome changes, so an idle deployment never rewrites the file |

## What the host writes

`thresholdRatio` is `compactAtTokens / contextWindow`, nudged to
`(tokens + 0.5) / contextWindow` so `floor(W * ratio)` reproduces the typed token count
exactly. `retainRatio` (only when `retainTokens` is set) is `retainTokens / (W - O)` where `O`
is the routed output reservation (`info.defaultMaxTokens`). Every other key of the backend
config — including an existing `thresholdRatio` — is preserved; policies for models outside
this table are left alone, and entries this plugin never wrote are never removed.

The written config is validated with `dsh-compaction-basic`'s own rules before the write:
`0 < ratio <= 1`, `retainRatio < thresholdRatio`, `retainTokens < thresholdTokens`, and
non-negative pressure headroom. A target above the backend's capacity ceiling
(`W - O - headroomTokens`, default headroom 65536) is written but capped — the backend takes
`min(W * ratio, W - O - headroom)` — and the host reports one note naming the capped value. A
target that cannot be expressed at all (`tokens > W`, or a retain target that violates the
ratio ordering) is refused, named in a note, and the row is left untouched.

Idle ticks are churn-free: the host deep-equal compares the computed `modelPolicies` with the
row's current ones and skips `configEditor.edit()` when nothing differs.

Provider decisions are deliberately **not** cached: a fixed table with an edited
`models[].contextWindow` must re-derive the ratio, otherwise the token target drifts.

## Why a reconcile loop and not the `loader/volatile-update` event

A settings write commits the volatile field **inside its own HMR transaction**, and `dsh-hmr`
guards re-entry with an `AsyncLocalStorage` flag
(`if (this.executing.getStore()) reject("HMR transactions cannot be nested")`). Anything
scheduled from the `loader/volatile-update` listener inherits that store, so a
`configEditor.edit()` started from it is rejected no matter how long it waits — verified here:
56 rejections across six retries and two runs. The host therefore reconciles on a timer armed
during activation (a clean async context) every 1500 ms; a changed table reaches the preset
rows within one tick plus the per-row write time (one `configEditor.edit()` per preset row,
roughly 0.5–9 s each on a large profile).

## Install

```jsonc
// <profile>/package.json  (e.g. ~/.dsh/profiles/web/package.json)
"dependencies":  { "dsh-compaction-thresholds": "link:/absolute/path/to/dsh-compaction-thresholds" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-compaction-thresholds" ] } }
```

Then `pnpm install` in that profile directory and restart `dsh web` (a new bundle layer needs a
boot; later table edits apply live). The bundle's `cordis.patch.yml` inserts the
`compaction-thresholds` row.

`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are **peer** dependencies on purpose: a
`link:`-installed plugin is a DSH "linked root", and the launcher's resolver routes a bare
package request from a linked root through the installation graph only when the requesting
package's `package.json` declares that name in `peerDependencies` (`dsh-app-boot/lib/index.js`
`routeLinked` + `readPeerNames`).

Tested against DSH `0.2.1-alpha.5`.

## Upgrade

A `link:`-installed plugin's **host code is not hot-reloaded**: after changing `lib/index.js`
(or pulling a new version) restart `dsh web` once, then refresh the page. Upgrading
0.1.0 → 0.2.0 is otherwise compatible: the row gains the `managed`/`report` fields on the first
reconcile.

The status line's timestamp (`at`) is the last time the *outcome* changed, not the last time a
save was accepted, so a save that lands on an already-synced outcome keeps the previous time.

## Uninstall

Remove the dependency and the bundle entry, `pnpm install`, delete the package directory, then
delete the `compaction-thresholds` row from the profile patch. Presets keep their
`modelPolicies`; clear every row in the panel first (which prunes them) or delete them by hand.

## Tests

```sh
node --test test/
```

Covers exact token↔ratio reproduction, projection and sibling preservation (`!!js` markers
included), the churn guard, pruning ownership, refusal paths and the structural comparator.
`lib/policy.js` is dependency-free on purpose so the tests need no module graph.

## Known limits

- Presets keep their revision: a changed trigger applies to **new** sessions.
- `retainTokens` has no UI control yet; it is preserved when present in a row.
- A preset that fails to write is retried on every tick until it succeeds; the table keeps the
  requested value.
- Only `@deepseek-ai/dsh-llm-pi-ai` providers are covered. `dsh-llm-deepseek` routes have their
  own catalog and are not extended yet.

## Files

| file | role |
|---|---|
| `lib/index.js` | host half: `Config` (three volatile fields), activation pass + 1500 ms reconcile loop, per-row `configEditor.edit()` projection, pruning, report publishing |
| `lib/policy.js` | pure logic: ratio math, plan/patch, validation, structural comparison |
| `lib/client.js` | browser half: ModuleLoader bundle registering into the `settings.models.provider-card` keyed seat under key `llm-pi-ai`, bilingual copy, save/clear, projection report |
| `cordis.patch.yml` | inserts the `compaction-thresholds` Loader row |
| `test/policy.test.mjs` | `node --test` suite |
| `package.json` | `dsh.bundle.patch` + `dsh.client` (`platform: web`) + `engines.dsh` |

## License

MIT — see [LICENSE](LICENSE).

---

<a id="中文"></a>

# 中文

[↑ 回到顶部](#dsh-compaction-thresholds) · [English](#dsh-compaction-thresholds)

给 DeepSeek Harness 的 `pi-ai` provider 用的**按模型设置自动压缩触发点（单位 token）**插件，
在**设置 → 模型**里改，不用碰 YAML。

`dsh-compaction-basic` 只接受"窗口比例"，实际阈值是
`floor(min(W × ratio, W − O − headroomTokens))`——你以为是调过的比例可能被上限压住，而且同一个
比例在不同模型上代表完全不同的 token 数。这个插件让你直接填真正关心的那个 token 数，由它换算成
精确比例，并写进每个 agent preset 行的 `modelPolicies`。

```
设置 → 模型 → 某个 provider 的卡片 → 自动压缩触发点 / Compaction trigger
   [ 320000 ] tokens   [保存] [清除]
        │
        │ 浏览器写本插件自己的 volatile 命名空间（settings.mutate）
        ▼
compaction-thresholds { models: [...], managed: [...], report: {...} }
        │
        │ 宿主每 1500ms 对账一次，再用 ctx.configEditor.edit() 投影
        ▼
preset-* 行 → plugins[compaction] → config[compaction-basic].config.modelPolicies
   { provider: "clay", model: "deepseek-flash", thresholdRatio: 0.305176… }
        │
        │ 结果以 report 字段回写到同一个命名空间
        ▼
面板显示「已同步 4/4 · 12:34」或「未同步 1/4：preset-standard（…）」
```

## 为什么要两跳

agent preset 行是 Loader 行、不是 settings 条目：`dsh-agent-preset` 的 `Config` 没有
`.volatile()` 字段，所以 `settings.describe()` 不会列出它们、`settings.mutate()` 也会拒绝。
浏览器只能写 volatile 命名空间，因此本插件自己拥有一个（`compaction-thresholds`，就是它自己的
行 id），由宿主去改 preset。**没有新增任何 Remote/RPC**——`dsh-api-remotes` 在构建期就固定了那套
命名空间。

必须接受的一个后果：**命名空间是权威值，preset 行只是投影。** 面板显示的是表，不是 preset 的
读回值；它能诚实显示的是宿主回报的投影结果（`synced` / `failed` / `notes`），放在 `report` 里。

## 三个 volatile 字段

| 字段 | 归属 | 含义 |
|---|---|---|
| `models` | 用户（设置页） | 表：`{provider, model, compactAtTokens, retainTokens?}` |
| `managed` | 宿主 | 本插件写过的 key，用于只 prune 自己的 policy |
| `report` | 宿主 | 上次投影的 `{at, synced[], failed[{preset,message}], notes[]}`；`at` 只在结果变化时前移，空闲时永不重写文件 |

## 宿主写了什么

`thresholdRatio = compactAtTokens / contextWindow`，并微调成 `(tokens + 0.5) / contextWindow`，
保证 `floor(W × ratio)` 精确还原你填的 token 数。`retainRatio`（仅当设置了 `retainTokens`）是
`retainTokens / (W − O)`，`O` 是该路由的预留输出（`info.defaultMaxTokens`）。后端配置里的其它
键——包括已有的 `thresholdRatio`——一律保留；不在表里的模型的 policy 不动；不是本插件写的条目
永不删除。

写入前会用 `dsh-compaction-basic` 自己的规则校验：`0 < ratio <= 1`、
`retainRatio < thresholdRatio`、`retainTokens < thresholdTokens`、压力余量非负。超过后端容量上限
（`W − O − headroomTokens`，headroom 默认 65536）的目标会被写入但截断——后端取
`min(W × ratio, W − O − headroom)`——宿主会报告一条 note 说明被截到了多少。完全无法表达的目标
（`tokens > W`、或保留目标违反比例顺序）会被拒绝，写进 note，行保持原样。

空闲 tick 无写入：宿主把算出的 `modelPolicies` 与当前值做 deep-equal，一致就跳过
`configEditor.edit()`。

provider 决策**故意不缓存**：表不变而某个模型的 `contextWindow` 被改时，必须重新折算比例，否则
token 目标会漂。

## 为什么用轮询而不是 `loader/volatile-update` 事件

settings 保存是在**它自己的 HMR 事务内部**提交 volatile 字段的，而 `dsh-hmr` 用
`AsyncLocalStorage` 挡重入（`if (this.executing.getStore()) reject("HMR transactions cannot be
nested")`）。从那个事件里派生的任何回调都继承了 store，所以由它发起的
`configEditor.edit()` 等多久都会被拒绝——实测：6 次重试 × 两轮 = **56 次拒绝**。因此宿主改成在
激活时武装的 1500ms 对账循环（干净的 async 上下文）；表变化后一个 tick 内读到，再加上逐行写入
时间（每个 preset 行一次 `configEditor.edit()`，大 profile 上约 0.5–9 秒）。

## 安装

```jsonc
// <profile>/package.json（例如 ~/.dsh/profiles/web/package.json）
"dependencies":  { "dsh-compaction-thresholds": "link:/指向/dsh-compaction-thresholds/的绝对路径" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-compaction-thresholds" ] } }
```

然后在该 profile 目录执行 `pnpm install`，重启 `dsh web`（新增 bundle 层需要启动一次；之后改表
实时生效）。bundle 的 `cordis.patch.yml` 会插入 `compaction-thresholds` 行。

`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是**peer** 依赖，这是有意的：以 `link:` 安装
的插件是一个"linked root"，启动器的解析器只有在请求包的 `package.json` 把该名字列进
`peerDependencies` 时，才会把这个裸包请求路由到安装树（`dsh-app-boot/lib/index.js` 的
`routeLinked` + `readPeerNames`）。

已在 DSH `0.2.1-alpha.5` 上验证。

## 升级

`link:` 安装的插件**宿主代码不会热重载**：改过 `lib/index.js`（或拉了新版本）之后要重启一次
`dsh web`，再刷新页面。0.1.0 → 0.2.0 其余兼容：行会在第一次对账时补上 `managed` / `report` 字段。

状态行的时间戳（`at`）是"结果最后一次变化"的时间，不是"最后一次保存成功"的时间；所以一次保存
如果落在已经同步的结果上，时间戳保持不变。

## 卸载

删掉依赖和 bundle 条目 → `pnpm install` → 删除插件目录 → 再从 profile patch 里删掉
`compaction-thresholds` 行。preset 里的 `modelPolicies` 会留着：可以先在面板里逐行清除（会 prune
掉），或者手工删。

## 测试

```sh
node --test test/
```

覆盖：token↔比例精确还原、投影与兄弟键保留（含 `!!js` 标记）、churn guard、prune 归属、拒绝
路径、结构化比较。`lib/policy.js` 故意做成零依赖，测试因此不需要模块图。

## 已知限制

- preset 保留自己的代数：改了触发点只对**新会话**生效。
- `retainTokens` 暂无 UI 控件；行里已有该字段时会被保留。
- 某个 preset 写失败会每 tick 重试直到成功；表里仍保留你输入的值。
- 只覆盖 `@deepseek-ai/dsh-llm-pi-ai` 的 provider；`dsh-llm-deepseek` 是另一套目录，暂未扩展。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半侧：`Config`（三个 volatile 字段）、激活 pass + 1500ms 对账循环、逐行 `configEditor.edit()` 投影、prune、发布 report |
| `lib/policy.js` | 纯逻辑：比例数学、plan/patch、校验、结构化比较 |
| `lib/client.js` | 浏览器半侧：ModuleLoader bundle，注册进 `settings.models.provider-card` 的 keyed 座位（key `llm-pi-ai`），中英文案、保存/清除、投影结果展示 |
| `cordis.patch.yml` | 插入 `compaction-thresholds` Loader 行 |
| `test/policy.test.mjs` | `node --test` 用例 |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（`platform: web`）+ `engines.dsh` |

## 许可

MIT，见 [LICENSE](LICENSE)。
