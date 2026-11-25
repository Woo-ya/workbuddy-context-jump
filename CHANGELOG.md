# Changelog

All notable changes to **WorkBuddy Context Jump** will be documented in this file.

## [1.0.0] - 2026-11-26

### Added
- WorkBuddy-style right-edge horizontal tick rail entry with active turn highlight.
- Hover-triggered floating quick-jump popover (`single-line prompt summary + right-aligned tick`) with click-to-pin support.
- Keyboard navigation (`Alt+J` toggle & list navigation, `Alt+↑` / `Alt+↓` turn jump, `Alt+Backspace` jump-back to previous reading position).
- Per-conversation LRU state store preserving active turn, popover scroll position, jump-back history stack, and prompt snippet cache.
- Edge-case resilience:
  - Content fingerprint + turn re-resolution for shifted/re-mounted DOM elements.
  - Virtualized turn fallback via native navigator dots with async mount polling.
  - Non-blocking toast + list refresh when a target message is deleted or missing.
  - Post-jump layout-shift drift correction (`150ms` / `340ms`, auto-cancelled on manual user scroll/input).
- Zero-dependency Antigravity managed Sidecar daemon (`sidecars/context_jump/daemon.mjs`) with hot-reload and automatic native UI restoration on shutdown.
- One-command installer (`scripts/install.mjs`), uninstaller (`scripts/uninstall.mjs`), and release zip packager (`scripts/package.mjs`).
- Automated test suite (`tests/context-jump.test.mjs`, 12/12 passing).
