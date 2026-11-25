// WorkBuddy Context Jump — Core Navigation & State Engine (context-jump-core.js)
// Pure, DOM-agnostic logic for turn indexing, stable identity/fingerprinting,
// target resolution across DOM/virtualized turns, active-turn calculation,
// per-conversation state preservation, and layout-shift drift detection.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.__agWbJumpCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const MAX_HISTORY_PER_CONV = 24;
  const MAX_CONVERSATION_STATES = 64;
  const MAX_RAIL_TICKS = 36;
  const DEFAULT_ALIGN_OFFSET_PX = 20;
  const DEFAULT_DRIFT_THRESHOLD_PX = 24;

  function normalizeText(raw) {
    return String(raw || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatPromptPreview(raw, maxLen = 54) {
    const clean = normalizeText(raw);
    if (!clean) return '';
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…';
  }

  function hashFingerprint(text) {
    const s = normalizeText(text).toLowerCase().slice(0, 160);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function parseTurnDotMeta(ariaLabel, dataTurnIndex) {
    const aria = String(ariaLabel || '');
    const m = aria.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (m) {
      return {
        turnNum: parseInt(m[1], 10) || 0,
        total: parseInt(m[2], 10) || 0,
      };
    }
    const tail = aria.match(/(?:of|\/)\s*(\d+)/i);
    const lead = aria.match(/(\d+)/);
    let turnNum = lead ? parseInt(lead[1], 10) || 0 : 0;
    if (!turnNum && dataTurnIndex != null && dataTurnIndex !== '') {
      const parsed = parseInt(String(dataTurnIndex), 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        turnNum = parsed + 1;
      }
    }
    return {
      turnNum,
      total: tail ? parseInt(tail[1], 10) || 0 : 0,
    };
  }

  /**
   * Builds a unified, ordered list of turn descriptors combining mounted DOM user turns
   * and (when virtualized) native conversation-navigator turn buttons + cached previews.
   */
  function buildTurnIndex({
    mountedTurns = [],
    nativeDots = [],
    snippetCache = null,
    viewportTop = 0,
    viewportHeight = 600,
    activeNativeTurnNum = 0,
    fallbackLabel = (n) => `第 ${n} 轮对话`,
  } = {}) {
    const totalFromDots = nativeDots.reduce((acc, d) => Math.max(acc, d.total || 0, d.turnNum || 0), 0);
    const mountedCount = mountedTurns.length;
    const totalTurns = Math.max(totalFromDots, mountedCount);

    // Determine active mounted index from viewport anchor line (~28% from top of viewport).
    const anchorY = viewportTop + Math.min(200, Math.max(72, viewportHeight * 0.28));
    let activeMountedIdx = -1;
    for (let i = 0; i < mountedTurns.length; i++) {
      const rect = mountedTurns[i].rect;
      if (rect && typeof rect.top === 'number' && rect.top <= anchorY) {
        activeMountedIdx = i;
      }
    }
    if (activeMountedIdx < 0 && mountedTurns.length > 0) {
      activeMountedIdx = 0;
    }

    // Align mounted turns to 1-based global turn numbers.
    const exactDots =
      mountedCount > 0 &&
      nativeDots.length === mountedCount &&
      nativeDots.every((d) => Number.isInteger(d.turnNum) && d.turnNum > 0);

    let mountedStartTurn = Math.max(1, totalTurns - mountedCount + 1);
    if (!exactDots && activeNativeTurnNum > 0 && activeMountedIdx >= 0 && mountedCount > 0) {
      mountedStartTurn = Math.max(1, Math.min(mountedStartTurn, activeNativeTurnNum - activeMountedIdx));
    }

    const byTurnNum = new Map();

    // Seed from native dots first (supports virtualized/unmounted turns).
    for (let i = 0; i < nativeDots.length; i++) {
      const dot = nativeDots[i];
      const turnNum = dot.turnNum > 0 ? dot.turnNum : i + 1;
      const cached = snippetCache && typeof snippetCache.get === 'function' ? snippetCache.get(turnNum) : null;
      const dotText = normalizeText(dot.previewText || '');
      const rawText = dotText || (cached && cached.rawText) || '';
      byTurnNum.set(turnNum, {
        key: `turn:${turnNum}`,
        turnNum,
        rawText,
        preview: formatPromptPreview(rawText) || fallbackLabel(turnNum),
        fingerprint: rawText ? hashFingerprint(rawText) : (cached && cached.fingerprint) || '',
        el: null,
        nativeDotEl: dot.el || null,
        mounted: false,
        active: Boolean(dot.active),
        domIndex: -1,
      });
    }

    // Overlay mounted DOM turns (authoritative for visible/mounted content & DOM targets).
    for (let i = 0; i < mountedTurns.length; i++) {
      const mt = mountedTurns[i];
      const turnNum =
        Number.isInteger(mt.explicitTurnNum) && mt.explicitTurnNum > 0
          ? mt.explicitTurnNum
          : exactDots
            ? nativeDots[i].turnNum
            : mountedStartTurn + i;
      const rawText = normalizeText(mt.text || '');
      const fp = rawText ? hashFingerprint(rawText) : `idx-${turnNum}`;
      if (snippetCache && typeof snippetCache.set === 'function' && rawText) {
        snippetCache.set(turnNum, { rawText, fingerprint: fp });
      }
      const existing = byTurnNum.get(turnNum);
      byTurnNum.set(turnNum, {
        key: `turn:${turnNum}:${fp}`,
        turnNum,
        rawText,
        preview: formatPromptPreview(rawText) || (existing && existing.preview) || fallbackLabel(turnNum),
        fingerprint: fp,
        el: mt.el || null,
        nativeDotEl: (existing && existing.nativeDotEl) || null,
        mounted: Boolean(mt.el),
        active: i === activeMountedIdx,
        domIndex: i,
      });
    }

    const items = Array.from(byTurnNum.values()).sort((a, b) => a.turnNum - b.turnNum);

    // Ensure at most one item is active; prefer mounted viewport calculation when mounted items exist.
    let activeIndex = -1;
    if (mountedCount > 0) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].mounted && items[i].domIndex === activeMountedIdx) {
          activeIndex = i;
          break;
        }
      }
    }
    if (activeIndex < 0) {
      activeIndex = items.findIndex((it) => it.active);
    }
    if (activeIndex < 0 && items.length > 0) {
      activeIndex = items.length - 1;
    }

    for (let i = 0; i < items.length; i++) {
      items[i].active = i === activeIndex;
    }

    return {
      totalTurns: Math.max(totalTurns, items.length),
      activeIndex,
      items,
    };
  }

  /**
   * Resolves a target turn entry against the live turn index when jumping.
   * Handles stale DOM refs, shifted indices, virtualized turns, and deleted targets.
   */
  function resolveJumpTarget(requestedItem, liveIndex, { isConnectedFn } = {}) {
    const isConnected =
      typeof isConnectedFn === 'function'
        ? isConnectedFn
        : (el) => Boolean(el && el.isConnected !== false);

    if (!requestedItem || !liveIndex || !Array.isArray(liveIndex.items) || liveIndex.items.length === 0) {
      return { status: 'missing', reason: 'empty-index', item: null, el: null, nativeDotEl: null };
    }

    // 1. Direct connected DOM element on the requested item.
    if (requestedItem.el && isConnected(requestedItem.el)) {
      const matched = liveIndex.items.find((it) => it.el === requestedItem.el) || requestedItem;
      return { status: 'mounted', reason: 'direct-ref', item: matched, el: requestedItem.el, nativeDotEl: matched.nativeDotEl || null };
    }

    // 2. Re-match by exact key or (turnNum + fingerprint).
    let match =
      liveIndex.items.find((it) => it.key === requestedItem.key) ||
      (requestedItem.fingerprint
        ? liveIndex.items.find((it) => it.fingerprint === requestedItem.fingerprint && it.turnNum === requestedItem.turnNum)
        : null);

    // 3. Re-match by fingerprint alone (handles turn renumbering / inserted or removed earlier messages).
    if (!match && requestedItem.fingerprint) {
      const fpMatches = liveIndex.items.filter((it) => it.fingerprint === requestedItem.fingerprint);
      if (fpMatches.length === 1) {
        match = fpMatches[0];
      } else if (fpMatches.length > 1) {
        // Choose closest turnNum to original requested turnNum.
        match = fpMatches.reduce((best, cur) =>
          Math.abs(cur.turnNum - requestedItem.turnNum) < Math.abs(best.turnNum - requestedItem.turnNum) ? cur : best
        );
      }
    }

    // 4. Re-match by turnNum only if the turn still exists and has compatible or empty fingerprint.
    if (!match && Number.isInteger(requestedItem.turnNum)) {
      const sameTurn = liveIndex.items.find((it) => it.turnNum === requestedItem.turnNum);
      if (sameTurn && (!requestedItem.fingerprint || !sameTurn.fingerprint || sameTurn.fingerprint === requestedItem.fingerprint)) {
        match = sameTurn;
      }
    }

    if (!match) {
      return { status: 'missing', reason: 'not-found', item: null, el: null, nativeDotEl: null };
    }

    if (match.el && isConnected(match.el)) {
      return { status: 'mounted', reason: 're-resolved', item: match, el: match.el, nativeDotEl: match.nativeDotEl || null };
    }

    if (match.nativeDotEl && isConnected(match.nativeDotEl)) {
      return { status: 'virtualized', reason: 'native-dot-fallback', item: match, el: null, nativeDotEl: match.nativeDotEl };
    }

    return { status: 'missing', reason: 'detached', item: match, el: null, nativeDotEl: null };
  }

  /**
   * Computes desired scrollTop inside scroll viewport and detects whether layout drift
   * exceeded tolerance after a jump.
   */
  function computeTargetScrollTop({
    currentScrollTop = 0,
    targetRectTop = 0,
    viewportRectTop = 0,
    alignOffsetPx = DEFAULT_ALIGN_OFFSET_PX,
    maxScrollTop = Infinity,
  } = {}) {
    const raw = Math.round(currentScrollTop + (targetRectTop - viewportRectTop) - alignOffsetPx);
    const boundedMax = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : raw;
    return Math.max(0, Math.min(boundedMax, raw));
  }

  function needsDriftCorrection({
    targetRectTop,
    viewportRectTop,
    alignOffsetPx = DEFAULT_ALIGN_OFFSET_PX,
    tolerancePx = DEFAULT_DRIFT_THRESHOLD_PX,
  } = {}) {
    if (typeof targetRectTop !== 'number' || typeof viewportRectTop !== 'number') return false;
    const expectedTop = viewportRectTop + alignOffsetPx;
    return Math.abs(targetRectTop - expectedTop) > tolerancePx;
  }

  /**
   * Slices items for the compact right-edge tick rail when a conversation has very many turns,
   * always keeping the active turn centered within the visible window.
   */
  function computeRailWindow(items, activeIndex, maxTicks = MAX_RAIL_TICKS) {
    const total = Array.isArray(items) ? items.length : 0;
    if (total <= maxTicks) {
      return { start: 0, end: total, items: items ? items.slice() : [] };
    }
    const safeActive = activeIndex >= 0 && activeIndex < total ? activeIndex : total - 1;
    const half = Math.floor(maxTicks / 2);
    let start = Math.max(0, safeActive - half);
    let end = start + maxTicks;
    if (end > total) {
      end = total;
      start = Math.max(0, end - maxTicks);
    }
    return { start, end, items: items.slice(start, end) };
  }

  /**
   * Per-conversation context state store with LRU eviction.
   * Preserves active turn key, popover scroll position, jump-back history, and prompt snippet cache.
   */
  function createConversationStateStore(maxEntries = MAX_CONVERSATION_STATES) {
    const map = new Map();

    function getOrCreate(convId) {
      const id = String(convId || '__default__');
      let entry = map.get(id);
      if (entry) {
        // Refresh LRU order.
        map.delete(id);
        map.set(id, entry);
        return entry;
      }
      entry = {
        id,
        activeTurnKey: '',
        lastJumpedTurnKey: '',
        popoverScrollTop: 0,
        pinned: false,
        jumpHistory: [],
        snippetCache: new Map(),
        updatedAt: Date.now(),
      };
      map.set(id, entry);
      while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
      }
      return entry;
    }

    function recordJumpOrigin(convId, origin) {
      if (!origin || typeof origin.scrollTop !== 'number') return;
      const st = getOrCreate(convId);
      const prev = st.jumpHistory[st.jumpHistory.length - 1];
      if (prev && Math.abs(prev.scrollTop - origin.scrollTop) < 12 && prev.turnKey === (origin.turnKey || '')) {
        return;
      }
      st.jumpHistory.push({
        scrollTop: Math.max(0, Math.round(origin.scrollTop)),
        turnKey: String(origin.turnKey || ''),
        ts: Date.now(),
      });
      if (st.jumpHistory.length > MAX_HISTORY_PER_CONV) {
        st.jumpHistory.shift();
      }
      st.updatedAt = Date.now();
    }

    function popJumpOrigin(convId) {
      const st = getOrCreate(convId);
      if (!st.jumpHistory.length) return null;
      st.updatedAt = Date.now();
      return st.jumpHistory.pop();
    }

    function clear() {
      map.clear();
    }

    return {
      getOrCreate,
      recordJumpOrigin,
      popJumpOrigin,
      clear,
      size: () => map.size,
    };
  }

  return {
    MAX_HISTORY_PER_CONV,
    MAX_CONVERSATION_STATES,
    MAX_RAIL_TICKS,
    DEFAULT_ALIGN_OFFSET_PX,
    DEFAULT_DRIFT_THRESHOLD_PX,
    normalizeText,
    formatPromptPreview,
    hashFingerprint,
    parseTurnDotMeta,
    buildTurnIndex,
    resolveJumpTarget,
    computeTargetScrollTop,
    needsDriftCorrection,
    computeRailWindow,
    createConversationStateStore,
  };
});
