import fs from "node:fs";
import path from "node:path";

/** 报告：只汇总结构性事实，提示词正文留在工作区，不写进报告。 */

export function knownFailures({ hostEntry, presetAudit, admin } = {}) {
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
  if (presetAudit && Array.isArray(presetAudit.files)) {
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
  if (admin && Array.isArray(admin.knownFailures)) out.push(...admin.knownFailures);
  return out;
}

export function buildReport({ workspace, baselineFile, seal, drift, sealCheck, hostInfo, pluginInfo, hostEntry, presetAudit, admin, commands } = {}) {
  const failures = knownFailures({ hostEntry, presetAudit, admin });
  const baselineOk = sealCheck ? sealCheck.ok !== false : !drift || drift.ok !== false;
  const ok = Boolean(baselineOk && hostEntry && hostEntry.ok && admin && admin.ok);
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
    } : null,
    presetAudit: presetAudit || null,
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
  } else {
    lines.push("未执行。");
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