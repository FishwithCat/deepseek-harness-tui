# Agent Note: macOS 原生选区复制

Status: implemented

[English](2026-09-19-tui-native-macos-copy.md) | 中文

## Problem

TUI 输出 OSC 52 后可能显示 `Copied!`，却没有改变 macOS Terminal 的剪贴板。Command+C 也可能被终端拦截，无法到达应用自己管理的选区。

## Decision

松开鼠标会自动复制选区。本机 macOS 会话通过 pi-tui 的 `copySelection` 回调调用 `/usr/bin/pbcopy`；终端转发的 Command+C 使用同一回调。文本通过 stdin 传递，不经过 shell；写入失败返回 false，使 pi-tui 显示 `Copy failed`。SSH 会话保留面向终端的 OSC 52 输出，避免写入远端主机的剪贴板。

## Alternatives considered

**仅使用 OSC 52：** 写出转义序列不会收到剪贴板更新确认，因此不能证明原生复制成功。

**仅使用 Command+C：** 终端拦截会阻止应用收到该操作。自动复制避免了这一依赖。

## Consequences

本机 macOS 复制依赖系统剪贴板命令，不依赖终端的 OSC 52 支持。其他平台和 SSH 保留没有确认响应的 OSC 52 传输。针对性测试覆盖 UTF-8 stdin 的完整传输、子进程失败、远端路由、松开选区、转发按键以及成功和失败提示。自动测试替换系统剪贴板，避免改动用户剪贴板或与其他测试进程竞争；Terminal 交互验证仍需手动完成。
