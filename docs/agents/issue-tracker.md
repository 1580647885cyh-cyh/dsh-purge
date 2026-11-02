# 任务管理：GitHub Issues

本项目的规格与任务发布到 https://github.com/1580647885cyh-cyh/dsh-purge/issues 。
使用 `gh` CLI 操作；每条写入命令显式指定 `--repo 1580647885cyh-cyh/dsh-purge`，避免 fork 被解析到原作者仓库。

## 基本操作

- 创建：`gh issue create --repo 1580647885cyh-cyh/dsh-purge --title "标题" --body-file <正文文件>`。
- 读取：`gh issue view <编号> --repo 1580647885cyh-cyh/dsh-purge --json number,title,body,labels,comments`。
- 列表：`gh issue list --repo 1580647885cyh-cyh/dsh-purge --state open --json number,title,labels`，按需加 `--label`。
- 评论：正文写入 D 盘文件，使用 `gh issue comment <编号> --repo 1580647885cyh-cyh/dsh-purge --body-file <正文文件>`。
- 标签：`gh issue edit <编号> --repo 1580647885cyh-cyh/dsh-purge --add-label <标签>`；移除用 `--remove-label`。
- 关闭：先提交完成说明，再用 `gh issue close <编号> --repo 1580647885cyh-cyh/dsh-purge`。

创建前核对目标仓库；任务状态标签见 `triage-labels.md`。
多行正文使用真实换行及 `--body-file`；临时文件放在 D 盘。

## 规格、子任务与依赖

技能要求“发布到任务系统”时，创建 GitHub issue；要求“读取任务”时，读取对应 issue 正文及评论。
每份规格一个 issue，每项可独立验收的实现工作一个子 issue。
优先使用 GitHub 原生子任务和阻塞关系；按当前 `gh` 的帮助选择命令，不支持时用 GitHub API。
API 的依赖参数使用 issue 的数字数据库 id，而非显示编号。
原生关系不可用时，在正文开头写 `Part of #<父任务>` 与 `Blocked by: #<阻塞任务>`。
只有全部阻塞任务关闭后才能领取实现任务。

## 外部 PR

PRs as a request surface: no.

## Wayfinding

需要 wayfinder 时，用标记为 `wayfinder:map` 的 issue 保存决策地图。
决策子任务使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 标记。
领取前确认阻塞已解除，领取时分配给自己；解决后记录答案、关闭子任务，并更新地图的决策链接。
