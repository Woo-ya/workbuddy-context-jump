// WorkBuddy Context Jump — Browser UI Runtime Controller (context-jump-ui.js)
// Replaces Antigravity's native conversation navigator & Obsidian Prism's left outline
// with WorkBuddy's right-edge horizontal tick rail and floating quick-jump list.

(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.__agWbJumpUi = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function (G) {
  'use strict';

  const VERSION = '1.0.0';
  const STYLE_ID = 'ag-wb-jump-style';
  const ROOT_ATTR = 'data-ag-wb-jump';
  const HIDE_DELAY_MS = 210;
  const SONAR_DURATION_MS = 760;
  const TOAST_DURATION_MS = 2200;
  const STREAM_SYNC_THROTTLE_MS = 180;
  const VIRTUAL_MOUNT_POLL_MS = 50;
  const VIRTUAL_MOUNT_MAX_WAIT_MS = 900;

  const S_CONV_VIEW = '[data-testid="conversation-view"]';
  const S_SUBAGENT_CONV = '[data-testid="subagent-tab-conversation"]';
  const S_VIEWPORT = '[data-testid="autoscroll-viewport"]';
  const S_NATIVE_NAV = '[data-testid="conversation-navigator"]';
  const S_NATIVE_TURN = '[data-testid="conversation-navigator-turn"]';
  const S_USER_STEP = '[data-testid="user-input-step"]';
  const S_USER_BUBBLE = '[data-testid="user-message-bubble"]';
  const S_USER_CONTENT = '[data-testid="user-message-content"]';
  const S_COMPOSER = '[data-testid="agent-input-box"]';

  const LOCALE_PACKS = {
    zh: {
      railLabel: '对话上下文快速定位',
      listLabel: '上下文快速跳转列表',
      fallbackTurn: (n) => `第 ${n} 轮提问`,
      targetMissing: '目标消息不存在或已变更，已刷新列表',
      returnedOrigin: '已返回跳转前位置',
      noOrigin: '暂无可返回的跳转记录',
    },
    en: {
      railLabel: 'Conversation quick jump',
      listLabel: 'Conversation turns',
      fallbackTurn: (n) => `Turn ${n}`,
      targetMissing: 'Target message no longer exists; list refreshed',
      returnedOrigin: 'Returned to previous position',
      noOrigin: 'No previous jump position',
    },
  };

  function getCore() {
    if (G && G.__agWbJumpCore) return G.__agWbJumpCore;
    if (typeof require === 'function') {
      try {
        return require('./context-jump-core.js');
      } catch {}
    }
    return null;
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.getAttribute?.('contenteditable') === 'true' || el.isContentEditable === true) return true;
    if (el.closest?.('[contenteditable="true"], input, textarea, select, [role="textbox"]')) return true;
    return false;
  }

  function markNoTranslate(el) {
    if (!el || !el.setAttribute) return el;
    el.setAttribute('translate', 'no');
    el.setAttribute('data-no-translate', 'true');
    el.setAttribute('data-ag-no-i18n', '');
    el.setAttribute('data-ag-localization-skip', 'true');
    el.setAttribute('data-agy-no-translate', 'true');
    el.setAttribute('data-antigravity-zh-skip', '1');
    el.setAttribute('data-ag-owned', '1');
    return el;
  }

  function resolveLocale(doc) {
    const raw =
      doc?.documentElement?.getAttribute?.('data-ag-cs-lang') ||
      doc?.documentElement?.getAttribute?.('lang') ||
      (typeof navigator !== 'undefined' ? navigator.language : '') ||
      'zh-CN';
    return /^zh|^yue/i.test(String(raw)) ? LOCALE_PACKS.zh : LOCALE_PACKS.en;
  }

  function isTurnDotActive(dot) {
    if (!dot) return false;
    return (
      dot.getAttribute?.('aria-current') === 'true' ||
      dot.getAttribute?.('data-active') === 'true' ||
      dot.getAttribute?.('data-selected') === 'true' ||
      dot.getAttribute?.('data-state') === 'active' ||
      Boolean(dot.querySelector?.('[data-active="true"], .bg-primary, .bg-foreground'))
    );
  }

  function extractPromptText(stepEl) {
    if (!stepEl) return '';
    const content =
      stepEl.querySelector?.(S_USER_CONTENT) ||
      stepEl.querySelector?.(S_USER_BUBBLE) ||
      stepEl;
    return String(content?.textContent || '').trim();
  }

  function createContextJumpController(options = {}) {
    const core = options.core || getCore();
    if (!core) throw new Error('WorkBuddy Context Jump core module is required');

    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    const win = options.win || (typeof window !== 'undefined' ? window : null);
    const cssText = typeof options.cssText === 'string' ? options.cssText : '';
    const stateStore = options.stateStore || core.createConversationStateStore();

    if (!doc || !win) {
      return {
        version: VERSION,
        sync: () => {},
        jumpToIndex: async () => false,
        jumpDelta: async () => false,
        jumpBack: () => false,
        openPopover: () => false,
        closePopover: () => {},
        getState: () => ({}),
        destroy: () => {},
      };
    }

    let destroyed = false;
    let isOpen = false;
    let pinnedOpen = false;
    let focusedListIdx = -1;
    let currentConvId = '';
    let currentModel = { totalTurns: 0, activeIndex: -1, items: [] };
    let lastStructureSig = '';
    let lastActiveKey = '';
    let lastSyncAt = 0;

    let styleEl = null;
    let rootEl = null;
    let railEl = null;
    let popoverEl = null;
    let listEl = null;
    let toastEl = null;

    let boundConvView = null;
    let boundViewport = null;
    let mutObserver = null;
    let resizeObserver = null;
    let hideTimer = 0;
    let toastTimer = 0;
    let syncRaf = 0;
    let scrollRaf = 0;
    let activeJumpSeq = 0;
    const activeTimers = new Set();
    const sonarTimers = new Set();
    let cancelStabilization = null;

    const itemBtnByKey = new Map();
    const railTickByKey = new Map();

    const stats = {
      jumpSuccess: 0,
      jumpMissing: 0,
      jumpVirtualized: 0,
      driftCorrections: 0,
      jumpBacks: 0,
    };

    function trackTimer(fn, ms) {
      const tid = setTimeout(() => {
        activeTimers.delete(tid);
        if (!destroyed) fn();
      }, ms);
      activeTimers.add(tid);
      return tid;
    }

    function clearHideTimer() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        activeTimers.delete(hideTimer);
        hideTimer = 0;
      }
    }

    function scheduleHide() {
      clearHideTimer();
      if (pinnedOpen) return;
      hideTimer = trackTimer(() => {
        hideTimer = 0;
        if (!pinnedOpen) closePopover();
      }, HIDE_DELAY_MS);
    }

    function showToast(msg) {
      if (!toastEl || !msg) return;
      if (toastTimer) {
        clearTimeout(toastTimer);
        activeTimers.delete(toastTimer);
        toastTimer = 0;
      }
      toastEl.textContent = msg;
      toastEl.setAttribute('data-visible', '1');
      toastTimer = trackTimer(() => {
        toastTimer = 0;
        toastEl?.removeAttribute('data-visible');
      }, TOAST_DURATION_MS);
    }

    function pulseSonar(targetEl) {
      if (!targetEl || !targetEl.setAttribute) return;
      const bubble = targetEl.querySelector?.(S_USER_BUBBLE) || targetEl;
      bubble.setAttribute('data-wb-jump-sonar', '1');
      const tid = setTimeout(() => {
        sonarTimers.delete(tid);
        if (!destroyed && bubble.isConnected !== false) {
          bubble.removeAttribute('data-wb-jump-sonar');
        }
      }, SONAR_DURATION_MS);
      sonarTimers.add(tid);
    }

    function prefersReducedMotion() {
      try {
        return Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
      } catch {
        return false;
      }
    }

    function findPrimaryConvView() {
      const views = doc.querySelectorAll?.(S_CONV_VIEW) || [];
      for (let i = 0; i < views.length; i++) {
        const cv = views[i];
        if (cv.closest?.(S_SUBAGENT_CONV)) continue;
        if (cv.closest?.('.agy-home') || cv.querySelector?.('.agy-home')) continue;
        return cv;
      }
      return null;
    }

    function findScrollViewport(convView) {
      if (convView?.querySelector) {
        const vp = convView.querySelector(S_VIEWPORT);
        if (vp) return vp;
      }
      return doc.querySelector?.(S_VIEWPORT) || null;
    }

    function readConversationId(convView) {
      const id =
        convView?.getAttribute?.('data-cascade-id') ||
        convView?.closest?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id') ||
        convView?.querySelector?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id') ||
        doc.querySelector?.('[data-cascade-id]')?.getAttribute?.('data-cascade-id') ||
        '';
      return String(id).trim();
    }

    function getMountedUserTurnElements(convView) {
      if (!convView?.querySelectorAll) return [];
      const steps = Array.from(convView.querySelectorAll(S_USER_STEP));
      return steps.length > 0 ? steps : Array.from(convView.querySelectorAll(S_USER_BUBBLE));
    }

    function collectLiveModel(convView, viewport) {
      const locale = resolveLocale(doc);
      const convState = stateStore.getOrCreate(currentConvId);
      const vpRect = viewport?.getBoundingClientRect?.() || { top: 0, height: win.innerHeight || 600 };

      const nativeNav = convView?.querySelector?.(S_NATIVE_NAV) || doc.querySelector?.(S_NATIVE_NAV);
      const dotEls = nativeNav ? Array.from(nativeNav.querySelectorAll(S_NATIVE_TURN)) : [];
      let activeNativeTurnNum = 0;
      const nativeDots = dotEls.map((dot) => {
        const meta = core.parseTurnDotMeta(
          dot.getAttribute?.('aria-label'),
          dot.getAttribute?.('data-turn-index')
        );
        const active = isTurnDotActive(dot);
        if (active && !activeNativeTurnNum && meta.turnNum > 0) {
          activeNativeTurnNum = meta.turnNum;
        }
        return {
          el: dot,
          turnNum: meta.turnNum,
          total: meta.total,
          active,
          previewText: dot.getAttribute?.('title') || '',
        };
      });

      const stepEls = getMountedUserTurnElements(convView);
      const mountedTurns = stepEls.map((el) => {
        const rawIdx = el.getAttribute?.('data-turn-index');
        const parsedIdx = rawIdx != null && rawIdx !== '' ? parseInt(rawIdx, 10) : NaN;
        return {
          el,
          text: extractPromptText(el),
          rect: el.getBoundingClientRect?.() || null,
          explicitTurnNum: Number.isInteger(parsedIdx) && parsedIdx >= 0 ? parsedIdx + 1 : 0,
        };
      });

      return core.buildTurnIndex({
        mountedTurns,
        nativeDots,
        snippetCache: convState.snippetCache,
        viewportTop: vpRect.top,
        viewportHeight: vpRect.height || win.innerHeight || 600,
        activeNativeTurnNum,
        fallbackLabel: locale.fallbackTurn,
      });
    }

    function updateAnchorPosition() {
      if (!rootEl || !boundConvView || boundConvView.isConnected === false) return;
      const cvRect = boundConvView.getBoundingClientRect?.();
      if (!cvRect || cvRect.width <= 0 || cvRect.height <= 0) {
        rootEl.hidden = true;
        return;
      }

      const composer = boundConvView.querySelector?.(S_COMPOSER) || doc.querySelector?.(S_COMPOSER);
      const compRect = composer?.getBoundingClientRect?.();
      const topBound = Math.max(56, cvRect.top + 36);
      const bottomBound =
        compRect && compRect.top > topBound + 120
          ? Math.min(cvRect.bottom - 16, compRect.top - 16)
          : cvRect.bottom - 24;

      const availableHeight = Math.max(120, bottomBound - topBound);
      const centerY = Math.round(topBound + availableHeight * 0.5);
      const rightOffset = Math.max(10, Math.round((win.innerWidth || cvRect.right) - cvRect.right + 14));

      rootEl.style.top = `${centerY}px`;
      rootEl.style.right = `${rightOffset}px`;
      rootEl.style.transform = 'translateY(-50%)';

      if (popoverEl) {
        const maxPopH = Math.max(160, Math.min(360, Math.round(availableHeight - 24)));
        popoverEl.style.maxHeight = `${maxPopH}px`;
      }
    }

    function cancelActiveStabilization() {
      if (typeof cancelStabilization === 'function') {
        try {
          cancelStabilization();
        } catch {}
        cancelStabilization = null;
      }
    }

    function scrollViewportToElement(targetEl, viewport, behavior = 'smooth') {
      if (!targetEl) return false;
      const tr = targetEl.getBoundingClientRect?.();
      const vr = viewport?.getBoundingClientRect?.();
      const effectiveBehavior = prefersReducedMotion() ? 'auto' : behavior;

      if (viewport && tr && vr && vr.height > 0) {
        const maxScrollTop = Math.max(0, (viewport.scrollHeight || 0) - (viewport.clientHeight || 0));
        const top = core.computeTargetScrollTop({
          currentScrollTop: viewport.scrollTop || 0,
          targetRectTop: tr.top,
          viewportRectTop: vr.top,
          alignOffsetPx: core.DEFAULT_ALIGN_OFFSET_PX,
          maxScrollTop,
        });
        if (typeof viewport.scrollTo === 'function') {
          viewport.scrollTo({ top, behavior: effectiveBehavior });
        } else {
          viewport.scrollTop = top;
        }
        return true;
      }

      if (typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ block: 'start', behavior: effectiveBehavior });
        return true;
      }
      return false;
    }

    function schedulePostJumpStabilization(targetEl, viewport, jumpSeq) {
      cancelActiveStabilization();
      if (!targetEl || !viewport) return;

      let cancelled = false;
      const timers = [];
      const stop = () => {
        if (cancelled) return;
        cancelled = true;
        for (const t of timers) {
          clearTimeout(t);
          activeTimers.delete(t);
        }
        for (const ev of ['wheel', 'pointerdown', 'touchstart']) {
          viewport.removeEventListener?.(ev, stop);
        }
        win.removeEventListener?.('keydown', stop);
      };

      for (const ev of ['wheel', 'pointerdown', 'touchstart']) {
        viewport.addEventListener?.(ev, stop, { passive: true, once: true });
      }
      win.addEventListener?.('keydown', stop, { passive: true, once: true });
      cancelStabilization = stop;

      const checkAndAlign = () => {
        if (destroyed || cancelled || jumpSeq !== activeJumpSeq) return;
        if (targetEl.isConnected === false || viewport.isConnected === false) {
          stop();
          return;
        }
        const tr = targetEl.getBoundingClientRect?.();
        const vr = viewport.getBoundingClientRect?.();
        if (!tr || !vr || vr.height <= 0) return;

        if (
          core.needsDriftCorrection({
            targetRectTop: tr.top,
            viewportRectTop: vr.top,
            alignOffsetPx: core.DEFAULT_ALIGN_OFFSET_PX,
            tolerancePx: core.DEFAULT_DRIFT_THRESHOLD_PX,
          })
        ) {
          scrollViewportToElement(targetEl, viewport, 'auto');
          stats.driftCorrections += 1;
        }
      };

      timers.push(trackTimer(checkAndAlign, 150));
      timers.push(
        trackTimer(() => {
          checkAndAlign();
          stop();
        }, 340)
      );
    }

    function waitForVirtualizedTargetMount(requestedItem, jumpSeq) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const poll = () => {
          if (destroyed || jumpSeq !== activeJumpSeq) return resolve(null);
          const convView = findPrimaryConvView();
          const viewport = findScrollViewport(convView);
          if (!convView) return resolve(null);

          const liveModel = collectLiveModel(convView, viewport);
          const resolved = core.resolveJumpTarget(requestedItem, liveModel);
          if (resolved.status === 'mounted' && resolved.el) {
            return resolve({ el: resolved.el, item: resolved.item, viewport });
          }
          if (Date.now() - startedAt >= VIRTUAL_MOUNT_MAX_WAIT_MS) {
            return resolve(null);
          }
          trackTimer(poll, VIRTUAL_MOUNT_POLL_MS);
        };
        trackTimer(poll, VIRTUAL_MOUNT_POLL_MS);
      });
    }

    async function jumpToItem(requestedItem, { recordOrigin = true, closeAfter = false } = {}) {
      if (destroyed || !requestedItem) return false;
      const convView = findPrimaryConvView();
      const viewport = findScrollViewport(convView);
      if (!convView || !viewport) return false;

      const jumpSeq = ++activeJumpSeq;
      cancelActiveStabilization();

      const liveModel = collectLiveModel(convView, viewport);
      currentModel = liveModel;
      const resolved = core.resolveJumpTarget(requestedItem, liveModel);

      if (resolved.status === 'missing') {
        stats.jumpMissing += 1;
        renderModel(liveModel, true);
        showToast(resolveLocale(doc).targetMissing);
        return false;
      }

      if (recordOrigin) {
        const curActive = liveModel.items[liveModel.activeIndex];
        stateStore.recordJumpOrigin(currentConvId, {
          scrollTop: viewport.scrollTop || 0,
          turnKey: curActive ? curActive.key : '',
        });
      }

      let finalEl = resolved.el;
      let finalItem = resolved.item;
      let finalViewport = viewport;

      if (resolved.status === 'virtualized' && resolved.nativeDotEl) {
        stats.jumpVirtualized += 1;
        try {
          resolved.nativeDotEl.click?.();
        } catch {}
        const mounted = await waitForVirtualizedTargetMount(requestedItem, jumpSeq);
        if (destroyed || jumpSeq !== activeJumpSeq) return false;
        if (!mounted || !mounted.el) {
          // Even if DOM element didn't materialize within timeout, native click may have scrolled.
          syncNow(true);
          return true;
        }
        finalEl = mounted.el;
        finalItem = mounted.item;
        finalViewport = mounted.viewport || viewport;
      }

      if (!finalEl || finalEl.isConnected === false) {
        stats.jumpMissing += 1;
        syncNow(true);
        showToast(resolveLocale(doc).targetMissing);
        return false;
      }

      scrollViewportToElement(finalEl, finalViewport, 'smooth');
      pulseSonar(finalEl);
      schedulePostJumpStabilization(finalEl, finalViewport, jumpSeq);

      const convState = stateStore.getOrCreate(currentConvId);
      convState.lastJumpedTurnKey = finalItem ? finalItem.key : requestedItem.key;
      convState.activeTurnKey = convState.lastJumpedTurnKey;
      stats.jumpSuccess += 1;

      setActiveVisualKey(convState.activeTurnKey);
      if (closeAfter) {
        pinnedOpen = false;
        closePopover();
      }
      return true;
    }

    async function jumpToIndex(index, opts = {}) {
      if (!currentModel.items.length) syncNow(true);
      const clamped = Math.max(0, Math.min(currentModel.items.length - 1, index));
      const item = currentModel.items[clamped];
      if (!item) return false;
      return jumpToItem(item, opts);
    }

    async function jumpDelta(delta) {
      if (destroyed || !delta) return false;
      const convView = findPrimaryConvView();
      const viewport = findScrollViewport(convView);
      if (!convView || !viewport) return false;
      const liveModel = collectLiveModel(convView, viewport);
      currentModel = liveModel;
      if (!liveModel.items.length) return false;

      const vr = viewport.getBoundingClientRect?.();
      const anchorY = vr && vr.height > 0 ? vr.top + 36 : 80;
      let targetIdx = -1;

      if (delta < 0) {
        for (let i = liveModel.items.length - 1; i >= 0; i--) {
          const el = liveModel.items[i].el;
          const r = el?.getBoundingClientRect?.();
          if (r && r.top < anchorY - 10) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx < 0) targetIdx = Math.max(0, (liveModel.activeIndex >= 0 ? liveModel.activeIndex : 1) - 1);
      } else {
        for (let i = 0; i < liveModel.items.length; i++) {
          const el = liveModel.items[i].el;
          const r = el?.getBoundingClientRect?.();
          if (r && r.top > anchorY + 10) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx < 0) targetIdx = Math.min(liveModel.items.length - 1, (liveModel.activeIndex >= 0 ? liveModel.activeIndex : 0) + 1);
      }

      return jumpToItem(liveModel.items[targetIdx], { recordOrigin: true, closeAfter: false });
    }

    function jumpBack() {
      if (destroyed) return false;
      const convView = findPrimaryConvView();
      const viewport = findScrollViewport(convView);
      if (!convView || !viewport) return false;

      const origin = stateStore.popJumpOrigin(currentConvId);
      if (!origin) {
        showToast(resolveLocale(doc).noOrigin);
        return false;
      }

      cancelActiveStabilization();
      const maxScrollTop = Math.max(0, (viewport.scrollHeight || 0) - (viewport.clientHeight || 0));
      const top = Math.max(0, Math.min(maxScrollTop, origin.scrollTop));
      const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ top, behavior });
      } else {
        viewport.scrollTop = top;
      }
      stats.jumpBacks += 1;
      showToast(resolveLocale(doc).returnedOrigin);
      trackTimer(() => syncActiveFromScroll(), 160);
      return true;
    }

    function setActiveVisualKey(nextKey) {
      if (!nextKey || nextKey === lastActiveKey) return;
      if (lastActiveKey) {
        itemBtnByKey.get(lastActiveKey)?.removeAttribute('data-active');
        railTickByKey.get(lastActiveKey)?.removeAttribute('data-active');
      }
      const nextBtn = itemBtnByKey.get(nextKey);
      const nextTick = railTickByKey.get(nextKey);
      if (nextBtn) nextBtn.setAttribute('data-active', '1');
      if (nextTick) nextTick.setAttribute('data-active', '1');
      lastActiveKey = nextKey;
    }

    function ensureUiMounted() {
      if (!styleEl && cssText) {
        styleEl = doc.getElementById?.(STYLE_ID) || doc.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = cssText;
        (doc.head || doc.documentElement).appendChild(styleEl);
      }

      if (rootEl && rootEl.isConnected !== false) return;

      const locale = resolveLocale(doc);
      rootEl = markNoTranslate(doc.createElement('div'));
      rootEl.className = 'ag-wb-jump-root';
      rootEl.setAttribute('data-testid', 'wb-context-jump-root');
      rootEl.hidden = true;

      railEl = doc.createElement('div');
      railEl.className = 'ag-wb-jump-rail';
      railEl.setAttribute('role', 'button');
      railEl.setAttribute('tabindex', '0');
      railEl.setAttribute('aria-label', locale.railLabel);
      railEl.setAttribute('aria-expanded', 'false');

      popoverEl = doc.createElement('div');
      popoverEl.className = 'ag-wb-jump-popover';
      popoverEl.setAttribute('role', 'region');
      popoverEl.setAttribute('aria-label', locale.listLabel);

      listEl = doc.createElement('div');
      listEl.className = 'ag-wb-jump-list';
      listEl.setAttribute('role', 'listbox');

      toastEl = doc.createElement('div');
      toastEl.className = 'ag-wb-jump-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');

      popoverEl.appendChild(listEl);
      rootEl.appendChild(toastEl);
      rootEl.appendChild(railEl);
      rootEl.appendChild(popoverEl);

      railEl.addEventListener('pointerenter', () => {
        clearHideTimer();
        openPopover({ pin: false });
      });
      railEl.addEventListener('pointerleave', () => {
        scheduleHide();
      });
      railEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isOpen && pinnedOpen) {
          pinnedOpen = false;
          closePopover();
        } else {
          openPopover({ pin: true, focusKeyboard: true });
        }
      });

      popoverEl.addEventListener('pointerenter', () => {
        clearHideTimer();
      });
      popoverEl.addEventListener('pointerleave', () => {
        scheduleHide();
      });

      listEl.addEventListener(
        'scroll',
        () => {
          if (!currentConvId) return;
          const convState = stateStore.getOrCreate(currentConvId);
          convState.popoverScrollTop = listEl.scrollTop || 0;
        },
        { passive: true }
      );

      (doc.body || doc.documentElement).appendChild(rootEl);
    }

    function setFocusedListIdx(nextIdx) {
      const items = currentModel.items;
      if (!items.length || !listEl) return;
      if (focusedListIdx >= 0 && items[focusedListIdx]) {
        itemBtnByKey.get(items[focusedListIdx].key)?.removeAttribute('data-focused');
      }
      focusedListIdx = Math.max(0, Math.min(items.length - 1, nextIdx));
      const btn = itemBtnByKey.get(items[focusedListIdx].key);
      if (btn) {
        btn.setAttribute('data-focused', '1');
        btn.scrollIntoView?.({ block: 'nearest' });
      }
    }

    function scrollActiveItemIntoPopoverView() {
      if (!listEl || !currentModel.items.length) return;
      const convState = stateStore.getOrCreate(currentConvId);
      if (convState.popoverScrollTop > 0 && listEl.scrollHeight > listEl.clientHeight) {
        listEl.scrollTop = convState.popoverScrollTop;
        return;
      }
      const activeItem = currentModel.items[currentModel.activeIndex];
      const activeBtn = activeItem ? itemBtnByKey.get(activeItem.key) : null;
      if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
        activeBtn.scrollIntoView({ block: 'center' });
      }
    }

    function openPopover({ pin = false, focusKeyboard = false } = {}) {
      if (destroyed) return false;
      clearHideTimer();
      syncNow(false);
      if (!rootEl || !currentModel.items.length) return false;

      if (pin) pinnedOpen = true;
      const wasOpen = isOpen;
      isOpen = true;
      rootEl.setAttribute('data-open', '1');
      railEl?.setAttribute('aria-expanded', 'true');
      updateAnchorPosition();

      if (!wasOpen) {
        scrollActiveItemIntoPopoverView();
      }
      if (focusKeyboard) {
        setFocusedListIdx(currentModel.activeIndex >= 0 ? currentModel.activeIndex : 0);
      }
      return true;
    }

    function closePopover() {
      clearHideTimer();
      isOpen = false;
      pinnedOpen = false;
      if (focusedListIdx >= 0 && currentModel.items[focusedListIdx]) {
        itemBtnByKey.get(currentModel.items[focusedListIdx].key)?.removeAttribute('data-focused');
      }
      focusedListIdx = -1;
      rootEl?.removeAttribute('data-open');
      railEl?.setAttribute('aria-expanded', 'false');
    }

    function renderModel(model, forceRebuild = false) {
      ensureUiMounted();
      if (!rootEl || !railEl || !listEl) return;

      if (!model || !model.items.length) {
        rootEl.hidden = true;
        closePopover();
        lastStructureSig = '';
        lastActiveKey = '';
        return;
      }

      rootEl.hidden = false;
      updateAnchorPosition();

      const activeItem = model.items[model.activeIndex] || null;
      const nextActiveKey = activeItem ? activeItem.key : '';
      const convState = stateStore.getOrCreate(currentConvId);
      convState.activeTurnKey = nextActiveKey;

      const sigParts = [currentConvId, model.items.length];
      for (let i = 0; i < model.items.length; i++) {
        const it = model.items[i];
        sigParts.push(`${it.key}|${it.preview}|${it.mounted ? 1 : 0}`);
      }
      const nextSig = sigParts.join('\x1f');

      if (!forceRebuild && nextSig === lastStructureSig && listEl.firstChild) {
        // Refresh live DOM element references without tearing down UI or losing scrollTop!
        for (let i = 0; i < model.items.length; i++) {
          const it = model.items[i];
          const btn = itemBtnByKey.get(it.key);
          if (btn) btn.__wbItem = it;
        }
        setActiveVisualKey(nextActiveKey);
        return;
      }

      const prevListScrollTop = listEl.scrollTop || convState.popoverScrollTop || 0;
      lastStructureSig = nextSig;
      lastActiveKey = nextActiveKey;
      itemBtnByKey.clear();
      railTickByKey.clear();

      // Build collapsed right-edge tick rail (windowed if extremely long conversation).
      const railWindow = core.computeRailWindow(model.items, model.activeIndex, core.MAX_RAIL_TICKS);
      const railFrag = doc.createDocumentFragment();
      for (let i = 0; i < railWindow.items.length; i++) {
        const it = railWindow.items[i];
        const tick = doc.createElement('span');
        tick.className = 'ag-wb-jump-rail-tick';
        if (it.active) tick.setAttribute('data-active', '1');
        railTickByKey.set(it.key, tick);
        railFrag.appendChild(tick);
      }
      railEl.textContent = '';
      railEl.appendChild(railFrag);

      // Build WorkBuddy floating quick-jump list rows: [ single-line prompt ...   — ]
      const listFrag = doc.createDocumentFragment();
      for (let i = 0; i < model.items.length; i++) {
        const it = model.items[i];
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-wb-jump-item';
        btn.setAttribute('role', 'option');
        btn.setAttribute('data-turn-num', String(it.turnNum));
        btn.setAttribute('aria-selected', it.active ? 'true' : 'false');
        if (it.active) btn.setAttribute('data-active', '1');
        if (!it.mounted) btn.setAttribute('data-virtual', '1');
        if (it.rawText) btn.title = it.rawText;
        btn.__wbItem = it;

        const textSpan = doc.createElement('span');
        textSpan.className = 'ag-wb-jump-item-text';
        textSpan.textContent = it.preview;

        const tickSpan = doc.createElement('span');
        tickSpan.className = 'ag-wb-jump-item-tick';
        tickSpan.setAttribute('aria-hidden', 'true');

        btn.appendChild(textSpan);
        btn.appendChild(tickSpan);

        // Preserve composer focus & user text selection on click.
        btn.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
        });
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          jumpToItem(btn.__wbItem || it, { recordOrigin: true, closeAfter: false });
        });

        itemBtnByKey.set(it.key, btn);
        listFrag.appendChild(btn);
      }
      listEl.textContent = '';
      listEl.appendChild(listFrag);

      if (prevListScrollTop > 0) {
        listEl.scrollTop = prevListScrollTop;
      }
    }

    function syncActiveFromScroll() {
      if (destroyed || !boundConvView || !boundViewport) return;
      const model = collectLiveModel(boundConvView, boundViewport);
      currentModel = model;
      if (!model.items.length) {
        renderModel(model, false);
        return;
      }
      const activeItem = model.items[model.activeIndex];
      if (activeItem) {
        setActiveVisualKey(activeItem.key);
        const convState = stateStore.getOrCreate(currentConvId);
        convState.activeTurnKey = activeItem.key;
      }
    }

    const onViewportScroll = () => {
      if (destroyed || scrollRaf) return;
      const schedule = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
      scrollRaf = schedule(() => {
        scrollRaf = 0;
        syncActiveFromScroll();
      });
    };

    function bindContainers(convView, viewport) {
      if (boundViewport !== viewport) {
        if (boundViewport) {
          boundViewport.removeEventListener?.('scroll', onViewportScroll);
        }
        boundViewport = viewport;
        if (boundViewport) {
          boundViewport.addEventListener?.('scroll', onViewportScroll, { passive: true });
        }
      }

      if (boundConvView !== convView) {
        if (resizeObserver) {
          try {
            resizeObserver.disconnect();
          } catch {}
        }
        boundConvView = convView;
        if (boundConvView && typeof win.ResizeObserver === 'function') {
          resizeObserver = new win.ResizeObserver(() => {
            if (!destroyed) updateAnchorPosition();
          });
          resizeObserver.observe(boundConvView);
          const composer = boundConvView.querySelector?.(S_COMPOSER);
          if (composer) resizeObserver.observe(composer);
        }
      }
    }

    function syncNow(forceRebuild = false) {
      if (destroyed) return;
      const convView = findPrimaryConvView();
      const viewport = findScrollViewport(convView);
      bindContainers(convView, viewport);

      if (!convView || !viewport) {
        currentModel = { totalTurns: 0, activeIndex: -1, items: [] };
        if (rootEl) rootEl.hidden = true;
        closePopover();
        return;
      }

      const nextConvId = readConversationId(convView) || '__active__';
      if (nextConvId !== currentConvId) {
        // Persist outgoing conversation's popover scroll before switching.
        if (currentConvId && listEl) {
          const prevSt = stateStore.getOrCreate(currentConvId);
          prevSt.popoverScrollTop = listEl.scrollTop || 0;
        }
        cancelActiveStabilization();
        activeJumpSeq += 1;
        currentConvId = nextConvId;
        lastStructureSig = '';
        lastActiveKey = '';
        closePopover();
        forceRebuild = true;
      }

      const model = collectLiveModel(convView, viewport);
      currentModel = model;
      renderModel(model, forceRebuild);
    }

    function scheduleSync(force = false) {
      if (destroyed) return;
      const now = Date.now();
      if (!force && now - lastSyncAt < STREAM_SYNC_THROTTLE_MS) {
        if (!syncRaf) {
          syncRaf = trackTimer(() => {
            syncRaf = 0;
            lastSyncAt = Date.now();
            syncNow(false);
          }, STREAM_SYNC_THROTTLE_MS);
        }
        return;
      }
      lastSyncAt = now;
      if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => syncNow(force));
      } else {
        syncNow(force);
      }
    }

    const onDocPointerDown = (ev) => {
      if (destroyed || !isOpen) return;
      if (rootEl && rootEl.contains?.(ev.target)) return;
      closePopover();
    };

    const onWinResize = () => {
      if (!destroyed) updateAnchorPosition();
    };

    const onWinKeyDown = (ev) => {
      if (destroyed || !ev) return;

      // Keyboard navigation while popover is open & pinned/focused.
      if (isOpen && (pinnedOpen || focusedListIdx >= 0)) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closePopover();
          return;
        }
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          ev.stopPropagation();
          setFocusedListIdx(focusedListIdx < 0 ? 0 : focusedListIdx + 1);
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          ev.stopPropagation();
          setFocusedListIdx(focusedListIdx < 0 ? currentModel.items.length - 1 : focusedListIdx - 1);
          return;
        }
        if (ev.key === 'Home') {
          ev.preventDefault();
          ev.stopPropagation();
          setFocusedListIdx(0);
          return;
        }
        if (ev.key === 'End') {
          ev.preventDefault();
          ev.stopPropagation();
          setFocusedListIdx(currentModel.items.length - 1);
          return;
        }
        if (ev.key === 'Enter' && focusedListIdx >= 0) {
          ev.preventDefault();
          ev.stopPropagation();
          const item = currentModel.items[focusedListIdx];
          if (item) jumpToItem(item, { recordOrigin: true, closeAfter: true });
          return;
        }
      }

      if (ev.key === 'Escape' && isOpen) {
        closePopover();
        return;
      }

      if (isEditableElement(ev.target)) return;

      // Alt+J: Toggle WorkBuddy quick-jump card with keyboard focus.
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && String(ev.key).toLowerCase() === 'j') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        if (isOpen) {
          closePopover();
        } else {
          openPopover({ pin: true, focusKeyboard: true });
        }
        return;
      }

      // Alt+ArrowUp / Alt+ArrowDown: Jump to previous / next user turn (replaces default jump).
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.shiftKey &&
        (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        jumpDelta(ev.key === 'ArrowUp' ? -1 : 1);
        return;
      }

      // Alt+Backspace: Return to previous reading position before last jump.
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.key === 'Backspace') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        jumpBack();
      }
    };

    // Activate replacement flag on <html>
    doc.documentElement?.setAttribute?.(ROOT_ATTR, 'active');
    ensureUiMounted();

    // Observe DOM mutations (conversation switches, streaming turns, virtualized mounts)
    if (typeof win.MutationObserver === 'function' && doc.body) {
      mutObserver = new win.MutationObserver((mutations) => {
        if (destroyed) return;
        for (let i = 0; i < mutations.length; i++) {
          const t = mutations[i].target;
          if (rootEl && (t === rootEl || rootEl.contains?.(t))) continue;
          scheduleSync(false);
          return;
        }
      });
      mutObserver.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-cascade-id', 'data-ag-cs-theme', 'class'],
      });
    }

    win.addEventListener('resize', onWinResize, { passive: true });
    win.addEventListener('keydown', onWinKeyDown, true);
    doc.addEventListener('pointerdown', onDocPointerDown, true);

    syncNow(true);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelActiveStabilization();
      clearHideTimer();

      for (const t of activeTimers) clearTimeout(t);
      activeTimers.clear();
      for (const t of sonarTimers) clearTimeout(t);
      sonarTimers.clear();

      if (scrollRaf && typeof win.cancelAnimationFrame === 'function') {
        try {
          win.cancelAnimationFrame(scrollRaf);
        } catch {}
      }
      scrollRaf = 0;

      try {
        mutObserver?.disconnect();
      } catch {}
      mutObserver = null;

      try {
        resizeObserver?.disconnect();
      } catch {}
      resizeObserver = null;

      if (boundViewport) {
        boundViewport.removeEventListener?.('scroll', onViewportScroll);
        boundViewport = null;
      }
      boundConvView = null;

      win.removeEventListener('resize', onWinResize);
      win.removeEventListener('keydown', onWinKeyDown, true);
      doc.removeEventListener('pointerdown', onDocPointerDown, true);

      doc.querySelectorAll?.('[data-wb-jump-sonar="1"]').forEach((el) => {
        el.removeAttribute('data-wb-jump-sonar');
      });

      rootEl?.remove();
      styleEl?.remove();
      doc.documentElement?.removeAttribute?.(ROOT_ATTR);

      itemBtnByKey.clear();
      railTickByKey.clear();
      rootEl = null;
      railEl = null;
      popoverEl = null;
      listEl = null;
      toastEl = null;
      styleEl = null;
    }

    return {
      version: VERSION,
      sync: () => syncNow(true),
      jumpToItem,
      jumpToIndex,
      jumpDelta,
      jumpBack,
      openPopover,
      closePopover,
      getState: () => ({
        version: VERSION,
        destroyed,
        isOpen,
        pinnedOpen,
        currentConvId,
        turnCount: currentModel.items.length,
        activeIndex: currentModel.activeIndex,
        activeKey: lastActiveKey,
        stats: { ...stats },
      }),
      destroy,
    };
  }

  return {
    VERSION,
    STYLE_ID,
    ROOT_ATTR,
    createContextJumpController,
  };
});
