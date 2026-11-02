# 宿主契约地图（DSH 0.2.1-rc.5 桌面）

导航文档：只记「哪个包做什么、入口在哪、契约边界在哪」，不复制实现语义。
动宿主包调用、预设注册或工具 Schema 之前看这里；具体验证见 `docs/verification/README.md`。

## 包根与版本

- 桌面布局：`<install>/resources/app/dsh/node_modules/@deepseek-ai`（另有 `resources/app/node_modules` 门面）。
- 解析与身份核对：`lib/host-deps.js`；验证侧封装：`lib/verify/host-entry.js` 的 `resolveHostInstall` / `loadHostModules`。

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

## 预设从磁盘到挂载

1. `$DSH_HOME/.agent-presets/<id>/{agent.cordis.yml,preset.yml}` **不是**宿主扫描目录；由插件读盘后 `ctx.agentPresets.register(definition)`（本项目在 `lib/redteam/index.js`）。
2. `register()` → `activate()`：`entryListProblem` 校验行列表 → `mountPreset` → `EntryTree.update(prepareProfileEntries(...))` → 每行 `ctx.plugin(模块, config)`。
3. 挂不上的行进入 `auditRows` 的 `failed`，整份预设被记为 `broken`（`registry.list()`；真实状态文件 `$DSH_HOME/redteam/preset-declare.json`）。
4. 行 config 由插件自己的 `Config`（schemastery）解析，**未知字段不会被丢掉**：插件的 `apply` 看得见并在边界处拒绝。

## 工具 Schema 契约

- `defineTool(...)` 把作者 DSL 编译进宿主子集（`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注解），子集外的写法在定义期就报错。
- 裸 `ctx.tools.register()` 的定义**不**带执行前参数校验；校验来自 `defineTool` 包的那层 `validate`。
- 对象根用 `assertObjectJsonSchema`：要求 `type: "object"`；`pattern`/`format`/`minimum`/`anyOf` 之类的 keyword 直接判违规。

## 已知不可行与边界

- 整份预设组合挂载需要 profile 的 `Loader` 与完整服务图；脱离宿主进程只能按行挂载（`lib/verify/preset-entry.js` 的做法）。
- 自建 `Loader` 时必须自己补 `builtins.group`（宿主由 `dsh-app-boot` 补），否则所有 `cordis:group` 行都 never started。
- `.agent-presets` 改位置不会被宿主发现：路径约定只有插件这一处来源。
- `tool-subagent` 对 `persona` / `toolFilter` 是**硬拒绝**（apply 直接抛错），迁移只能改成 `agentPreset`；见 `lib/redteam/preset-migration.js`。

## 探针

- `lib/verify/host-entry.js`：加载、提示词装配、工具契约、宿主依赖桥接。
- `lib/verify/preset-entry.js`：预设行挂载、迁移与组合裁剪。
- `lib/verify/model-endpoint.js`：假 OpenAI 端点 + 真实适配器 + 真实工具执行。
