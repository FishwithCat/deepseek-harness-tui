# Agent Note: 备用屏 TUI 退出时恢复 transcript

Status: implemented

[English](2026-09-14-tui-alternate-exit-restore.md) | 中文

## 问题

应用运行期间，transcript 归备用屏所有，终端自身的 scrollback 中什么都没有。因此 pi-tui 的 `TuiAltScreen` 承诺：停止它时恢复主缓冲区并打印完整的最终文档，而这是应用退出后用户唯一能选择的副本。在 [`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts) 的布局根下，这次恢复只写回了 composer 与 footer。transcript 条目声明了 `basis: 0`，而 pi-tui 的 `VStack.render` 在渲染无界文档时按每个子项的 basis 分配高度，于是该 scroll view 的槽位变成 `rendered.slice(0, 0)`。退出一次备用屏运行——默认的 `screen`——的用户会发现大段输出消失，既无法选择也无法复制。

## 决策

`mount()` 中备用屏的布局根用 `shrink: 0` 固定 composer 与 footer，并给 transcript 设置 `grow: 1` 且不写 `basis`。在有界的终端高度下，栈仍把 composer 与 footer 之外的每一行都给 transcript，因此视口与固定 chrome 不变；在退出恢复使用的无界高度下，每个条目回退到自身固有高度，于是 `render(width)` 包含整个 transcript。退出路径本身仍归 pi-tui。

## 备选方案

**修补 pi-tui 的 `VStack.render`，在高度无界时把 basis 为 0、grow 的子项当作固有高度。** 这是上游缺陷——pi-tui 的 README 记载 `render(width)` 会产生退出恢复所依赖的无界文档——但 [fork 终端界面](../architecture/2026-09-11-fork-terminal-surface.zh.md)刻意不携带打过补丁的 pi-tui 产物，且 fork 本地补丁每次升级都要重新应用。

**给 transcript 设 `basis: 'auto'`，同时让 composer 与 footer 继续收缩。** 这能恢复 transcript，但收缩阶段会按高度比例把溢出分摊到三个条目上，于是 composer 与 footer 丢失行并脱离固定。`shrink: 0` 让 transcript 成为唯一让出高度的条目。

**由应用在停止渲染器前自行写出文档。** 应用必须为这次恢复复现 pi-tui 的行重置、截断与同步输出，重复渲染器已经拥有的库行为。

## 后果

备用屏运行现在会在退出后把 transcript 留在普通屏中，因此输出可以被选择与复制。`screen: 'inline'` 从未受影响，因为那段历史归终端 scrollback 所有。该布局声明不如 pi-tui 文档中的 `basis: 0, grow: 1` 示例直观，因此声明处带有一条注释，说明无界的退出渲染才是原因。

## 测试

`tests/tui-app.spec.ts` 以备用屏模式启动真实应用，追加一个已答复的 turn，清空已捕获的终端输出后停止应用；它断言退出序列以及恢复字节中的 prompt 与回复文本。该测试在此前的 `basis: 0` 声明下失败，此时恢复内容只有 composer 与 footer。
