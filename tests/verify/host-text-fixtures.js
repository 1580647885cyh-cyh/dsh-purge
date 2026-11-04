/**
 * 宿主原文 fixture（#21 复盘）。
 *
 * 为什么单独成模块：锚点测试里的「宿主原文」必须逐字节就是宿主文件里的一段。
 * #21 第一版把 rc.5 的 `WEB_SURFACE_PROMPT` 缩成了手写骨架（少了 "this GUI" / "this app"、少了 \` 转义
 * 反引号），窗口锚点看起来能用、对真机字节却不可靠；两轴 review 判成「证据不得自证」。
 *
 * 规矩：**声称是原文的**文本登记在这里，由 host-text-fixtures.test.js 回真机核对子串
 * （Apply 之后 live 文件是补丁态，测试优先从 app.asar 取原文）；
 * **故意裁过的等价形状**（#6 的 close 回调、assemble 分支那类）留在各自测试里，不要混进来。
 *
 * 出处：rc.5 桌面安装 `resources/app/dsh/node_modules/@deepseek-ai/<package>/<relative>`。
 */
export const HOST_TEXT_FIXTURES = [
  {
    id: "dev-context",
    package: "dsh-harness-dev-context",
    relative: "lib/index.js",
    texts: {
      // WEB_SURFACE_PROMPT 整段（含 \` 转义反引号与 HMR 段）
      webSurfacePrompt:
        "const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to \"this page\", \"this GUI\", or \"this app\" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while \\`pnpm run dev:web\\` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.`;",
      // LEGACY_SOURCE.prefix（冻结的旧段落前半）
      legacySourcePrefix:
        "\tprefix: \"The DeepSeek Harness implementation checkout is at \",",
      // LEGACY_SOURCE.suffix
      legacySourceSuffix:
        "\tsuffix: \". The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.\"",
      // LEGACY_WEB_SURFACE.prefix（web 身份句的旧半段）
      legacyWebSurfacePrefix:
        "\tprefix: \"You are interacting with the user through the DeepSeek Harness Web GUI at \",",
      // LEGACY_WEB_SURFACE.suffix
      legacyWebSurfaceSuffix:
        "\tsuffix: \". When the user refers to \\\"this page\\\", \\\"this GUI\\\", or \\\"this app\\\" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.\"",
      // 运行时上下文：实现 checkout
      contextCheckout:
        "\t\ttext: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`",
      // 运行时上下文：Web GUI URL
      contextUrl:
        "\t\ttext: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`",
    },
  },
  {
    // #22：ConversationNodeAssembler.append 的方法头到 inputs.set 这一段（含 rc.5 改写的 revised.clear 写法）。
    // 旧 #77 的整段锚点把这条语句写成 `this.revised.clear();`，rc.5 改成 `if (this.revised.size > 0) …` 后就一次都命中不了。
    id: "conversation-client",
    package: "dsh-client-ui-conversation",
    relative: "lib/client.js",
    texts: {
      append: [
        "\t\t\tappend(record) {",
        "\t\t\t\tconst event = record.event;",
        "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";",
        "\t\t\t\tif (this.revised.size > 0) this.revised.clear();",
        "\t\t\t\tthis.inputs.set(event.seq, record);",
        "\t\t\t\tlet publication = \"none\";",
        "\t\t\t\tif (event.type !== \"assistant/live-chunk\" && isLocationBoundary(event.type)) {",
        "\t\t\t\t\tconst previousTimeline = this.locationIndex.snapshot();",
        "\t\t\t\t\tconst changed = this.locationIndex.appendBoundary(event);",
        "\t\t\t\t\tif (this.locationIndex.snapshot() !== previousTimeline) {",
        "\t\t\t\t\t\tthis.timelineDirty = true;",
        "\t\t\t\t\t\tpublication = \"immediate\";",
        "\t\t\t\t\t}",
        "\t\t\t\t\tthis.replayContexts(this.refreshMatchLocations(changed));",
        "\t\t\t\t\tif (changed.size > 0) publication = \"immediate\";",
        "\t\t\t\t} else this.locationIndex.appendNonBoundary(event);",
        "\t\t\t\tpublication = maximumPublication(publication, this.matchInput(record));",
        "\t\t\t\tif (this.replayRevisedDependents()) publication = \"immediate\";",
        "\t\t\t\tif (this.revised.size > 0) this.revised.clear();",
        "\t\t\t\treturn publication;",
        "\t\t\t}",
      ].join("\n"),
    },
  },
];
