<div align="center">

<img src="assets/logo.svg" width="88" height="88" alt="WorkBuddy Context Jump Logo" />

# WorkBuddy Context Jump

**A WorkBuddy-style right-edge context tick rail & hover quick-jump navigator for Google Antigravity**

Right-Edge Tick Rail · Hover Quick-Jump Popover · Per-Conversation State Preservation · Layout-Shift Resilience · Zero-Dependency Sidecar

[简体中文](./README.md) · [English](./README.en.md) · [Changelog](./CHANGELOG.md)

</div>

---

## Features

- **Minimal Right-Edge Tick Rail**: Renders a sleek vertical stack of horizontal ticks along the right edge of the conversation view, highlighting the active turn in the viewport and windowing ultra-long threads automatically.
- **Hover, Click & Keyboard Triggers**:
  - **Hover** over the rail to expand a floating WorkBuddy-style dark/light quick-jump card (`single-line prompt summary + right-aligned tick`).
  - **Click** the rail to pin/unpin the card, or click any turn to jump smoothly with a subtle arrival highlight—without stealing composer focus or clearing text selection.
  - **Keyboard Shortcuts** (when focus is outside text inputs):
    - `Alt + J`: Toggle and keyboard-navigate the quick-jump list (`↑` / `↓` / `Home` / `End` / `Enter` / `Esc`).
    - `Alt + ↑` / `Alt + ↓`: Jump to the previous / next user turn.
    - `Alt + Backspace`: Jump back to the reading position prior to the last jump.
- **Context State Preservation**: Maintains an LRU per-conversation store (`data-cascade-id`) for active turns, popover scroll offsets, jump-back history, and prompt snippet caches.
- **Edge-Case Resilience**:
  - Re-resolves shifted or re-mounted DOM elements via FNV-1a content fingerprinting.
  - Handles virtualized turns by triggering native turn dots and polling for DOM mount before fine alignment.
  - Displays a non-blocking toast and refreshes the list when a target message is deleted/missing.
  - Corrects post-jump layout-shift drift (`150ms` / `340ms`) and cancels immediately upon manual user scroll/input.
- **Non-Destructive Replacement**: Hides Antigravity's native `[data-testid="conversation-navigator"]` without mutating React-owned DOM nodes, and cleanly restores everything on disable/uninstall.

## Installation

Requires **Node.js >= 22** and Antigravity launched with `--remote-debugging-port=0`.

```bash
git clone https://github.com/Woo-ya/workbuddy-context-jump.git
cd workbuddy-context-jump
npm run install:plugin
```

To uninstall and restore the default navigator:

```bash
npm run uninstall:plugin
```

## Development & Packaging

```bash
npm test          # Run 12 unit & edge-case tests
npm run inject    # Inject once into active Antigravity windows
npm run remove    # Cleanly remove injection
npm run package   # Build distributable ZIP in dist/
```

## License

[MIT](./LICENSE)
