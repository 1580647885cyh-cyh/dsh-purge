import fs from "node:fs";
import path from "node:path";

/** 报告：只汇总结构性事实，提示词正文留在工作区，不写进报告。 */

export function knownFailures({ hostEntry, presetAudit, presetEntry, modelToolCall, modelToolCallRejected, admin } = {}) {
  const out = [];
  if (hostEntry && hostEntry.cwdTemplate && hostEntry.cwdTemplate.ok === false) {
    out.push({
      id: "cwd-template-variable",
      area: "提示词变量",
      summary: "宿主只注册 provider/model；任意模板里的 {{cwd}} 仍会让装配渲染失败。",
      evidence: hostEntry.cwdTemplate.error,
      owner: "#5 / #6",
    });
  }
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
  return out;
}

export function buildReport({ workspace, baselineFile, seal, drift, sealCheck, hostInfo, pluginInfo, hostEntry, presetAudit, presetEntry, presetMigration, modelToolCall, modelToolCallRejected, admin, commands } = {}) {
  const failures = knownFailures({ hostEntry, presetAudit, presetEntry, modelToolCall, modelToolCallRejected, admin });
  const baselineOk = sealCheck ? sealCheck.ok !== false : !drift || drift.ok !== false;
  const presetOk = presetEntry ? presetEntry.ok : true;
  const modelOk = modelToolCall ? modelToolCall.ok : true;
  const rejectOk = modelToolCallRejected
    ? modelToolCallRejected.executed !== null && modelToolCallRejected.executed.isError === true
    : true;
  const ok = Boolean(baselineOk && hostEntry && hostEntry.ok && presetOk && modelOk && rejectOk && admin && admin.ok);
  return {
    kind: "dsh-purge-verification",
    generatedAt: new Date().toISOString(),
    ok,
    workspace: {
      root: workspace.root,
      home: workspace.home,
      install: workspace.install,
      out: workspace.out,
    },
    commands: commands || [],
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
      cwdTemplate: hostEntry.cwdTemplate,
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
  lines.push("");
  lines.push("## 隔离边界");
  lines.push("");
  lines.push(line("工作区", report.workspace.root));
  lines.push(line("隔离 DSH_HOME", report.workspace.home));
  lines.push(line("隔离宿主副本", report.workspace.install));
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
    if (report.hostEntry.cwdTemplate) lines.push(line("{{cwd}} 模板", report.hostEntry.cwdTemplate.ok ? "可渲染" : "失败（已知）"));
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