# 宿主契约地图（DSH 0.2.1-rc.5 桌面）

导航文档：只记「哪个包做什么、入口在哪、契约边界在哪」，不复制实现语义。
动宿主包调用、预设注册或工具 Schema 之前看这里；具体验证见 `docs/verification/README.md`。

## 包根与版本

- 桌面布局：`<install>/resources/app/dsh/node_modules/@deepseek-ai`（另有 `resources/app/node_modules` 门面）。
- 解析与身份核对：`lib/host-deps.js`；验证侧封装：`lib/verify/host-entry.js` 的 `resolveHostInstall` / `loadHostModules`。
- **版本真源**：适配判定读桌面壳的 `<install>/resources/app/package.json`（`@deepseek-ai/dsh-desktop`），**不读** `resources/app/dsh/package.json` 里的运行时版本；判定与三态在 `lib/host-version.js`（A1 / #18）。未适配不阻断，只进报告与状态。

## 提示词与关键文本在哪个包（改锚点前先查这张表）

补丁里的 `file` 键是「**我们认为**它该在哪」，宿主改版后可能过期。漂移清单里某条锚点在原文件 0 命中、
却在别的包出现 → 先怀疑搬家，别急着改窗口。

| 内容 | rc.5 落点 | 备注 |
| --- | --- | --- |
| web 面身份句 + `Do not start a replacement server` | `dsh-harness-dev-context/lib/index.js` | 键 `dev-context`（#21）；`WEB_SURFACE_PROMPT` 整段，以及 `prefix` / `suffix` 拆开的两半；`LEGACY_WEB_SURFACE` 是**冻结**的旧文案（宿主拿它匹配老会话已记录的段落），任何补丁都不许动；`dsh-web-app/lib/index.js`（181 行）已不含这些句子，只剩 `DSH_WEB_URL` 的描述 |
| 系统提示词装配 / complete 分支 | `dsh-system-prompt/lib/index.js` | 键 `system-prompt` |
| 回滚 append / rewind | `dsh-client-ui-conversation/lib/client.js` | `append(record)`、宿主自带 `isRewindMarker` |
| 审批句与 invariant | `dsh-user-approval/lib/index.js`、`lib/types/index.js`、`lib/invariant.js` | 键 `user-approval*` |
| agent instructions | `dsh-agent-instructions/lib/index.js` | 键 `agent-instructions` |

## 服务与入口

| 用途 | 包 | 入口 | 契约要点 |
| --- | --- | --- | --- |
| 插件生命周期 | `@deepseek-ai/cordis` | `Context` | `ctx.plugin(plugin, config)`；插件行 = `{ id, name, config, disabled, group, isolate }` |
| 系统提示词 | `dsh-system-prompt` | `SystemPrompt` | `ctx.systemPrompt.assemble/createAgentContext`、`renderPrompt(assembly)`、`renderContextSnapshot`；装配变量由宿主注册（桌面只有 `provider`/`model`），未知变量直接抛错；`cwd` 由插件补回（`lib/prompt-variables.js`，值取 `session.header.cwd`，缺失给空串） |
| 工具 | `dsh-tools` | `ToolRuntime` | `ctx.tools.register/schemas/get/execute`；`defineTool`；`assertObjectJsonSchema`、`validateJsonSchemaValue`；执行入口 `ctx.tools.execute({ name, arguments, callId, signal })` |
| 预设注册表 | `dsh-agent-preset-registry` | `AgentPresetRegistry` | `ctx.agentPresets.register/list/readDocument/resolve/compositionInventory`；导出 `entryListProblem`、`auditRows` |
| 预设声明行 | `dsh-agent-preset` | 行插件 | `Config = { id, name, description, order, plugins }`；等价于 `ctx.agentPresets.register()` |
| Loader | `cordis-plugin-loader` | `Loader` / `EntryTree` / `Group` | `Loader` 是 `EntryTree` 子类并提供 `ctx.loader`；`cordis:group` 行要靠 `loader.builtins.group` 才解析 |
| 会话投影 | `dsh-session-projection` | `SessionProjectionRegistry` | `ctx.sessionProjections.register/stateOf` |
| 子智能体 | `dsh-subagent` + `dsh-subagent-spawn-in-process` | `ctx.subagents` | provider 行提供 `spawn`/`fork`；tool 行 `dsh-tool-subagent` 的 config 见下 |
| 模型 | `dsh-llm` + `dsh-llm-pi-ai` | `ctx.llm` | `ctx.llm.stream({ provider, model, messages, tools })`；适配器配 `api: openai-completions` + `baseURL` + `apiKeyEnv` + `models` |

