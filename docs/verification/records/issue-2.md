# #2 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 本票验收对应（#2）

- 核对并保留当前源码、形成可校验快照：baseline.js 的清单/treeHash/自检与测试。
- 确认目标宿主与指纹：baseline.js 的 hostFingerprint/pluginFingerprint/environmentFingerprint 与报告。
- 隔离副本、配置、缓存、日志与测试端点都在 D 盘：isolate.js、预检、真实安装只读守卫与测试。
- 宿主公开加载与请求准备最小案例：host-entry.js 与集成测试。
- 公开管理操作最小隔离案例：admin-entry.js 与集成测试。
- 先例探针局限：见上一节。
- 期望来源与允许差异：见上一节。
