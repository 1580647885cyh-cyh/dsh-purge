import fs from "node:fs";
import path from "node:path";
import { describeHostAdaptation } from "../host-version.js";

/** 报告：只汇总结构性事实，提示词正文留在工作区，不写进报告。 */

function retentionReasonCounts(skipped) {
  const counts = new Map();
  for (const item of skipped || []) counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

/**
 * 工作区清理的一句话事实：run.js 的日志、verify.mjs 的控制台与 report.md 共用同一段话，
 * 免得三个地方各写一遍数字格式（#13 审查发现的重复）。
 */
export function describeRetention(retention) {
  if (!retention) return "";
  if (retention.enabled === false) return "已关闭（--no-prune）";
  if (retention.error) return "未执行：" + retention.error;
  const reasons = retentionReasonCounts(retention.skipped);
  const skipped = reasons.reduce((total, item) => total + item.count, 0);
  return "保留最近 " + retention.keep + " 个旧工作区（本轮另算）"
    + " · 删除 " + retention.removed.length + " 个"
    + " · 释放 " + Math.round(retention.freedBytes / 1048576) + " MB"
    + (skipped > 0 ? " · 跳过 " + skipped + " 个（" + reasons.map((item) => item.reason + " ×" + item.count).join("；") + "）" : "");
}

export function knownFailures({ hostEntry, presetAudit, presetEntry, modelToolCall, modelToolCallRejected, admin, targets } = {}) {
  const out = [];
  // #5 起模板渲染是硬契约：{{cwd}} 渲染不出来属于验证失败（见 buildReport）。
  if (hostEntry && hostEntry.toolBridge && hostEntry.toolBridge.ok === false) {
    out.push({
      id: "host-tool-bridge",
      area: "宿主依赖解析",
      summary: "工具桥接模块拿不到宿主依赖 @deepseek-ai/dsh-tools（预设行会 never started）。",
      evidence: {
        isolated: hostEntry.toolBridge.isolated,
        loaded: hostEntry.toolBridge.loaded,
        error: hostEntry.toolBridge.error,
      },
      owner: "#3",
    });
  }
  if (hostEntry && Array.isArray(hostEntry.toolErrors)) {
    for (const tool of hostEntry.toolErrors) {
      out.push({
        id: "tool-schema-" + tool.name,
        area: "工具 Schema",
        summary: "工具参数 Schema 未通过宿主校验：" + tool.name,
        evidence: tool.error,
        owner: "#4",
      });
    }
  }
  if (presetEntry) {
    if (presetEntry.legacy && presetEntry.legacy.rejected !== true) {
      out.push({
        id: "preset-legacy-not-reproduced",
        area: "预设配置",
        summary: "旧 toolFilter 配置没有复现宿主的拒绝，迁移断言缺少对照。",
        evidence: presetEntry.legacy.error,
        owner: "#4",
      });
    }
    if (presetEntry.migrated && presetEntry.migrated.ok === false) {
      out.push({
        id: "preset-migration",
        area: "预设配置",
        summary: "迁移后的 redteam 预设挂在 tool-subagent 行上仍然失败。",
        evidence: presetEntry.migrated.error,
        owner: "#4",
      });
    }
    if (presetEntry.worker && presetEntry.worker.ok === false) {
      out.push({
        id: "preset-worker",
        area: "预设配置",
        summary: "子级预设 redteam-worker 的组合不可用。",
        evidence: presetEntry.worker.error,
        owner: "#4",
      });
    }
    if (presetEntry.composition && presetEntry.composition.problem) {
      out.push({
        id: "preset-composition",
        area: "预设配置",
        summary: "预设组合不是宿主认可的插件行列表。",
        evidence: presetEntry.composition.problem,
        owner: "#4",
      });
    }
  } else if (presetAudit && Array.isArray(presetAudit.files)) {
    for (const file of presetAudit.files) {
      if (!file.deprecated || file.deprecated.length === 0) continue;
      out.push({
        id: "preset-deprecated-" + file.id,
        area: "预设配置",
        summary: "已安装预设仍写宿主已废弃字段：" + file.deprecated.map((item) => item.key + "@" + item.line).join(", "),
        evidence: file.file,
        owner: "#4",
      });
    }
  }
  if (hostEntry && Array.isArray(hostEntry.tools)) {
    for (const tool of hostEntry.tools) {
      if (tool.contract && tool.contract.extraRejected === false) {
        out.push({
          id: "tool-contract-" + tool.name,
          area: "工具契约",
          summary: "工具参数接受了一个未声明的额外属性：" + tool.name,
          evidence: JSON.stringify(tool.contract),
          owner: "#4",
        });
      }
    }
  }
  if (modelToolCallRejected && modelToolCallRejected.executed && modelToolCallRejected.executed.isError !== true) {
    out.push({
      id: "model-tool-unknown-accepted",
      area: "工具调用",
      summary: "模型点名不存在的工具时宿主没有拒绝。",
      evidence: JSON.stringify(modelToolCallRejected.executed),
      owner: "#4",
    });
  }
  if (modelToolCall && modelToolCall.ok === false) {
    out.push({
      id: "model-tool-call",
      area: "工具调用",
      summary: "受控模型端点产出的工具调用没能走通宿主执行路径。",
      evidence: modelToolCall.error || (modelToolCall.executed && modelToolCall.executed.isError ? "工具返回错误结果" : ""),
      owner: "#4",
    });
  }
  if (admin && Array.isArray(admin.knownFailures)) out.push(...admin.knownFailures);
  // #6：状态与文件事实不一致属于验证失败，不降级成已知故障。
  if (targets && targets.error) {
    out.push({
      id: "target-entry",
      area: "目标定位",
      summary: "目标定位与适配状态入口没有跑完。",
      evidence: targets.error,
      owner: "#6",
    });
  }
  if (targets && targets.audit && Array.isArray(targets.audit.falseSuccess)) {
    for (const row of targets.audit.falseSuccess) {
      out.push({
        id: "target-false-success-" + row.id,
        area: "适配状态",
        summary: "补丁 #" + row.id + " " + row.name + " 报 " + row.status + "，但目标文件里既没有目标态也没有待改原文。",
        evidence: row.targets.join(", "),
        owner: "#6",
      });
    }
  }
  if (targets && targets.audit && Array.isArray(targets.audit.ahead)) {
    for (const row of targets.audit.ahead) {
      out.push({
        id: "target-status-ahead-" + row.id,
        area: "适配状态",
        summary: "补丁 #" + row.id + " " + row.name + " 报 " + row.status + "，目标文件里仍能匹配到待改原文。",
        evidence: "",
        owner: "#6",
      });
    }
  }
  if (targets && targets.isolated && targets.isolated.diffs && targets.isolated.diffs.reapply > 0) {
    out.push({
      id: "target-reapply-not-idempotent",
      area: "适配状态",
      summary: "重复应用仍在改文件（" + targets.isolated.diffs.reapply + " 处）：补丁会叠加重复内容。",
      evidence: JSON.stringify(targets.isolated.diffs),
      owner: "#6",
    });
  }
  if (targets && targets.runtime) {
    for (const [id, record] of Object.entries(targets.runtime)) {
      if (record && record.ok === false) {
        out.push({
          id: "target-runtime-" + id,
          area: "运行结果",
          summary: "适配后的运行结果没有证明处理生效：" + id,
          evidence: record.error || JSON.stringify(record.cases || record.detail || {}),
          owner: "#6",
        });
      }
    }
  }
  // A4（#24）：fixture 的 NEXT 安装树上，四项事实任一条不成立就报出来。
  if (targets && targets.desktop && targets.desktop.ok === false) {
    const failed = (targets.desktop.cases || []).filter((item) => !item.ok).map((item) => item.id);
    out.push({
      id: "target-desktop-next",
      area: "发行形态识别",
      summary: "NEXT 安装树的事实没有全部成立：" + (failed.join(", ") || "未跑完"),
      evidence: targets.desktop.error || JSON.stringify(targets.desktop.facts || {}),
      owner: "#24",
    });
  }
  if (targets && targets.liveHost && targets.liveHost.ok === false) {
    out.push({
      id: "target-live-host-write",
      area: "隔离边界",
      summary: "目标定位过程中真实安装的目标文件发生变化。",
      evidence: targets.liveHost.changed.slice(0, 20),
      owner: "#6",
    });
  }
  return out;
}

export function buildReport({ workspace, baselineFile, seal, drift, sealCheck, hostInfo, pluginInfo, hostEntry, presetAudit, presetEntry, presetMigration, modelToolCall, modelToolCallRejected, admin, targets, fixture, retention, commands, partial = null } = {}) {
  const failures = knownFailures({ hostEntry, presetAudit, presetEntry, modelToolCall, modelToolCallRejected, admin, targets });
  const baselineOk = sealCheck ? sealCheck.ok !== false : !drift || drift.ok !== false;
  const presetOk = presetEntry ? presetEntry.ok : true;
  const modelOk = modelToolCall ? modelToolCall.ok : true;
  const rejectOk = modelToolCallRejected
    ? modelToolCallRejected.executed !== null && modelToolCallRejected.executed.isError === true
    : true;
  // 模板渲染与完整提示词预设是 #5 的硬契约：任一案例失败就让验证不通过，而不是降级成已知故障。
  const templateOk = Boolean(hostEntry && hostEntry.templateContract && hostEntry.templateContract.ok === true);
  const promptPresetOk = Boolean(hostEntry && hostEntry.promptPreset && hostEntry.promptPreset.ok === true);
  // #6 起「目标定位 + 逐文件核对 + 运行结果」也是硬契约。
  const targetsOk = Boolean(targets && targets.ok === true);
  // --only：只对跑过的阶段判红。没跑的阶段不能算失败（否则探针永远退出码 2），
  // 也不能算通过 —— 报告里用 partial 明写「本次未执行」。
  const ran = (stage) => !partial || (Array.isArray(partial.stages) && partial.stages.includes(stage));
  const stageResults = {
    host: Boolean(hostEntry && hostEntry.ok && templateOk && promptPresetOk),
    preset: Boolean(presetOk),
    model: Boolean(modelOk && rejectOk),
    admin: Boolean(admin && admin.ok),
    targets: targetsOk,
  };
  const ok = Boolean(baselineOk && Object.entries(stageResults).every(([stage, value]) => !ran(stage) || value));
  return {
    kind: "dsh-purge-verification",
    generatedAt: new Date().toISOString(),
    ok,
    // 只跑了部分入口时写明跑了哪些、跳过哪些（--only targets）。null = 整轮。
    partial: partial || null,
    workspace: {
      root: workspace.root,
      home: workspace.home,
      install: workspace.install,
      out: workspace.out,
    },
    commands: commands || [],
    // #11：fixture 来源与缓存事实——asar（本次现解）/ cache（命中缓存）/ install（无 asar 时复制安装目录）。
    fixture: fixture ? {
      source: fixture.source,
      packages: (fixture.copied || []).length,
      extras: (fixture.copiedExtras || []).length,
      durationMs: fixture.durationMs || 0,
      cacheKey: fixture.cache ? fixture.cache.key : "",
      cacheDir: fixture.cache ? fixture.cache.dir : "",
      cacheHit: Boolean(fixture.cache && fixture.cache.hit),
      rebuildReason: fixture.cache ? fixture.cache.rebuildReason || "" : "",
      cacheError: fixture.cache ? fixture.cache.error || "" : "",
    } : null,
    // #13：工作区清理的结构性事实——保留几个、删了哪些、释放多少、为什么跳过。
    retention: retention ? {
      enabled: retention.enabled !== false,
      root: retention.root,
      keep: retention.keep,
      error: retention.error || "",
      kept: retention.kept,
      removed: retention.removed,
      freedBytes: retention.freedBytes,
      skippedCount: (retention.skipped || []).length,
      skippedReasons: retentionReasonCounts(retention.skipped),
      skipped: (retention.skipped || []).slice(0, 10),
    } : null,
    baseline: {
      file: baselineFile || "",
      sourceRoot: seal ? seal.baseline.sourceRoot : "",
      treeHash: seal ? seal.baseline.source.treeHash : "",
      fileCount: seal ? seal.baseline.source.fileCount : 0,
      plugin: pluginInfo || (seal ? seal.baseline.plugin : null),
      host: hostInfo || (seal ? seal.baseline.host : null),
      environment: seal ? seal.baseline.environment : null,
      git: seal ? seal.baseline.git : null,
      drift: drift || null,
      sealCheck: sealCheck || null,
    },
    hostEntry: hostEntry ? {
      ok: hostEntry.ok,
      error: hostEntry.error || "",
      prompt: hostEntry.prompt ? { length: hostEntry.prompt.length, sha256: hostEntry.prompt.sha256 } : null,
      context: hostEntry.context,
      sections: hostEntry.sections,
      variables: hostEntry.variables,
      tools: hostEntry.tools,
      toolErrors: hostEntry.toolErrors,
      templateContract: hostEntry.templateContract || null,
      promptPreset: hostEntry.promptPreset || null,
      toolBridge: hostEntry.toolBridge || null,
    } : null,
    presetAudit: presetAudit || null,
    presetEntry: presetEntry || null,
    presetMigration: presetMigration || null,
    modelToolCall: modelToolCall || null,
    modelToolCallRejected: modelToolCallRejected || null,
    pendingSelfHeal: presetEntry && presetEntry.installedLegacy
      ? [{
        id: "preset-installed-legacy",
        summary: "真实 DSH_HOME 里的已安装副本仍是旧 toolFilter；插件下次启动会就地迁移（副本上的迁移与幂等已验证）。",
        evidence: presetEntry.installedLegacy,
      }]
      : [],
    admin: admin ? {
      ok: admin.ok,
      error: admin.error || "",
      hosts: admin.hosts,
      aiBase: admin.aiBase,
      steps: admin.steps,
      diffs: admin.diffs,
      backupsCreated: admin.backupsCreated,
      revertRestored: admin.revertRestored,
      liveHost: admin.liveHost,
      fdProbe: admin.fdProbe,
      fileProbe: admin.fileProbe || null,
      backupFaults: admin.backupFaults || null,
    } : null,
    targets: targets ? {
      ok: targets.ok,
      error: targets.error || "",
      aiBase: targets.aiBase,
      host: targets.host || null,
      live: targets.live,
      isolated: targets.isolated,
      audit: targets.audit,
      runtime: targets.runtime,
      desktop: targets.desktop || null,
      liveHost: targets.liveHost,
    } : null,
    knownFailures: failures,
  };
}

function line(label, value) {
  return "- " + label + "：" + String(value);
}

export function renderReportMarkdown(report) {
  const lines = [];
  lines.push("# dsh-purge 隔离验证报告");
  lines.push("");
  lines.push("生成时间：" + report.generatedAt);
  lines.push("结论：" + (report.ok ? "通过（已知故障单独记录）" : "未通过"));
  if (report.partial) {
    lines.push(line("范围", "只跑了 " + report.partial.stages.join(",") + "；未执行：" + (report.partial.skipped || []).join(",")
      + "（结论只对跑过的阶段负责）"));
  }
  lines.push("");
  lines.push("## 隔离边界");
  lines.push("");
  lines.push(line("工作区", report.workspace.root));
  lines.push(line("隔离 DSH_HOME", report.workspace.home));
  lines.push(line("隔离宿主副本", report.workspace.install));
  if (report.retention) lines.push(line("工作区清理", describeRetention(report.retention)));
  if (report.fixture) {
    const source = report.fixture.source;
    const how = source === "cache" ? "（命中缓存，整棵复制）" : source === "asar" ? "（从 app.asar 解）" : "（从安装目录复制）";
    lines.push(line("fixture 来源", source + how + " · " + report.fixture.durationMs + " ms"));
    lines.push(line("fixture 包", report.fixture.packages + " 个 · 额外依赖 " + report.fixture.extras + " 个"));
    if (report.fixture.cacheKey) {
      lines.push(line("fixture 缓存", report.fixture.cacheDir
        + " · " + (report.fixture.cacheHit ? "命中" : "重建" + (report.fixture.rebuildReason ? "（" + report.fixture.rebuildReason + "）" : ""))
        + (report.fixture.cacheError ? " · 缓存不可用：" + report.fixture.cacheError : "")));
    }
  }
  lines.push("");
  lines.push("## 保护基线");
  lines.push("");
  lines.push(line("快照文件", report.baseline.file));
  lines.push(line("源码根", report.baseline.sourceRoot));
  lines.push(line("treeHash", report.baseline.treeHash));
  lines.push(line("文件数", report.baseline.fileCount));
  if (report.baseline.plugin) lines.push(line("插件版本", report.baseline.plugin.version + "（锁 " + JSON.stringify(report.baseline.plugin.localVersionLock) + "）"));
  if (report.baseline.host) lines.push(line("宿主版本", report.baseline.host.shellVersion + " / runtime " + report.baseline.host.runtimeVersion));
  if (report.baseline.sealCheck) {
    lines.push(line("封存清单自检", report.baseline.sealCheck.ok ? "一致" : "失败"));
  }
  if (report.baseline.drift) {
    lines.push(line("与上一次基线对比", report.baseline.drift.ok ? "一致" : "有差异（源码在上次验证后发生过改动）"));
    if (!report.baseline.drift.ok) {
      lines.push(line("新增", report.baseline.drift.added.length));
      lines.push(line("删除", report.baseline.drift.removed.length));
      lines.push(line("修改", report.baseline.drift.changed.length));
    }
  }
  lines.push("");
  lines.push("## 宿主加载与请求准备");
  lines.push("");
  if (report.hostEntry) {
    lines.push(line("结果", report.hostEntry.ok ? "通过" : "失败：" + report.hostEntry.error));
    if (report.hostEntry.prompt) lines.push(line("系统提示词", report.hostEntry.prompt.length + " 字符 / sha256 " + report.hostEntry.prompt.sha256.slice(0, 16)));
    lines.push(line("段", (report.hostEntry.sections || []).map((item) => item.name + "(" + item.length + ")").join(", ")));
    lines.push(line("装配变量", (report.hostEntry.variables || []).join(", ")));
    lines.push(line("工具契约", (report.hostEntry.tools || []).map((item) => item.name).join(", ")));
    if (report.hostEntry.templateContract) {
      const contract = report.hostEntry.templateContract;
      const failed = (contract.cases || []).filter((item) => item.ok === false);
      lines.push(line("模板渲染契约", contract.ok
        ? "通过（" + (contract.cases || []).length + " 个案例）"
        : "失败：" + failed.map((item) => item.id + "（" + (item.error || "未渲染") + "）").join("；")));
      for (const item of contract.cases || []) {
        lines.push(line("  " + item.id, (item.ok ? "ok" : "失败") + " · " + JSON.stringify(item.rendered === undefined ? "" : item.rendered) + (item.error ? " · " + item.error : "")));
      }
      if (contract.regression) {
        lines.push(line("  故障对照", contract.regression.rejected
          ? "只给宿主自带变量时仍被拒绝 · " + contract.regression.error
          : "未能复现拒绝：" + (contract.regression.error || "宿主接受了未知变量")));
      }
    }
    if (report.hostEntry.promptPreset) {
      const preset = report.hostEntry.promptPreset;
      if (preset.persona) lines.push(line("预设 persona", (preset.persona.loaded ? "已载入" : "未载入") + " · " + preset.persona.prefixLength + " 字符 · " + preset.persona.source + (preset.persona.error ? " · " + preset.persona.error : "")));
      if (preset.mode) lines.push(line("会话模式", (preset.mode.redteam ? "redteam" : "general") + (preset.mode.preset ? "（预设 " + preset.mode.preset + "）" : "")));
      lines.push(line("完整提示词预设", (preset.ok ? "通过" : "失败：" + (preset.error || "案例未通过"))
        + " · 提示词 " + (preset.prompt ? preset.prompt.length : 0) + " 字符"
        + " · 运行上下文 " + (preset.context ? preset.context.length : 0) + " 字符"
        + " · 重复装配 " + (preset.stable && preset.stable.repeats ? preset.stable.repeats : 0) + " 次"));
      for (const pass of preset.passes || []) lines.push(line("  " + pass.id, (pass.ok ? "ok" : "失败") + (pass.detail ? " · " + pass.detail : "")));
    }
    if (report.hostEntry.toolBridge) {
      const bridge = report.hostEntry.toolBridge;
      lines.push(line("工具桥接", bridge.ok ? "通过" : "失败：" + (bridge.error || "未解析")));
      if (bridge.isolated) lines.push(line("隔离桌面解析", (bridge.isolated.ok ? "ok" : "失败") + " / via " + (bridge.isolated.via || "-")));
      if (bridge.host) lines.push(line("真实宿主解析", (bridge.host.ok ? "ok" : "失败") + " / via " + (bridge.host.via || "-")));
      if (bridge.loaded) lines.push(line("真实宿主加载", (bridge.loaded.ok ? "ok" : "失败") + " / apply " + (bridge.loaded.apply ? "function" : "-")));
    }
  } else {
    lines.push("未执行。");
  }
  lines.push("");
  lines.push("## 预设注册与工具契约");
  lines.push("");
  if (report.presetEntry) {
    const entry = report.presetEntry;
    lines.push(line("结果", entry.ok ? "通过" : "失败"));
    lines.push(line("预设目录", entry.dir));
    lines.push(line("旧 toolFilter 复现", entry.legacy
      ? (entry.legacy.rejected ? "宿主拒绝（" + entry.legacy.error + "）" : "未复现：" + entry.legacy.error)
      : "未执行"));
    lines.push(line("迁移后挂载", entry.migrated ? (entry.migrated.ok ? "ok" : "失败：" + entry.migrated.error) : "未执行"));
    if (entry.worker) {
      lines.push(line("worker 组合裁掉的行", (entry.worker.removed || []).join(", ") || "无"));
      lines.push(line("worker agentPreset", entry.worker.agentPreset || "未声明"));
      lines.push(line("worker 挂载", entry.worker.ok ? "ok" : "失败：" + entry.worker.error));
    }
    if (entry.composition) lines.push(line("组合校验", entry.composition.problem ? "失败：" + entry.composition.problem : "通过（" + entry.composition.rows + " 行）"));
    if (entry.error) lines.push(line("错误", entry.error));
  } else {
    lines.push("未执行。");
  }
  if (report.presetMigration) {
    const migration = report.presetMigration;
    lines.push(line("已安装副本迁移", migration.changed ? "已迁移（副本）" : (migration.reason || "无需迁移")));
    if (migration.changed) {
      lines.push(line("删除的行", (migration.removedLines || []).map((text) => text.trim()).filter(Boolean).join(" | ") || "无"));
      lines.push(line("新增的行", (migration.addedLines || []).map((text) => text.trim()).filter(Boolean).join(" | ") || "无"));
      lines.push(line("重复迁移", migration.idempotent ? "稳定（第二次无改动）" : "不稳定"));
    }
  }
  lines.push("");
  lines.push("## 受控模型端点 → 工具调用");
  lines.push("");
  const rounds = [
    { label: "工具路径（有效参数）", record: report.modelToolCall, want: "accept" },
    { label: "工具集外调用", record: report.modelToolCallRejected, want: "reject" },
  ];
  for (const round of rounds) {
    const record = round.record;
    if (!record) { lines.push(line(round.label, "未执行")); continue; }
    const executed = record.executed;
    const passed = round.want === "reject"
      ? Boolean(executed && executed.isError === true)
      : Boolean(executed && executed.isError === false);
    lines.push(line(round.label, (passed ? "通过" : "未通过")
      + " / 调用 " + record.call.name + " / 端点端口 " + (record.endpoint ? record.endpoint.port : "-")
      + " / 工具结果 " + (executed ? (executed.isError ? "拒绝（isError）" : "成功（" + executed.textLength + " 字符）") : "未执行")
      + (record.error ? " / " + record.error : "")));
  }
  lines.push("");
  lines.push("## 管理生命周期（隔离副本）");
  lines.push("");
  if (report.admin) {
    lines.push(line("结果", report.admin.ok ? "通过" : "失败：" + report.admin.error));
    lines.push(line("宿主", (report.admin.hosts || []).join(", ")));
    for (const step of report.admin.steps || []) {
      lines.push(line(step.name, (step.ok ? "ok" : "error") + " / " + step.text.slice(0, 160)));
    }
    for (const [name, diff] of Object.entries(report.admin.diffs || {})) {
      lines.push(line(name + " 文件差异", "新增 " + diff.added + " / 修改 " + diff.changed + " / 删除 " + diff.removed));
    }
    if (report.admin.liveHost) {
      lines.push(line("真实安装目标文件", report.admin.liveHost.ok ? "未改动（" + report.admin.liveHost.checked + " 个）" : "被改动：" + report.admin.liveHost.changed.join(", ")));
    }
    lines.push(line("备份文件", report.admin.backupsCreated));
    lines.push(line("revert 还原", report.admin.revertRestored ? "是" : "否"));
    if (report.admin.backupFaults) {
      const faults = report.admin.backupFaults;
      const failed = (faults.cases || []).filter((item) => !item.ok);
      lines.push(line("备份/恢复故障注入", faults.ok
        ? (faults.cases || []).length + "/" + (faults.cases || []).length + " 通过（完整备份 / 官方标记识别 / 过期备份刷新 / 过期备份不写回 / 0 字节备份）"
        : "失败：" + (faults.error || failed.map((item) => item.id).join(","))));
      for (const item of (faults.cases || []).filter((caseItem) => !caseItem.ok)) lines.push(line("  " + item.id, item.detail));
    }
    if (report.admin.fdProbe) {
      lines.push(line("hostFs fd 方法缺失", (report.admin.fdProbe.missing || []).join(", ") || "无"));
      lines.push(line("备份 rename 结果", report.admin.fdProbe.renameError || "成功"));
    }
    if (report.admin.fileProbe) {
      const probe = report.admin.fileProbe;
      lines.push(line("文件种类", probe.ok ? "文本入口/普通文件/二进制已区分" : "未正确区分：" + probe.error));
      if (probe.before && probe.after) {
        lines.push(line("文本入口", probe.before.text + " → " + probe.after.text));
        lines.push(line("二进制", probe.before.binary + (probe.binaryUnchanged ? "（字节未变）" : "（被改写）")));
        lines.push(line("普通文件", probe.plainUnchanged ? "未被 shim 写入（字节未变）" : "被改写"));
      }
    }
  } else {
    lines.push("未执行。");
  }
  lines.push("");
  lines.push("## 目标定位与适配状态（#6）");
  lines.push("");
  if (report.targets) {
    const targets = report.targets;
    const failing = [];
    if (targets.error) failing.push(targets.error);
    if (targets.isolated && targets.isolated.diffs && targets.isolated.diffs.apply === 0) failing.push("隔离副本应用没有改动文件");
    if (targets.isolated && targets.isolated.diffs && targets.isolated.diffs.reapply > 0) failing.push("重复应用仍在改文件");
    if (targets.audit && targets.audit.falseSuccess.length > 0) failing.push("状态与文件不一致 " + targets.audit.falseSuccess.map((item) => "#" + item.id).join(","));
    if (targets.audit && targets.audit.ahead.length > 0) failing.push("状态超前于文件 " + targets.audit.ahead.map((item) => "#" + item.id).join(","));
    if (targets.audit && targets.audit.behind.length > 0) failing.push("状态落后于文件 " + targets.audit.behind.map((item) => "#" + item.id).join(","));
    for (const [id, record] of Object.entries(targets.runtime || {})) {
      if (record && record.ok === false) failing.push(id + " 运行结果未通过");
    }
    if (targets.desktop && targets.desktop.ok === false) failing.push("NEXT 发行形态识别未通过");
    if (targets.liveHost && targets.liveHost.ok === false) failing.push("真实安装被改动");
    lines.push(line("结果", targets.ok ? "通过" : "失败：" + (failing.join("；") || "未跑完")));
    // A1：宿主版本与适配状态是「能见度」，不是通过条件 —— 未适配也照常执行。
    if (targets.host) {
      // 与 status 输出共用同一套描述，避免两处拼串各自漂（code-review 判断项）。
      lines.push(line("宿主版本与适配状态", describeHostAdaptation(targets.host)
        + (targets.host.state === "adapted" ? "" : "；不阻断，只在报告与状态里提醒")));
      if (targets.host.path) lines.push(line("  版本来源", targets.host.path));
    }
    if (targets.live) {
      const live = targets.live.summary || {};
      lines.push(line("真实安装定位", ((live.effective || 0) + (live.satisfied || 0)) + " 个补丁已具目标态（其中写进文件 "
        + (live.effective || 0) + "） / " + (live.pending || 0) + " 个待应用 / "
        + (live.unmatched || 0) + " 个对不上 / " + (live["not-applicable"] || 0) + " 个不适用"));
      if (targets.live.shellFile) lines.push(line("桌面壳入口", targets.live.shellFile));
      // A5：新补丁在真实安装上的目标态。pending = 还没写进宿主（Apply 之后应为 effective）。
      if (targets.live.exitPatch) {
        lines.push(line("桌面退出留痕补丁 #" + targets.live.exitPatch.id, targets.live.exitPatch.evidence));
      }
      if ((targets.live.unmatched || []).length > 0) {
        lines.push(line("真实安装对不上的补丁", targets.live.unmatched.map((item) => "#" + item.id + "(" + item.keys.join("/") + ")").join(",")));
      }
      for (const item of targets.live.unresolvedKeys || []) {
        if (item.searched.length === 0) continue;
        lines.push(line("  真实安装未定位键 " + item.key, "搜索过 " + item.searched.slice(0, 2).join(" ; ")));
      }
    }
    const isolated = targets.isolated || {};
    lines.push(line("隔离副本应用", "改了 " + (isolated.diffs ? isolated.diffs.apply : 0) + " 个文件；重复应用再改 " + (isolated.diffs ? isolated.diffs.reapply : 0) + " 个"));
    const summary = isolated.summary || {};
    lines.push(line("应用后逐文件核对", "写进文件 " + (summary.effective || 0)
      + " / 宿主本就满足 " + (summary.satisfied || 0)
      + " / 待改 " + (summary.pending || 0)
      + " / 对不上 " + (summary.unmatched || 0)
      + " / 不适用 " + (summary["not-applicable"] || 0)));
    for (const item of isolated.unmatched || []) {
      lines.push(line("  对不上 #" + item.id, item.name + " · " + item.keys.join(", ")));
    }
    // A2：漂移清单 —— 修锚点的输入。逐条给到「哪个文件的哪个锚点没命中」。
    const drifted = isolated.drifted || [];
    if (drifted.length > 0) {
      lines.push(line("漂移（原文对不上、也没改上）", drifted.length + " 条：不挡 Apply，但这是要修锚点的清单"));
      for (const item of drifted) {
        const where = (item.keys || []).map((entry) => {
          const anchors = (entry.anchors || []).map((anchor) => JSON.stringify(anchor.head)).join(" / ");
          return (entry.path || entry.key) + (anchors ? "：锚点 " + anchors : "");
        }).join(" ; ");
        const tag = item.strict ? "（必需）" : item.optional ? "（可选）" : "";
        lines.push(line("  漂移 #" + item.id + tag, item.name + (where ? " · " + where : "")));
      }
    }
    for (const item of isolated.unresolvedKeys || []) {
      if (item.searched.length === 0) {
        lines.push(line("  未定位键 " + item.key, "当前安装没有这个落点"));
        continue;
      }
      lines.push(line("  未定位键 " + item.key, "搜索过 " + item.searched.slice(0, 3).join(" ; ")));
    }
    if (targets.audit) {
      const settled = targets.audit.settledByLayout.map((item) => "#" + item.id).join(",");
      lines.push(line("状态与文件一致", "假成功 " + targets.audit.falseSuccess.length
        + " / 状态超前 " + targets.audit.ahead.length
        + " / 状态落后 " + targets.audit.behind.length
        + " / 布局结算 " + targets.audit.settledByLayout.length
        + (settled ? "（" + settled + "：目标文件里没有该布局的原文，按布局软补丁结算，不计入成功证据）" : "")));
    }
    for (const item of isolated.notApplicable || []) {
      const places = item.keys.flatMap((entry) => entry.searched || []);
      lines.push(line("  不适用 #" + item.id + (item.optional ? "" : "（非可选）"), item.name + (places.length ? " · 搜索过 " + places.slice(0, 3).join(" ; ") : "")));
    }
    const runtime = targets.runtime || {};
    if (runtime.completePrompt) {
      const proof = runtime.completePrompt;
      const control = proof.control && typeof proof.control.hasInject === "boolean"
        ? " · 对照（未打补丁的真实宿主）注入段：" + (proof.control.hasInject ? "仍在（宿主已带同类处理）" : "丢失")
        : "";
      lines.push(line("完整提示词装配", (proof.ok
        ? "注入段与 complete 段共存，required 上下文保留"
        : "失败：" + (proof.error || JSON.stringify(proof.detail))) + control));
    }
    if (runtime.shell) {
      const failed = (runtime.shell.cases || []).filter((item) => !item.ok);
      lines.push(line("桌面壳 close 回调", runtime.shell.ok
        ? "未打补丁 code=0 报错 → 打补丁后不报错、非 0 仍报错、重复应用稳定"
        : "失败：" + (runtime.shell.error || failed.map((item) => item.id).join(","))));
    }
    if (runtime.exitTrace) {
      const proof = runtime.exitTrace;
      const failedCases = (proof.cases || []).filter((item) => !item.ok);
      lines.push(line("桌面退出留痕", proof.ok
        ? "close 三路（code=0 / 非 0 / signal）各落一条，条数与字节有上界，拔掉那段会重新变红"
        : "失败：" + (proof.error || failedCases.map((item) => item.id).join(","))));
      for (const item of proof.cases || []) {
        lines.push(line("  " + item.id, (item.ok ? "ok" : "失败") + (item.detail ? " · " + item.detail : "")));
      }
      // 这一行原样取自公开 purge_status 的输出：报告不重算格式，也不在 read-side 失败时自己拼一行。
      lines.push(proof.statusLine || "  · 最近一次桌面退出：purge_status 里读不到这一行（见上方失败项）");
    }
    if (runtime.presetFetch) {
      const failed = (runtime.presetFetch.cases || []).filter((item) => !item.ok);
      lines.push(line("preset fetch 落地", runtime.presetFetch.ok
        ? "副本上关掉 fetch 后，公开 purge_apply 重新打开且重复应用不追加"
        : "失败：" + (runtime.presetFetch.error || failed.map((item) => item.id).join(","))));
    }
    if (targets.desktop) {
      const desk = targets.desktop;
      lines.push(line("发行形态 fixture（DSH NEXT）", desk.ok ? "通过" : "失败：" + (desk.error || "案例未通过")));
      for (const item of desk.cases || []) {
        lines.push(line("  " + item.id, (item.ok ? "ok" : "失败") + (item.detail ? " · " + item.detail : "")));
      }
      if (desk.facts) {
        lines.push(line("  形态事实", "surface=" + desk.facts.surface
          + " · form=" + (desk.facts.form || "未认出")
          + " · " + desk.facts.swap_reason
          + " · 壳入口 " + (desk.facts.shell_main ? "已定位" : "未定位")));
      }
    }
    if (targets.liveHost) {
      lines.push(line("真实安装目标文件", targets.liveHost.ok ? "未改动（" + targets.liveHost.checked + " 个）" : "被改动：" + targets.liveHost.changed.join(", ")));
    }
  } else {
    lines.push("未执行。");
  }
  lines.push("");
  lines.push("## 已知故障（保留，不在本票修复）");
  lines.push("");
  if (!report.knownFailures || report.knownFailures.length === 0) {
    lines.push("无。");
  } else {
    for (const failure of report.knownFailures) {
      lines.push("- [" + failure.id + "] " + failure.summary + (failure.owner ? "（归属 " + failure.owner + "）" : ""));
    }
  }
  if (report.pendingSelfHeal && report.pendingSelfHeal.length > 0) {
    lines.push("");
    lines.push("## 待自愈（真实安装，只读）");
    lines.push("");
    for (const item of report.pendingSelfHeal) lines.push("- [" + item.id + "] " + item.summary);
  }
  lines.push("");
  lines.push("## 执行记录");
  lines.push("");
  for (const command of report.commands || []) lines.push(line("命令", command));
  lines.push("");
  return lines.join("\n");
}

export function writeReport(workspace, report) {
  const jsonFile = path.join(workspace.out, "report.json");
  const mdFile = path.join(workspace.out, "report.md");
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(mdFile, renderReportMarkdown(report) + "\n", "utf8");
  return { jsonFile, mdFile };
}