## 消息与依赖（#5 实测）

- `ctx.llm.stream({ messages })`：`message.content` 必须是**内容块数组**（`[{ type: "text", text }]`）。传字符串会在适配器历史校验里失败，最终只落一个 `finish` 块、没有 error 块、端点收不到请求——现象是"模型没产出 tool-call"。
- 第三方依赖（如 `yaml`）在 `<install>/resources/app/dsh/node_modules/<pkg>`；`@deepseek-ai/` 只是宿主包目录，不是所有依赖的根。

## 预设从磁盘到挂载

1. `$DSH_HOME/.agent-presets/<id>/{agent.cordis.yml,preset.yml}` **不是**宿主扫描目录；由插件读盘后 `ctx.agentPresets.register(definition)`（本项目在 `lib/redteam/index.js`）。
2. `register()` → `activate()`：`entryListProblem` 校验行列表 → `mountPreset` → `EntryTree.update(prepareProfileEntries(...))` → 每行 `ctx.plugin(模块, config)`。
3. 挂不上的行进入 `auditRows` 的 `failed`，整份预设被记为 `broken`（`registry.list()`；真实状态文件 `$DSH_HOME/redteam/preset-declare.json`）。
4. 行 config 由插件自己的 `Config`（schemastery）解析，**未知字段不会被丢掉**：插件的 `apply` 看得见并在边界处拒绝。

## 工具 Schema 契约

- `defineTool(...)` 把作者 DSL 编译进宿主子集（`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注解），子集外的写法在定义期就报错。
- 裸 `ctx.tools.register()` 的定义**不**带执行前参数校验；校验来自 `defineTool` 包的那层 `validate`。
- 对象根用 `assertObjectJsonSchema`：要求 `type: "object"`；`pattern`/`format`/`minimum`/`anyOf` 之类的 keyword 直接判违规。
- **rc.5 的硬规则**：作者 DSL 里任何 `type: "object"` 节点必须显式给布尔 `additionalProperties`，漏了
  `defineTool()` 当场抛错（`dsh-tools/lib/index.js` 的 author 编译分支，rc.5 在 `:699` 附近），
  该行 apply 失败 → registry 把整份预设记 `broken`，红队模式直接消失。改工具参数后跑 `npm run verify`
  的入口四：它会真挂 `redteam-tools` 行，让宿主自己编译这些 schema（A8）。

## 已知不可行与边界

- 整份预设组合挂载需要 profile 的 `Loader` 与完整服务图；脱离宿主进程只能按行挂载（`lib/verify/preset-entry.js` 的做法）。
- 自建 `Loader` 时必须自己补 `builtins.group`（宿主由 `dsh-app-boot` 补），否则所有 `cordis:group` 行都 never started。
- `.agent-presets` 改位置不会被宿主发现：路径约定只有插件这一处来源。
- `tool-subagent` 对 `persona` / `toolFilter` 是**硬拒绝**（apply 直接抛错），迁移只能改成 `agentPreset`；见 `lib/redteam/preset-migration.js`。

## 探针

- `lib/verify/host-entry.js`：加载、提示词装配、工具契约、宿主依赖桥接。
- `lib/verify/preset-entry.js`：预设行挂载、迁移与组合裁剪。
- `lib/verify/model-endpoint.js`：假 OpenAI 端点 + 真实适配器 + 真实工具执行。