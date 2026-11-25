<div align="center">

<img src="assets/logo.svg" width="88" height="88" alt="WorkBuddy Context Jump Logo" />

# WorkBuddy Context Jump

**为 Google Antigravity 打造的 WorkBuddy 风格右侧上下文快速定位跳转插件**

极简右侧刻度导轨 · 悬停快速跳转浮窗 · 会话上下文状态保持 · 虚拟列表与布局漂移容错 · 零依赖原生 Sidecar

[简体中文](./README.md) · [English](./README.en.md) · [更新日志](./CHANGELOG.md)

</div>

---

## 为什么需要这个插件？

在长对话场景下，原生导航点或侧边大纲往往存在入口不够直观、切换会话丢失定位上下文、消息折叠/流式展开导致跳转位置偏移等问题。

**WorkBuddy Context Jump** 复刻了 WorkBuddy 的经典右侧上下文定位交互，无损替换 Antigravity 原生 `[data-testid="conversation-navigator"]`（并与 `obsidian-prism` 礼貌共存让位），提供轻盈、精准、可回溯的快速定位体验。

## 核心特性

- **清晰入口（右侧刻度导轨）**
  - 在对话区右边缘悬浮一列极简水平短线刻度，每条刻度对应一轮用户提问。
  - 当前视口所在轮次以更长的高亮白线标识，超长会话自动以当前轮次为中心进行窗口化展示，避免刻度过密。
- **多种触发方式与高效跳转**
  - **悬停展开**：鼠标移至右侧刻度导轨，平滑展开深色半透明浮窗列表（左侧单行截断提问摘要 + 右侧对齐刻度线，当前轮次高亮加粗），移出后 `210ms` 防抖收回。
  - **点击锁定与跳转**：点击导轨可锁定展开面板；点击任意列表项立即平滑滚动到目标消息并触发到达脉冲高亮，同时通过 `mousedown.preventDefault()` 保持输入框焦点与文本选区不丢失。
  - **键盘快捷键**（焦点不在输入框时生效）：
    | 快捷键 | 功能 |
    | :--- | :--- |
    | `Alt + J` | 打开 / 关闭并聚焦快速定位列表（支持 `↑` / `↓` / `Home` / `End` / `Enter` / `Esc`） |
    | `Alt + ↑` / `Alt + ↓` | 快速跳转到上一轮 / 下一轮用户提问 |
    | `Alt + Backspace` | 返回跳转前的阅读滚动位置 |
- **上下文状态保持**
  - 按会话 ID（`data-cascade-id`）独立维护 LRU 状态缓存：记录当前活跃轮次、浮窗滚动位置、跳转前阅读位置栈以及已见提问摘要缓存。
  - 流式输出或滚动过程采用增量属性更新，不重建列表 DOM，不会打断悬停或重置列表滚动位置。
  - 切换会话时自动保存上一会话状态并收起浮窗，切回时自动恢复。
- **完善的边界情况处理**
  - **目标不存在 / 已被删除**：跳转前实时校验目标节点，依次尝试直接引用、内容指纹（FNV-1a）重匹配与虚拟节点唤醒；若目标确实已不存在，则弹出非阻塞提示并刷新列表，不破坏当前阅读位置。
  - **虚拟列表未挂载轮次**：自动触发原生导航点定位，轮询等待目标 DOM 挂载后再执行精确对齐与高亮。
  - **位置变化 / 布局漂移**：跳转后在 `150ms` 与 `340ms` 执行两次漂移校验（偏移超过 `24px` 自动重对齐，一旦用户手动滚轮/点击/按键立即取消），并通过 `ResizeObserver` 随窗口缩放、辅栏开关和输入框高度变化动态校准位置。
- **零依赖 & 无损可逆**
  - 纯原生 JavaScript + Node.js（`>= 22` 内置 `fetch` / `WebSocket`），零第三方 `npm` 依赖。
  - 不删除宿主 React 托管节点，停用插件或关闭 Sidecar 时自动卸载样式与 DOM 并完整还原原有导航。

---

## 安装指南

### 方式一：源码一键部署（推荐）

需要 **Node.js >= 22**，并确保 Antigravity 已开启本地调试端口（`--remote-debugging-port=0`）。

```bash
git clone https://github.com/Woo-ya/workbuddy-context-jump.git
cd workbuddy-context-jump

# 部署到 ~/.gemini/config/plugins/workbuddy-context-jump 并尝试立即注入当前窗口
npm run install:plugin
```

### 方式二：Release 压缩包手动安装

1. 前往 [Releases](https://github.com/Woo-ya/workbuddy-context-jump/releases) 下载 `workbuddy-context-jump-v1.0.0.zip`。
2. 解压至 Antigravity 全局插件目录：
   - **Windows**: `%USERPROFILE%\.gemini\config\plugins\workbuddy-context-jump`
   - **macOS / Linux**: `~/.gemini/config/plugins/workbuddy-context-jump`
3. Antigravity 会自动发现并启动插件内置的 Sidecar 守护进程；若窗口未立即生效，可在**自定义 / 插件**页面确认开关已开启或执行一次 `npm run inject`。

### 卸载还原

```bash
npm run uninstall:plugin
```

或在 Antigravity 插件管理页面直接关闭 **WorkBuddy Context Jump**，原有导航将立即恢复。

---

## 开发与打包命令

```bash
# 运行全部单元测试与边界场景测试（12 项）
npm test

# 单次手动注入当前运行中的 Antigravity 窗口
npm run inject

# 单次移除注入并还原原有上下文导航
npm run remove

# 打包生成可分发的 Release ZIP（输出至 dist/）
npm run package
```

## 目录结构

```text
workbuddy-context-jump/
├── plugin.json                        # Antigravity 原生插件清单
├── package.json                       # npm 脚本与包元信息
├── LICENSE                            # MIT 开源许可证
├── CHANGELOG.md                       # 版本更新记录
├── assets/
│   └── logo.svg                       # 插件图标
├── src/
│   ├── context-jump-core.js           # 纯函数导航索引、指纹匹配、状态保持与漂移计算引擎
│   ├── context-jump-ui.js             # 浏览器端 WorkBuddy 交互控制器与观察器
│   └── context-jump.css               # 深/浅主题样式与原生导航替换规则
├── sidecars/context_jump/
│   ├── sidecar.json                   # Antigravity 托管 Sidecar 配置
│   ├── cdp-client.mjs                 # 零依赖 CDP 客户端与注入打包器
│   └── daemon.mjs                     # 常驻守护进程（热重载 + 退出自动还原）
├── scripts/
│   ├── install.mjs                    # 一键部署插件至 ~/.gemini/config/plugins/
│   ├── uninstall.mjs                  # 一键还原并卸载插件
│   ├── inject.mjs                     # 手动单次注入脚本
│   ├── remove.mjs                     # 手动单次卸载还原脚本
│   └── package.mjs                    # Release ZIP 打包脚本
└── tests/
    └── context-jump.test.mjs          # 自动化单元测试与边界场景测试
```

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
