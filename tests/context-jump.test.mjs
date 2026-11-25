import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildInjectBundle, isEligibleTarget, PLUGIN_ROOT } from '../sidecars/context_jump/cdp-client.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = require('../src/context-jump-core.js');
const ui = require('../src/context-jump-ui.js');

// ── Minimal Simulated DOM Harness for UI Controller Tests ──────────────────
class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName || 'DIV').toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.parentElement = null;
    this.children = [];
    this.attrs = new Map();
    this.style = {};
    this.listeners = new Map();
    this.hidden = false;
    this._textContent = '';
    this.scrollTop = 0;
    this.scrollHeight = 2000;
    this.clientHeight = 600;
    this._rect = { top: 0, bottom: 40, left: 0, right: 800, width: 800, height: 40 };
    this.clicked = 0;
  }

  get id() {
    return this.attrs.get('id') || '';
  }
  set id(v) {
    this.attrs.set('id', String(v));
  }

  get className() {
    return this.attrs.get('class') || '';
  }
  set className(v) {
    this.attrs.set('class', String(v));
  }

  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === this.ownerDocument.documentElement) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._textContent = String(v ?? '');
    this.children.forEach((c) => (c.parentElement = null));
    this.children = [];
  }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.isFragment) {
      for (const c of child.children.slice()) {
        this.appendChild(c);
      }
      child.children = [];
      return child;
    }
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }

  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const s = part.trim();
      if (!s) return false;
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
      const attrEq = /^\[([^=\]]+)="([^"]*)"\]$/.exec(s);
      if (attrEq) return this.getAttribute(attrEq[1]) === attrEq[2];
      const attrHas = /^\[([^\]]+)\]$/.exec(s);
      if (attrHas) return this.hasAttribute(attrHas[1]);
      return this.tagName === s.toUpperCase();
    });
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matches(selector)) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add({ fn, once: Boolean(opts && opts.once) });
  }

  removeEventListener(type, fn) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const rec of set) {
      if (rec.fn === fn) set.delete(rec);
    }
  }

  dispatchEvent(ev) {
    const e = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
      ...ev,
    };
    const set = this.listeners.get(e.type);
    if (set) {
      for (const rec of Array.from(set)) {
        if (rec.once) set.delete(rec);
        rec.fn(e);
      }
    }
    return true;
  }

  click() {
    this.clicked += 1;
    this.dispatchEvent({ type: 'click' });
  }

  getBoundingClientRect() {
    if (typeof this._rectFn === 'function') return this._rectFn();
    return { ...this._rect };
  }

  scrollTo({ top }) {
    this.scrollTop = top;
  }

  scrollIntoView() {}
}

function createMockEnv() {
  const doc = {
    documentElement: null,
    head: null,
    body: null,
    listeners: new Map(),
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    createDocumentFragment() {
      return { isFragment: true, children: [], appendChild(c) { this.children.push(c); return c; } };
    },
    getElementById(id) {
      return doc.documentElement.querySelector(`#${id}`);
    },
    querySelector(sel) {
      return doc.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.documentElement.querySelectorAll(sel);
    },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, new Set());
      doc.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      doc.listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of doc.listeners.get(ev.type) || []) fn(ev);
    },
  };

  doc.documentElement = new FakeElement('HTML', doc);
  doc.documentElement.setAttribute('lang', 'zh-CN');
  doc.head = new FakeElement('HEAD', doc);
  doc.body = new FakeElement('BODY', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const winListeners = new Map();
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const e = {
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {},
        ...ev,
      };
      for (const fn of winListeners.get(e.type) || []) fn(e);
      return e;
    },
  };

  return { doc, win };
}

