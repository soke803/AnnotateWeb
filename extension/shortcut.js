// Resident controller v1.2.4: OFF never depends on a connected toolbar or worker.
(() => {
  const VERSION = '1.2.4';
  const previous = window.__webDrawController;
  if (previous?.version === VERSION) return;
  previous?.dispose?.();
  const completed = new Map();
  const runtime = chrome.runtime;

  function status() {
    const panel = document.getElementById('control-panel');
    const root = document.getElementById('webdraw-overlay-root');
    const active = window.webDrawActive === true ||
      Boolean(root && root.style.display !== 'none' && root.style.pointerEvents === 'auto');
    const healthy = Boolean(window.webDrawInitialized && panel?.isConnected && root?.isConnected &&
      typeof window.webDrawSuspend === 'function' && typeof window.webDrawResume === 'function');
    return {version: VERSION, active, healthy};
  }

  function forceOff() {
    // Independent fallbacks: a failed cleanup must never leave input captured.
    for (const action of [
      () => window.webDrawSuspend?.(),
      () => window.webDrawForceOff?.(),
      () => window.webDrawUnlockScroll?.(),
      () => window.webDrawUnlockInteractions?.(),
    ]) { try { action(); } catch (error) { console.warn('Annotate Web OFF cleanup:', error); } }
    for (const id of ['control-panel', 'webdraw-overlay-root', 'textInput']) {
      const node = document.getElementById(id);
      if (node) { node.style.display = 'none'; node.style.pointerEvents = 'none'; }
    }
    const lockStyle = document.getElementById('webdraw-lock-style');
    if (lockStyle) lockStyle.media = 'not all';
    window.webDrawActive = false;
    return 'off';
  }

  function setActive(active) {
    if (!active) return forceOff();
    const state = status();
    if (!state.healthy) return window.webDrawInitialized ? 'broken' : 'cold';
    try {
      if (!state.active && !window.webDrawResume()) return 'broken';
      return status().active ? 'on' : 'broken';
    } catch (error) {
      forceOff();
      console.warn('Annotate Web ON:', error);
      return 'broken';
    }
  }

  function control(op, requestId) {
    if (requestId && completed.has(requestId)) return completed.get(requestId);
    let result;
    if (op === 'status') return status();
    if (op === 'off') result = forceOff();
    else if (op === 'on') result = setActive(true);
    else if (op === 'toggle') result = status().active ? forceOff() : setActive(true);
    else return {version: VERSION, status: 'unsupported'};
    const reply = {version: VERSION, status: result};
    // A worker retry of the same request must not toggle a second time.
    if (requestId && (result === 'on' || result === 'off')) {
      completed.set(requestId, reply);
      if (completed.size > 16) completed.delete(completed.keys().next().value);
    }
    return reply;
  }

  function send(message) {
    try {
      runtime.sendMessage(message, () => { void runtime.lastError; });
    } catch (_) { /* OFF and the toolbar still work if an extension was reloaded. */ }
  }

  function onMessage(message, sender, reply) {
    if (message?.type !== 'AW_CONTROL') return false;
    reply(control(message.op, message.requestId));
    return false;
  }

  function onKey(e) {
    const shortcut = e.altKey && !e.metaKey && !e.ctrlKey && !e.repeat && !e.isComposing &&
      (e.code === 'Backquote' || e.key === '`' || e.key === '~');
    const escape = e.key === 'Escape' && status().active;
    if (!shortcut && !escape) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const result = control(escape ? 'off' : 'toggle');
    if (result.status === 'on' || result.status === 'off') {
      send({type: 'AW_STATE', status: result.status});
    } else {
      send({type: 'AW_TOGGLE'});
    }
  }

  const controller = {version: VERSION, status, control, setActive, forceOff, dispose() {
    window.removeEventListener('keydown', onKey, true);
    try { runtime.onMessage.removeListener(onMessage); } catch (_) {}
  }};
  window.__webDrawController = controller;
  window.__webDrawBootstrapped = true;
  runtime.onMessage.addListener(onMessage);
  window.addEventListener('keydown', onKey, true);
  // Load the drawing engine only on explicit activation. Background prewarming
  // previously raced clicks and could strand a per-tab activation lock.
})();
