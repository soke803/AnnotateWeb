const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const assert = require('assert/strict');
const extension = path.resolve(__dirname, '../extension');
const results = [];
const workerErrors = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/icons/')) {res.writeHead(204); res.end(); return;}
  res.end('<!doctype html><style>body{margin:0}main{height:30000px}a{display:block;width:160px;height:40px}</style><main><a id="link" href="#normal">Link</a></main>');
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const page = await browser.newPage({viewport: {width: 1200, height: 800}});
  let worker, actionListener, messageListener, badges = [], faults = {};
  let timeScale = 1;
  const source = file => fs.readFileSync(path.join(extension, file), 'utf8');
  await page.exposeFunction('__toWorker', message => {
    let response;
    messageListener(message, {tab: {id: 1, url: origin}, frameId: 0}, r => {response = r;});
    return response;
  });
  const script = async options => {
    if (faults.hangScript) {faults.hangScript = false; return new Promise(() => {});}
    if (faults.script) {faults.script = false; throw new Error('Injected scripting failure');}
    if (options.files) {
      for (const file of options.files) await page.evaluate(code => (0, eval)(code), source(file));
      return [{result: undefined}];
    }
    const result = await page.evaluate(({code, args}) => (0, eval)(`(${code})`)(...args), {code: options.func.toString(), args: options.args || []});
    return [{result}];
  };
  function startWorker() {
    worker = vm.createContext({
      console: {warn: (...args) => workerErrors.push(args.map(String).join(' '))},
      setTimeout: (fn, ms) => setTimeout(fn, ms * timeScale), clearTimeout, Promise, Map, Date, Math, Error,
      chrome: {
        action: {
          onClicked: {addListener: f => {actionListener = f;}},
          setBadgeBackgroundColor: async () => {},
          setBadgeText: async args => {badges.push(args.text);},
          setTitle: async () => {},
        },
        runtime: {onMessage: {addListener: f => {messageListener = f;}}},
        tabs: {
          onUpdated: {addListener: () => {}}, onRemoved: {addListener: () => {}},
          sendMessage: async (id, message) => {
            if (faults.hangMessage) return new Promise(() => {});
            const response = await page.evaluate(message => {
              let result;
              for (const listener of window.__messageListeners || []) listener(message, {}, r => {result = r;});
              return result;
            }, message);
            if (faults.loseReply) {faults.loseReply = false; throw new Error('Lost reply after delivery');}
            return response;
          },
        },
        storage: {sync: {get: async () => ({theme: 'dark'})}},
        scripting: {executeScript: script, insertCSS: async options => {
          if (faults.css) {faults.css = false; throw new Error('Injected CSS failure');}
          for (const file of options.files) await page.addStyleTag({content: source(file)});
        }},
      },
    });
    vm.runInContext(source('background.js'), worker, {filename: 'background.js'});
  }
  async function reset(options = {}) {
    faults = {}; timeScale = 1;
    await page.goto(origin + '/fixture?' + Date.now());
    await page.evaluate(({origin, denyStorage}) => {
      window.__messageListeners = [];
      const data = {};
      const storage = {get(keys, cb) {
        if (window.__throwSyncGet) throw new Error('Simulated initialization exception');
        const result = typeof keys === 'object' ? {...keys, ...data} : {...data};
        if (cb) cb(result); return Promise.resolve(result);
      }, set(values, cb) {Object.assign(data, values); if (cb) cb(); return Promise.resolve();}};
      window.chrome = {runtime: {
        getURL: file => origin + '/' + file, lastError: null,
        onMessage: {addListener: f => window.__messageListeners.push(f), removeListener: f => {window.__messageListeners = window.__messageListeners.filter(x => x !== f);}},
        sendMessage: (message, cb) => window.__toWorker(message).then(r => {if (cb) cb(r); return r;}),
      }, storage: {local: storage, sync: storage}};
      if (denyStorage) Object.defineProperty(window, 'localStorage', {get() {throw new DOMException('Denied', 'SecurityError');}});
    }, {origin, denyStorage: options.denyStorage});
    startWorker();
  }
  async function idle() {
    const end = Date.now() + 16000;
    while (Date.now() < end) {
      if (vm.runInContext('jobs.size', worker) === 0) return;
      await page.waitForTimeout(15);
    }
    throw new Error('Worker queue stayed locked');
  }
  async function click() {actionListener({id: 1, url: origin}); await idle();}
  async function active() {return page.evaluate(() => window.webDrawActive === true);}
  async function off() {
    assert.equal(await active(), false);
    assert.equal(await page.locator('#control-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => {
      const root = document.getElementById('webdraw-overlay-root');
      return !root || root.style.display === 'none' || root.style.pointerEvents === 'none';
    }), true);
    await page.mouse.click(10, 10);
    await page.waitForURL(url => url.hash === '#normal', {timeout: 2000});
  }
  async function test(name, fn) {await fn(); results.push({name, passed: true}); console.log('PASS', name);}

  await test('cold tab opened before extension installation: icon ON then OFF', async () => {
    await reset(); await click(); assert(await active()); await click(); await off();
  });
  await test('30 icon toggles retain working OFF', async () => {
    await reset(); for (let i = 0; i < 30; i++) {await click(); assert.equal(await active(), i % 2 === 0);} await off();
  });
  await test('missing toolbar while ON: first click OFF, next click rebuilds ON', async () => {
    await reset(); await click(); await page.evaluate(() => document.getElementById('control-panel').remove());
    await click(); await off(); await click(); assert(await active()); assert(await page.locator('#control-panel').isVisible());
  });
  await test('missing overlay while ON: OFF then new overlay on next ON', async () => {
    await reset(); await click(); await page.evaluate(() => document.getElementById('webdraw-overlay-root').remove());
    await click(); await off(); await click(); assert(await active()); assert(await page.locator('#webdraw-overlay-root').isVisible());
  });
  await test('suspend callback throws: OFF still unlocks the page', async () => {
    await reset(); await click(); await page.evaluate(() => {window.webDrawSuspend = () => {throw new Error('Simulated suspend failure');};});
    await click(); await off();
  });
  await test('lost message reply is retried once without toggling twice', async () => {
    await reset(); await click(); faults.loseReply = true; await click(); await off();
  });
  await test('hung messaging falls back; next click remains usable', async () => {
    await reset(); await click(); timeScale = 0.2; faults.hangMessage = true; await click(); await off();
    faults.hangMessage = false; await click(); assert(await active());
  });
  await test('script API never resolves: queue times out and next click can turn OFF', async () => {
    await reset(); await click(); timeScale = 0.03;
    faults.hangMessage = true; faults.hangScript = true; await click();
    faults.hangMessage = false; timeScale = 1; await click(); await off();
  });
  await test('lost ON reply does not invert successful activation', async () => {
    await reset(); await click(); await click(); faults.loseReply = true;
    await click(); assert(await active()); await click(); await off();
  });
  await test('CSS load failure leaves no overlay trap and next click recovers', async () => {
    await reset(); faults.css = true; await click(); await off(); await click(); assert(await active());
  });
  await test('mid-initialization exception removes lock/listeners and permits retry', async () => {
    await reset(); await page.evaluate(() => {window.__throwSyncGet = true;}); await click(); await off();
    await page.evaluate(() => {window.__throwSyncGet = false;}); await click(); assert(await active());
  });
  await test('localStorage access denied does not prevent activation or OFF', async () => {
    await reset({denyStorage: true}); await click(); assert(await active()); await click(); await off();
  });
  await test('service worker restart still controls resident engine', async () => {
    await reset(); await click(); startWorker(); await click(); await off();
  });
  await test('toolbar OFF works even when runtime messaging throws', async () => {
    await reset(); await click(); await page.evaluate(() => {chrome.runtime.sendMessage = () => {throw new Error('Extension context invalidated');};});
    await page.click('#webdraw-off-button'); await off();
  });
  await test('Escape works even when runtime messaging throws', async () => {
    await reset(); await click(); await page.evaluate(() => {chrome.runtime.sendMessage = () => {throw new Error('Extension context invalidated');};});
    await page.keyboard.press('Escape'); await off();
  });
  await test('rapid queued icon clicks preserve odd/even parity', async () => {
    await reset(); for (let i = 0; i < 6; i++) actionListener({id: 1, url: origin}); await idle(); await off();
    for (let i = 0; i < 3; i++) actionListener({id: 1, url: origin}); await idle(); assert(await active());
  });
  await test('shortcut cold activation and warm OFF', async () => {
    await reset(); await script({files: ['shortcut.js']});
    await page.keyboard.press('Alt+Backquote'); await idle(); assert(await active());
    await page.keyboard.press('Alt+Backquote'); await off();
  });
  fs.writeFileSync(path.resolve(__dirname, '../TEST_RESULTS.json'), JSON.stringify({passed: results.length, results, expectedFaultLogs: workerErrors.length}, null, 2));
  await browser.close(); server.close();
})().catch(error => {console.error(error); server.close(); process.exit(1);});