function buildConversationDom(doc, { convId = 'conv-1', prompts = [], virtualDots = [] } = {}) {
  const convView = doc.createElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', convId);
  convView._rect = { top: 40, bottom: 760, left: 260, right: 1260, width: 1000, height: 720 };

  const viewport = doc.createElement('div');
  viewport.setAttribute('data-testid', 'autoscroll-viewport');
  viewport._rect = { top: 40, bottom: 680, left: 260, right: 1260, width: 1000, height: 640 };
  viewport.scrollTop = 0;
  viewport.scrollHeight = 3200;
  viewport.clientHeight = 640;

  const stepEls = [];
  prompts.forEach((p, idx) => {
    const step = doc.createElement('div');
    step.setAttribute('data-testid', 'user-input-step');
    if (p.turnIndex != null) step.setAttribute('data-turn-index', String(p.turnIndex));
    const bubble = doc.createElement('div');
    bubble.setAttribute('data-testid', 'user-message-bubble');
    const content = doc.createElement('div');
    content.setAttribute('data-testid', 'user-message-content');
    content.textContent = p.text;
    bubble.appendChild(content);
    step.appendChild(bubble);

    const baseDocY = p.docY ?? idx * 450 + 80;
    step._docY = baseDocY;
    step._rectFn = () => ({
      top: viewport._rect.top + (step._docY - viewport.scrollTop),
      bottom: viewport._rect.top + (step._docY - viewport.scrollTop) + 60,
      left: 300,
      right: 1100,
      width: 800,
      height: 60,
    });
    viewport.appendChild(step);
    stepEls.push(step);
  });

  const nativeNav = doc.createElement('div');
  nativeNav.setAttribute('data-testid', 'conversation-navigator');
  const dotEls = [];
  virtualDots.forEach((d) => {
    const dot = doc.createElement('button');
    dot.setAttribute('data-testid', 'conversation-navigator-turn');
    if (d.ariaLabel) dot.setAttribute('aria-label', d.ariaLabel);
    if (d.active) dot.setAttribute('aria-current', 'true');
    if (d.onClick) dot.addEventListener('click', d.onClick);
    nativeNav.appendChild(dot);
    dotEls.push(dot);
  });

  const composer = doc.createElement('div');
  composer.setAttribute('data-testid', 'agent-input-box');
  composer._rect = { top: 690, bottom: 750, left: 300, right: 1200, width: 900, height: 60 };

  convView.appendChild(viewport);
  convView.appendChild(nativeNav);
  convView.appendChild(composer);
  doc.body.appendChild(convView);

  return { convView, viewport, nativeNav, composer, stepEls, dotEls };
}

// ── 1. Core Unit Tests ─────────────────────────────────────────────────────
test('core: parseTurnDotMeta parses standard aria labels and fallback data-turn-index', () => {
  assert.deepEqual(core.parseTurnDotMeta('Turn 3 of 12', null), { turnNum: 3, total: 12 });
  assert.deepEqual(core.parseTurnDotMeta('5 / 20', null), { turnNum: 5, total: 20 });
  assert.deepEqual(core.parseTurnDotMeta('', '4'), { turnNum: 5, total: 0 });
});

test('core: buildTurnIndex merges virtualized dots with mounted turns and caches snippets', () => {
  const cache = new Map();
  cache.set(1, { rawText: '之前滚动出去的第一轮提问', fingerprint: core.hashFingerprint('之前滚动出去的第一轮提问') });

  const idx = core.buildTurnIndex({
    nativeDots: [
      { turnNum: 1, total: 3, el: { id: 'dot-1', isConnected: true }, active: false },
      { turnNum: 2, total: 3, el: { id: 'dot-2', isConnected: true }, active: false },
      { turnNum: 3, total: 3, el: { id: 'dot-3', isConnected: true }, active: true },
    ],
    mountedTurns: [
      { el: { id: 'step-2', isConnected: true }, text: '第二轮修复布局抖动', rect: { top: 90 } },
      { el: { id: 'step-3', isConnected: true }, text: '第三轮实现 WorkBuddy 快速跳转', rect: { top: 480 } },
    ],
    snippetCache: cache,
    viewportTop: 40,
    viewportHeight: 600,
    activeNativeTurnNum: 3,
  });

  assert.equal(idx.totalTurns, 3);
  assert.equal(idx.items.length, 3);
  assert.equal(idx.items[0].mounted, false);
  assert.equal(idx.items[0].preview, '之前滚动出去的第一轮提问');
  assert.equal(idx.items[1].mounted, true);
  assert.equal(idx.items[1].active, true);
  assert.equal(idx.items[2].mounted, true);
  assert.ok(cache.has(2));
  assert.ok(cache.has(3));
});

