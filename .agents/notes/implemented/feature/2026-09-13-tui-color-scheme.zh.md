# Agent Note: TUI colour scheme and legibility pass

Status: implemented

[English](2026-09-13-tui-color-scheme.md) | 中文

## Problem

终端界面在 [`src/ansi.ts`](../../../../packages/bundle/tui-app/src/ansi.ts) 中只有一套扁平调色板，由单个 SGR 参数字符串拼成，并且是为深色背景调的。若干语义角色难以辨认：`dim` 只是 SGR 2 属性，许多终端主题会把它渲染得几乎不可见；reasoning 文本把 `2`（dim）与 `3`（italic）和灰色叠加，而部分终端会静默忽略 italic；markdown 的斜体复用了 reasoning 样式，于是强调文本呈现为暗、斜、灰。除了审美问题，空输入框还有一个可见缺陷：光标字符被 `theme.dim` 包裹，而每个 styler 都以 `\x1b[0m` 结尾，这会抵消其外层的 `\x1b[7m` 反显视频——只要开启颜色，光标块就消失。此外没有浅色背景调色板，浅色终端上的用户只能得到深色背景配色，且无法更改。

## Decision

**调色板变成显式的深色／浅色一对。** [`src/ansi.ts`](../../../../packages/bundle/tui-app/src/ansi.ts) 为每种方案各持有一个 `PaletteSpec`。`TuiTheme` 新增 `italic` 与四个 diff 样式（`diffAdd`、`diffDel`、`diffContext`、`diffMeta`）；`createTheme` 改为接受 `{ enabled, palette }`，不再是裸布尔值。`dim` 变为真正的灰色而非 SGR 2 属性，`reasoning` 去掉 dim 与 italic、改用柔和的颜色，markdown 的 `italic` 映射到新的专用样式，而不再借用 reasoning 样式。

**方案是部署设置，并被显式解析。** `Config` 新增 `colorScheme: 'auto' | 'dark' | 'light'`（默认 `'auto'`），bundle 补丁中的 `DSH_TUI_COLOR_SCHEME` 提供默认值，与既有的 `screen` 字段一致。`resolveColorScheme(mode, env)` 对显式选择原样返回，否则读取 `COLORFGBG`——xterm 系终端导出的 `foreground;background` 信号：背景索引为 7 或 15 时选择浅色，缺失或无法解析时保持深色。解析在应用构造时完成一次，绝不发生在 styler 内部。

**光标字符不套样式。** `PlaceholderEditor.placeholderLine` 只在裸字符外发出反显视频块，并只对其余提示文字做 dim，因此该块不再被周围的样式抵消。

## Alternatives considered

**保留 `dim` 为 SGR 2，只在缺失处补颜色。** 它落选是因为该属性是调色板中可移植性最差的信号——一些主题会把它映射到对比度下限之下，而且它与彩色前景组合得很差，而界面恰恰在页脚、提示与参数摘要这些地方这样用。

**只提供深色调色板，让浅色终端依赖 `NO_COLOR`。** 它落选是因为 `NO_COLOR` 会抹掉界面编码的全部区分——错误、警告、工具状态——而浅色调色板能保留所有这些；配置字段只是一个受校验的值加一个 schema 默认值。

**用 OSC 11 查询从终端取真实背景色。** 它落选是因为这需要在应用构造期间写入请求并读取回复：回复是异步的、可能永远不来，而忽略该查询的终端会让启动挂起。`COLORFGBG` 是同步的、被广泛导出，且其缺失有安全的默认值。

**复用 Web 客户端的 `--dsw-*` 主题 token。** 它落选是因为那些是 CSS 自定义属性，没有 256 色或 ANSI 形式；映射它们会是一次有损转换，且没有共享的事实来源。

## Consequences

终端界面能适配浅色与深色宿主，每个语义角色都有了明确的外观，空输入框的光标也重新可见。代价是多了一个配置字段、其生成的目录条目，以及新增角色时需要同步维护的深／浅一对。调色板取值仍是有意的视觉选择，在仓库其他地方没有事实来源，因此本 Agent Note 只固定结构——每种方案一个 spec、`resolveColorScheme` 的规则与角色集合——而不固定具体的 SGR 数值，那些数值由测试固定。

## Testing

`tests/ansi.spec.ts` 固定颜色开关、`resolveColorScheme` 的显式、浅色、深色与无法解析输入、每个角色的深色与浅色取值、禁用样式时的恒等行为，以及选择器／输入框／markdown 的映射（含 `italic`）。`tests/transcript.spec.ts` 固定开启样式时反显视频光标仍然保留，状态栏的升级着色测试现在断言真实的 `dim` 灰色。没有面向模型、持久化或 wire 行为发生变化，因此不影响任何录制会话快照；本界面本来也没有。
