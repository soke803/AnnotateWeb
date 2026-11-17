// Annotate Web v1.2.4. Register listeners synchronously; no startup network work.
const jobs = new Map();
const TITLE = 'Annotate Web: 주석 켜기/끄기 (Alt/Option + `, Esc로 끄기)';

function deadline(action, label, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: 응답 시간 초과`)), ms);
    Promise.resolve().then(action).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function validUrl(url = '') {
  return /^https?:\/\//i.test(url) &&
    !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(url);
}
async function badge(tabId, status, error) {
  try {
    await deadline(() => Promise.all([
      chrome.action.setBadgeBackgroundColor({tabId, color: error ? '#b91c1c' : '#16a34a'}),
      chrome.action.setBadgeText({tabId, text: error ? '!' : status === 'on' ? 'ON' : ''}),
      chrome.action.setTitle({tabId, title: error ? `${TITLE}\n${error.message || error}` : TITLE}),
    ]), '아이콘 상태 갱신', 1000);
  } catch (_) {}
}

async function control(tabId, op, requestId) {
  const message = {type: 'AW_CONTROL', op, requestId};
  try {
    const response = await deadline(() => chrome.tabs.sendMessage(tabId, message), '페이지 제어', 1500);
    if (response?.version === '1.2.4') return response;
  } catch (_) { /* Old tab, missing receiver, or lost response: direct fallback. */ }
  // The request ID deduplicates a reply that was lost after the toggle ran.
  const results = await deadline(() => chrome.scripting.executeScript({target: {tabId},
    func: (op, id) => window.__webDrawController?.control(op, id), args: [op, requestId]
  }), '페이지 제어 복구');
  return results?.[0]?.result || {status: 'cold'};
}
async function ensureController(tabId) {
  await deadline(() => chrome.scripting.executeScript({target: {tabId}, files: ['shortcut.js']}), '단축키 제어 복구');
}
async function cleanup(tabId) {
  await deadline(() => chrome.scripting.executeScript({target: {tabId}, func: () => {
    for (const action of [window.webDrawDisable, window.webDrawForceOff,
      window.webDrawUnlockInteractions, window.webDrawUnlockScroll]) {
      try { action?.(); } catch (_) {}
    }
    for (const id of ['control-panel', 'webdraw-overlay-root', 'textInput',
      'webdraw-lock-style', 'webdraw-shape-style']) document.getElementById(id)?.remove();
    document.querySelectorAll('.webdraw-canvas').forEach(node => node.remove());
    window.webDrawInitialized = false;
    window.webDrawActive = false;
    window.webDrawSuspend = undefined;
    window.webDrawResume = undefined;
  }}), '그리기 상태 복구');
}
async function initialize(tabId) {
  let theme = 'dark';
  try {
    theme = (await deadline(() => chrome.storage.sync.get('theme'), '테마 읽기', 1000)).theme || 'dark';
  } catch (_) {}
  // Even a late injection stays OFF until explicit activation succeeds.
  await deadline(() => chrome.scripting.executeScript({target: {tabId}, func: () => {
    window.__webDrawPreloadOnly = true;
  }}), '그리기 준비');
  const results = await Promise.allSettled([
    deadline(() => chrome.scripting.insertCSS({target: {tabId}, files: [
      'styles/styles.css', theme === 'light' ? 'styles/panel-light.css' : 'styles/panel-dark.css'
    ]}), '스타일 준비'),
    deadline(() => chrome.scripting.executeScript({target: {tabId}, files: ['draw.js']}), '그리기 준비'),
  ]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
async function toggle(tabId) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let response = await control(tabId, 'toggle', id);
  if (response.status === 'on' || response.status === 'off') return response.status;
  // Tabs opened before installation also need the resident shortcut controller.
  await ensureController(tabId);
  response = await control(tabId, 'toggle', id);
  if (response.status === 'on' || response.status === 'off') return response.status;
  await cleanup(tabId);
  try {
    await initialize(tabId);
    response = await control(tabId, 'on', id);
    if (response.status === 'on') return 'on';
    throw new Error('그리기 도구를 준비하지 못했습니다. 탭을 새로고침한 후 다시 눌러주세요.');
  } catch (error) {
    // Initialization can fail after input listeners were attached. Always unwind.
    try { await cleanup(tabId); } catch (_) {}
    throw error;
  }
}
function enqueue(tabId, url) {
  if (!validUrl(url)) { void badge(tabId, 'off', new Error('일반 http/https 웹페이지에서 사용해주세요.')); return; }
  let job = jobs.get(tabId);
  if (!job) { job = {pending: 0, running: false}; jobs.set(tabId, job); }
  job.pending += 1;
  if (job.running) return;
  job.running = true;
  void (async () => {
    try {
      while (job.pending > 0 && jobs.get(tabId) === job) {
        job.pending -= 1;
        try { await badge(tabId, await toggle(tabId)); }
        catch (error) { console.warn('Annotate Web:', error); void badge(tabId, 'off', error); }
      }
    } finally {
      if (jobs.get(tabId) === job) jobs.delete(tabId);
    }
  })();
}
chrome.action.onClicked.addListener(tab => {
  if (Number.isInteger(tab?.id)) enqueue(tab.id, tab.url);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab || sender.frameId !== 0) return false;
  if (message?.type === 'AW_TOGGLE') {
    enqueue(sender.tab.id, sender.tab.url); reply({accepted: true});
  } else if (message?.type === 'AW_STATE' && ['on', 'off'].includes(message.status)) {
    void badge(sender.tab.id, message.status); reply({accepted: true});
  }
  return false;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void badge(tabId, 'off');
});
chrome.tabs.onRemoved.addListener(tabId => jobs.delete(tabId));