test('core: resolveJumpTarget handles shifted indices via content fingerprint, virtualized fallback, and missing targets', () => {
  const elA = { id: 'a', isConnected: false }; // detached old ref
  const elANew = { id: 'a-new', isConnected: true };
  const dotV = { id: 'dot-v', isConnected: true };

  const liveIndex = {
    items: [
      { key: 'turn:2:fp-a', turnNum: 2, fingerprint: 'fp-a', el: elANew, nativeDotEl: null, mounted: true },
      { key: 'turn:5', turnNum: 5, fingerprint: 'fp-v', el: null, nativeDotEl: dotV, mounted: false },
    ],
  };

  // Detached ref shifted from turn 1 -> turn 2, re-resolved by fingerprint
  const resShifted = core.resolveJumpTarget({ key: 'turn:1:fp-a', turnNum: 1, fingerprint: 'fp-a', el: elA }, liveIndex);
  assert.equal(resShifted.status, 'mounted');
  assert.equal(resShifted.el, elANew);

  // Virtualized turn resolves to nativeDotEl
  const resVirt = core.resolveJumpTarget({ key: 'turn:5', turnNum: 5, fingerprint: 'fp-v', el: null }, liveIndex);
  assert.equal(resVirt.status, 'virtualized');
  assert.equal(resVirt.nativeDotEl, dotV);

  // Non-existent target returns missing
  const resMissing = core.resolveJumpTarget({ key: 'turn:9:fp-gone', turnNum: 9, fingerprint: 'fp-gone', el: null }, liveIndex);
  assert.equal(resMissing.status, 'missing');
});

test('core: computeRailWindow keeps active item centered for very long conversations', () => {
  const items = Array.from({ length: 80 }, (_, i) => ({ key: `t:${i + 1}`, turnNum: i + 1 }));
  const winMid = core.computeRailWindow(items, 50, 20);
  assert.equal(winMid.items.length, 20);
  assert.ok(winMid.start <= 50 && winMid.end > 50);

  const winEnd = core.computeRailWindow(items, 79, 20);
  assert.equal(winEnd.start, 60);
  assert.equal(winEnd.end, 80);
});

test('core: conversation state store preserves history and evicts LRU entries', () => {
  const store = core.createConversationStateStore(2);
  store.recordJumpOrigin('c1', { scrollTop: 120, turnKey: 'turn:1' });
  store.recordJumpOrigin('c1', { scrollTop: 125, turnKey: 'turn:1' }); // deduplicated
  store.recordJumpOrigin('c1', { scrollTop: 640, turnKey: 'turn:3' });
  assert.equal(store.popJumpOrigin('c1').scrollTop, 640);
  assert.equal(store.popJumpOrigin('c1').scrollTop, 120);
  assert.equal(store.popJumpOrigin('c1'), null);

  store.getOrCreate('c2');
  store.getOrCreate('c3'); // evicts c1
  assert.equal(store.size(), 2);
});

