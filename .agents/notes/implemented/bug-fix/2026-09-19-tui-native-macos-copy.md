# Agent Note: Native macOS selection copying

Status: implemented

English | [中文](2026-09-19-tui-native-macos-copy.zh.md)

## Problem

The TUI's OSC 52 output can display `Copied!` without changing the clipboard in macOS Terminal. Command+C can also be intercepted by the terminal instead of reaching the application-owned selection.

## Decision

Mouse release automatically copies the selection. Local macOS sessions use `/usr/bin/pbcopy` through pi-tui's `copySelection` callback; forwarded Command+C uses the same callback. Text travels on stdin without a shell, and failed writes return false so pi-tui displays `Copy failed`. SSH sessions retain terminal-directed OSC 52 output rather than writing the remote host's clipboard.

## Alternatives considered

**OSC 52 alone:** writing the escape sequence does not acknowledge a clipboard update, so it cannot establish native success.

**Command+C alone:** terminal interception prevents the application from receiving the gesture. Automatic copying avoids that dependency.

## Consequences

Local macOS copying depends on the system pasteboard command, not terminal OSC 52 support. Other platforms and SSH retain unacknowledged OSC 52 transport. Focused tests cover exact UTF-8 stdin, child failure, remote routing, selection release, forwarded key presses, and success/failure feedback. Automated tests substitute the system clipboard to avoid changing a user's clipboard or racing other test processes; interactive Terminal verification remains manual.
