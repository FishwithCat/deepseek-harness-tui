# Agent Note: TUI 剪贴板粘贴延迟

Status: implemented

[English](2026-09-16-tui-clipboard-paste-latency.md) | 中文

## Problem

[剪贴板图片粘贴](../feature/2026-09-11-tui-clipboard-image-paste.zh.md)通过 `osascript` 中的 AppleScript `the clipboard as «class PNGf»` 强制转换读取 macOS 粘贴板，而应用在该子进程运行期间不请求任何重绘。仅针对读取器的墙钟测量如下，剪贴板上分别放一张 904 KB 与一张 5.76 MB 的 PNG，各跑三次：

| 载荷 | `the clipboard as «class PNGf»` | `NSPasteboard.dataForType('public.png')` |
|---|---|---|
| 904 KB | 0.27–0.28 s | 0.04–0.06 s |
| 5.76 MB | 0.45–0.46 s | 0.04 s |

一个只返回数据长度、不写文件的 AppleScript 变体仍耗费 0.47 s 子进程 CPU，因此成本来自强制转换而非落盘写入。在这整段时间里输入框毫无变化，于是 Ctrl+V 的体感就是先冻结、再突然出现标记。

## Decision

**macOS 读取器经 `osascript` 的 JavaScript 运行时读取 `NSPasteboard`。** `readDarwin` 执行 `osascript -l JavaScript -e …`，脚本读取 `$.NSPasteboard.generalPasteboard.dataForType('public.png')` 并调用 `writeToFileAtomically(stagePath, true)`；它返回 `ok`、`empty`（粘贴板上没有 PNG）或 `failed`（写入未落地），只有 `ok` 才会进入暂存文件读取。暂存路径通过 `JSON.stringify` 作为 JavaScript 字面量嵌入。AppleScript 被删除而不是保留为兜底：在本场景真正出现的各种粘贴板上，两种读取器结论一致，该兜底没有任何场景可服务（见下）。

**页脚报告等待。** `TuiApp` 统计进行中的剪贴板读取数，`TuiStatus` 携带 `pasting`，`StatusBar.headText` 在该计数非零时于生命周期状态旁追加 `pasting image…`。计数在 `finally` 中递减，因此通知路径、teardown 之后的提前返回以及重叠粘贴都能如实收敛。这覆盖了本次未改动的读取器——Windows 与 WSL 的 PowerShell 读取器仍要启动 PowerShell、执行 `Add-Type` 并编码图像——也覆盖任何在负载下仍然缓慢的 macOS 读取。

## Alternatives considered

**先试 JavaScript，失败再回退到 AppleScript 强制转换。** 该兜底只会在粘贴板提供图片类型但不提供 PNG 时运行。它因测量而落选：仅有 TIFF 的粘贴板对 `public.png` 返回 `nil`，对 `«class PNGf»` 同样报错；仅有 JPEG 时表现一致，因此该兜底只是给一条本就报告"无图片"的路径再增加一个子进程。没有可观察场景的兜底属于投机代码。

**延迟显示 `pasting image…`。** 延迟显示可避免读取很快时的一闪而过。它落选是因为在 pi-tui 16 ms 的渲染间隔下这一闪最多只有两三帧，而延迟方案需要定时器及其结算路径与 teardown 路径；何况慢读取器本就必须立即显示等待。

**已安装 `pngpaste` 时优先使用它。** 这个 Homebrew 工具能在数十毫秒内写出粘贴板 PNG。它落选是因为它并非 macOS 自带的程序，会引入安装步骤，而系统运行时已经达到同样的速度。

**原生剪贴板插件。** 粘贴功能落地时已拒绝 `@mariozechner/clipboard`，理由记在那里：它并不能移除各平台的读取器。

## Consequences

macOS 上的一次 Ctrl+V 现在在子进程中花费约 40 ms——经读取器端到端约 50 ms——而不再是 270–460 ms，因此对剪贴板截图而言标记会在按键后的一个渲染间隔内出现。该界面少了一门脚本语言，AppleScript 的引号辅助函数与脚本都被删除。Windows 与 WSL 读取器不变，冷启动 PowerShell 时仍要接近一秒；让这段等待可见的正是页脚的等待提示。旧读取器的等价边界原样保留：只有提供 `public.png` 的粘贴板才能取出图片，仅提供 TIFF 或 JPEG 的粘贴板会报告空剪贴板。粘贴内容在提交之前依旧对会话日志与模型不可见。

## Testing

`tests/clipboard.spec.ts` 断言 darwin 读取器的命令、其 `-l JavaScript` 参数、`dataForType('public.png')` 请求，以及 `writeToFileAtomically` 中经 JSON 引号处理的暂存路径，并覆盖 `ok`、`empty`、`failed`、读取器缺失，以及读取器报告成功却未写出文件五种情况。`tests/transcript.spec.ts` 固定 `pasting` 为 true、false 与缺省时的页脚文本。`tests/tui-app.spec.ts` 用 deferred promise 挂起一次剪贴板读取，断言合成后的 alternate 屏幕帧中出现 `pasting image…`，随后 resolve 并断言标记到达、等待文本消失。在真实粘贴板上放置 5.76 MB PNG 后，对 `dsh --profile tui` 做一次伪终端运行，能看到同样的序列：先是一帧在 `○ idle` 旁显示 `pasting image…`，随后输入框出现 `[Image #1]`、页脚恢复空闲。

上述测量是手动的且仅限 macOS：该读取器会调用需要真实粘贴板的系统程序，因此没有 CI 时间预算可以断言它。在剪贴板上放置该 5.76 MB PNG 后，对已发布的 `readClipboardImage()` 连跑三次，分别以 47.0、47.7 与 49.7 ms 返回全部 5 763 018 字节；负对照是在同一主机、同一载荷、同一时段运行的 AppleScript 强制转换，耗时 0.50–0.51 s。Windows、WSL 与 Linux 上的真实读取仍是[粘贴说明](../feature/2026-09-11-tui-clipboard-image-paste.zh.md)中已指明的同一项手工检查。
