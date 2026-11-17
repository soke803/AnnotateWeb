if (!window.webDrawInitialized) {
  // Keep a teardown entry point available even if initialization is interrupted.
  const engineListeners = [];
  function listen(target, type, handler, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (!engineListeners.some(item => item.target === target && item.type === type &&
        item.handler === handler && item.capture === capture)) {
      target.addEventListener(type, handler, options);
      engineListeners.push({target, type, handler, options, capture});
    }
  }
  function unlisten(target, type, handler, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    target.removeEventListener(type, handler, options);
    for (let i = engineListeners.length - 1; i >= 0; i--) {
      const item = engineListeners[i];
      if (item.target === target && item.type === type && item.handler === handler && item.capture === capture) {
        engineListeners.splice(i, 1);
      }
    }
  }
  const siteStorage = {
    getItem(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    setItem(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
  };
  const safely = action => { try { action(); } catch (error) { console.warn('Annotate Web cleanup:', error); } };
  window.webDrawForceOff = forceOffWebDraw;
  window.webDrawDisable = disableWebDraw;
  /* каждому scroll-контейнеру свой холст */
  const canvasMap = new Map();               // container → state { baseCanvas, overlayCanvas, ... }
  let historyRevision = 0;
  let drawSessionCounter = 0;
  const measurementCanvas = document.createElement('canvas');
  const measurementCtx = measurementCanvas.getContext('2d');
  /* храним историю по страницам: signature (origin+path+query) → entries[] */
  const HISTORY_MAP_STORAGE_KEY = 'webdraw:drawHistoryByPage';
  const PAGE_STORAGE_FALLBACK_KEY = 'about:blank';

  function resolvePageStorageKey() {
    try {
      const { origin = '', pathname = '', search = '' } = window.location || {};
      const signature = `${origin}${pathname || '/'}${search || ''}`;
      if (signature) return signature;
    } catch (err) {
      // ignore and fall through to fallback
    }
    return PAGE_STORAGE_FALLBACK_KEY;
  }

  function loadHistoryMap() {
    let raw = null;
    try {
      raw = siteStorage.getItem(HISTORY_MAP_STORAGE_KEY);
    } catch (err) {
      raw = null;
    }
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      // ignore corrupted payloads
    }
    return {};
  }

  const pageHistoryKey = resolvePageStorageKey();
  const historyMap = loadHistoryMap();
  function getStoredHistoryForPage() {
    const stored = historyMap[pageHistoryKey];
    return Array.isArray(stored) ? stored : [];
  }

  function escapeAttributeValue(value) {
    if (typeof value !== 'string') return value;
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
      }
    } catch (err) {
      // ignore and fall back
    }
    return value.replace(/["\\]/g, '\\$&');
  }

  function ensureContainerIdentifier(container, preferredId) {
    const normalized = normalizeContainer(container);
    if (!normalized || normalized === document.documentElement) return 'root';
    const current = normalized.dataset.webdrawId;
    if (current) return current;
    const candidate = preferredId && preferredId !== 'root' ? preferredId : (
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `wd-${Math.random().toString(36).slice(2)}`
    );
    normalized.dataset.webdrawId = candidate;
    return candidate;
  }

  function buildContainerPath(node) {
    const path = [];
    let current = node;
    if (!current) return path;
    if (current === document.documentElement) return [{ tag: 'html' }];

    while (current && current !== document.documentElement) {
      const segment = {
        tag: current.tagName ? current.tagName.toLowerCase() : ''
      };
      if (current.id) {
        segment.id = current.id;
      } else {
        const classList = current.classList ? Array.from(current.classList).slice(0, 3) : [];
        if (classList.length) segment.classes = classList;
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
          segment.nth = siblings.indexOf(current);
        }
      }
      path.push(segment);
      current = current.parentElement;
    }

    path.push({ tag: 'html' });
    return path.reverse();
  }

  function resolveContainerByPath(pathSegments) {
    if (!Array.isArray(pathSegments) || pathSegments.length === 0) return null;
    const [first] = pathSegments;
    if (!first || (first.tag || '').toLowerCase() !== 'html') return null;
    let node = document.documentElement;

    for (let i = 1; i < pathSegments.length; i += 1) {
      if (!node) return null;
      const segment = pathSegments[i];
      if (!segment || !segment.tag) return null;
      const tagName = segment.tag.toUpperCase();

      if (segment.id) {
        const withId = document.getElementById(segment.id);
        if (withId && withId.tagName === tagName) {
          node = withId;
          continue;
        }
      }

      let candidates = Array.from(node.children).filter(child => child.tagName === tagName);
      if (!candidates.length) return null;

      if (segment.classes && segment.classes.length) {
        candidates = candidates.filter(child =>
          segment.classes.every(cls => child.classList?.contains(cls))
        );
        if (!candidates.length) return null;
      }

      if (typeof segment.nth === 'number' && segment.nth >= 0) {
        node = candidates[segment.nth] || candidates[0] || null;
      } else {
        node = candidates[0] || null;
      }
    }

    return node;
  }

  function ensureOverlayRoot() {
    let root = document.getElementById('webdraw-overlay-root');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'webdraw-overlay-root';
    root.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      contain: layout paint style;
      cursor: default;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    `;

    const attachTo = document.body || document.documentElement;
    attachTo.appendChild(root);
    if (!document.body) {
      listen(window, 'DOMContentLoaded', () => {
        if (document.body && root.parentNode !== document.body) {
          document.body.appendChild(root);
        }
      }, { once: true });
    }
    return root;
  }

  function normalizeContainer(container) {
    if (!container || container === window || container === document) {
      return document.documentElement;
    }
    if (document.body && container === document.body) {
      return document.documentElement;
    }
    return container;
  }

  function getDrawContainer(node) {
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;

    while (node && node !== document.documentElement) {
      const st = getComputedStyle(node);
      if (st.position === 'fixed' || st.position === 'sticky') return normalizeContainer(node);          // fixed-контейнер
      if (/(auto|scroll|overlay)/.test(st.overflow + st.overflowY + st.overflowX))   // scrollable
        return normalizeContainer(node);
      node = node.parentElement;
    }
    return document.documentElement;  // fallback
  }

  function ensureCanvas(container) {
    container = normalizeContainer(container);
    if (container === document.documentElement && document.body && canvasMap.has(document.body)) {
      const legacy = canvasMap.get(document.body);
      if (legacy) {
        canvasMap.delete(document.body);
        legacy.container = document.documentElement;
        canvasMap.set(document.documentElement, legacy);
        return legacy;
      }
    }

    let state = canvasMap.get(container);
    if (state) return state;

    const isRoot = container === document.documentElement;
    const baseCanvas = document.createElement('canvas');
    baseCanvas.className = 'webdraw-canvas webdraw-canvas-base';
    baseCanvas.style.cssText = `
      position:${isRoot ? 'fixed' : 'absolute'};
      top:0;
      left:0;
      pointer-events:none;
      z-index:10000;
      transform-origin:top left;
    `;

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'webdraw-canvas webdraw-canvas-overlay';
    overlayCanvas.style.cssText = `
      position:${isRoot ? 'fixed' : 'absolute'};
      top:0;
      left:0;
      pointer-events:none;
      z-index:10001;
      transform-origin:top left;
    `;

    if (isRoot) {
      baseCanvas.id = 'webdraw-canvas-base';
      overlayCanvas.id = 'webdraw-canvas';
    }

    /* все холсты живут в общем overlay-слое, чтобы не зависеть от локальных стэков */
    const host = ensureOverlayRoot();
    host.appendChild(baseCanvas);
    host.appendChild(overlayCanvas);

    /* присваиваем контейнеру уникальный data-атрибут,
       чтобы хранить его в localStorage */
    ensureContainerIdentifier(container);

    const cacheCanvas = document.createElement('canvas');

    state = {
      container,
      baseCanvas,
      overlayCanvas,
      baseCtx: baseCanvas.getContext('2d'),
      overlayCtx: overlayCanvas.getContext('2d'),
      cacheCanvas,
      cacheCtx: cacheCanvas.getContext('2d'),
      width: 0,
      height: 0,
      dpr: 1,
      viewport: { scrollLeft: 0, scrollTop: 0, width: 0, height: 0 },
      redrawScheduled: false,
      renderedViewport: null,
      pendingReason: null,
      entriesCache: null,
      entriesCacheVersion: -1,
    };

    canvasMap.set(container, state);

    refreshStateMetrics(state, /* resize = */ true);
    attachContainerScroll(state);
    observeContainerResize(state);

    return state;
  }

  let previewState = null;

  function ensurePreviewCanvas() {
    if (previewState) return previewState;

    const canvas = document.createElement('canvas');
    canvas.className = 'webdraw-canvas webdraw-canvas-preview';
    canvas.style.cssText = `
      position:fixed;
      top:0;
      left:0;
      pointer-events:none;
      z-index:2147483647;
      transform-origin:top left;
      display:none;
    `;

    const ctx = canvas.getContext('2d', {desynchronized: true});
    const state = {
      canvas,
      ctx,
      width: 0,
      height: 0,
      dpr: 1,
      active: false,
    };

    const host = ensureOverlayRoot();
    host.appendChild(canvas);
    previewState = state;
    refreshPreviewMetrics(state, /* force = */ true);
    return state;
  }

  function refreshPreviewMetrics(state, force = false) {
    if (!state) return;
    const cssWidth =
      window.innerWidth ||
      document.documentElement.clientWidth ||
      0;
    const cssHeight =
      window.innerHeight ||
      document.documentElement.clientHeight ||
      0;
    const dpr = window.devicePixelRatio || 1;

    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    const sizeChanged =
      force ||
      state.width !== cssWidth ||
      state.height !== cssHeight ||
      state.dpr !== dpr;

    if (sizeChanged) {
      if (state.canvas.width !== pixelWidth) state.canvas.width = pixelWidth;
      if (state.canvas.height !== pixelHeight) state.canvas.height = pixelHeight;
      state.canvas.style.width = cssWidth + 'px';
      state.canvas.style.height = cssHeight + 'px';

      state.ctx.setTransform(1, 0, 0, 1, 0, 0);
      state.ctx.scale(dpr, dpr);

      state.width = cssWidth;
      state.height = cssHeight;
      state.dpr = dpr;
    }
  }

  function clearPreviewCanvas() {
    if (!previewState) return;
    const { ctx, width, height } = previewState;
    if (!ctx || width === 0 || height === 0) return;
    ctx.clearRect(0, 0, width, height);
  }

  function activatePreviewCanvas() {
    const state = ensurePreviewCanvas();
    refreshPreviewMetrics(state);
    state.canvas.style.display = 'block';
    state.active = true;
    return state;
  }

  function deactivatePreviewCanvas() {
    if (!previewState) return;
    if (previewState.active) clearPreviewCanvas();
    previewState.canvas.style.display = 'none';
    previewState.active = false;
  }

  // Keep buffers bounded even when an overflow container is as tall as the
  // conversation. Coordinates remain in the container's content space.
  const VIEWPORT_MARGIN = 128;
  function getViewportMetrics(container) {
    container = normalizeContainer(container);
    if (container === document.documentElement) {
      return {
        // In quirks mode html.clientHeight can be the entire document.
        width: window.innerWidth || document.documentElement.clientWidth,
        height: window.innerHeight || document.documentElement.clientHeight,
        scrollLeft: window.scrollX || window.pageXOffset || 0,
        scrollTop: window.scrollY || window.pageYOffset || 0,
        screenLeft: 0,
        screenTop: 0,
      };
    }

    const rect = container.getBoundingClientRect();
    let clipLeft = -VIEWPORT_MARGIN;
    let clipTop = -VIEWPORT_MARGIN;
    let clipRight = window.innerWidth + VIEWPORT_MARGIN;
    let clipBottom = window.innerHeight + VIEWPORT_MARGIN;
    // A tall sticky child must also stay inside its parent chat pane.
    for (let parent = container.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const clipsX = /(auto|scroll|hidden|clip|overlay)/.test(style.overflowX);
      const clipsY = /(auto|scroll|hidden|clip|overlay)/.test(style.overflowY);
      if (!clipsX && !clipsY) continue;
      const bounds = parent.getBoundingClientRect();
      if (clipsX) {
        clipLeft = Math.max(clipLeft, bounds.left + parent.clientLeft);
        clipRight = Math.min(clipRight, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (clipsY) {
        clipTop = Math.max(clipTop, bounds.top + parent.clientTop);
        clipBottom = Math.min(clipBottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
    }
    const left = Math.min(container.clientWidth, Math.max(0, clipLeft - rect.left));
    const top = Math.min(container.clientHeight, Math.max(0, clipTop - rect.top));
    const right = Math.max(left, Math.min(container.clientWidth, clipRight - rect.left));
    const bottom = Math.max(top, Math.min(container.clientHeight, clipBottom - rect.top));
    return {
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      scrollLeft: container.scrollLeft + left,
      scrollTop: container.scrollTop + top,
      screenLeft: rect.left + left,
      screenTop: rect.top + top,
    };
  }

  function updateCanvasTransform(state) {
    const container = normalizeContainer(state.container);
    state.container = container;

    if (container === document.documentElement) {
      state.baseCanvas.style.transform = '';
      state.overlayCanvas.style.transform = '';
      return;
    }

    if (!container.isConnected) return;

    const translate = `translate(${state.viewport.screenLeft}px, ${state.viewport.screenTop}px)`;
    state.baseCanvas.style.transform = translate;
    state.overlayCanvas.style.transform = translate;
  }

  let overlayRelayoutScheduled = false;
  function scheduleOverlayRelayout() {
    if (window.webDrawActive === false) return;
    if (overlayRelayoutScheduled) return;
    overlayRelayoutScheduled = true;
    requestAnimationFrame(() => {
      overlayRelayoutScheduled = false;
      if (window.webDrawActive === false) return;
      canvasMap.forEach(state => {
        if (!state || state.container === document.documentElement) return;
        // Resizing a cropped buffer clears it. Repaint in this same frame
        // instead of showing an empty buffer until a second animation frame.
        renderContainerState(state);
      });
    });
  }

  listen(window, 'scroll', scheduleOverlayRelayout, true);
  listen(window, 'resize', scheduleOverlayRelayout, true);

  function handlePreviewResize() {
    if (previewState?.active) {
      refreshPreviewMetrics(previewState, true);
      clearPreviewCanvas();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth * (currentShape === 'highlight' ? 2 : 1);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (currentShape === 'freeform' || currentShape === 'highlight') {
        renderPolyline(ctx, currentPath,
          {scrollLeft: window.scrollX, scrollTop: window.scrollY}, strokeSmoothing > 0);
      }
    }
  }

  listen(window, 'resize', handlePreviewResize);

  function refreshStateMetrics(state, resize = false) {
    const metrics = getViewportMetrics(state.container);
    state.viewport = metrics;

    const dpr = window.devicePixelRatio || 1;
    const sizeChanged =
      resize ||
      state.width !== metrics.width ||
      state.height !== metrics.height ||
      state.dpr !== dpr;

    if (sizeChanged) {
      const pixelWidth = Math.max(1, Math.round(metrics.width * dpr));
      const pixelHeight = Math.max(1, Math.round(metrics.height * dpr));

      [state.baseCanvas, state.overlayCanvas].forEach(canvas => {
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        canvas.style.width = metrics.width + 'px';
        canvas.style.height = metrics.height + 'px';
      });

      state.baseCtx.setTransform(1, 0, 0, 1, 0, 0);
      state.baseCtx.scale(dpr, dpr);
      state.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      state.overlayCtx.scale(dpr, dpr);
      if (state.cacheCanvas.width !== pixelWidth) state.cacheCanvas.width = pixelWidth;
      if (state.cacheCanvas.height !== pixelHeight) state.cacheCanvas.height = pixelHeight;
      state.cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      state.cacheCtx.scale(dpr, dpr);

      state.width = metrics.width;
      state.height = metrics.height;
      state.dpr = dpr;
      state.renderedViewport = null;
    }

    updateCanvasTransform(state);
    return sizeChanged;
  }

  function attachContainerScroll(state) {
    const target =
      state.container === document.documentElement ? window : state.container;

    const onScroll = () => {
      if (window.webDrawActive === false) return;
      scheduleStateRedraw(state, 'scroll');
    };

    listen(target, 'scroll', onScroll, { passive: true });
    state.onScroll = onScroll;
    state.scrollTarget = target;
  }

  function observeContainerResize(state) {
    if (state.container === document.documentElement) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (window.webDrawActive === false) return;
      scheduleStateRedraw(state, 'full');
    });

    observer.observe(state.container);
    state.resizeObserver = observer;
  }

  function clearOverlay(state) {
    if (!state) return;
    state.overlayCtx.clearRect(0, 0, state.width || state.overlayCanvas.width, state.height || state.overlayCanvas.height);
  }

  function toViewportCoordsForState(point, state) {
    return {
      x: point.x - state.viewport.scrollLeft,
      y: point.y - state.viewport.scrollTop,
    };
  }

  function measureTextWidth(text, font) {
    if (!measurementCtx) return (text || '').length * 8;
    if (font) measurementCtx.font = font;
    return measurementCtx.measureText(text || '').width || 0;
  }

  function withIdentityTransform(ctx, fn) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    try {
      fn(ctx);
    } finally {
      ctx.restore();
    }
  }

  function boundsFromPoints(points) {
    if (!points || points.length === 0) return null;
    let minX = null;
    let maxX = null;
    let minY = null;
    let maxY = null;

    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (minX === null || p.x < minX) minX = p.x;
      if (maxX === null || p.x > maxX) maxX = p.x;
      if (minY === null || p.y < minY) minY = p.y;
      if (maxY === null || p.y > maxY) maxY = p.y;
    }

    if (minX === null || minY === null || maxX === null || maxY === null) {
      return null;
    }

    return { minX, minY, maxX, maxY };
  }

  function calculateBounds(entry) {
    if (!entry) return null;
    const { shape } = entry;
    if (shape === 'freeform' || shape === 'highlight') {
      return boundsFromPoints(entry.points);
    }
    if (shape === 'circle') {
      if (!entry.points || entry.points.length < 2) return null;
      const end = entry.points[1];
      const radius = Math.sqrt(
        Math.pow(end.x - entry.startX, 2) + Math.pow(end.y - entry.startY, 2)
      );
      return {
        minX: entry.startX - radius,
        minY: entry.startY - radius,
        maxX: entry.startX + radius,
        maxY: entry.startY + radius,
      };
    }
    if (shape === 'square') {
      if (!entry.points || entry.points.length < 2) return null;
      const end = entry.points[1];
      return {
        minX: Math.min(entry.startX, end.x),
        maxX: Math.max(entry.startX, end.x),
        minY: Math.min(entry.startY, end.y),
        maxY: Math.max(entry.startY, end.y),
      };
    }
    if (shape === 'triangle') {
      if (!entry.points || entry.points.length < 2) return null;
      const end = entry.points[1];
      const mirroredX = 2 * entry.startX - end.x;
      return {
        minX: Math.min(entry.startX, end.x, mirroredX),
        maxX: Math.max(entry.startX, end.x, mirroredX),
        minY: Math.min(entry.startY, end.y),
        maxY: Math.max(entry.startY, end.y),
      };
    }
    if (shape === 'arrow' || shape === 'line') {
      if (!entry.points || entry.points.length < 2) return null;
      const end = entry.points[1];
      return {
        minX: Math.min(entry.startX, end.x),
        maxX: Math.max(entry.startX, end.x),
        minY: Math.min(entry.startY, end.y),
        maxY: Math.max(entry.startY, end.y),
      };
    }
    if (shape === 'text') {
      const fontSizeMatch = /(\d+(\.\d+)?)px/.exec(entry.font || '');
      const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 16;
      const width = measureTextWidth(entry.text, entry.font) || (entry.text?.length || 1) * (fontSize * 0.6);
      return {
        minX: entry.x,
        minY: entry.y,
        maxX: entry.x + width,
        maxY: entry.y + fontSize,
      };
    }
    return null;
  }

  function createHistoryEntry(data) {
    const entry = { ...data };
    if (entry.containerId) {
      const normalized = normalizeContainer(entry.containerId);
      entry.containerId = normalized;
      entry.containerPath =
        normalized === document.documentElement ? null : buildContainerPath(normalized);
    } else {
      entry.containerPath = null;
    }
    entry.bounds = calculateBounds(entry);
    return entry;
  }

  function getCurrentThickness() {
    const raw = Number(siteStorage.getItem('currentThickness'));
    if (!Number.isFinite(raw) || raw <= 0) return 3;
    return raw;
  }

  function markHistoryDirty() {
    historyRevision += 1;
  }

  function getContainerEntries(state) {
    if (!state) return [];
    if (state.entriesCacheVersion === historyRevision && state.entriesCache) {
      return state.entriesCache;
    }

    const container = state.container;
    const entries = drawHistory.filter(entry =>
      (entry.containerId || document.documentElement) === container
    );
    state.entriesCache = entries;
    state.entriesCacheVersion = historyRevision;
    return entries;
  }

  function intersectsViewport(bounds, viewport) {
    if (!bounds) return true;
    const viewMinX = viewport.scrollLeft;
    const viewMaxX = viewport.scrollLeft + viewport.width;
    const viewMinY = viewport.scrollTop;
    const viewMaxY = viewport.scrollTop + viewport.height;

    return !(
      bounds.maxX < viewMinX ||
      bounds.minX > viewMaxX ||
      bounds.maxY < viewMinY ||
      bounds.minY > viewMaxY
    );
  }

  function intersectsRect(bounds, rect) {
    if (!bounds || !rect) return true;
    return !(
      bounds.maxX < rect.left ||
      bounds.minX > rect.right ||
      bounds.maxY < rect.top ||
      bounds.minY > rect.bottom
    );
  }

  function renderHistoryEntry(ctx, entry, viewport) {
    ctx.strokeStyle = entry.color;
    const lineWidth = Number(entry.width) || 1;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (entry.shape === 'freeform' && entry.points && entry.points.length > 0) {
      renderPolyline(ctx, entry.points, viewport, entry.smooth === true);
      return;
    }

    if (entry.shape === 'circle' && entry.points && entry.points.length > 1) {
      const radius = Math.sqrt(
        Math.pow(entry.points[1].x - entry.startX, 2) +
        Math.pow(entry.points[1].y - entry.startY, 2)
      );
      ctx.beginPath();
      ctx.arc(
        entry.startX - viewport.scrollLeft,
        entry.startY - viewport.scrollTop,
        radius,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      return;
    }

    if (entry.shape === 'square' && entry.points && entry.points.length > 1) {
      ctx.beginPath();
      ctx.rect(
        entry.startX - viewport.scrollLeft,
        entry.startY - viewport.scrollTop,
        entry.points[1].x - entry.startX,
        entry.points[1].y - entry.startY
      );
      ctx.stroke();
      return;
    }

    if (entry.shape === 'triangle' && entry.points && entry.points.length > 1) {
      ctx.beginPath();
      const startX = entry.startX - viewport.scrollLeft;
      const startY = entry.startY - viewport.scrollTop;
      const pointX = entry.points[1].x - viewport.scrollLeft;
      const pointY = entry.points[1].y - viewport.scrollTop;
      ctx.moveTo(startX, startY);
      ctx.lineTo(pointX, pointY);
      ctx.lineTo(2 * startX - pointX, pointY);
      ctx.closePath();
      ctx.stroke();
      return;
    }

    if (entry.shape === 'arrow' && entry.points && entry.points.length > 1) {
      drawArrow(
        ctx,
        entry.startX - viewport.scrollLeft,
        entry.startY - viewport.scrollTop,
        entry.points[1].x - viewport.scrollLeft,
        entry.points[1].y - viewport.scrollTop,
        lineWidth
      );
      return;
    }

    if (entry.shape === 'line' && entry.points && entry.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(
        entry.startX - viewport.scrollLeft,
        entry.startY - viewport.scrollTop
      );
      ctx.lineTo(
        entry.points[1].x - viewport.scrollLeft,
        entry.points[1].y - viewport.scrollTop
      );
      ctx.stroke();
      return;
    }

    if (entry.shape === 'text') {
      ctx.textBaseline = 'top';
      ctx.font = entry.font;
      ctx.fillStyle = entry.color;
      ctx.fillText(
        entry.text,
        entry.x - viewport.scrollLeft,
        entry.y - viewport.scrollTop
      );
      return;
    }

    if (entry.shape === 'highlight' && entry.points && entry.points.length > 0) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = lineWidth * 2;
      renderPolyline(ctx, entry.points, viewport, entry.smooth === true);
      ctx.restore();
      return;
    }
  }

  function renderContainerState(state) {
    if (!state || window.webDrawActive === false) return;

    const reason = state.pendingReason || 'scroll';
    state.pendingReason = null;
    const sizeChanged = refreshStateMetrics(state);

    if (state.width === 0 || state.height === 0) {
      state.renderedViewport = {
        left: state.viewport.scrollLeft,
        top: state.viewport.scrollTop,
        width: state.width,
        height: state.height,
      };
      return;
    }

    const viewport = state.viewport;
    const needsFull =
      reason === 'full' ||
      sizeChanged ||
      !state.renderedViewport;

    if (needsFull) {
      renderFullViewport(state);
      return;
    }

    const prev = state.renderedViewport;
    let deltaX = viewport.scrollLeft - prev.left;
    let deltaY = viewport.scrollTop - prev.top;

    const epsilon = 0.001;
    if (Math.abs(deltaX) < epsilon) deltaX = 0;
    if (Math.abs(deltaY) < epsilon) deltaY = 0;

    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    const maxShiftX = state.width;
    const maxShiftY = state.height;
    if (Math.abs(deltaX) >= maxShiftX || Math.abs(deltaY) >= maxShiftY) {
      renderFullViewport(state);
      return;
    }

    renderShiftedViewport(state, deltaX, deltaY);
  }

  function scheduleStateRedraw(state, reason = 'scroll') {
    if (!state) return;
    if (reason === 'full') {
      state.pendingReason = 'full';
    } else if (state.pendingReason !== 'full') {
      state.pendingReason = reason;
    }
    if (state.redrawScheduled) return;

    state.redrawScheduled = true;
    requestAnimationFrame(() => {
      state.redrawScheduled = false;
      renderContainerState(state);
    });
  }

  function renderFullViewport(state) {
    const { baseCtx, width, height, viewport } = state;
    baseCtx.clearRect(0, 0, width, height);

    const entries = getContainerEntries(state);
    entries.forEach(entry => {
      if (!intersectsViewport(entry.bounds, viewport)) return;
      renderHistoryEntry(baseCtx, entry, viewport);
    });

    state.renderedViewport = {
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      width,
      height,
    };
  }

  function renderShiftedViewport(state, deltaX, deltaY) {
    const { baseCtx, cacheCtx, baseCanvas, cacheCanvas, width, height, viewport } = state;

    withIdentityTransform(cacheCtx, ctx => {
      ctx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
      ctx.drawImage(baseCanvas, 0, 0);
    });

    withIdentityTransform(baseCtx, ctx => {
      ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
      ctx.drawImage(cacheCanvas, -deltaX * state.dpr, -deltaY * state.dpr);
    });

    const exposureRects = computeExposureRects(state, deltaX, deltaY);
    exposureRects.forEach(region => {
      renderRegion(state, region.world, region.clip);
    });

    state.renderedViewport = {
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      width,
      height,
    };
  }

  function computeExposureRects(state, deltaX, deltaY) {
    const rects = [];
    const viewport = state.viewport;
    const width = state.width;
    const height = state.height;
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    const right = left + width;
    const bottom = top + height;

    if (deltaY > 0) {
      const region = clampExposureRegion(state, {
        world: {
          left,
          top: bottom - deltaY,
          right,
          bottom,
        },
        clip: {
          x: 0,
          y: height - deltaY,
          width,
          height: deltaY,
        },
      });
      if (region) rects.push(region);
    } else if (deltaY < 0) {
      const abs = -deltaY;
      const region = clampExposureRegion(state, {
        world: {
          left,
          top,
          right,
          bottom: top + abs,
        },
        clip: {
          x: 0,
          y: 0,
          width,
          height: abs,
        },
      });
      if (region) rects.push(region);
    }

    if (deltaX > 0) {
      const region = clampExposureRegion(state, {
        world: {
          left: right - deltaX,
          top,
          right,
          bottom,
        },
        clip: {
          x: width - deltaX,
          y: 0,
          width: deltaX,
          height,
        },
      });
      if (region) rects.push(region);
    } else if (deltaX < 0) {
      const abs = -deltaX;
      const region = clampExposureRegion(state, {
        world: {
          left,
          top,
          right: left + abs,
          bottom,
        },
        clip: {
          x: 0,
          y: 0,
          width: abs,
          height,
        },
      });
      if (region) rects.push(region);
    }

    return rects;
  }

  function clampExposureRegion(state, region) {
    const maxWidth = state.width;
    const maxHeight = state.height;

    let { x, y, width, height } = region.clip;
    let { left, top, right, bottom } = region.world;

    const clampX = (value) => Math.max(0, Math.min(maxWidth, value));
    const clampY = (value) => Math.max(0, Math.min(maxHeight, value));

    const originalRight = x + width;
    const originalBottom = y + height;

    const clampedLeft = clampX(x);
    const clampedTop = clampY(y);
    const clampedRight = clampX(originalRight);
    const clampedBottom = clampY(originalBottom);

    const newWidth = clampedRight - clampedLeft;
    const newHeight = clampedBottom - clampedTop;

    if (newWidth <= 0 || newHeight <= 0) return null;

    const worldLeft = left + (clampedLeft - x);
    const worldTop = top + (clampedTop - y);
    const worldRight = worldLeft + newWidth;
    const worldBottom = worldTop + newHeight;

    return {
      world: {
        left: worldLeft,
        top: worldTop,
        right: worldRight,
        bottom: worldBottom,
      },
      clip: {
        x: clampedLeft,
        y: clampedTop,
        width: newWidth,
        height: newHeight,
      },
    };
  }

  function renderRegion(state, worldRect, clipRect) {
    const { baseCtx, viewport } = state;
    let { x, y, width, height } = clipRect;
    if (width <= 0 || height <= 0) return;

    let { left, top, right, bottom } = worldRect;

    if (x < 0) {
      const delta = -x;
      width -= delta;
      x = 0;
      left += delta;
    }
    if (y < 0) {
      const delta = -y;
      height -= delta;
      y = 0;
      top += delta;
    }
    if (x + width > state.width) {
      const delta = x + width - state.width;
      width -= delta;
      right -= delta;
    }
    if (y + height > state.height) {
      const delta = y + height - state.height;
      height -= delta;
      bottom -= delta;
    }
    if (width <= 0 || height <= 0) return;

    baseCtx.save();
    baseCtx.beginPath();
    baseCtx.rect(x, y, width, height);
    baseCtx.clip();
    baseCtx.clearRect(x, y, width, height);

    const regionWorld = { left, top, right, bottom };
    const entries = getContainerEntries(state);
    entries.forEach(entry => {
      if (!intersectsRect(entry.bounds, regionWorld)) return;
      renderHistoryEntry(baseCtx, entry, viewport);
    });

    baseCtx.restore();
  }

  function renderPolyline(ctx, points, viewport, smooth = false) {
    if (!Array.isArray(points) || points.length === 0) return false;
    ctx.beginPath();
    let segment = [];
    let drewSegment = false;

    function flushSegment() {
      if (!segment.length) return;
      const first = segment[0];
      ctx.moveTo(first.x - viewport.scrollLeft, first.y - viewport.scrollTop);
      if (segment.length === 1) {
        // A single point is not a stroke; retain existing semantics.
      } else if (!smooth || segment.length === 2) {
        for (let i = 1; i < segment.length; i++) {
          ctx.lineTo(segment[i].x - viewport.scrollLeft,
                     segment[i].y - viewport.scrollTop);
        }
        drewSegment = true;
      } else {
        // Midpoint quadratic spline: curved corners, linear-time replay.
        for (let i = 1; i < segment.length - 1; i++) {
          const control = segment[i];
          const next = segment[i + 1];
          ctx.quadraticCurveTo(
            control.x - viewport.scrollLeft,
            control.y - viewport.scrollTop,
            (control.x + next.x) * 0.5 - viewport.scrollLeft,
            (control.y + next.y) * 0.5 - viewport.scrollTop
          );
        }
        const last = segment[segment.length - 1];
        ctx.lineTo(last.x - viewport.scrollLeft,
                   last.y - viewport.scrollTop);
        drewSegment = true;
      }
      segment = [];
    }

    for (const point of points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        flushSegment();
      } else {
        segment.push(point);
      }
    }
    flushSegment();
    if (drewSegment) ctx.stroke();
    return drewSegment;
  }

  let activeContainer = null;    // scroll-контейнер, в котором идёт рисование
  let activeState = null;        // состояние холстов контейнера
  let ctx    = null;             // контекст превью-холста

  let startPagePoint = null;
  let lastPagePoint = null;
  let containersDuringDraw = new Set();

  /* -----------------------------------------------------*
     Блокируем взаимодействие со страницей, кроме прокрутки
   * ----------------------------------------------------- */

  let interactionsLocked = false;

  // All interaction rules belong to the viewport overlay. Never toggle a
  // `body *` rule: its style invalidation grows with a long ChatGPT conversation.
  const lockStyle = document.createElement('style');
  lockStyle.id = 'webdraw-lock-style';
  lockStyle.textContent = `
    #webdraw-overlay-root { cursor: default; }
    #webdraw-overlay-root #textInput {
      cursor: text; user-select: text; -webkit-user-select: text;
      pointer-events: auto; touch-action: auto;
    }
  `;
  document.head.appendChild(lockStyle);

  const blockedEvents = [
    'click', 'dblclick', 'mousedown', 'mouseup',
    'contextmenu', 'selectstart', 'dragstart'
  ];
  window.webDrawBlockedEvents = blockedEvents;

  function isDrawingControl(target) {
    return Boolean(target?.closest?.('#control-panel, #textInput'));
  }

  function stopEvent(e) {
    if (isDrawingControl(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  // The overlay receives wheel input, so route it to the actual scrollable
  // content underneath, including nested chat panes and scroll chaining.
  function forwardWheel(e) {
    if (isDrawingControl(e.target) || e.ctrlKey || drawing) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    let dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
    let dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
    let node = pageElementFromPoint(e.clientX, e.clientY);
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const oldX = node.scrollLeft;
      const oldY = node.scrollTop;
      const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX);
      const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY);
      node.scrollBy({left: scrollsX ? dx : 0, top: scrollsY ? dy : 0, behavior: 'instant'});
      dx -= node.scrollLeft - oldX;
      dy -= node.scrollTop - oldY;
      if (scrollsX && /(contain|none)/.test(style.overscrollBehaviorX)) dx = 0;
      if (scrollsY && /(contain|none)/.test(style.overscrollBehaviorY)) dy = 0;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) break;
      node = node.parentElement;
    }
    if (dx || dy) window.scrollBy({left: dx, top: dy, behavior: 'instant'});
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function lockInteractions() {
    if (interactionsLocked) return;
    interactionsLocked = true;
    ensureOverlayRoot().style.pointerEvents = 'auto';
    blockedEvents.forEach(ev => listen(window, ev, stopEvent, true));
    listen(window, 'wheel', forwardWheel, {capture: true, passive: false});
    window.webDrawStopEvent = stopEvent;
  }

  function unlockInteractions() {
    if (!interactionsLocked) return;
    interactionsLocked = false;
    const root = document.getElementById('webdraw-overlay-root');
    if (root) root.style.pointerEvents = 'none';
    blockedEvents.forEach(ev => unlisten(window, ev, stopEvent, true));
    unlisten(window, 'wheel', forwardWheel, true);
  }

  let scrollLocked = false;
  let scrollLockPrev = null;

  function preventScroll(e) {
    if (e.target.closest && e.target.closest('#control-panel')) return;
    e.preventDefault();
  }

  function lockScroll() {
    if (scrollLocked) return;
    scrollLocked = true;
    const savedX = window.scrollX || window.pageXOffset || 0;
    const savedY = window.scrollY || window.pageYOffset || 0;
    const maintainPosition = () => {
      if (Math.abs((window.scrollX || window.pageXOffset || 0) - savedX) > 1 ||
          Math.abs((window.scrollY || window.pageYOffset || 0) - savedY) > 1) {
        window.scrollTo(savedX, savedY);
      }
    };
    scrollLockPrev = {
      scrollX: savedX,
      scrollY: savedY,
      maintainPosition,
    };
    listen(window, 'scroll', maintainPosition, { passive: true });
    listen(window, 'wheel', preventScroll, { passive: false, capture: true });
    listen(window, 'touchmove', preventScroll, { passive: false, capture: true });
  }

  function unlockScroll() {
    if (!scrollLocked) return;
    scrollLocked = false;
    if (scrollLockPrev?.maintainPosition) {
      unlisten(window, 'scroll', scrollLockPrev.maintainPosition);
    }
    unlisten(window, 'wheel', preventScroll, { capture: true });
    unlisten(window, 'touchmove', preventScroll, { capture: true });
    scrollLockPrev = null;
  }

  window.webDrawLockInteractions = lockInteractions;
  window.webDrawUnlockInteractions = unlockInteractions;
  window.webDrawLockScroll = lockScroll;
  window.webDrawUnlockScroll = unlockScroll;

  /* включаем блокировку сразу после инициализации рисования */
  if (!window.__webDrawPreloadOnly) lockInteractions();

  // Optional smoothing, configured in the existing pen settings dropdown.
  // PointerEvent.pointerType cannot reliably distinguish a trackpad from a mouse.
  const SMOOTHING_STORAGE_KEY = 'webdraw:smoothingStrength';
  const DEFAULT_SMOOTHING = 55;
  let strokeSmoothing = 0;
  let strokeColor = '#FF0000';
  let strokeWidth = 3;
  let lastRawPoint = null;
  let filteredPoint = null;

  function getSmoothingStrength() {
    const stored = siteStorage.getItem(SMOOTHING_STORAGE_KEY);
    if (stored === null) return DEFAULT_SMOOTHING;
    const value = Number(stored);
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : DEFAULT_SMOOTHING));
  }

  function smoothIncomingPoint(raw) {
    if (!filteredPoint || strokeSmoothing === 0) {
      filteredPoint = { x: raw.x, y: raw.y };
      lastRawPoint = { x: raw.x, y: raw.y };
      return filteredPoint;
    }
    if (lastRawPoint && raw.x === lastRawPoint.x && raw.y === lastRawPoint.y) {
      return null;
    }
    // Moderate one-pole smoothing suppresses mouse sensor jitter.
    // Preserve fast motion (large coordinate gaps) to avoid a lagging cursor.
    const dx = raw.x - filteredPoint.x;
    const dy = raw.y - filteredPoint.y;
    const distance = Math.hypot(dx, dy);
    let alpha = 1 - 0.0075 * strokeSmoothing;
    if (distance > 7) alpha = Math.max(alpha, 0.7);
    if (distance > 20) alpha = Math.max(alpha, 0.84);
    filteredPoint = {
      x: filteredPoint.x + alpha * dx,
      y: filteredPoint.y + alpha * dy
    };
    lastRawPoint = { x: raw.x, y: raw.y };
    return filteredPoint;
  }

  function drawLiveSegment() {
    const n = currentPath.length;
    if (n < 2) return;
    const offsetX = window.scrollX;
    const offsetY = window.scrollY;
    const a = currentPath[n - 2];
    const b = currentPath[n - 1];
    ctx.beginPath();
    if (strokeSmoothing === 0) {
      ctx.moveTo(a.x - offsetX, a.y - offsetY);
      ctx.lineTo(b.x - offsetX, b.y - offsetY);
    } else if (n === 2) {
      // The live spline is one half-segment behind the raw pointer.
      ctx.moveTo(a.x - offsetX, a.y - offsetY);
      ctx.lineTo((a.x + b.x) * 0.5 - offsetX,
                 (a.y + b.y) * 0.5 - offsetY);
    } else {
      const prev = currentPath[n - 3];
      ctx.moveTo((prev.x + a.x) * 0.5 - offsetX,
                 (prev.y + a.y) * 0.5 - offsetY);
      ctx.quadraticCurveTo(a.x - offsetX, a.y - offsetY,
                           (a.x + b.x) * 0.5 - offsetX,
                           (a.y + b.y) * 0.5 - offsetY);
    }
    ctx.stroke();
  }

  let drawing = false;
  let activePointerId = null;
  let currentPath = [];
  const storedPageHistory = getStoredHistoryForPage();
  let drawHistory = hydrateHistory(storedPageHistory);
  markHistoryDirty();
  let redoHistory = [];
  let currentShape = 'freeform'; // Тип фигуры: 'freeform', 'circle', 'square', 'triangle', 'arrow', 'line', 'text'
  let startX, startY;

  // --- helpers: сделайте единую функцию, чтобы не дублировать
  function hydrateHistory(raw) {
    return raw.map(item => {
      let container = null;
      if (item.containerRef === 'root') {
        container = document.documentElement;
      } else {
        if (item.containerRef) {
          const selector = `[data-webdraw-id="${escapeAttributeValue(item.containerRef)}"]`;
          container = document.querySelector(selector);
        }
        if (!container && item.containerPath) {
          container = resolveContainerByPath(item.containerPath);
          if (container && item.containerRef) {
            container.dataset.webdrawId = item.containerRef;
          }
        }
      }

      const normalized = normalizeContainer(container || document.documentElement);
      const entry = {
        ...item,
        containerId: normalized,
      };
      entry.containerPath =
        item.containerPath ||
        (normalized === document.documentElement ? null : buildContainerPath(normalized));
      if (normalized !== document.documentElement) {
        ensureContainerIdentifier(normalized, item.containerRef);
      }
      entry.bounds = item.bounds || calculateBounds(entry);
      return entry;
    });
  }

  function toContainerCoords(e, cont) {
    cont = normalizeContainer(cont);
    const rect = cont.getBoundingClientRect();

    /* базовые page-координаты относительно левого-верхнего угла документа */
    let x = e.pageX - (rect.left + window.scrollX);
    let y = e.pageY - (rect.top  + window.scrollY);

    /* для всех, кроме <html>, нужно учесть собственную прокрутку контейнера */
    if (cont !== document.documentElement) {
      x += cont.scrollLeft;
      y += cont.scrollTop;
    }
    /*  у <html> cont.scrollLeft == window.scrollX, но мы его уже вычли,       *
     *  добавлять ещё раз нельзя — именно это и давало постоянный сдвиг       */

    return { x, y };
  }

  function pageToContainer(pageX, pageY, cont) {
    cont = normalizeContainer(cont);
    const rect = cont.getBoundingClientRect();
    let x = pageX - (rect.left + window.scrollX);
    let y = pageY - (rect.top  + window.scrollY);
    if (cont !== document.documentElement) {
      x += cont.scrollLeft;
      y += cont.scrollTop;
    }
    return { x, y };
  }

  function pagePointToViewport(point) {
    return {
      x: point.x - window.scrollX,
      y: point.y - window.scrollY,
    };
  }

  function pageElementFromPoint(clientX, clientY) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    return document.elementsFromPoint(clientX, clientY).find(node =>
      !node.closest('#webdraw-overlay-root, #control-panel, #textInput')
    ) || null;
  }

  function containerFromClientPoint(clientX, clientY) {
    const hit = pageElementFromPoint(clientX, clientY);
    return hit ? getDrawContainer(hit) : null;
  }

  function computePageBounds(shape, start, end, path, width) {
    if (!start) return null;
    const thickness = Number(width) || 1;
    const padding = shape === 'highlight' ? thickness : thickness * 0.5;

    if (shape === 'freeform' || shape === 'highlight') {
      const points = (path && path.length ? path : [start]).filter(Boolean);
      if (points.length === 0) return null;
      let minX = points[0].x;
      let maxX = points[0].x;
      let minY = points[0].y;
      let maxY = points[0].y;
      for (let i = 1; i < points.length; i += 1) {
        const pt = points[i];
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
      return {
        minX: minX - padding,
        minY: minY - padding,
        maxX: maxX + padding,
        maxY: maxY + padding,
      };
    }

    if (!end) return {
      minX: start.x - padding,
      maxX: start.x + padding,
      minY: start.y - padding,
      maxY: start.y + padding,
    };

    if (shape === 'circle') {
      const radius = Math.sqrt(
        Math.pow(end.x - start.x, 2) +
        Math.pow(end.y - start.y, 2)
      ) + padding;
      return {
        minX: start.x - radius,
        minY: start.y - radius,
        maxX: start.x + radius,
        maxY: start.y + radius,
      };
    }

    if (shape === 'triangle') {
      const mirroredX = 2 * start.x - end.x;
      const minX = Math.min(start.x, end.x, mirroredX);
      const maxX = Math.max(start.x, end.x, mirroredX);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      return {
        minX: minX - padding,
        minY: minY - padding,
        maxX: maxX + padding,
        maxY: maxY + padding,
      };
    }

    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  }

  function enrichContainersFromBounds(bounds, targetSet) {
    if (!bounds || !targetSet) return;
    const SAMPLE_STEPS = 4;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const safeWidth = Number.isFinite(width) ? width : 0;
    const safeHeight = Number.isFinite(height) ? height : 0;

    for (let ix = 0; ix <= SAMPLE_STEPS; ix += 1) {
      const ratioX = SAMPLE_STEPS === 0 ? 0 : ix / SAMPLE_STEPS;
      const sampleX = bounds.minX + safeWidth * ratioX;
      for (let iy = 0; iy <= SAMPLE_STEPS; iy += 1) {
        const ratioY = SAMPLE_STEPS === 0 ? 0 : iy / SAMPLE_STEPS;
        const sampleY = bounds.minY + safeHeight * ratioY;
        if (!Number.isFinite(sampleX) || !Number.isFinite(sampleY)) continue;
        const clientX = sampleX - window.scrollX;
        const clientY = sampleY - window.scrollY;
        if (clientX < 0 || clientY < 0 ||
            clientX > (window.innerWidth || document.documentElement.clientWidth || 0) ||
            clientY > (window.innerHeight || document.documentElement.clientHeight || 0)) {
          continue;
        }
        const container = containerFromClientPoint(clientX, clientY);
        if (container) targetSet.add(container);
      }
    }

    const viewMinX = window.scrollX;
    const viewMaxX = viewMinX + (window.innerWidth || document.documentElement.clientWidth || 0);
    const viewMinY = window.scrollY;
    const viewMaxY = viewMinY + (window.innerHeight || document.documentElement.clientHeight || 0);

  if (bounds.minX < viewMinX || bounds.maxX > viewMaxX ||
      bounds.minY < viewMinY || bounds.maxY > viewMaxY) {
    targetSet.add(document.documentElement);
  }
}

  function isScrollableContainer(elem) {
    elem = normalizeContainer(elem);
    if (!elem || elem === document.documentElement) return false;
    const st = getComputedStyle(elem);
    const overflow = `${st.overflow || ''}${st.overflowX || ''}${st.overflowY || ''}`;
    return /(auto|scroll|overlay)/.test(overflow);
  }

  function computeContainerPriority(container) {
    container = normalizeContainer(container);
    let depth = 0;
    let node = container;
    while (node && node !== document.documentElement && node.parentElement) {
      depth += 1;
      node = node.parentElement;
    }
    const bonus = isScrollableContainer(container) ? 100 : 0;
    const base = container === document.documentElement ? 0 : 1;
    return depth * 1000 + bonus + base;
  }

  function getContainerPageRect(container) {
    if (!container) return null;
    container = normalizeContainer(container);
    if (container === document.documentElement) {
      const left = window.scrollX || window.pageXOffset || 0;
      const top = window.scrollY || window.pageYOffset || 0;
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      const height = window.innerHeight || document.documentElement.clientHeight || 0;
      return {
        left,
        top,
        right: left + width,
        bottom: top + height,
      };
    }

    if (!container.getBoundingClientRect) return null;
    const rect = container.getBoundingClientRect();
    const left = rect.left + (window.scrollX || window.pageXOffset || 0);
    const top = rect.top + (window.scrollY || window.pageYOffset || 0);
    return {
      left,
      top,
      right: left + rect.width,
      bottom: top + rect.height,
    };
  }

  function rectWidth(rect) {
    return rect ? rect.right - rect.left : 0;
  }

  function rectHeight(rect) {
    return rect ? rect.bottom - rect.top : 0;
  }

  function subtractRect(base, clip) {
    if (!base || !clip) return base ? [base] : [];
    const intersectLeft = Math.max(base.left, clip.left);
    const intersectTop = Math.max(base.top, clip.top);
    const intersectRight = Math.min(base.right, clip.right);
    const intersectBottom = Math.min(base.bottom, clip.bottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      return [base];
    }

    const pieces = [];
    if (base.top < intersectTop) {
      pieces.push({
        left: base.left,
        top: base.top,
        right: base.right,
        bottom: intersectTop,
      });
    }
    if (intersectBottom < base.bottom) {
      pieces.push({
        left: base.left,
        top: intersectBottom,
        right: base.right,
        bottom: base.bottom,
      });
    }
    if (base.left < intersectLeft) {
      pieces.push({
        left: base.left,
        top: intersectTop,
        right: intersectLeft,
        bottom: intersectBottom,
      });
    }
    if (intersectRight < base.right) {
      pieces.push({
        left: intersectRight,
        top: intersectTop,
        right: base.right,
        bottom: intersectBottom,
      });
    }

    return pieces.filter(rect => rectWidth(rect) > 0 && rectHeight(rect) > 0);
  }

  function subtractRects(bases, clips) {
    if (!Array.isArray(bases) || bases.length === 0) return [];
    if (!Array.isArray(clips) || clips.length === 0) return bases.slice();
    let current = bases.slice();
    clips.forEach(clip => {
      const next = [];
      current.forEach(base => {
        next.push(...subtractRect(base, clip));
      });
      current = next;
    });
    return current;
  }

  function clipSegmentToRect(p0, p1, rect) {
    if (!rect) return null;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    let t0 = 0;
    let t1 = 1;
    const checks = [
      { p: -dx, q: p0.x - rect.left },
      { p: dx, q: rect.right - p0.x },
      { p: -dy, q: p0.y - rect.top },
      { p: dy, q: rect.bottom - p0.y },
    ];

    const EPS = 1e-9;
    for (let i = 0; i < checks.length; i += 1) {
      const { p, q } = checks[i];
      if (Math.abs(p) < EPS) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }

    if (t0 > t1) return null;

    const start = {
      x: p0.x + dx * t0,
      y: p0.y + dy * t0,
    };
    const end = {
      x: p0.x + dx * t1,
      y: p0.y + dy * t1,
    };

    return { start, end, t0, t1 };
  }

  function clipPolylineToRects(polyline, rects) {
    if (!polyline || polyline.length < 2 || !Array.isArray(rects) || rects.length === 0) {
      return [];
    }

    const results = [];
    let currentChunk = null;
    const EPS = 1e-6;

    for (let i = 0; i < polyline.length - 1; i += 1) {
      const p0 = polyline[i];
      const p1 = polyline[i + 1];
      const segments = [];

      rects.forEach(rect => {
        const clipped = clipSegmentToRect(p0, p1, rect);
        if (clipped) segments.push(clipped);
      });

      if (segments.length === 0) {
        if (currentChunk && currentChunk.length >= 2) {
          results.push(currentChunk);
        }
        currentChunk = null;
        continue;
      }

      segments.sort((a, b) => a.t0 - b.t0);
      segments.forEach(seg => {
        if (!currentChunk) {
          currentChunk = [seg.start];
        } else {
          const last = currentChunk[currentChunk.length - 1];
          const dx = seg.start.x - last.x;
          const dy = seg.start.y - last.y;
          if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
            results.push(currentChunk);
            currentChunk = [seg.start];
          }
        }
        currentChunk.push(seg.end);
      });
    }

    if (currentChunk && currentChunk.length >= 2) {
      results.push(currentChunk);
    }
    return results;
  }

  function dedupeSequentialPoints(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const deduped = [points[0]];
    const EPS = 1e-6;
    for (let i = 1; i < points.length; i += 1) {
      const prev = deduped[deduped.length - 1];
      const curr = points[i];
      if (Math.abs(prev.x - curr.x) < EPS && Math.abs(prev.y - curr.y) < EPS) continue;
      deduped.push(curr);
    }
    return deduped;
  }

  function buildShapePolylines(details) {
    const { shape, start, end, path, width } = details;
    if (shape === 'freeform' || shape === 'highlight') {
      return path && path.length ? [path.slice()] : [];
    }

    if (!start || !end) return [];
    const polylines = [];

    if (shape === 'line' || shape === 'arrow') {
      polylines.push([start, end]);
      if (shape === 'arrow') {
        const thickness = Number(width) || 1;
        const headlen = Math.max(20, thickness * 4);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const p1 = {
          x: end.x - headlen * Math.cos(angle - Math.PI / 7),
          y: end.y - headlen * Math.sin(angle - Math.PI / 7),
        };
        const p2 = {
          x: end.x - headlen * Math.cos(angle + Math.PI / 7),
          y: end.y - headlen * Math.sin(angle + Math.PI / 7),
        };
        polylines.push([end, p1]);
        polylines.push([end, p2]);
      }
      return polylines;
    }

    if (shape === 'square') {
      const topLeft = start;
      const bottomRight = end;
      const other = {
        x: bottomRight.x,
        y: topLeft.y,
      };
      const other2 = {
        x: topLeft.x,
        y: bottomRight.y,
      };
      polylines.push([topLeft, other, bottomRight, other2, topLeft]);
      return polylines;
    }

    if (shape === 'triangle') {
      const mirroredX = 2 * start.x - end.x;
      const apex = { x: mirroredX, y: end.y };
      polylines.push([start, end, apex, start]);
      return polylines;
    }

    if (shape === 'circle') {
      const radius = Math.sqrt(
        Math.pow(end.x - start.x, 2) +
        Math.pow(end.y - start.y, 2)
      );
      if (!Number.isFinite(radius) || radius <= 0) return [];
      const segments = 48;
      const points = [];
      for (let i = 0; i <= segments; i += 1) {
        const t = (i / segments) * Math.PI * 2;
        points.push({
          x: start.x + radius * Math.cos(t),
          y: start.y + radius * Math.sin(t),
        });
      }
      polylines.push(points);
      return polylines;
    }

    return [];
  }

  // Функция начала рисования
  function startDrawing(e) {
    if (isDrawingControl(e.target) || drawing || (e.button !== undefined && e.button !== 0) || e.isPrimary === false) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const hit = pageElementFromPoint(e.clientX, e.clientY) || document.documentElement;

    if (currentShape === 'text') {
      activeContainer = getDrawContainer(hit);
      activeState = ensureCanvas(activeContainer);
      refreshStateMetrics(activeState);
      const { x: textX, y: textY } = toContainerCoords(e, activeContainer);
      addTextToCanvas(e, activeContainer, textX, textY);
      return;
    }

    lockScroll();
    const preview = activatePreviewCanvas();
    ctx = preview.ctx;
    clearPreviewCanvas();
    strokeSmoothing = getSmoothingStrength();
    strokeColor = siteStorage.getItem('currentColor') || '#FF0000';
    strokeWidth = getCurrentThickness();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth * (currentShape === 'highlight' ? 2 : 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Avoid transparent freehand segment intersections looking darker.
    preview.canvas.style.opacity = currentShape === 'highlight' ? '0.3' : '1';

    activeContainer = getDrawContainer(hit);
    activeState = ensureCanvas(activeContainer);
    refreshStateMetrics(activeState);

    drawing = true;
    activePointerId = e.pointerId;
    try { ensureOverlayRoot().setPointerCapture(e.pointerId); } catch (_) {}
    startPagePoint = { x: e.pageX, y: e.pageY };
    lastPagePoint = { ...startPagePoint };
    currentPath = [{ x: startPagePoint.x, y: startPagePoint.y }];
    filteredPoint = { ...startPagePoint };
    lastRawPoint = { ...startPagePoint };
    containersDuringDraw = new Set();
    if (activeContainer) containersDuringDraw.add(activeContainer);
    const startInActive = pageToContainer(startPagePoint.x, startPagePoint.y, activeContainer);
    startX = startInActive.x;
    startY = startInActive.y;
    redoHistory = [];
    if (currentShape === 'freeform' || currentShape === 'highlight') {
      // Show contact immediately, including a click without a pointermove.
      ctx.beginPath();
      ctx.moveTo(e.clientX, e.clientY);
      ctx.lineTo(e.clientX + 0.01, e.clientY);
      ctx.stroke();
    }
  }

  function draw(e) {
    if (!drawing || !ctx || e.pointerId !== activePointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    if (currentShape === 'freeform' || currentShape === 'highlight') {
      // Chrome may combine multiple pointer samples into one pointermove.
      // Reuse them when available; avoid processing a duplicate last point.
      let samples = [];
      if (typeof e.getCoalescedEvents === 'function') {
        try { samples = e.getCoalescedEvents() || []; } catch (_) { samples = []; }
      }
      if (!samples.length) samples = [e];
      const last = samples[samples.length - 1];
      if (!last || last.pageX !== e.pageX || last.pageY !== e.pageY) {
        samples = [...samples, e];
      }
      for (const sample of samples) {
        if (!Number.isFinite(sample.pageX) || !Number.isFinite(sample.pageY)) continue;
        const point = smoothIncomingPoint({ x: sample.pageX, y: sample.pageY });
        if (!point) continue;
        const previous = currentPath[currentPath.length - 1];
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.12) {
          continue;
        }
        currentPath.push({ x: point.x, y: point.y });
        drawLiveSegment();
      }
      lastPagePoint = { x: e.pageX, y: e.pageY };
      return;
    }

    // Geometric shapes are left unchanged and should not be smoothed.
    const currentPage = { x: e.pageX, y: e.pageY };
    lastPagePoint = { ...currentPage };
    clearPreviewCanvas();
    const startViewport = pagePointToViewport(startPagePoint);
    const currentViewport = pagePointToViewport(currentPage);

    if (currentShape === 'circle') {
      const radius = Math.hypot(currentPage.x - startPagePoint.x,
                                currentPage.y - startPagePoint.y);
      ctx.beginPath();
      ctx.arc(startViewport.x, startViewport.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (currentShape === 'square') {
      ctx.beginPath();
      ctx.rect(startViewport.x, startViewport.y,
               currentViewport.x - startViewport.x,
               currentViewport.y - startViewport.y);
      ctx.stroke();
    } else if (currentShape === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(startViewport.x, startViewport.y);
      ctx.lineTo(currentViewport.x, currentViewport.y);
      ctx.lineTo(2 * startViewport.x - currentViewport.x, currentViewport.y);
      ctx.closePath();
      ctx.stroke();
    } else if (currentShape === 'arrow') {
      drawArrow(ctx, startViewport.x, startViewport.y,
                currentViewport.x, currentViewport.y, ctx.lineWidth);
    } else if (currentShape === 'line') {
      ctx.beginPath();
      ctx.moveTo(startViewport.x, startViewport.y);
      ctx.lineTo(currentViewport.x, currentViewport.y);
      ctx.stroke();
    }
  }

  function buildEntriesForContainer(container, details, regionRects, allowFullFallback = false) {
    if (!container) return [];
    container = normalizeContainer(container);
    if (!Array.isArray(regionRects) || regionRects.length === 0) {
      return [];
    }

    const { shape, color, width, start, end, path, smooth } = details;
    const polylines = buildShapePolylines({ shape, start, end, path, width });
    if (!polylines.length) return [];

    const isHighlight = shape === 'highlight';
    const targetShape = isHighlight ? 'highlight' : 'freeform';
    const produced = [];
    const chunks = [];

    polylines.forEach(polyline => {
      const clipped = clipPolylineToRects(polyline, regionRects);
      clipped.forEach(chunk => {
        const cleaned = dedupeSequentialPoints(chunk);
        if (cleaned.length < 2) return;
        const points = cleaned.map(point => pageToContainer(point.x, point.y, container));
        if (points.length === 1) {
          points.push({ ...points[0] });
        }
        chunks.push(points);
      });
    });

    if (isHighlight && chunks.length > 0) {
      const merged = [];
      chunks.forEach((segment, index) => {
        if (!segment || segment.length === 0) return;
        if (merged.length > 0) merged.push(null);
        merged.push(...segment);
      });
      if (merged.length >= 2) {
        produced.push({
          containerId: container,
          shape: 'highlight',
          color,
          width,
          smooth: Boolean(smooth),
          points: merged,
        });
      }
    }

    if (!isHighlight) {
      chunks.forEach(points => {
        produced.push({
          containerId: container,
          shape: targetShape,
          color,
          width,
          smooth: Boolean(smooth),
          points,
        });
      });
    }

    if (allowFullFallback && produced.length === 0 && (shape === 'freeform' || shape === 'highlight') && path && path.length) {
      const points = path.map(point => pageToContainer(point.x, point.y, container));
      if (points.length >= 2) {
        produced.push({
          containerId: container,
          shape,
          color,
          width,
          smooth: Boolean(smooth),
          points,
        });
      }
    }

    return produced;
  }

  // Функция рисования стрелки
  function drawArrow(context, fromx, fromy, tox, toy, thickness) {
    const headlen = Math.max(20, thickness * 4); // Настраиваем длину наконечника стрелки в зависимости от толщины
    const angle = Math.atan2(toy - fromy, tox - fromx);

    context.beginPath();
    context.moveTo(fromx, fromy);
    context.lineTo(tox, toy);
    context.stroke();

    context.beginPath();
    context.moveTo(
      tox - headlen * Math.cos(angle - Math.PI / 7),
      toy - headlen * Math.sin(angle - Math.PI / 7)
    );

    context.lineTo(tox, toy);

    context.lineTo(
      tox - headlen * Math.cos(angle + Math.PI / 7),
      toy - headlen * Math.sin(angle + Math.PI / 7)
    );
    context.stroke();
  }

  // Функция добавления текста
  function addTextToCanvas(e, container, textX, textY) {
    // если на странице уже есть активное текстовое поле — сначала
    // «сфокусируем» blur, чтобы его onBlur → finalizeText отработали
    const old = document.getElementById('textInput');
    if (old) old.blur();          // blur вызовет finalizeText и самоудаление

    // удаляем старый и создаём host
    const host = ensureOverlayRoot();

    const input = document.createElement('input');
    input.id   = 'textInput';
    input.type = 'text';

    // сохраняем координаты для finalizeText
    input.dataset.textX = textX;
    input.dataset.textY = textY;

    input.style.position = 'fixed';
    input.style.left     = `${e.clientX}px`;
    input.style.top      = `${e.clientY}px`;
    input.style.fontSize = `${siteStorage.getItem('currentFontSize') || 16}px`;
    input.style.fontFamily = siteStorage.getItem('currentFontFamily') || 'Arial, sans-serif';
    input.style.color = siteStorage.getItem('currentColor') || '#FF0000';
    input.style.border = '1px solid #000';
    input.style.backgroundColor = 'rgba(255, 255, 255, 0.7)';
    input.style.zIndex = '10001'; // Обеспечиваем отображение поверх canvas
    input.style.padding = '2px';
    input.style.outline = 'none';
    input.style.boxShadow = '0 0 5px rgba(0, 0, 0, 0.2)';
    input.style.width = '200px';

    // Сохраняем текст при нажатии Enter
    const onEnter = (e) => {
      if (e.key === 'Enter') {
        input.removeEventListener('keydown', onEnter);
        input.removeEventListener('blur', onBlur);
        finalizeText(input, container);
      }
    };
    input.addEventListener('keydown', onEnter);

    // Отложенная обработка события blur при клике мышью
    let ignoreBlur = false;

    input.addEventListener('mousedown', function () {
        ignoreBlur = true;
    });

    input.addEventListener('mouseup', function () {
        ignoreBlur = false;
        input.focus(); // Продолжаем фокусировку
    });

    input.addEventListener('blur', onBlur);

    function onBlur() {
      if (!ignoreBlur) {
        input.removeEventListener('keydown', onEnter);
        input.removeEventListener('blur', onBlur);
        finalizeText(input, container);
      }
    }

    // Добавляем текстовое поле на страницу
    host.appendChild(input);

    // Автоматически устанавливаем фокус
    setTimeout(() => input.focus(), 100);
  }

  // Функция завершения добавления текста
  function finalizeText(input, container) {
    if (input.dataset.finalized) return;       // уже отработали
    input.dataset.finalized = 'true';

    const text = input.value.trim();
    if (text) {
      // Вместо вычислений через getBoundingClientRect — читаем сохранённые координаты:
      const x = parseFloat(input.dataset.textX);
      const y = parseFloat(input.dataset.textY);
      const computed = window.getComputedStyle(input);
      const paddingLeft = parseFloat(computed.paddingLeft) || 0;
      const paddingTop = parseFloat(computed.paddingTop) || 0;
      const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
      const borderTop = parseFloat(computed.borderTopWidth) || 0;
      const adjustedX = x + paddingLeft + borderLeft;
      const adjustedY = y + paddingTop + borderTop;

      drawHistory.push(createHistoryEntry({
        containerId: container,
        shape: 'text',
        text,
        x: adjustedX,
        y: adjustedY,
        font:   input.style.fontSize + ' ' + input.style.fontFamily,
        color:  input.style.color,
      }));
      markHistoryDirty();
      persistHistory();
      const state = ensureCanvas(container);
      scheduleStateRedraw(state, 'full');
    }
    // удаляем только если всё ещё в DOM
    if (input.isConnected) input.remove();
  }

  // Функция перерисовки рисунков
  function redraw(targetContainer) {
    if (targetContainer) {
      const state = ensureCanvas(targetContainer);
      scheduleStateRedraw(state, 'full');
      return;
    }

    const containers = new Set();
    drawHistory.forEach(entry => {
      containers.add(entry.containerId || document.documentElement);
    });

    containers.forEach(container => {
      const state = ensureCanvas(container);
      scheduleStateRedraw(state, 'full');
    });

    canvasMap.forEach((state, container) => {
      if (containers.has(container)) return;
      state.baseCtx.clearRect(0, 0, state.width, state.height);
    });
  }

  let historySaveTimer = null;
  let historySaveIdle = null;
  let historySavePending = false;

  function persistHistory() {
    historySavePending = true;
    if (historySaveTimer !== null) clearTimeout(historySaveTimer);
    if (historySaveIdle !== null) {
      cancelIdleCallback(historySaveIdle);
      historySaveIdle = null;
    }
    historySaveTimer = setTimeout(() => {
      historySaveTimer = null;
      if (drawing) { persistHistory(); return; }
      if (typeof requestIdleCallback === 'function') {
        historySaveIdle = requestIdleCallback(() => {
          historySaveIdle = null;
          if (drawing) persistHistory();
          else flushHistory();
        }, {timeout: 1000});
      } else {
        flushHistory();
      }
    }, 200);
  }

  function flushHistory() {
    if (!historySavePending) return;
    if (historySaveTimer !== null) clearTimeout(historySaveTimer);
    if (historySaveIdle !== null) cancelIdleCallback(historySaveIdle);
    historySaveTimer = historySaveIdle = null;
    historySavePending = false;
    /* выкидываем несериализуемые поля перед сохранением */
    const paths = new Map();
    const plain = drawHistory.map(p => {
        const { containerId, ...rest } = p;
        const container = containerId || document.documentElement;
        const normalized = normalizeContainer(container);
        const containerRef = ensureContainerIdentifier(normalized, rest.containerRef);
        if (containerRef !== 'root' && !paths.has(normalized)) {
          paths.set(normalized, normalized.isConnected ? buildContainerPath(normalized) : rest.containerPath);
        }
        return {
            ...rest,
            bounds: rest.bounds || calculateBounds(p),
            containerRef,
            containerPath: containerRef === 'root' ? null : paths.get(normalized),
        };
    });

    let latestMap = {};
    try {
      const raw = siteStorage.getItem(HISTORY_MAP_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          latestMap = parsed;
        }
      }
    } catch (err) {
      latestMap = {};
    }

    if (plain.length > 0) {
      latestMap[pageHistoryKey] = plain;
    } else {
      delete latestMap[pageHistoryKey];
    }

    /* синхронизируем локальный кэш, чтобы новые чтения видели актуальные данные */
    Object.keys(historyMap).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(latestMap, key)) {
        delete historyMap[key];
      }
    });
    Object.keys(latestMap).forEach(key => {
      historyMap[key] = latestMap[key];
    });

    try {
      siteStorage.setItem(HISTORY_MAP_STORAGE_KEY, JSON.stringify(latestMap));
    } catch (err) {
      // Игнорируем ошибки квоты, чтобы не ломать основной сценарий
      console.warn('WebDraw: failed to persist history for this page', err);
    }
  }

  function flushHiddenHistory() {
    if (document.visibilityState === 'hidden') flushHistory();
  }
  listen(window, 'pagehide', flushHistory);
  listen(document, 'visibilitychange', flushHiddenHistory);

  // Функция завершения рисования
  function stopDrawing(e) {
    if (!drawing || (e && e.pointerId !== activePointerId)) return;
    e?.preventDefault();
    e?.stopImmediatePropagation();
    activePointerId = null;
    const targetIsPanel = e?.target?.closest('#control-panel');
    if (targetIsPanel) {
      drawing = false;
      deactivatePreviewCanvas();
      unlockScroll();
      currentPath = [];
      containersDuringDraw = new Set();
      startPagePoint = null;
      lastPagePoint = null;
      clearPreviewCanvas();
      return;
    }
    drawing = false;

    const containerAtPointer = e
      ? containerFromClientPoint(e.clientX, e.clientY)
      : null;
    if (containerAtPointer) containersDuringDraw.add(containerAtPointer);

    const endPage = e
      ? { x: e.pageX, y: e.pageY }
      : (lastPagePoint || startPagePoint);
    lastPagePoint = endPage ? { ...endPage } : null;
    if ((currentShape === 'freeform' || currentShape === 'highlight') && endPage &&
        currentPath.length > 0) {
      const prev = currentPath[currentPath.length - 1];
      if (Math.hypot(endPage.x - prev.x, endPage.y - prev.y) > 0.25) {
        // Keep a real endpoint after smoothing, otherwise the stroke may
        // appear to stop short of where the user released the mouse.
        currentPath.push({ x: endPage.x, y: endPage.y });
      }
      if (currentPath.length === 1) {
        currentPath.push({x: currentPath[0].x + 0.01, y: currentPath[0].y});
      }
    }

    unlockScroll();

    const color = strokeColor;
    const width = strokeWidth;

    const pageBounds = computePageBounds(
      currentShape,
      startPagePoint,
      endPage,
      currentPath,
      width
    );
    enrichContainersFromBounds(pageBounds, containersDuringDraw);

    const containers = containersDuringDraw && containersDuringDraw.size
      ? Array.from(containersDuringDraw)
      : [activeContainer || document.documentElement];

    const containerInfos = containers
      .map(container => {
        if (!container) return null;
        const rect = getContainerPageRect(container);
        if (!rect || rectWidth(rect) <= 0 || rectHeight(rect) <= 0) return null;
        return {
          container,
          rect,
          priority: computeContainerPriority(container),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority);

    const groupId = `g-${drawSessionCounter + 1}`;
    const entriesToAdd = [];
    const claimedRects = [];
    const shapeDetails = {
      shape: currentShape,
      color,
      width,
      smooth: (currentShape === 'freeform' || currentShape === 'highlight') && strokeSmoothing > 0,
      start: startPagePoint,
      end: endPage,
      path: currentPath,
    };

    containerInfos.forEach(info => {
      const allowFallback = claimedRects.length === 0;
      const availableRegions = subtractRects([info.rect], claimedRects);
      claimedRects.push(info.rect);
      if (!availableRegions.length) return;
      const entryDatas = buildEntriesForContainer(info.container, shapeDetails, availableRegions, allowFallback);
      entryDatas.forEach(entryData => {
        entryData.groupId = groupId;
        const created = createHistoryEntry(entryData);
        created.groupId = groupId;
        entriesToAdd.push({ container: info.container, entry: created });
      });
    });

    if (entriesToAdd.length > 0) {
      drawSessionCounter += 1;
      const affected = new Set();
      entriesToAdd.forEach(({ container, entry }) => {
        drawHistory.push(entry);
        affected.add(container);
      });
      markHistoryDirty();
      affected.forEach(container => {
        const state = ensureCanvas(container);
        // Draw only the new entries. Replaying all history on every pen-up
        // makes the next stroke wait as the annotation history grows.
        const resized = refreshStateMetrics(state);
        if (resized || !state.renderedViewport || state.pendingReason === 'full' ||
            state.renderedViewport.left !== state.viewport.scrollLeft ||
            state.renderedViewport.top !== state.viewport.scrollTop) {
          renderFullViewport(state);
        } else {
          entriesToAdd.forEach(item => {
            if (item.container === container && intersectsViewport(item.entry.bounds, state.viewport)) {
              renderHistoryEntry(state.baseCtx, item.entry, state.viewport);
            }
          });
        }
        state.pendingReason = null;
      });
      persistHistory();
    }

    deactivatePreviewCanvas();
    currentPath = [];
    containersDuringDraw = new Set();
    startPagePoint = null;
    lastPagePoint = null;
  }

  function createShapeButtons() {
    const shapes = [
      { name: 'Freeform', value: 'freeform', icon: 'icons/pencil.png' },
      { name: 'Circle', value: 'circle', icon: 'icons/circle.png' },
      { name: 'Square', value: 'square', icon: 'icons/square.png' },
      { name: 'Triangle', value: 'triangle', icon: 'icons/triangle.png' },
      { name: 'Arrow', value: 'arrow', icon: 'icons/arrow.png' },
      { name: 'Line', value: 'line', icon: 'icons/line.png' },
      { name: 'Text', value: 'text', icon: 'icons/text.png' },
      { name: 'Highlight', value: 'highlight', icon: 'icons/highlight.png' }
    ];

    const shapeContainer = document.createElement('div');
    shapeContainer.id = 'shape-container';
    shapeContainer.style.display = 'flex';
    shapeContainer.style.gap = '5px';

    shapes.forEach(shape => {
      const shapeButton = document.createElement('button');
      shapeButton.style.background = `url(${chrome.runtime.getURL(shape.icon)}) no-repeat center`;
      shapeButton.style.backgroundSize = 'contain';
      shapeButton.style.width = '25px';
      shapeButton.style.height = '25px';
      shapeButton.style.border = 'none';
      shapeButton.style.cursor = 'pointer';
      shapeButton.title = shape.name;
      shapeButton.dataset.shape = shape.value; // Добавляем данные атрибуты для каждой кнопки
      shapeButton.addEventListener('click', () => {
        currentShape = shape.value;
        updateActiveShape(shapeButton);
      });
      shapeContainer.appendChild(shapeButton);
    });

    document.getElementById('control-panel').appendChild(shapeContainer);

    // По умолчанию выбираем Freeform
    const defaultButton = shapeContainer.querySelector('button[data-shape="freeform"]');
    if (defaultButton) {
      updateActiveShape(defaultButton);
    }
  }

  // Функция обновления активной фигуры
  function updateActiveShape(activeButton) {
    document.querySelectorAll('#shape-container button').forEach(button => {
      button.classList.remove('active-shape');
    });

    activeButton.classList.add('active-shape');
  }

  // Стили для кнопок формы
  document.getElementById('webdraw-shape-style')?.remove();
  const style = document.createElement('style');
  style.id = 'webdraw-shape-style';
  style.innerHTML = `
    .active-shape {
      border: 2px solid #fff;              /* Граница выбранной кнопки */
      background-color: rgba(255,255,255,.2);
    }

    /* --- аккуратный "антиресет": возвращаем вид только INPUT / SELECT --- */
    #control-panel input[type="range"],
    #control-panel input[type="color"],
    #control-panel input[type="number"],
    #control-panel select {
        -webkit-appearance: auto !important; /* отменяем page-reset */
                appearance: auto !important;
    }

    /* прежние размеры — без изменения темы */
    #control-panel input[type="range"]  { width:160px; }
    #control-panel input[type="color"]  { width:30px;height:30px;padding:0;border:none; }
  `;
  document.head.appendChild(style);

  const initializeDefaultShape = () => {
    const defaultButton = document.querySelector('button[data-shape="freeform"]');
    if (defaultButton) updateActiveShape(defaultButton);
  };
  if (document.readyState === 'loading') {
    listen(document, 'DOMContentLoaded', initializeDefaultShape, { once: true });
  } else {
    initializeDefaultShape();
  }

  // Функция создания кнопок выбора цвета
  function createFavoriteColorButtons() {
    chrome.storage.sync.get('favColors', ({ favColors }) => {
      const colors = favColors || ['#FF0000', '#00FF00', '#0000FF'];
      const colorContainer = document.createElement('div');
      colorContainer.id = 'color-container';
      colorContainer.style.display = 'flex';
      colorContainer.style.gap = '5px';

      colors.forEach(color => {
        const colorButton = document.createElement('button');
        colorButton.style.background = color;
        colorButton.style.width = '30px';
        colorButton.style.height = '30px';
        colorButton.style.border = '2px solid #fff';
        colorButton.style.borderRadius = '50%';
        colorButton.style.cursor = 'pointer';
        colorButton.addEventListener('click', () => {
          siteStorage.setItem('currentColor', color);
        });
        colorContainer.appendChild(colorButton);
      });

      document.getElementById('control-panel').appendChild(colorContainer);
    });
  }

  // Добавляем выбор шрифта и размера в выпадающее меню
  function createFontOptions(dropdownMenu) {
    const fontContainer = document.createElement('div');
    fontContainer.id = 'font-container';
    fontContainer.style.display = 'flex';
    fontContainer.style.flexDirection = 'column';
    fontContainer.style.gap = '5px';

    const fontFamilies = ['Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia'];
    const fontSizeRange = { min: 8, max: 72 };

    const fontFamilySelect = document.createElement('select');
    fontFamilies.forEach(font => {
      const option = document.createElement('option');
      option.value = font;
      option.textContent = font;
      fontFamilySelect.appendChild(option);
    });
    fontFamilySelect.classList.add('action-picker');
    fontFamilySelect.addEventListener('change', () => {
      siteStorage.setItem('currentFontFamily', fontFamilySelect.value);
    });

    const fontSizeInput = document.createElement('input');
    fontSizeInput.type = 'number';
    fontSizeInput.min = fontSizeRange.min;
    fontSizeInput.max = fontSizeRange.max;
    fontSizeInput.value = siteStorage.getItem('currentFontSize') || 16;
    fontSizeInput.classList.add('action-picker');
    fontSizeInput.addEventListener('input', () => {
      siteStorage.setItem('currentFontSize', fontSizeInput.value);
    });

    fontContainer.appendChild(fontFamilySelect);
    fontContainer.appendChild(fontSizeInput);

    dropdownMenu.appendChild(fontContainer);
  }

  function createFeedbackWidget(dropdownMenu) {
    const feedbackContainer = document.createElement('div');
    feedbackContainer.id = 'feedback-widget';

    const divider = document.createElement('hr');
    divider.classList.add('feedback-divider');

    const title = document.createElement('p');
    title.classList.add('feedback-title');
    title.textContent = 'Rate us:';

    const starsWrapper = document.createElement('div');
    starsWrapper.classList.add('feedback-stars');

    const starSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512">
        <path
          d="M259.3 17.8L194 150.2 47.9 171.5c-26.2 3.8-36.7 36.1-17.7 54.6l105.7 103-25 145.5c-4.5 26.3 23.2 46 46.4 33.7L288 439.6l130.7 68.7c23.2 12.2 50.9-7.4 46.4-33.7l-25-145.5 105.7-103c19-18.5 8.5-50.8-17.7-54.6L382 150.2 316.7 17.8c-11.7-23.6-45.6-23.9-57.4 0z"
        />
      </svg>
    `;

    const stars = [
      {
        href: 'https://docs.google.com/forms/d/e/1FAIpQLSd2NcEEtBMJJO7Fq0F1FiTmZrIyM0Spgjs-w6dkND5G1hicQQ/viewform',
        ariaLabel: 'Rate 1 star'
      },
      {
        href: 'https://docs.google.com/forms/d/e/1FAIpQLSd2NcEEtBMJJO7Fq0F1FiTmZrIyM0Spgjs-w6dkND5G1hicQQ/viewform',
        ariaLabel: 'Rate 2 stars'
      },
      {
        href: 'https://docs.google.com/forms/d/e/1FAIpQLSd2NcEEtBMJJO7Fq0F1FiTmZrIyM0Spgjs-w6dkND5G1hicQQ/viewform',
        ariaLabel: 'Rate 3 stars'
      },
      {
        href: 'https://chromewebstore.google.com/detail/annotate-web/njfokngnhkjhcdnepoaleidpgagmcjbj/reviews',
        ariaLabel: 'Rate 4 stars'
      },
      {
        href: 'https://chromewebstore.google.com/detail/annotate-web/njfokngnhkjhcdnepoaleidpgagmcjbj/reviews',
        ariaLabel: 'Rate 5 stars'
      }
    ];

    stars.forEach(({ href, ariaLabel }) => {
      const starLink = document.createElement('a');
      starLink.href = href;
      starLink.target = '_blank';
      starLink.rel = 'noopener noreferrer';
      starLink.classList.add('feedback-star');
      starLink.setAttribute('aria-label', ariaLabel);
      starLink.innerHTML = starSvg;
      starsWrapper.appendChild(starLink);
    });

    feedbackContainer.appendChild(divider);
    feedbackContainer.appendChild(title);
    feedbackContainer.appendChild(starsWrapper);
    dropdownMenu.appendChild(feedbackContainer);
  }

  function maybeAttachFeedbackWidget(dropdownMenu) {
    const hasWidgetInDom = () =>
      Boolean(dropdownMenu.querySelector('#feedback-widget'));

    const markSessionDisplayed = () => {
      window.webDrawFeedbackShownThisSession = true;
    };

    const shownThisSession = () =>
      Boolean(window.webDrawFeedbackShownThisSession);

    const ensureWidget = () => {
      if (hasWidgetInDom()) return false;
      createFeedbackWidget(dropdownMenu);
      dropdownMenu.dataset.feedbackWidgetState = 'ready';
      return true;
    };

    const showOncePerSession = () => {
      if (shownThisSession()) return;
      if (ensureWidget()) {
        markSessionDisplayed();
      }
    };

    let storageAvailable = true;
    try {
      storageAvailable = Boolean(chrome?.storage?.local);
    } catch (err) {
      storageAvailable = false;
    }

    if (!storageAvailable) {
      showOncePerSession();
      return;
    }

    chrome.storage.local.get(
      { feedbackDisplayCount: 0 },
      (stored) => {
        if (chrome.runtime?.lastError) {
          showOncePerSession();
          return;
        }

        const rawValue = stored?.feedbackDisplayCount;
        let currentCount = 0;
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          currentCount = rawValue;
        } else {
          const parsed = Number.parseInt(rawValue, 10);
          if (Number.isFinite(parsed)) currentCount = parsed;
        }

        const nextCount = currentCount + 1;
        const shouldShow = nextCount % 10 === 0;

        chrome.storage.local.set(
          { feedbackDisplayCount: nextCount },
          () => {
            if (chrome.runtime?.lastError) {
              showOncePerSession();
              return;
            }

            if (shouldShow && ensureWidget()) {
              markSessionDisplayed();
            }
          }
        );
      }
    );
  }

  // Функция отмены последнего рисования
  function undoLastDraw() {
    if (drawHistory.length === 0) {
      return;
    }
    const affectedContainers = new Set();
    const lastDraw = drawHistory.pop();
    if (!lastDraw) return;
    const groupId = lastDraw.groupId;
    redoHistory.push(lastDraw);
    affectedContainers.add(lastDraw.containerId || document.documentElement);

    if (groupId) {
      while (drawHistory.length > 0) {
        const peek = drawHistory[drawHistory.length - 1];
        if (peek.groupId !== groupId) break;
        redoHistory.push(drawHistory.pop());
        affectedContainers.add(peek.containerId || document.documentElement);
      }
    }

    markHistoryDirty();
    persistHistory();
    currentPath = [];
    affectedContainers.forEach(container => {
      redraw(container);
    });
  }

  function redoLastDraw() {
    if (redoHistory.length === 0) {
      return;
    }
    const affectedContainers = new Set();
    const lastRedo = redoHistory.pop();
    if (!lastRedo) return;
    if (!lastRedo.bounds) lastRedo.bounds = calculateBounds(lastRedo);
    const groupId = lastRedo.groupId;
    drawHistory.push(lastRedo);
    affectedContainers.add(lastRedo.containerId || document.documentElement);

    if (groupId) {
      while (redoHistory.length > 0) {
        const peek = redoHistory[redoHistory.length - 1];
        if (peek.groupId !== groupId) break;
        const entry = redoHistory.pop();
        if (!entry.bounds) entry.bounds = calculateBounds(entry);
        drawHistory.push(entry);
        affectedContainers.add(entry.containerId || document.documentElement);
      }
    }

    markHistoryDirty();
    persistHistory();
    currentPath = [];
    affectedContainers.forEach(container => {
      redraw(container);
    });
  }

  function clearCanvas() {
    canvasMap.forEach(state => {
      state.baseCtx.clearRect(0, 0, state.width, state.height);
      clearOverlay(state);
      withIdentityTransform(state.cacheCtx, ctx => {
        ctx.clearRect(0, 0, state.cacheCanvas.width, state.cacheCanvas.height);
      });
      state.renderedViewport = null;
      state.entriesCache = null;
      state.entriesCacheVersion = -1;
    });
    drawHistory.length = 0;
    redoHistory.length = 0;
    markHistoryDirty();
    persistHistory();
    redraw();
  }

  function handleResize() {
    canvasMap.forEach(state => {
      refreshStateMetrics(state, true);
      scheduleStateRedraw(state, 'full');
    });
  }

  // Функция создания панели управления
  if (!document.getElementById('control-panel')) {
    const panel = document.createElement('div');
    panel.id = 'control-panel';

    document.body.appendChild(panel);
    createShapeButtons(); // Кнопки формы добавляются после панели
    createFavoriteColorButtons(); // Кнопки выбора цвета добавляются после панели

    const undoRedoContainer = document.createElement('div');
    undoRedoContainer.id = 'undo-redo-container';

    const undoButton = document.createElement('button');
    undoButton.classList.add('action-button', 'small');
    const undoIcon = document.createElement('img');
    undoIcon.src = chrome.runtime.getURL('icons/undo.png');
    undoIcon.classList.add('webdraw-icon', 'webdraw-icon--action');
    undoButton.appendChild(undoIcon);

    const redoButton = document.createElement('button');
    redoButton.classList.add('action-button', 'small');
    const redoIcon = document.createElement('img');
    redoIcon.src = chrome.runtime.getURL('icons/redo.png');
    redoIcon.classList.add('webdraw-icon', 'webdraw-icon--action');
    redoButton.appendChild(redoIcon);

    const clearButton = document.createElement('button');
    clearButton.id = 'clear-button';
    clearButton.classList.add('action-button');
    const clearIcon = document.createElement('img');
    clearIcon.src = chrome.runtime.getURL('icons/clear.png');
    clearIcon.classList.add('webdraw-icon', 'webdraw-icon--action');
    clearButton.appendChild(clearIcon);

    undoButton.addEventListener('click', (e) => {
      undoLastDraw();
      e.stopPropagation();
    });
    redoButton.addEventListener('click', (e) => {
      redoLastDraw();
      e.stopPropagation();
    });
    clearButton.addEventListener('click', (e) => {
      clearCanvas();
      e.stopPropagation();
    });

    undoRedoContainer.appendChild(undoButton);
    undoRedoContainer.appendChild(redoButton);

    panel.appendChild(undoRedoContainer);
    panel.appendChild(clearButton);
    const offButton = document.createElement('button');
    offButton.id = 'webdraw-off-button';
    offButton.className = 'action-button';
    offButton.textContent = 'OFF';
    offButton.title = '주석 끄기 (Esc)';
    offButton.setAttribute('aria-label', '주석 끄기');
    offButton.addEventListener('click', e => {
      e.stopPropagation();
      if (window.__webDrawController) {
        window.__webDrawController.forceOff();
        try { chrome.runtime.sendMessage({type: 'AW_STATE', status: 'off'}, () => { void chrome.runtime.lastError; }); } catch (_) {}
      } else forceOffWebDraw();
    });
    panel.appendChild(offButton);


    const dropdownButton = document.createElement('button');
    dropdownButton.id = 'dropdown-button';
    const dropdownImage = document.createElement('img');
    dropdownImage.src = chrome.runtime.getURL('icons/128x128.png');
    dropdownImage.classList.add('webdraw-icon');
    dropdownButton.appendChild(dropdownImage);

    const dropdownMenu = document.createElement('div');
    dropdownMenu.id = 'dropdown-menu';
    dropdownMenu.style.display = 'none';
    dropdownMenu.style.flexDirection = 'column';
    dropdownMenu.style.gap = '12px';
    dropdownMenu.style.padding = '20px';
    dropdownMenu.style.top = 'auto';
    dropdownMenu.style.bottom = 'calc(100% + 12px)';

    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.classList.add('action-picker');
    colorPicker.value = '#FF0000';

    const thicknessInput = document.createElement('input');
    thicknessInput.type = 'range';
    thicknessInput.min = '1';
    thicknessInput.max = '20';
    thicknessInput.value = siteStorage.getItem('currentThickness') || '3';

    dropdownMenu.appendChild(colorPicker);
    dropdownMenu.appendChild(thicknessInput);

    const smoothLabel = document.createElement('label');
    smoothLabel.style.cssText = 'display:flex;flex-direction:column;gap:5px;min-width:170px;font-size:12px;';
    const smoothingInput = document.createElement('input');
    smoothingInput.type = 'range';
    smoothingInput.min = '0';
    smoothingInput.max = '100';
    smoothingInput.step = '5';
    smoothingInput.value = String(getSmoothingStrength());
    smoothingInput.style.width = '100%';
    const smoothLabelText = document.createElement('span');
    const updateSmoothingLabel = () => {
      smoothLabelText.textContent = `선 보정 (Smoothing): ${smoothingInput.value}%`;
    };
    updateSmoothingLabel();
    smoothingInput.addEventListener('input', () => {
      try { siteStorage.setItem(SMOOTHING_STORAGE_KEY, smoothingInput.value); }
      catch (_) { /* Storage can be unavailable on some pages. */ }
      updateSmoothingLabel();
    });
    smoothLabel.appendChild(smoothLabelText);
    smoothLabel.appendChild(smoothingInput);
    dropdownMenu.appendChild(smoothLabel);

    createFontOptions(dropdownMenu);
    maybeAttachFeedbackWidget(dropdownMenu);

    dropdownButton.addEventListener('click', () => {
      if (dropdownMenu.style.display === 'flex') {
        dropdownMenu.style.display = 'none';
        dropdownButton.classList.remove('open');
        dropdownButton.classList.add('close');

        if (dropdownMenu.dataset.feedbackWidgetState === 'ready') {
          dropdownMenu.querySelector('#feedback-widget')?.remove();
          dropdownMenu.dataset.feedbackWidgetState = 'consumed';
        }
      } else {
        dropdownMenu.style.display = 'flex';
        dropdownButton.classList.remove('close');
        dropdownButton.classList.add('open');
      }
    });

    colorPicker.addEventListener('input', () => {
      siteStorage.setItem('currentColor', colorPicker.value);
    });

    thicknessInput.addEventListener('input', () => {
      siteStorage.setItem('currentThickness', thicknessInput.value);
    });

    panel.appendChild(dropdownButton);
    panel.appendChild(dropdownMenu);
  }

  // Keep the initialized drawing engine in memory between toggles.
  // Activation is then instantaneous; hiding must detach input listeners.
  function attachDrawingListeners() {
    listen(window, 'pointerdown', startDrawing, true);
    listen(window, 'pointermove', draw, true);
    listen(window, 'pointerup', stopDrawing, true);
    listen(window, 'pointercancel', stopDrawing, true);
    listen(window, 'keydown', handleHotkeys, true);
    listen(window, 'resize', handleResize);
    listen(window, 'undoDrawing', undoLastDraw);
    listen(window, 'redoDrawing', redoLastDraw);
    listen(window, 'clearCanvas', clearCanvas);
  }

  function detachDrawingListeners() {
    unlisten(window, 'pointerdown', startDrawing, true);
    unlisten(window, 'pointermove', draw, true);
    unlisten(window, 'pointerup', stopDrawing, true);
    unlisten(window, 'pointercancel', stopDrawing, true);
    unlisten(window, 'keydown', handleHotkeys, true);
    unlisten(window, 'resize', handleResize);
    unlisten(window, 'undoDrawing', undoLastDraw);
    unlisten(window, 'redoDrawing', redoLastDraw);
    unlisten(window, 'clearCanvas', clearCanvas);
  }

  attachDrawingListeners();
  // Allocate the small live buffer before the first pointerdown.
  ensurePreviewCanvas();
  window.webDrawInitialized = true;
  window.webDrawActive = true;
  try { siteStorage.setItem('isDrawingActive', 'true'); } catch (_) {}
  // Pre-warming a previously used site must not block its initial paint
  // with expensive hydration and drawing of saved annotations.
  let savedHistoryDrawn = false;
  if (!window.__webDrawPreloadOnly) {
    redraw();
    savedHistoryDrawn = true;
  }

  /* --- сохранить ссылки для последующего removeEventListener --- */
  window.webDrawStart  = startDrawing;
  window.webDrawMove   = draw;
  window.webDrawStop   = stopDrawing;

  // Fast suspend/resume: retains history, toolbar, canvases and event closures.
  // The DOM is neither destroyed nor re-created during normal toggles.
  function forceOffWebDraw() {
    // Hide and release input first. A history/text cleanup failure cannot veto OFF.
    window.webDrawActive = false;
    for (const id of ['control-panel', 'webdraw-overlay-root']) {
      const node = document.getElementById(id);
      if (node) { node.style.display = 'none'; node.style.pointerEvents = 'none'; }
    }
    safely(() => { drawing = false; });
    safely(() => detachDrawingListeners());
    safely(() => unlockScroll());
    safely(() => unlockInteractions());
    safely(() => document.getElementById('textInput')?.blur());
    safely(() => {
      const root = document.getElementById('webdraw-overlay-root');
      if (activePointerId !== null) root?.releasePointerCapture(activePointerId);
      activePointerId = null;
    });
    safely(() => deactivatePreviewCanvas());
    safely(() => { currentPath = []; containersDuringDraw = new Set(); startPagePoint = lastPagePoint = null; });
    siteStorage.setItem('isDrawingActive', 'false');
    return true;
  }

  function suspendWebDraw() {
    return forceOffWebDraw();
  }

  function resumeWebDraw() {
    if (!window.webDrawInitialized || window.webDrawActive) return false;
    const panel = document.getElementById('control-panel');
    if (!panel || !panel.isConnected) return false; // SPA may have removed it
    const root = document.getElementById('webdraw-overlay-root');
    if (root) root.style.display = '';
    panel.style.display = '';
    panel.style.pointerEvents = '';
    lockStyle.media = 'all';
    attachDrawingListeners();
    lockInteractions();
    window.webDrawActive = true;
    try { siteStorage.setItem('isDrawingActive', 'true'); } catch (_) {}
    // Canvas buffers survive suspension. Avoid full-history redraw on every ON.
    // A prewarmed engine has never painted history, so render it exactly once.
    if (!savedHistoryDrawn) {
      savedHistoryDrawn = true;
      redraw();
    }
    // Scrolling/resizing while OFF must not paint, but ON must catch up.
    canvasMap.forEach(state => scheduleStateRedraw(state, state.pendingReason || 'scroll'));
    ensurePreviewCanvas();
    scheduleOverlayRelayout();
    return true;
  }
  window.webDrawSuspend = suspendWebDraw;
  window.webDrawResume = resumeWebDraw;

  /* --- общая 함수 완전 종료: 오래된 DOM 상태 복구 시에만 사용 --- */
  function disableWebDraw() {
    forceOffWebDraw();
    safely(() => flushHistory());
    for (const item of engineListeners.splice(0)) {
      safely(() => item.target.removeEventListener(item.type, item.handler, item.options));
    }
    safely(() => canvasMap.forEach(state => {
      state.resizeObserver?.disconnect();
      state.baseCanvas.remove();
      state.overlayCanvas.remove();
      state.cacheCanvas.width = state.cacheCanvas.height = 0;
    }));
    safely(() => canvasMap.clear());
    for (const id of ['control-panel', 'webdraw-overlay-root', 'textInput',
      'webdraw-shape-style', 'webdraw-lock-style']) document.getElementById(id)?.remove();
    window.webDrawInitialized = false;
    window.webDrawActive = false;
    window.webDrawSuspend = undefined;
    window.webDrawResume = undefined;
    window.webDrawForceOff = undefined;
  }

  /* делаем доступным из background.js */
  window.webDrawDisable = disableWebDraw;

  /* ---------- горячие клавиши ---------- */
  function handleHotkeys(e) {
    /* ---------------------------------------------------------
       1. Глобальное Undo → выполняем ПЕРВЫМ, пока событие живо
          - срабатывает всегда, кроме «чужих» полей ввода
          - своё временное #textInput не считается "чужим"
    --------------------------------------------------------- */
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey &&
        (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
      const tag = e.target.tagName.toLowerCase();
      const isForeignInput =
        (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) &&
        e.target.id !== 'textInput';                 // наш можно обрабатывать

      if (!isForeignInput) {
        e.preventDefault();
        undoLastDraw();
        return;          // больше ничего не делаем
      }
    }

    /* ---------------------------------------------------------
       2. Остальные сочетания (добавите позже)
       3. Фильтрируем «чужие» поля, чтобы не мешать вводу текста
    --------------------------------------------------------- */
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' ||
        e.target.isContentEditable || e.target.closest('#control-panel')) return;
  }
  if (window.__webDrawPreloadOnly) {
    window.__webDrawPreloadOnly = false;
    suspendWebDraw();
  }
} // The resident controller handles already-initialized documents.
