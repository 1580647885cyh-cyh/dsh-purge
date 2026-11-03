# #5 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#5 恢复模板渲染和完整提示词预设运行）

- 故障：目标宿主（0.2.1-rc.5 的 dsh-agent-loop）只注册 provider/model；模板里的 {{cwd}}
  让 renderPrompt 抛 unknown prompt variable，整份提示词渲染失败（此前工作目录报错的来源）。
- 修复：lib/prompt-variables.js 在 apply 时注册 cwd（值取 session.header.cwd，缺失给空串），
  旧模板/自定义模板按原契约渲染；插件自己的段仍不写 {{cwd}}，目录由宿主必需运行上下文提供，
  不重复表达同一事实（原 CWD_ONLY_SUFFIX 修复保持不变）。
- 通过证据：报告已知故障 0 条；模板渲染契约 6/6（含空后缀、缺失后缀、缺失工作目录），
  并带故障对照——同一份旧模板只给宿主自带的 provider/model 时必须仍被拒绝（unknown prompt variable）。
- 通过证据：完整提示词预设全部核对项通过——随包预设 persona 进装配并原样保留、真实装配内模板渲染出
  {{cwd}}、会话模式按预设走红队分支、重复装配三次一致、无残留变量、注入段 1 份、required 上下文在抑制下保留；
  受控请求的系统消息命中插件正文，运行上下文消息带工作目录。

## 本票验收对应（#5 恢复模板渲染和完整提示词预设运行）

- 先回归工作目录报错、已通过的不重复替换：CWD_ONLY_SUFFIX 与 identity.js 的目录句清理保持不变，本票没改提示词段，只补回宿主不再提供的 cwd 装配变量。
- 旧模板、自定义模板、空或缺失后缀、正常与缺失工作目录：host-entry.js 的 templateContract 六案例；期望值取基线模板字面量，缺失目录时变量给空串，渲染不抛。
- 完整提示词预设完成一次受控请求：promptPreset 的 assemble / render / template-in-assembly / baseline-sections / preset-persona / context / stability / required-context / refresh / suppressor-dispose / no-leftovers / no-duplication / request 十三项；随包预设的 persona 行载入装配，会话模式按该预设声明。
- 宿主必需运行上下文与插件贡献的最终呈现：working-directory 按 dsh-working-directory 的公开契约注册（required、JSON 引号目录、不插值），抑制可选上下文后仍在、refresh 后仍在；受控请求的上下文消息命中它，系统消息命中 dsh-purge 正文。
- 与保护基线比较、不宽泛忽略：段名与长度、变量集合、注入段份数、上下文段名逐项比较；report.ok 把模板契约与预设跑通算硬契约，不再降级成已知故障。
- 重复组装与连续步骤稳定：两次装配的提示词、段、上下文一致；受控工具调用照旧（modelToolCall / modelToolCallRejected 未受本票影响）。
- 版本与锁：1.1.71、localVersionLock（remoteUpdates:false、editable:true）未改动。`dshTarget` / `dshTargets` 是**插件声明的已适配版本**（手写常量，本机实测过 0.2.1-rc.5）；**实测宿主版本**只看报告的 `host.adaptation.version` 与 `host.adaptation.state`，两者不要混用（#18）。
