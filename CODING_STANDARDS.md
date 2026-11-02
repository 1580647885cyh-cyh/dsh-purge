# 编码标准（审查代理读）

这份文件给 /code-review 的 Standards 轴用；实现代理不需要先读它——实现阶段的机械错误应当由
npm run check、测试和 pre-commit 钩子拦住，留下的都是判断题。

## 规则

1. **目录风格各自沿用**：lib/verify/ 与 tests/verify/ 用双引号 + 分号；lib/redteam/ 用单引号无分号；lib/ 其余文件沿用所在文件既有风格。不要为一个新文件“统一”整个目录。
2. **写盘边界**：测试与脚本只写 D 盘；动到 installPreset / homedir() / 技能同步的测试必须用 tests/verify/helpers.js 的 withIsolatedHome()，不得自行改 DSH_HOME 了事。
3. **迁移类改动必须可重复执行**：只碰目标片段、保留用户其余内容、第二次执行 0 改动。不接受“删掉旧字段换可加载”——旧字段的配置含义要么在新接口表达出来，要么在文档里记录具体行为冲突。
4. **验证证据进报告，不进控制台**：新探针的结构化结果要落 report.json / report.md，断言公开可观察的行为（返回值、文件差异、报告字段），不依赖私有方法名或内部调用次数。
5. **未使用的导出与参数**（判断题，无自动化）：仓库没有 lint，未被引用的字段/参数只能在这里兜。审查时发现就记一条；不要为此引入宽泛的重构。

## 工具化现状（决定与原因）

- **lint**：暂不引入。仓库是零依赖交付（package.json 无 devDependencies），离线环境下 npx oxlint / npx eslint 均不可用。
  重新考虑的触发条件：开始允许 devDependency，或有人提供可离线安装的 linter；届时优先补 no-unused-vars 与 no-undef。
- **语法/入口**：npm run check（全量 node --check + 入口 import）。
- **测试**：pre-commit 跑 npm run test:ci（全量测试 + --test-force-exit + 单例超时）。