// ── 2. UI Controller & Edge-Case Integration Tests ─────────────────────────
test('ui: mounts WorkBuddy right-edge rail, opens on hover, jumps & preserves jump-back origin', async () => {
  const { doc, win } = createMockEnv();
  const { viewport, stepEls } = buildConversationDom(doc, {
    convId: 'conv-alpha',
    prompts: [
      { text: '第一轮：分析 WorkBuddy 的右侧定位交互', docY: 80 },
      { text: '第二轮：实现插件替换原有导航并处理边界情况', docY: 620 },
      { text: '第三轮：补齐自动化测试与热重载验证', docY: 1280 },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win, cssText: '.ag-wb-jump-root{}' });
  assert.equal(doc.documentElement.getAttribute('data-ag-wb-jump'), 'active');

  const root = doc.querySelector('.ag-wb-jump-root');
  const rail = doc.querySelector('.ag-wb-jump-rail');
  const items = doc.querySelectorAll('.ag-wb-jump-item');
  assert.ok(root && !root.hidden);
  assert.equal(items.length, 3);
  assert.equal(items[0].getAttribute('data-active'), '1');

  // Hover opens popover
  rail.dispatchEvent({ type: 'pointerenter' });
  assert.equal(ctrl.getState().isOpen, true);
  assert.equal(root.getAttribute('data-open'), '1');

  // Click third item -> scrolls viewport to turn 3 & adds sonar
  items[2].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(viewport.scrollTop, 1260); // 1280 - 20 alignOffsetPx
  assert.equal(stepEls[2].querySelector('[data-testid="user-message-bubble"]').getAttribute('data-wb-jump-sonar'), '1');
  assert.equal(ctrl.getState().stats.jumpSuccess, 1);

  // Alt+Backspace jumps back to origin (scrollTop 0)
  win.dispatchEvent({ type: 'keydown', key: 'Backspace', altKey: true, target: doc.body });
  assert.equal(viewport.scrollTop, 0);
  assert.equal(ctrl.getState().stats.jumpBacks, 1);

  ctrl.destroy();
  assert.equal(doc.documentElement.hasAttribute('data-ag-wb-jump'), false);
  assert.equal(doc.querySelector('.ag-wb-jump-root'), null);
});

test('ui edge case: target deleted/missing shows non-blocking toast and refreshes list safely', async () => {
  const { doc, win } = createMockEnv();
  const { stepEls } = buildConversationDom(doc, {
    convId: 'conv-missing',
    prompts: [
      { text: '消息 A', docY: 80 },
      { text: '消息 B 将被删除', docY: 500 },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win });
  const staleBtn = doc.querySelectorAll('.ag-wb-jump-item')[1];
  const staleItem = staleBtn.__wbItem;

  // Simulate message B removed from DOM before user clicks
  stepEls[1].remove();

  const ok = await ctrl.jumpToItem(staleItem);
  assert.equal(ok, false);
  assert.equal(ctrl.getState().stats.jumpMissing, 1);
  assert.equal(doc.querySelectorAll('.ag-wb-jump-item').length, 1);
  assert.equal(doc.querySelector('.ag-wb-jump-toast').getAttribute('data-visible'), '1');

  ctrl.destroy();
});

test('ui edge case: virtualized turn triggers native dot click, waits for mount, and fine-aligns', async () => {
  const { doc, win } = createMockEnv();
  let mountedLateStep = null;
  const dom = buildConversationDom(doc, {
    convId: 'conv-virtual',
    prompts: [{ text: '当前可见的第 2 轮', docY: 600, turnIndex: 1 }],
    virtualDots: [
      {
        ariaLabel: 'Turn 1 of 2',
        onClick: () => {
          // Simulate host async mounting turn 1 after native dot click
          setTimeout(() => {
            const s = doc.createElement('div');
            s.setAttribute('data-testid', 'user-input-step');
            s.setAttribute('data-turn-index', '0');
            const b = doc.createElement('div');
            b.setAttribute('data-testid', 'user-message-bubble');
            b.textContent = '历史第 1 轮（延迟挂载）';
            s.appendChild(b);
            s._docY = 100;
            s._rectFn = () => ({
              top: dom.viewport._rect.top + (s._docY - dom.viewport.scrollTop),
              bottom: dom.viewport._rect.top + (s._docY - dom.viewport.scrollTop) + 50,
              left: 300,
              right: 1000,
              width: 700,
              height: 50,
            });
            dom.viewport.appendChild(s);
            mountedLateStep = s;
          }, 30);
        },
      },
      { ariaLabel: 'Turn 2 of 2', active: true },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win });
  const rows = doc.querySelectorAll('.ag-wb-jump-item');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-virtual'), '1');

  const ok = await ctrl.jumpToIndex(0);
  assert.equal(ok, true);
  assert.equal(dom.dotEls[0].clicked, 1);
  assert.ok(mountedLateStep);
  assert.equal(dom.viewport.scrollTop, 80); // 100 - 20
  assert.equal(ctrl.getState().stats.jumpVirtualized, 1);

  ctrl.destroy();
});

test('ui edge case: post-jump layout shift triggers automatic drift correction unless user scrolls', async () => {
  const { doc, win } = createMockEnv();
  const { viewport, stepEls } = buildConversationDom(doc, {
    convId: 'conv-drift',
    prompts: [
      { text: '第一轮', docY: 80 },
      { text: '第二轮（上方将发生高度膨胀）', docY: 600 },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win });
  await ctrl.jumpToIndex(1);
  assert.equal(viewport.scrollTop, 580);

  // Simulate layout shift: content above expands by +120px after jump!
  stepEls[1]._docY = 720;
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(viewport.scrollTop, 700); // auto-corrected to 720 - 20!
  assert.ok(ctrl.getState().stats.driftCorrections >= 1);

  ctrl.destroy();
});

test('ui edge case: conversation switch preserves per-conversation state and closes popover', () => {
  const { doc, win } = createMockEnv();
  const dom = buildConversationDom(doc, {
    convId: 'conv-1',
    prompts: [
      { text: '会话一提问 A', docY: 80 },
      { text: '会话一提问 B', docY: 520 },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win });
  ctrl.openPopover({ pin: true });
  assert.equal(ctrl.getState().isOpen, true);

  // Switch conversation ID and replace turns
  dom.convView.setAttribute('data-cascade-id', 'conv-2');
  dom.stepEls.forEach((el) => el.remove());
  const newStep = doc.createElement('div');
  newStep.setAttribute('data-testid', 'user-input-step');
  newStep.textContent = '会话二唯一提问';
  newStep._rect = { top: 80, bottom: 130, left: 300, right: 1000, width: 700, height: 50 };
  dom.viewport.appendChild(newStep);

  ctrl.sync();
  assert.equal(ctrl.getState().currentConvId, 'conv-2');
  assert.equal(ctrl.getState().isOpen, false);
  assert.equal(ctrl.getState().turnCount, 1);

  ctrl.destroy();
});

test('ui: keyboard shortcuts ignore editable elements and support Alt+J navigation', () => {
  const { doc, win } = createMockEnv();
  buildConversationDom(doc, {
    convId: 'conv-kb',
    prompts: [
      { text: '第一轮', docY: 80 },
      { text: '第二轮', docY: 500 },
    ],
  });

  const ctrl = ui.createContextJumpController({ core, doc, win });
  const input = doc.createElement('textarea');

  // Alt+J inside textarea must be ignored
  win.dispatchEvent({ type: 'keydown', key: 'j', altKey: true, target: input });
  assert.equal(ctrl.getState().isOpen, false);

  // Alt+J on body opens & pins popover
  win.dispatchEvent({ type: 'keydown', key: 'j', altKey: true, target: doc.body });
  assert.equal(ctrl.getState().isOpen, true);
  assert.equal(ctrl.getState().pinnedOpen, true);

  // Escape closes popover
  win.dispatchEvent({ type: 'keydown', key: 'Escape', target: doc.body });
  assert.equal(ctrl.getState().isOpen, false);

  ctrl.destroy();
});

// ── 3. Bundle & CDP Target Filter Verification ─────────────────────────────
test('bundle & cdp: buildInjectBundle compiles cleanly and target filter matches Antigravity windows', () => {
  const bundle = buildInjectBundle(PLUGIN_ROOT);
  assert.equal(bundle.hash.length, 16);
  // Verify generated JS parses cleanly with zero syntax errors
  new vm.Script(bundle.expression);

  assert.equal(
    isEligibleTarget({
      type: 'page',
      url: 'app://antigravity/index.html',
      title: 'Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }),
    true
  );
  assert.equal(
    isEligibleTarget({
      type: 'page',
      url: 'devtools://devtools/bundled/inspector.html',
      title: 'DevTools',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2',
    }),
    false
  );
});
