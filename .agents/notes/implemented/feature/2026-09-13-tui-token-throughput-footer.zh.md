# Agent Note: TUI 页脚 token 吞吐量与缓存数字

Status: implemented

[English](2026-09-13-tui-token-throughput-footer.md) | 中文

## 问题

Web 聊天统计条会报告整段会话的数字——以每秒 token 计的解码吞吐量、计费 token 总量与缓存命中占比——这些数字来自 `sessionStats` 与 `tokenUsage` 两个会话投影。[fork 终端界面](../architecture/2026-09-11-fork-terminal-surface.zh.md)的页脚只报告最近一次 provider 调用的 `↑输入 ↓输出` 与下一次请求的上下文占用，因此终端用户看不到会话的解码速度、已消耗的 token 数量，以及 provider 从缓存提供的提示词占比。

## 决策

**TUI 挂载 `dsh-session-stats`，并读取与 Web 统计条相同的折叠。** bundle patch 插入 `session-stats` 行，其单元在基础投影注册表上注册 `sessionStats` 投影键；总量与缓存命中占比取自 `tokenUsage`，后者由基础层已挂载的 token meter 注册。终端不再自行推导任何计时折叠。

**一次投影快照服务整个页脚。** `TuiApp.measurement` 一并读取 `contextPressure`、`tokenUsage` 与 `sessionStats`，并把派生出的 `{context, stats}` 按 Session 及其日志位置缓存，因为实时 Assistant 流的重绘远比事件追加频繁。缓存键同时包含 Session 与 seq，因此 `/new` 或 `/resume` 替换后不会复用上一个会话的数字。

**这些数字构成页脚右下角的一组。** `StatusBar` 在底行左侧保留原有的计数内容——最近一次调用的用量与占用——并在右侧放置 `sessionStatsParts`：`<tps> tok/s`、`<total> tok`、`<cache>% cache`，每一项在有数据前都不显示。该组通过既有的 `pairLine` 右对齐，因此在窄终端上会先截断、再先于计数内容被丢弃；当它没有任何内容可渲染时，该行与改动前完全一致。格式与 Web 统计条一致：每秒十以上取整、token 数使用紧凑记法、缓存占比绝不把部分命中四舍五入成 `100%`。

## 备选方案

**在 TUI 内重新推导解码折叠。** 终端本就为对话记录折叠每个会话事件，因此可以自行跟踪 step 边界与首 token 时间。它没有被采用，因为 `dsh-session-stats` 已经拥有该折叠及其真实组合与墙钟时间测试；第二份副本会逐渐偏离，并新增一处需要维护的计时表面。

**用流式 chunk 显示实时瞬时吞吐量。** 它会在回复流式产出时不断变化。它没有被采用，因为它与 Web 统计条是不同的数字，需要单独的采样策略，而且在两次结算之间读起来只是噪声。

**把这组数字放到页脚的第三行。** 独立一行能给出更多空间。它没有被采用，因为页脚刻意保持两行，且每个提示面板的行预算都据此计算（`PINNED_FOOTER_ROWS`）；现有行的右下角正是需求所指的角落。

## 后果

TUI profile 现在多挂载一个 host 行，`dsh-tui-app` 把 `@deepseek-ai/dsh-session-stats` 声明为依赖，使 patch 行能从 bundle 自己的 manifest 解析。这些数字是在 step 结算时更新的整段会话平均值，与 Web 统计条一致，而不会追随实时流。没有投影注册表的会话，或卸载了任一单元的部署，只会缺少这些单元所提供的数字。

## 测试

`tests/transcript.spec.ts` 直接固定 `sessionStatsParts`——每秒十上下两侧的吞吐量格式化、负值钳制、缺席数字的省略、完全命中、整数部分命中、小数部分命中，以及被钳制到 `99.9` 的比值——并固定 `StatusBar` 的渲染：该组右对齐于底行、没有任何数字时计数行不做填充、以及窄宽度下该组先于计数内容被丢弃。`tests/tui-app.spec.ts` 在挂载了 token meter 与 session-stats 插件的真实注册表上启动应用，随后追加一个消息携带 usage 且带首 token 时间戳的 step，断言合成画面中出现 `1.1k tok`、`90% cache` 与 `tok/s`。
