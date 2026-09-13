# Agent Note: 会话替换后保留 TUI 全局快捷键

Status: implemented

[English](2026-09-13-tui-new-session-keys.md) | 中文

## 问题

`/new` 与 `/resume` 通过 `replaceSession`（[`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts)）替换活动会话。该方法会释放单个 `disposers` 数组中的每一项，但 `registerKeys` 把全局输入监听器压入了同一个数组，而 `mount` 已在该数组中放入了 `attach` 的会话订阅。因此替换会话会移除按键监听器，而 `attach` 只重新注册了会话订阅。监听器持有的所有绑定——Shift+Tab（[plan 模式切换](../feature/2026-09-13-tui-plan-mode-toggle.zh.md)）、Ctrl+D 退出、Ctrl+C、Escape（[中断](../feature/2026-09-13-tui-esc-interrupt.zh.md)）、Ctrl+V 与 Ctrl+L——都会失效，直到应用重启，而输入框提示仍继续展示它们。

## 决策

**拆分两种释放生命周期。** `disposers` 持有应用生命周期的注册，目前就是 `registerKeys` 安装的单个输入监听器；新增的 `sessionDisposers` 数组持有 `attach` 为当前会话添加的五个订阅。`replaceSession` 在打开替代会话前只释放 `sessionDisposers`，`teardown` 释放两个数组。绑定代码本身不变。

## 备选方案

**在 `replaceSession` 中再次调用 `registerKeys`。** 它会恢复监听器，但仍把应用生命周期与会话生命周期的注册留在同一个数组里，因此下一个应用生命周期的订阅会被 `/new` 以同样方式悄悄丢弃。共享的生命周期才是缺陷，所以修复要把它们分开。

**让监听器注册幂等，并在 `replaceSession` 中重新添加。** 防止重复监听器的守卫只是增加状态，并未修复所有权错误，它仍然无法区分按键绑定与会话订阅。

## 后果

快捷键在 `/new` 与 `/resume` 后仍然可用。约束是：`sessionDisposers` 只能持有指向当前会话的订阅，所有应用生命周期的注册都归 `disposers`；`teardown` 必须释放两者。替换后输入框提示与页脚由 `refresh` 重绘，因此过时的提示从未掩盖仍然可用的绑定。

## 测试

`tests/tui-app.spec.ts` 新增两个用例。一个运行 `/new`，等待 `started a new session`，然后输入 Shift+Tab 并断言 plan 模式通知；另一个运行 `/new` 后输入 Ctrl+D 并断言应用退出。当 `replaceSession` 释放按键监听器时，两者都会失败。该界面没有 recorded-session 快照，因此由包测试承担验收。
