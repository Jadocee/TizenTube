// Drives standalone/index.html's launch state machine over every combination of
// the two flags the service reports, with the real source lifted out of the page.
import { readFileSync } from 'fs';
import { repoPath, readRepo } from '../lib/repo.mjs';
const html = process.env.SPLASH_HTML ? readFileSync(process.env.SPLASH_HTML, 'utf8') : readRepo('standalone', 'index.html');

// From the attempts counter (which useInjectorOrProxy closes over) to the
// launch call, so the lifted function has the state it actually uses.
const body = html.slice(html.indexOf('let statusEl = null;'),
                        html.indexOf('tizen.application.launchAppControl'));
if (!body.includes('getState')) { console.log('FAIL: could not lift useInjectorOrProxy'); process.exit(1); }

let fail = 0;
const check = (d, got, want) => {
  const ok = got === want; if (!ok) fail++;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(52)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`);
};

function run(state, ms = 3000) {
  return new Promise((resolve) => {
    const outcome = { debugger: 0, navigated: null, exited: false, reloaded: 0, polls: 0, timers: 0 };
    const sandbox = {
      fetch: (url) => {
        if (String(url).includes('/getState')) {
          outcome.polls++;
          return Promise.resolve({ json: () => Promise.resolve(state) });
        }
        if (String(url).includes('/debugger')) outcome.debugger++;
        return Promise.resolve({ json: () => Promise.resolve({}) });
      },
      tizen: {
        application: {
          getCurrentApplication: () => ({
            getRequestedAppControl: () => ({ appControl: { data: [] } }),
            exit: () => { outcome.exited = true; },
            appInfo: { packageId: 'TESTPKG' },
          }),
        },
      },
      location: { set href(v) { outcome.navigated = v; }, get href() { return outcome.navigated; } },
      window: { location: { reload: () => { outcome.reloaded++; } } },
      setTimeout: (fn, d) => { outcome.timers++; return setTimeout(fn, Math.min(d, 20)); },
      console,
    };
    const fn = new Function(...Object.keys(sandbox), `${body}; return useInjectorOrProxy;`);
    fn(...Object.values(sandbox))();
    setTimeout(() => resolve(outcome), 300);
  });
}

console.log('The four states the service can report:\n');

const a = await run({ canConnectToDaemon: true,  isConnecting: false });
check('daemon reachable, idle -> starts the debugger', a.debugger, 1);
check('daemon reachable, idle -> exits the splash', a.exited, true);

const b = await run({ canConnectToDaemon: false, isConnecting: false });
check('no daemon -> navigates to the proxy', typeof b.navigated === 'string' && b.navigated.includes('localhost:8099/tv'), true);

const c = await run({ canConnectToDaemon: false, isConnecting: true });
check('no daemon, connecting -> still the proxy', typeof c.navigated === 'string' && c.navigated.includes('localhost:8099/tv'), true);

const d = await run({ canConnectToDaemon: true,  isConnecting: true });
console.log('\n  <-- the case that used to match neither branch:');
check('attach in flight -> does NOT hang', d.polls > 1, true);
check('attach in flight -> does not exit', d.exited, false);
check('attach in flight -> does not navigate', d.navigated, null);
check('attach in flight -> does not double-start', d.debugger, 0);


// --- the service not answering yet: retry in place, never reload the document
function runFailing(ms = 900) {
  return new Promise((resolve) => {
    const outcome = { reloaded: 0, polls: 0, navigated: null, exited: false };
    const sandbox = {
      fetch: () => { outcome.polls++; return Promise.reject(new Error('ECONNREFUSED')); },
      tizen: { application: { getCurrentApplication: () => ({
        getRequestedAppControl: () => ({ appControl: { data: [] } }),
        appInfo: { packageId: 'TESTPKG' },
        exit: () => { outcome.exited = true; } }) } },
      location: { set href(v) { outcome.navigated = v; }, get href() { return outcome.navigated; } },
      window: { location: { reload: () => { outcome.reloaded++; } } },
      setTimeout: (fn, d) => setTimeout(fn, Math.min(d, 20)),
      clearTimeout, AbortController, document: { body: null },
      console: { log(){}, warn(){}, error(){} },
    };
    const fn = new Function(...Object.keys(sandbox), `${body}; return useInjectorOrProxy;`);
    fn(...Object.values(sandbox))();
    setTimeout(() => resolve(outcome), ms);
  });
}

console.log('\nWhen the service has not bound 8099 yet:');
const f = await runFailing();
check('retries rather than reloading the document', f.reloaded, 0);
check('keeps polling in place', f.polls > 3, true);
check('does not navigate away', f.navigated, null);

// --- key registration must not be able to stop the launch
const prologue = html.slice(html.indexOf('const keys = ['), html.indexOf('let statusEl'));
let launched = false;
const kb = {
  tizen: { tvinputdevice: { registerKey: (k) => { if (k === 'ColorF2Yellow') throw new Error('InvalidValuesError'); launched = true; } } },
  document: { body: null },
};
let threw = false;
try { new Function(...Object.keys(kb), prologue)(...Object.values(kb)); } catch (e) { threw = true; }
console.log('\nWhen a model rejects one of the twelve keys:');
check('registration does not abort the script', threw, false);

console.log(`\n${fail ? fail + ' FAILURES' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
