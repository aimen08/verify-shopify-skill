#!/usr/bin/env node
// control-shopify.mjs — agent-friendly CLI for verifying Shopify theme work.
//
// One binary that knows how to: run `shopify theme dev`, drive the storefront in a
// real Chromium (agent-browser), collect evidence (screenshots / video / console),
// lint + profile the theme, and talk to the Admin GraphQL API via `shopify store`.
//
// Zero dependencies. Node >= 20. Every structured command prints JSON on stdout;
// failures print {"ok":false,"error":..,"hint":..} on stderr and exit 1.
//
// Run `node control-shopify.mjs help` for the command reference.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 9292;
const DEFAULT_SCOPES = [
  'write_products', 'read_products',
  'write_inventory', 'read_inventory', 'read_locations',
  'write_publications', 'write_files', 'write_purchase_options',
  'read_online_store_navigation', 'write_online_store_navigation',
  'write_content',
];
const DEFAULT_ROUTES = [
  '/', '/collections/all', '/collections/{collection}', '/products/{product}',
  '/cart', '/search?q=a', '/pages/{page}',
];
const DEFAULT_NOISE = [
  '[HotReload]', 'configggggg', 'Third-party cookie', 'favicon.ico',
  'was preloaded using link preload', 'net::ERR_BLOCKED_BY_CLIENT',
];
// Commands forwarded verbatim to agent-browser (inside the store's session).
const PASSTHROUGH = new Set([
  'snapshot', 'click', 'dblclick', 'fill', 'type', 'press', 'keyboard', 'hover', 'focus',
  'check', 'uncheck', 'select', 'drag', 'upload', 'download', 'scroll', 'scrollintoview',
  'wait', 'eval', 'get', 'is', 'find', 'mouse', 'set', 'network', 'cookies', 'storage',
  'tab', 'back', 'forward', 'reload', 'diff', 'trace', 'profiler', 'record', 'console',
  'errors', 'highlight', 'read', 'dialog', 'pdf', 'inspect', 'session', 'close',
]);
const GLOBAL_VALUE_FLAGS = ['store', 'port', 'target', 'session', 'theme', 'cwd', 'timeout'];
const GLOBAL_BOOL_FLAGS = ['dry-run', 'json', 'headed', 'verbose', 'strict', 'keep-dev'];

// ---------------------------------------------------------------- utilities
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const slug = (s) => String(s || 'page').toLowerCase().replace(/https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function fail(error, hint, extra = {}, code = 1) {
  process.stderr.write(JSON.stringify({ ok: false, error, hint, ...extra }, null, 2) + '\n');
  process.exit(code);
}
function warn(msg) { if (process.env.CONTROL_SHOPIFY_QUIET) return; process.stderr.write(`[control-shopify] ${msg}\n`); }

function run(cmd, args, { input, timeout = 120000, env = {}, cwd, inherit = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', input, timeout, cwd,
    env: { ...process.env, ...env },
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const missing = r.error && r.error.code === 'ENOENT';
  return {
    code: r.status ?? (r.error ? 1 : 0),
    stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    error: r.error, missing, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
  };
}
function which(bin) { return run('sh', ['-c', `command -v ${bin}`]).stdout.trim() || null; }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function portListening(port, host = '127.0.0.1', timeout = 1000) {
  // Synchronous probe via a tiny node child so we can stay sync everywhere.
  const r = run(process.execPath, ['-e', `
    const net=require('node:net');const s=net.connect({host:'${host}',port:${port}});
    s.setTimeout(${timeout});s.on('connect',()=>{console.log('open');s.destroy()});
    s.on('error',()=>console.log('closed'));s.on('timeout',()=>{console.log('closed');s.destroy()});`],
    { timeout: timeout + 1000 });
  return r.stdout.trim() === 'open';
}
function readJSON(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }
function tail(str, n = 40) { const lines = String(str).split('\n'); return lines.slice(-n).join('\n'); }
function stripAnsi(s) { return String(s).replace(/\x1B\[[0-9;]*[A-Za-z]/g, ''); }
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2); const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; } else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

// ---------------------------------------------------------------- context
function findRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.claude', 'verify-shopify.json'))) return d;
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const p = path.dirname(d); if (p === d) return path.resolve(start); d = p;
  }
}
function normalizeStore(s) {
  if (!s) return null;
  let v = String(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!v.includes('.')) v += '.myshopify.com';
  return v;
}
function storeFromToml(root) {
  const f = path.join(root, 'shopify.theme.toml');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/^\s*store\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}
function buildContext(globals) {
  const root = findRoot(globals.cwd || process.cwd());
  const configFile = path.join(root, '.claude', 'verify-shopify.json');
  const config = readJSON(configFile, null) || {};
  const store = normalizeStore(globals.store || process.env.SHOPIFY_FLAG_STORE || config.store || storeFromToml(root));
  const port = Number(globals.port || process.env.SHOPIFY_FLAG_PORT || config.port || DEFAULT_PORT);
  const stateDir = path.join(root, '.shopify', 'verify');
  const evidenceDir = path.join(stateDir, 'evidence');
  const devState = readJSON(path.join(stateDir, 'dev.json'), null);
  const storeState = readJSON(path.join(stateDir, 'store.json'), null) || {};
  const storePrefix = store ? store.split('.')[0] : 'store';
  const session = globals.session || process.env.AGENT_BROWSER_SESSION || `verify-${storePrefix}`;
  const passwordEnv = config.storePasswordEnv || 'SHOPIFY_STORE_PASSWORD';
  return {
    root, configFile, config, store, port, stateDir, evidenceDir, devState, storeState, session,
    themeId: globals.theme || (devState && devState.themeId) || config.themeId || null,
    target: globals.target || config.defaultTarget || 'dev',
    primaryDomain: config.primaryDomain || storeState.primaryDomain || null,
    storePassword: process.env[passwordEnv] || config.storePassword || null,
    scopes: config.scopes || DEFAULT_SCOPES,
    routes: config.routes || DEFAULT_ROUTES,
    noise: [...DEFAULT_NOISE, ...(config.consoleNoise || [])],
    abTimeout: String(globals.timeout || config.browserTimeoutMs || 45000),
    headed: !!globals.headed, dryRun: !!globals['dry-run'], json: !!globals.json, strict: !!globals.strict,
    keepDev: !!globals['keep-dev'],
    files: {
      pid: path.join(stateDir, 'dev.pid'), log: path.join(stateDir, 'dev.log'),
      dev: path.join(stateDir, 'dev.json'), store: path.join(stateDir, 'store.json'),
    },
  };
}
function requireStore(ctx) {
  if (!ctx.store) fail('No store configured.', `Run: node ${path.join(SKILL_DIR, 'control-shopify.mjs')} init --store <shop>.myshopify.com  (or pass --store)`);
  return ctx.store;
}

// ---------------------------------------------------------------- shopify / agent-browser wrappers
function shopify(args, opts = {}) {
  const r = run('shopify', args, { timeout: 180000, ...opts, env: { SHOPIFY_FLAG_NO_COLOR: '1', ...(opts.env || {}) } });
  if (r.missing) fail('Shopify CLI not found on PATH.', 'Install: npm i -g @shopify/cli  (https://shopify.dev/docs/api/shopify-cli)');
  return r;
}
function ab(ctx, args, opts = {}) {
  const r = run('agent-browser', args, {
    timeout: Number(ctx.abTimeout) + 15000, ...opts,
    env: { AGENT_BROWSER_SESSION: ctx.session, AGENT_BROWSER_DEFAULT_TIMEOUT: ctx.abTimeout, ...(opts.env || {}) },
  });
  if (r.missing) fail('agent-browser not found on PATH.', 'Install: npm i -g agent-browser && agent-browser install');
  return r;
}
function abText(ctx, args) { return stripAnsi(ab(ctx, args).stdout).trim(); }
function abEval(ctx, js) {
  const r = ab(ctx, ['eval', '--stdin'], { input: js });
  const text = stripAnsi(r.stdout).trim();
  try { return { ok: r.code === 0, value: JSON.parse(text), raw: text }; } catch { return { ok: r.code === 0, value: text, raw: text }; }
}

// ---------------------------------------------------------------- commands: setup & health
function cmdInit(ctx, rest) {
  const { flags } = parseArgs(rest);
  const store = normalizeStore(flags.store || ctx.store);
  if (!store) fail('init needs --store <shop>.myshopify.com');
  if (fs.existsSync(ctx.configFile) && !flags.force) {
    fail(`Config already exists: ${ctx.configFile}`, 'Pass --force to overwrite, or edit the file directly.');
  }
  const cfg = {
    $schema: 'control-shopify config (see ~/.claude/skills/verify-shopify/SKILL.md)',
    store,
    port: Number(flags.port || ctx.port || DEFAULT_PORT),
    primaryDomain: flags['primary-domain'] || null,
    storePasswordEnv: 'SHOPIFY_STORE_PASSWORD',
    defaultTarget: 'dev',
    scopes: DEFAULT_SCOPES,
    routes: DEFAULT_ROUTES,
    consoleNoise: [],
    featureMap: '.claude/verify-shopify/features/README.md',
  };
  writeJSON(ctx.configFile, cfg);
  const featuresDir = path.join(ctx.root, '.claude', 'verify-shopify', 'features');
  fs.mkdirSync(featuresDir, { recursive: true });
  const readme = path.join(featuresDir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# Feature Map — ${store}\n\nNot written yet. Run \`control-shopify map\` for a generated skeleton, then follow\n"Building a Feature Map" in ~/.claude/skills/verify-shopify/SKILL.md.\n`);
  }
  const gi = path.join(ctx.root, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  let gitignoreOk = /^\.shopify\/?\s*$/m.test(giText);
  if (!gitignoreOk && flags.gitignore) { fs.appendFileSync(gi, `${giText.endsWith('\n') || !giText ? '' : '\n'}# Shopify CLI + verify-shopify state\n.shopify/\n`); gitignoreOk = true; }
  out({ ok: true, config: ctx.configFile, store, featureMap: readme, gitignoreHasShopifyDir: gitignoreOk,
    next: ['doctor', 'auth --dry-run', 'dev start', 'map'] .map((c) => `control-shopify ${c}`) });
  if (!gitignoreOk) warn('.gitignore does not ignore .shopify/ — re-run init --force --gitignore or add it by hand.');
}

function tokenCheck(ctx, timeout = 45000) {
  const q = '{ shop { name myshopifyDomain primaryDomain { url } } currentAppInstallation { accessScopes { handle } } }';
  const r = shopify(['store', 'execute', '-s', ctx.store, '-q', q, '--json'], { timeout });
  const text = stripAnsi(r.stdout + r.stderr);
  let parsed = null; try { parsed = JSON.parse(stripAnsi(r.stdout)); } catch {}
  const data = parsed && (parsed.data || (parsed.result && parsed.result.data) || parsed);
  const shop = data && data.shop; const inst = data && data.currentAppInstallation;
  if (!shop) return { ok: false, timedOut: r.timedOut, detail: tail(text, 12) };
  const granted = inst ? inst.accessScopes.map((s) => s.handle) : [];
  return { ok: true, shop: shop.name, primaryDomain: shop.primaryDomain && shop.primaryDomain.url, granted };
}
function missingScopes(needed, granted) {
  // write_x implies read_x
  const has = new Set(granted);
  for (const g of granted) if (g.startsWith('write_')) has.add('read_' + g.slice(6));
  return needed.filter((s) => !has.has(s));
}

function cmdDoctor(ctx) {
  const checks = {};
  checks.node = { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.versions.node };
  const sv = run('shopify', ['version'], { timeout: 30000 });
  checks.shopifyCli = { ok: !sv.missing && sv.code === 0, version: stripAnsi(sv.stdout).trim().split('\n').pop(), hint: sv.missing ? 'npm i -g @shopify/cli' : undefined };
  const av = run('agent-browser', ['--version'], { timeout: 30000 });
  checks.agentBrowser = { ok: !av.missing && av.code === 0, version: stripAnsi(av.stdout).trim(), hint: av.missing ? 'npm i -g agent-browser && agent-browser install' : undefined };
  checks.config = { ok: fs.existsSync(ctx.configFile), file: ctx.configFile, store: ctx.store, hint: fs.existsSync(ctx.configFile) ? undefined : 'control-shopify init --store <shop>.myshopify.com' };
  const listening = portListening(ctx.port);
  checks.devServer = { ok: listening, port: ctx.port, pid: ctx.devState && ctx.devState.pid, alive: ctx.devState ? isAlive(ctx.devState.pid) : false,
    previewUrl: listening ? `http://127.0.0.1:${ctx.port}` : null, shareUrl: ctx.devState && ctx.devState.shareUrl, hint: listening ? undefined : 'control-shopify dev start' };
  if (ctx.store) {
    const t = tokenCheck(ctx);
    if (t.ok) {
      const missing = missingScopes(ctx.scopes, t.granted);
      checks.storeAuth = { ok: missing.length === 0, shop: t.shop, primaryDomain: t.primaryDomain, granted: t.granted, missing,
        hint: missing.length ? `control-shopify auth   (re-auth with the full scope list; missing: ${missing.join(', ')})` : undefined };
      if (t.primaryDomain) writeJSON(ctx.files.store, { ...ctx.storeState, primaryDomain: t.primaryDomain, shop: t.shop, checkedAt: new Date().toISOString() });
    } else {
      checks.storeAuth = { ok: false, detail: t.detail, hint: 'control-shopify auth   (token missing/expired — tokens expire daily)' };
    }
  } else checks.storeAuth = { ok: false, hint: 'no store configured' };
  const fm = path.join(ctx.root, ctx.config.featureMap || '.claude/verify-shopify/features/README.md');
  checks.featureMap = { ok: fs.existsSync(fm) && fs.readFileSync(fm, 'utf8').length > 300, file: fm, hint: fs.existsSync(fm) ? undefined : 'control-shopify map, then write the Feature Map' };
  const ok = Object.values(checks).every((c) => c.ok);
  out({ ok, checks });
  if (!ok) process.exit(1);
}

function cmdAuth(ctx, rest) {
  const { flags } = parseArgs(rest);
  const store = requireStore(ctx);
  const scopes = flags.scopes ? String(flags.scopes).split(',').map((s) => s.trim()).filter(Boolean) : ctx.scopes;
  const args = ['store', 'auth', '--store', store, '--scopes', scopes.join(',')];
  if (ctx.dryRun || flags['dry-run']) { out({ ok: true, dryRun: true, command: `shopify ${args.join(' ')}`, scopes }); return; }
  warn('Opening the Shopify OAuth flow in your browser. Approve the scopes to continue.');
  const r = shopify(args, { inherit: true, timeout: 10 * 60 * 1000 });
  if (r.code !== 0) fail('shopify store auth failed', 'Run the command yourself in a terminal to see the prompt.', { command: `shopify ${args.join(' ')}` });
  out({ ok: true, store, scopes, next: 'control-shopify doctor' });
}

// ---------------------------------------------------------------- commands: dev server
function parseDevBanner(log) {
  const text = stripAnsi(log);
  const local = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/);
  const share = text.match(/https?:\/\/[^\s│]+preview_theme_id=(\d+)/);
  return {
    ready: /Preview your theme/i.test(text) && !!local,
    previewUrl: local ? local[0] : null,
    shareUrl: share ? share[0] : null,
    themeId: share ? share[1] : null,
  };
}
function fetchText(url, timeoutMs = 20000) {
  const r = run(process.execPath, ['-e', `
    const c = new AbortController(); setTimeout(() => c.abort(), ${timeoutMs});
    fetch(${JSON.stringify(url)}, { signal: c.signal, redirect: 'follow' }).then(async (res) => { process.stdout.write(JSON.stringify({ status: res.status, url: res.url, body: await res.text() })); })
      .catch((e) => { process.stdout.write(JSON.stringify({ status: 0, error: String(e) })); });`], { timeout: timeoutMs + 5000 });
  try { return JSON.parse(r.stdout); } catch { return { status: 0, error: 'no response' }; }
}
// Every Shopify storefront inlines `Shopify.theme = {...}`; use it to learn which theme a URL renders.
function discoverTheme(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const res = fetchText(url);
    const m = res.body && res.body.match(/Shopify\.theme\s*=\s*(\{[^;]*\});/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    sleep(1500 * (i + 1));
  }
  return null;
}
function adoptDevServer(ctx, store) {
  // A dev server is listening but we did not start it: learn the theme id from the page and persist it.
  const theme = discoverTheme(`http://127.0.0.1:${ctx.port}/`);
  const state = { pid: null, adopted: true, port: ctx.port, store, previewUrl: `http://127.0.0.1:${ctx.port}`,
    themeId: theme ? String(theme.id) : null, themeName: theme ? theme.name : null,
    shareUrl: theme ? `https://${store}/?preview_theme_id=${theme.id}` : null,
    editorUrl: theme ? `https://${store}/admin/themes/${theme.id}/editor` : null,
    startedAt: null, adoptedAt: new Date().toISOString(), log: ctx.files.log };
  writeJSON(ctx.files.dev, state);
  return state;
}
function devFailureReason(log) {
  const t = stripAnsi(log);
  const m = t.match(/(not logged in|Session expired|log in|EADDRINUSE|address already in use|Error:[^\n]*|✗[^\n]*)/i);
  return m ? m[0].trim() : null;
}
function cmdDev(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  const sub = pos[0] || 'status';
  const store = requireStore(ctx);
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  const pid = Number(fs.existsSync(ctx.files.pid) ? fs.readFileSync(ctx.files.pid, 'utf8').trim() : 0) || null;

  const status = () => {
    const listening = portListening(ctx.port);
    let state = readJSON(ctx.files.dev, null);
    if (listening && (!state || !state.themeId)) state = adoptDevServer(ctx, store);
    return { ok: listening, running: listening, port: ctx.port, pid: (state && state.pid) || pid, pidAlive: pid ? isAlive(pid) : false,
      adopted: !!(state && state.adopted),
      previewUrl: listening ? `http://127.0.0.1:${ctx.port}` : null,
      shareUrl: state && state.shareUrl, themeId: state && state.themeId, themeName: state && state.themeName,
      editorUrl: state && state.themeId ? `https://${store}/admin/themes/${state.themeId}/editor` : null,
      log: ctx.files.log, startedAt: state && state.startedAt };
  };

  if (sub === 'status') { out(status()); return; }
  if (sub === 'logs') { const n = Number(flags.tail || 60); process.stdout.write(stripAnsi(fs.existsSync(ctx.files.log) ? tail(fs.readFileSync(ctx.files.log, 'utf8'), n) : '(no log yet)') + '\n'); return; }
  if (sub === 'stop' || sub === 'restart') {
    if (pid && isAlive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      for (let i = 0; i < 25 && isAlive(pid); i++) sleep(200);
      if (isAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    }
    try { fs.unlinkSync(ctx.files.pid); } catch {}
    try { fs.unlinkSync(ctx.files.dev); } catch {}
    if (portListening(ctx.port)) {
      const who = run('sh', ['-c', `lsof -tiTCP:${ctx.port} -sTCP:LISTEN 2>/dev/null | head -1`]).stdout.trim();
      if (sub === 'stop') fail(`Port ${ctx.port} is still in use by pid ${who || '?'} (not started by this tool).`, `Stop it yourself: kill ${who || '<pid>'}`);
    }
    if (sub === 'stop') { out({ ok: true, stopped: pid, port: ctx.port }); return; }
  }
  if (sub === 'start' || sub === 'restart') {
    if (portListening(ctx.port)) {
      const s = status();
      out({ ...s, adopted: true, note: 'A dev server is already listening on this port; using it. `dev restart` to replace it.' });
      return;
    }
    const args = ['theme', 'dev', '--store', store, '--port', String(ctx.port), '--no-color'];
    const themeId = flags.theme || ctx.themeId;
    if (themeId) args.push('--theme', String(themeId));
    if (flags['live-reload']) args.push('--live-reload', String(flags['live-reload']));
    if (flags['theme-editor-sync']) args.push('--theme-editor-sync');
    if (ctx.storePassword) args.push('--store-password', ctx.storePassword);
    if (ctx.dryRun) { out({ ok: true, dryRun: true, command: `shopify ${args.join(' ').replace(ctx.storePassword || ' ', '***')}` }); return; }
    if (!which('shopify')) fail('Shopify CLI not found on PATH.', 'npm i -g @shopify/cli');
    if (fs.existsSync(ctx.files.log)) fs.renameSync(ctx.files.log, ctx.files.log + '.prev');
    const fd = fs.openSync(ctx.files.log, 'a');
    const child = spawn('shopify', args, { cwd: ctx.root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, SHOPIFY_FLAG_NO_COLOR: '1', CI: '1' } });
    child.unref();
    fs.writeFileSync(ctx.files.pid, String(child.pid));
    const waitMs = Number(flags.wait || 240) * 1000;
    const started = Date.now();
    let banner = null; let reason = null;
    while (Date.now() - started < waitMs) {
      sleep(2000);
      const log = fs.existsSync(ctx.files.log) ? fs.readFileSync(ctx.files.log, 'utf8') : '';
      banner = parseDevBanner(log);
      if (banner.ready && portListening(ctx.port)) break;
      if (!isAlive(child.pid)) { reason = devFailureReason(log) || 'process exited'; break; }
      const fr = devFailureReason(log);
      if ((fr && /not logged in|Session expired|EADDRINUSE|address already in use/i.test(fr)) || /log in to Shopify|User verification code/i.test(log)) {
        reason = fr || 'Shopify CLI asked for an interactive login (device code)';
        // Don't leave a theme dev process polling the device-auth endpoint in the background.
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch {} }
        break;
      }
    }
    if (banner && banner.ready && !banner.themeId) {
      const theme = discoverTheme(`http://127.0.0.1:${ctx.port}/`);
      if (theme) { banner.themeId = String(theme.id); banner.shareUrl = `https://${store}/?preview_theme_id=${theme.id}`; }
    }
    if (!banner || !banner.ready) {
      const log = fs.existsSync(ctx.files.log) ? stripAnsi(fs.readFileSync(ctx.files.log, 'utf8')) : '';
      if (isAlive(child.pid) && !reason) {
        fail(`Dev server did not become ready within ${waitMs / 1000}s (still running, pid ${child.pid}).`,
          'Large themes take a while to upload. Re-run `dev status` in a minute, or `dev logs` to watch. `dev stop` to give up.', { logTail: tail(log, 20) });
      }
      fail(`shopify theme dev failed: ${reason || 'unknown'}`, /log in|Session expired/i.test(reason || '') ? 'Run `shopify auth logout && shopify theme dev --store ' + store + '` once interactively to log in.' : 'Inspect `dev logs`.', { logTail: tail(log, 30) });
    }
    const state = { pid: child.pid, port: ctx.port, store, previewUrl: banner.previewUrl, shareUrl: banner.shareUrl, themeId: banner.themeId,
      editorUrl: banner.themeId ? `https://${store}/admin/themes/${banner.themeId}/editor` : null, startedAt: new Date().toISOString(), log: ctx.files.log };
    writeJSON(ctx.files.dev, state);
    out({ ok: true, ...state, readyInSeconds: Math.round((Date.now() - started) / 1000) });
    return;
  }
  fail(`Unknown dev subcommand: ${sub}`, 'dev start | stop | restart | status | logs [--tail N]');
}

// ---------------------------------------------------------------- commands: admin API
function cmdGql(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  const store = requireStore(ctx);
  let query = pos[0];
  if (!query && !flags['query-file']) fail('gql needs a query string, @file, or --query-file <path>', "Example: gql '{ shop { name } }'");
  if (query && query.startsWith('@')) query = fs.readFileSync(query.slice(1), 'utf8');
  if (flags['query-file']) query = fs.readFileSync(String(flags['query-file']), 'utf8');
  const isMutation = /^\s*mutation\b/i.test(query);
  const args = ['store', 'execute', '-s', store, '-q', query, '--json'];
  if (flags.version) args.push('--version', String(flags.version));
  let variables = flags.variables;
  if (variables && String(variables).startsWith('@')) variables = fs.readFileSync(String(variables).slice(1), 'utf8');
  if (variables) args.push('-v', typeof variables === 'string' ? variables : JSON.stringify(variables));
  if (isMutation) {
    if (!flags['allow-mutations']) fail('Refusing to run a mutation without --allow-mutations.', 'Re-run with --allow-mutations (and --dry-run first to see the exact command). Mutations change the live store.');
    args.push('--allow-mutations');
  }
  if (ctx.dryRun || flags['dry-run']) { out({ ok: true, dryRun: true, mutation: isMutation, command: ['shopify', ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ') }); return; }
  const r = shopify(args, { timeout: 120000 });
  const text = stripAnsi(r.stdout).trim();
  try { const j = JSON.parse(text); out(j); } catch { process.stdout.write(text + '\n'); }
  if (r.code !== 0) fail('shopify store execute failed', 'Check auth (`doctor`) and the query. Use --dry-run to see the command.', { stderr: tail(stripAnsi(r.stderr), 15) });
}
function gqlData(ctx, query, timeout = 60000, attempts = 3) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = shopify(['store', 'execute', '-s', ctx.store, '-q', query, '--json'], { timeout });
    const transient = r.timedOut || /aborted before it completed|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up/i.test(r.stdout + r.stderr);
    if (r.code === 0 || !transient || i === attempts) break;
    warn(`store execute: transient network error (attempt ${i}/${attempts}), retrying`);
    sleep(2000 * i);
  }
  let j = null; try { j = JSON.parse(stripAnsi(r.stdout).trim()); } catch {}
  // `shopify store execute --json` prints the unwrapped `data` object; tolerate wrapped shapes too.
  const errors = j && (j.errors || (j.result && j.result.errors));
  const data = j && (j.data || (j.result && j.result.data) || (!errors && typeof j === 'object' ? j : null));
  return { ok: !!data && r.code === 0, data, errors, raw: tail(stripAnsi(r.stdout + r.stderr), 8) };
}
function fetchHandles(ctx, limit = 5) {
  const res = { products: [], collections: [], pages: [], blogs: [], warnings: [] };
  const p = gqlData(ctx, `{ products(first: ${limit}, query: "status:active", sortKey: UPDATED_AT, reverse: true) { nodes { handle title onlineStoreUrl variants(first: 3) { nodes { id title availableForSale } } } } collections(first: ${limit}, sortKey: UPDATED_AT, reverse: true) { nodes { handle title productsCount { count } } } }`);
  if (p.ok) {
    res.products = p.data.products.nodes.map((n) => ({ handle: n.handle, title: n.title, url: n.onlineStoreUrl, variants: n.variants.nodes.map((v) => ({ id: v.id.split('/').pop(), title: v.title, available: v.availableForSale })) }));
    res.collections = p.data.collections.nodes.map((n) => ({ handle: n.handle, title: n.title, products: n.productsCount && n.productsCount.count }));
  } else res.warnings.push(`products/collections query failed: ${JSON.stringify(p.errors || p.raw)}`);
  const c = gqlData(ctx, `{ pages(first: ${limit}) { nodes { handle title templateSuffix } } blogs(first: ${limit}) { nodes { handle title } } }`);
  if (c.ok) { res.pages = c.data.pages.nodes; res.blogs = c.data.blogs.nodes; }
  else res.warnings.push(`pages/blogs query failed (needs read_content): ${JSON.stringify(c.errors || c.raw)}`);
  return res;
}
function cmdHandles(ctx, rest) {
  const { flags } = parseArgs(rest);
  requireStore(ctx);
  const h = fetchHandles(ctx, Number(flags.limit || 5));
  out({ ok: h.warnings.length === 0, ...h });
}

// ---------------------------------------------------------------- commands: browser
function baseFor(ctx, target) {
  if (target === 'dev') return `http://127.0.0.1:${ctx.port}`;
  if (target === 'live') return ctx.primaryDomain || `https://${ctx.store}`;
  if (target === 'preview') return `https://${ctx.store}`;
  fail(`Unknown target: ${target}`, '--target dev | preview | live');
}
function resolveUrl(ctx, target, pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const p = pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl;
  const u = new URL(p, baseFor(ctx, target));
  if (target === 'preview') {
    if (!ctx.themeId) fail('preview target needs a theme id.', 'Start the dev server (`dev start`) so the development theme id is known, or pass --theme <id>.');
    u.searchParams.set('preview_theme_id', String(ctx.themeId));
  }
  return u.toString();
}
function cmdUrls(ctx) {
  requireStore(ctx);
  const dev = `http://127.0.0.1:${ctx.port}`;
  out({ ok: true, target: ctx.target, dev, preview: ctx.themeId ? `https://${ctx.store}/?preview_theme_id=${ctx.themeId}` : null,
    live: baseFor(ctx, 'live'), editor: ctx.themeId ? `https://${ctx.store}/admin/themes/${ctx.themeId}/editor` : null, session: ctx.session });
}
function unlockPassword(ctx) {
  if (!ctx.storePassword) return false;
  ab(ctx, ['fill', 'input[type=password]', ctx.storePassword]);
  ab(ctx, ['press', 'Enter']);
  ab(ctx, ['wait', '--load', 'domcontentloaded']);
  return true;
}
function openWithRetry(ctx, url, { retries = 3, quiet = false } = {}) {
  const attempts = [];
  for (let i = 1; i <= retries; i++) {
    const r = ab(ctx, ['open', ...(ctx.headed ? ['--headed'] : []), url]);
    let title = abText(ctx, ['get', 'title']);
    let cur = abText(ctx, ['get', 'url']);
    const bad = /Failed to render storefront|Bad Gateway|502|503|504/i.test(title);
    attempts.push({ attempt: i, title, url: cur, exit: r.code, timedOut: r.timedOut });
    if (/\/password(\?|$)/.test(cur) && ctx.storePassword) {
      unlockPassword(ctx); ab(ctx, ['open', url]);
      title = abText(ctx, ['get', 'title']); cur = abText(ctx, ['get', 'url']);
    }
    if (!bad && (title || r.code === 0)) {
      // Shopify injects a preview bar iframe (#PBarNextFrame / #preview-bar-iframe) on preview_theme_id pages;
      // it sits over the bottom of the viewport and swallows clicks. Remove it so refs stay clickable.
      const pb = abEval(ctx, `(() => { const els = document.querySelectorAll('#PBarNextFrame, #preview-bar-iframe, iframe[src*="preview_bar"]'); els.forEach(e => e.remove()); return els.length; })()`);
      return { ok: true, url: cur, title, attempts, previewBarRemoved: Number(pb.value) || 0 };
    }
    if (!quiet) warn(`open attempt ${i}/${retries}: ${bad ? title : 'no title / timeout'} — retrying`);
    sleep(2000 * i);
  }
  return { ok: false, url, attempts };
}
function cmdOpen(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  const target = flags.target || ctx.target;
  if (target !== 'dev') requireStore(ctx);
  const url = resolveUrl(ctx, target, pos[0] || '/');
  if (target === 'dev' && !portListening(ctx.port)) fail(`Nothing is listening on 127.0.0.1:${ctx.port}.`, 'Run `dev start` first (or --target preview|live).');
  if (ctx.dryRun) { out({ ok: true, dryRun: true, url, session: ctx.session }); return; }
  const r = openWithRetry(ctx, url, { retries: Number(flags.retries || 3) });
  if (!r.ok) fail(`Could not open ${url} (storefront kept failing).`, 'Check `dev logs`; the Shopify dev proxy returns 502 intermittently — wait and retry, or use --target preview.', { attempts: r.attempts });
  out({ ok: true, target, ...r, session: ctx.session });
}
function evidencePath(ctx, name, ext = 'png') {
  fs.mkdirSync(ctx.evidenceDir, { recursive: true });
  return path.join(ctx.evidenceDir, `${ts()}-${slug(name)}.${ext}`);
}
function cmdScreenshot(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  let file = pos[0];
  if (!file) file = evidencePath(ctx, abText(ctx, ['get', 'title']) || 'page');
  else if (!path.isAbsolute(file) && !file.includes('/')) { fs.mkdirSync(ctx.evidenceDir, { recursive: true }); file = path.join(ctx.evidenceDir, file); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['screenshot'];
  if (flags.full) args.push('--full');
  if (flags.annotate) args.push('--annotate');
  args.push(file);
  const r = ab(ctx, args);
  if (r.code !== 0 || !fs.existsSync(file)) fail('screenshot failed', 'Is a page open? Run `open <path>` first.', { stderr: tail(stripAnsi(r.stderr + r.stdout), 6) });
  out({ ok: true, file, url: abText(ctx, ['get', 'url']), title: abText(ctx, ['get', 'title']) });
}
function cmdRecord(ctx, rest) {
  const { pos } = parseArgs(rest);
  const sub = pos[0];
  if (sub === 'start') {
    const file = pos[1] ? path.resolve(pos[1]) : evidencePath(ctx, 'recording', 'webm');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = ab(ctx, ['record', 'start', file, ...(pos[2] ? [pos[2]] : [])]);
    if (r.code !== 0) fail('record start failed', 'Open a page first.', { stderr: tail(stripAnsi(r.stderr + r.stdout), 6) });
    writeJSON(path.join(ctx.stateDir, 'recording.json'), { file, startedAt: new Date().toISOString() });
    out({ ok: true, recording: file }); return;
  }
  if (sub === 'stop') {
    const r = ab(ctx, ['record', 'stop']);
    const st = readJSON(path.join(ctx.stateDir, 'recording.json'), {});
    out({ ok: r.code === 0, file: st.file, output: stripAnsi(r.stdout).trim() }); return;
  }
  fail('record start [file.webm] [url] | record stop');
}
function consoleLines(ctx, { clear = false } = {}) {
  const raw = abText(ctx, ['console', ...(clear ? ['--clear'] : [])]).split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = abText(ctx, ['errors', ...(clear ? ['--clear'] : [])]).split('\n').map((l) => l.replace(/^✗\s*/, '').trim()).filter(Boolean);
  const isNoise = (l) => ctx.noise.some((n) => l.includes(n));
  return {
    console: raw.filter((l) => !isNoise(l)),
    consoleErrors: raw.filter((l) => /^\[(error|assert)\]/i.test(l) && !isNoise(l)),
    pageErrors: errs.filter((l) => !isNoise(l) && !/^✗?$/.test(l)),
  };
}
function pageFacts(ctx) {
  const r = abEval(ctx, `JSON.stringify({
    url: location.href, title: document.title,
    textLength: (document.body && document.body.innerText || '').length,
    images: document.images.length,
    brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map(i => i.currentSrc || i.src).slice(0, 10),
    theme: window.Shopify && Shopify.theme ? { id: Shopify.theme.id, name: Shopify.theme.name, role: Shopify.theme.role } : null,
    template: document.body && [...document.body.classList].filter(c => /^template/.test(c)),
    storefrontError: !!document.querySelector('[role=alert]') && /Failed to render storefront/i.test(document.body.innerText),
  })`);
  let v = r.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = { parseError: v }; } }
  return v || {};
}
function cmdCheckPage(ctx) {
  const facts = pageFacts(ctx);
  const logs = consoleLines(ctx);
  const problems = [];
  if (facts.storefrontError) problems.push('storefront 502 page');
  if (facts.textLength !== undefined && facts.textLength < 20) problems.push('page has (almost) no text');
  if (logs.pageErrors.length) problems.push(`${logs.pageErrors.length} uncaught page error(s)`);
  if (ctx.strict && logs.consoleErrors.length) problems.push(`${logs.consoleErrors.length} console error(s)`);
  out({ ok: problems.length === 0, problems, ...facts, ...logs });
  if (problems.length) process.exit(1);
}

// ---------------------------------------------------------------- commands: cart
function cmdCart(ctx, rest) {
  const { pos } = parseArgs(rest);
  const sub = pos[0];
  const fetchJson = (route, init) => abEval(ctx, `(async () => { const r = await fetch('${route}', ${init}); let body; try { body = await r.json(); } catch { body = await r.text(); } return JSON.stringify({ status: r.status, body }); })()`);
  const done = (r) => { let v = r.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} } out({ ok: r.ok && v && v.status < 400, ...(typeof v === 'object' ? v : { raw: v }) }); if (!(r.ok && v && v.status < 400)) process.exit(1); };
  if (sub === 'add') {
    const id = String(pos[1] || '').split('/').pop(); const qty = Number(pos[2] || 1);
    if (!id) fail('cart add <variantId|gid> [qty]', 'Get variant ids from `handles`.');
    return done(fetchJson('/cart/add.js', `{ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items: [{ id: ${Number(id)}, quantity: ${qty} }] }) }`));
  }
  if (sub === 'get') return done(fetchJson('/cart.js', `{ headers: { Accept: 'application/json' } }`));
  if (sub === 'clear') return done(fetchJson('/cart/clear.js', `{ method: 'POST', headers: { Accept: 'application/json' } }`));
  if (sub === 'open') {
    const r = ab(ctx, ['find', 'role', 'button', 'click', '--name', 'Cart']);
    if (r.code !== 0) fail('Could not click a button named "Cart".', 'Check the Feature Map for the cart trigger, or `open /cart`.', { stderr: tail(stripAnsi(r.stderr + r.stdout), 5) });
    ab(ctx, ['wait', '500']);
    out({ ok: true, note: 'Clicked the Cart button; run `snapshot` to see the drawer.' }); return;
  }
  fail('cart add <variantId> [qty] | cart get | cart clear | cart open');
}

// ---------------------------------------------------------------- commands: smoke
function cmdSmoke(ctx, rest) {
  const { flags } = parseArgs(rest);
  const target = flags.target || ctx.target;
  if (target !== 'dev') requireStore(ctx);
  if (target === 'dev' && !portListening(ctx.port)) fail(`Nothing is listening on 127.0.0.1:${ctx.port}.`, 'Run `dev start` first.');
  let routes = flags.routes ? String(flags.routes).split(',').map((s) => s.trim()).filter(Boolean) : ctx.routes;
  const notes = [];
  if (routes.some((r) => /\{(product|collection|page|blog)\}/.test(r))) {
    const h = ctx.store ? fetchHandles(ctx, 3) : { products: [], collections: [], pages: [], blogs: [], warnings: ['no store'] };
    const pick = { product: h.products[0] && h.products[0].handle, collection: h.collections[0] && h.collections[0].handle, page: h.pages[0] && h.pages[0].handle, blog: h.blogs[0] && h.blogs[0].handle };
    const resolved = [];
    for (const r of routes) {
      const m = r.match(/\{(product|collection|page|blog)\}/);
      if (!m) { resolved.push(r); continue; }
      if (pick[m[1]]) resolved.push(r.replace(/\{(product|collection|page|blog)\}/g, (_, k) => pick[k]));
      else notes.push(`skipped ${r}: no ${m[1]} handle available (auth/network?)`);
    }
    routes = resolved;
    if (h.warnings.length) notes.push(...h.warnings);
  }
  const runDir = path.join(ctx.evidenceDir, `smoke-${ts()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const results = [];
  routes.forEach((route, i) => {
    const url = resolveUrl(ctx, target, route);
    ab(ctx, ['console', '--clear']); ab(ctx, ['errors', '--clear']);
    const o = openWithRetry(ctx, url, { retries: 2, quiet: true });
    const facts = o.ok ? pageFacts(ctx) : {};
    const logs = o.ok ? consoleLines(ctx) : { console: [], consoleErrors: [], pageErrors: [] };
    let screenshot = null;
    if (o.ok && !flags['no-screenshots']) {
      screenshot = path.join(runDir, `${String(i + 1).padStart(2, '0')}-${slug(route)}.png`);
      ab(ctx, ['screenshot', screenshot]);
      if (!fs.existsSync(screenshot)) screenshot = null;
    }
    const problems = [];
    if (!o.ok) problems.push('could not open (storefront error / timeout)');
    if (facts.storefrontError) problems.push('storefront 502 page');
    if (o.ok && facts.textLength !== undefined && facts.textLength < 20) problems.push('page has (almost) no text');
    if (logs.pageErrors.length) problems.push(`${logs.pageErrors.length} uncaught page error(s)`);
    if (ctx.strict && logs.consoleErrors.length) problems.push(`${logs.consoleErrors.length} console error(s)`);
    const warnings = [];
    if (facts.brokenImages && facts.brokenImages.length) warnings.push(`${facts.brokenImages.length} broken image(s)${target === 'dev' ? ' (known: local proxy; confirm on --target preview)' : ''}`);
    if (!ctx.strict && logs.consoleErrors.length) warnings.push(`${logs.consoleErrors.length} console error(s)`);
    results.push({ route, url: o.url || url, title: o.title || facts.title, status: problems.length ? 'fail' : 'pass', problems, warnings, screenshot,
      template: facts.template, theme: facts.theme, brokenImages: facts.brokenImages, pageErrors: logs.pageErrors, consoleErrors: logs.consoleErrors, attempts: o.attempts && o.attempts.length });
  });
  const failed = results.filter((r) => r.status === 'fail');
  const summary = { ok: failed.length === 0, target, store: ctx.store, routes: results.length, passed: results.length - failed.length, failed: failed.length, evidenceDir: runDir, notes, results };
  writeJSON(path.join(runDir, 'report.json'), summary);
  const md = [`# Smoke report — ${ctx.store || 'store'} (${target})`, '', `Generated ${new Date().toISOString()}`, '', '| # | Route | Status | Problems | Warnings | Screenshot |', '|---|---|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | \`${r.route}\` | ${r.status} | ${r.problems.join('; ') || '-'} | ${r.warnings.join('; ') || '-'} | ${r.screenshot ? path.basename(r.screenshot) : '-'} |`), ''];
  fs.writeFileSync(path.join(runDir, 'report.md'), md.join('\n'));
  out(summary);
  if (failed.length) process.exit(1);
}

// ---------------------------------------------------------------- commands: theme tooling
function cmdCheck(ctx, rest) {
  const { flags } = parseArgs(rest);
  const args = ['theme', 'check', '-o', 'json'];
  if (flags['fail-level']) args.push('--fail-level', String(flags['fail-level']));
  const r = shopify(args, { cwd: ctx.root, timeout: 300000 });
  const text = stripAnsi(r.stdout).trim();
  const jsonStart = text.indexOf('['); const jsonAlt = text.indexOf('{');
  const start = jsonStart === -1 ? jsonAlt : (jsonAlt === -1 ? jsonStart : Math.min(jsonStart, jsonAlt));
  let parsed = null; try { parsed = JSON.parse(text.slice(start)); } catch {}
  if (parsed) {
    const files = Array.isArray(parsed) ? parsed : [];
    const offenses = files.flatMap((f) => (f.offenses || []).map((o) => ({ file: f.path, severity: o.severity, check: o.check, message: o.message, line: o.start_row !== undefined ? o.start_row + 1 : undefined })));
    const counts = offenses.reduce((a, o) => { a[o.severity] = (a[o.severity] || 0) + 1; return a; }, {});
    out({ ok: r.code === 0, exitCode: r.code, counts, offenses: flags.all ? offenses : offenses.slice(0, 50), truncated: !flags.all && offenses.length > 50 });
  } else {
    process.stdout.write(text + '\n' + stripAnsi(r.stderr));
  }
  if (r.code !== 0) process.exit(r.code);
}
function cmdProfile(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  if (flags.from) {
    // Summarize an existing profile JSON (no network): `profile --from .shopify/verify/evidence/<ts>-profile.json`
    const file = path.resolve(String(flags.from));
    const parsed = readJSON(file, null);
    if (!parsed) fail(`Cannot read profile JSON: ${file}`);
    out({ ok: true, from: file, summary: summarizeProfile(parsed) });
    return;
  }
  requireStore(ctx);
  const args = ['theme', 'profile', '-s', ctx.store, '--url', pos[0] || '/', '--json'];
  const themeId = flags.theme || ctx.themeId;
  if (themeId) args.push('-t', String(themeId));
  if (ctx.dryRun) { out({ ok: true, dryRun: true, command: `shopify ${args.join(' ')}` }); return; }
  const r = shopify(args, { cwd: ctx.root, timeout: 300000 });
  const text = stripAnsi(r.stdout).trim();
  let parsed = null; try { parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('{')))); } catch {}
  if (parsed) {
    const file = evidencePath(ctx, `profile-${pos[0] || 'home'}`, 'json');
    writeJSON(file, parsed);
    const nodes = parsed.nodes || parsed.profile || null;
    out({ ok: r.code === 0, url: pos[0] || '/', themeId, saved: file, summary: summarizeProfile(parsed), note: 'Full Speedscope-format profile saved; open it at https://www.speedscope.app or inspect the JSON.' });
  } else { process.stdout.write(text + '\n' + stripAnsi(r.stderr)); }
  if (r.code !== 0) process.exit(r.code);
}
function summarizeProfile(p) {
  // Speedscope "evented" format as emitted by `shopify theme profile --json`:
  // { shared: { frames: [{name}] }, profiles: [{ type: 'evented', unit: 'nanoseconds', startValue, endValue, events: [{type:'O'|'C', frame, at}] }] }
  try {
    const prof = p.profiles && p.profiles[0];
    const frames = (p.shared && p.shared.frames) || p.frames;
    if (!prof || !frames || prof.type !== 'evented') return null;
    const div = { nanoseconds: 1e6, microseconds: 1e3, milliseconds: 1, seconds: 1e-3 }[prof.unit] || 1e6;
    const incl = new Map(); const self = new Map(); const calls = new Map();
    const stack = [];
    for (const ev of prof.events) {
      if (ev.type === 'O') stack.push({ frame: ev.frame, at: ev.at, child: 0 });
      else if (ev.type === 'C') {
        const o = stack.pop(); if (!o) continue;
        const dur = ev.at - o.at;
        const name = (frames[o.frame] && frames[o.frame].name) || String(o.frame);
        incl.set(name, (incl.get(name) || 0) + dur);
        self.set(name, (self.get(name) || 0) + (dur - o.child));
        calls.set(name, (calls.get(name) || 0) + 1);
        if (stack.length) stack[stack.length - 1].child += dur;
      }
    }
    const ms = (v) => Math.round((v / div) * 100) / 100;
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([name, s]) => ({ frame: name, selfMs: ms(s), inclusiveMs: ms(incl.get(name)), calls: calls.get(name) }));
    return { totalMs: ms(prof.endValue - prof.startValue), frames: frames.length, events: prof.events.length, topBySelfTime: top };
  } catch { return null; }
}

// ---------------------------------------------------------------- commands: feature map skeleton
function cmdMap(ctx, rest) {
  const { flags } = parseArgs(rest);
  const root = ctx.root;
  const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const ls = (dir, ext) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).sort() : []);
  const templates = ls('templates', '.json').map((f) => {
    const j = readJSON(path.join(root, 'templates', f), {}) || {};
    const order = j.order || Object.keys(j.sections || {});
    return { file: `templates/${f}`, name: f.replace(/\.json$/, ''), layout: j.layout, sections: order.map((k) => (j.sections && j.sections[k] ? j.sections[k].type : k)) };
  });
  const liquidTemplates = ls('templates', '.liquid').map((f) => ({ file: `templates/${f}`, name: f.replace(/\.liquid$/, '') }));
  const groups = ls('sections', '.json').map((f) => { const j = readJSON(path.join(root, 'sections', f), {}) || {}; const order = j.order || Object.keys(j.sections || {}); return { file: `sections/${f}`, sections: order.map((k) => (j.sections && j.sections[k] ? j.sections[k].type : k)) }; });
  const sections = ls('sections', '.liquid').map((f) => f.replace(/\.liquid$/, ''));
  const blocks = ls('blocks', '.liquid').map((f) => f.replace(/\.liquid$/, ''));
  const snippets = ls('snippets', '.liquid').length;
  const elements = [];
  for (const f of ls('assets', '.js')) {
    const src = rd(`assets/${f}`);
    for (const m of src.matchAll(/customElements\.define\(\s*['"]([a-z0-9-]+)['"]/g)) elements.push({ element: m[1], file: `assets/${f}` });
  }
  const routes = [
    { route: '/', template: 'index' }, { route: '/collections', template: 'list-collections' }, { route: '/collections/all', template: 'collection' },
    { route: '/collections/<handle>', template: 'collection' }, { route: '/products/<handle>', template: 'product' }, { route: '/cart', template: 'cart' },
    { route: '/search?q=<term>', template: 'search' }, { route: '/blogs/<blog>', template: 'blog' }, { route: '/blogs/<blog>/<article>', template: 'article' },
    { route: '/pages/<handle>', template: 'page' }, { route: '/password', template: 'password' }, { route: '/<anything-missing>', template: '404' },
    ...templates.filter((t) => /^page\./.test(t.name)).map((t) => ({ route: `/pages/<page with template "${t.name.slice(5)}">`, template: t.name })),
  ];
  const md = [
    `# Feature Map (generated skeleton) — ${ctx.store || path.basename(root)}`, '',
    `Generated ${new Date().toISOString()} by \`control-shopify map\`. Regenerate any time; hand-written notes belong in README.md and per-feature files next to this one.`, '',
    '## Routes', '', '| Route | Template |', '|---|---|', ...routes.map((r) => `| \`${r.route}\` | ${r.template} |`), '',
    '## Templates (section order)', '', ...templates.map((t) => `- **${t.name}** (\`${t.file}\`${t.layout === false ? ', no layout' : ''}): ${t.sections.join(' → ') || '(no sections)'}`),
    ...liquidTemplates.map((t) => `- **${t.name}** (\`${t.file}\`, Liquid template)`), '',
    '## Section groups', '', ...groups.map((g) => `- \`${g.file}\`: ${g.sections.join(' → ')}`), '',
    `## Sections (${sections.length})`, '', sections.map((s) => `\`${s}\``).join(', '), '',
    `## Blocks (${blocks.length})`, '', blocks.map((s) => `\`${s}\``).join(', '), '',
    `## Custom elements registered in assets/ (${elements.length})`, '', '| Element | File |', '|---|---|', ...elements.map((e) => `| \`<${e.element}>\` | \`${e.file}\` |`), '',
    `Snippets: ${snippets}.`, '',
  ].join('\n');
  const outFile = path.join(root, flags.out || '.claude/verify-shopify/features/README.generated.md');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, md);
  out({ ok: true, file: outFile, templates: templates.length + liquidTemplates.length, sections: sections.length, blocks: blocks.length, customElements: elements.length, routes: routes.length });
}

// ---------------------------------------------------------------- cleanup
function cmdCleanup(ctx) {
  const closed = ab(ctx, ['close']);
  let dev = null;
  if (!ctx.keepDev) {
    const pid = Number(fs.existsSync(ctx.files.pid) ? fs.readFileSync(ctx.files.pid, 'utf8').trim() : 0) || null;
    if (pid && isAlive(pid)) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } for (let i = 0; i < 25 && isAlive(pid); i++) sleep(200); dev = { stopped: pid }; }
    try { fs.unlinkSync(ctx.files.pid); } catch {} try { fs.unlinkSync(ctx.files.dev); } catch {}
  }
  out({ ok: true, browserSession: ctx.session, browserClosed: closed.code === 0, dev: dev || (ctx.keepDev ? 'kept' : 'was not running') });
}

// ---------------------------------------------------------------- help
function help() {
  process.stdout.write(`control-shopify v${VERSION} — verification CLI for Shopify theme work

Usage: node ${path.join(SKILL_DIR, 'control-shopify.mjs')} <command> [args] [--store X] [--port N] [--target dev|preview|live] [--session S] [--dry-run] [--headed] [--strict]

Setup & health
  init --store <shop>.myshopify.com [--port 9292] [--primary-domain https://…] [--gitignore] [--force]
                              Write .claude/verify-shopify.json + features/ skeleton in this repo
  doctor                      Check node, shopify CLI, agent-browser, config, dev server, store token + scopes
  auth [--scopes a,b] [--dry-run]
                              shopify store auth with the configured scope list (interactive; opens browser)
  urls                        Print dev / preview / live / editor URLs for the current store

Dev server (shopify theme dev)
  dev start [--theme ID] [--live-reload hot-reload|full-page|off] [--wait SECONDS] [--theme-editor-sync]
  dev status | dev stop | dev restart | dev logs [--tail N]

Browser (real Chromium via agent-browser, one isolated session per store)
  open <path|url> [--target dev|preview|live] [--retries 3]
                              Navigate; retries the Shopify dev proxy's intermittent 502 page
  snapshot [-i -c -s <css>]   Accessibility tree with @eN refs (default: -i -c)
  click|fill|type|press|hover|select|check|scroll|wait|eval|get|find|is|tab|back|reload …
                              Forwarded to agent-browser verbatim (see: agent-browser --help)
  screenshot [file] [--full] [--annotate]
                              PNG into .shopify/verify/evidence/ (prints the path)
  record start [file.webm] [url] | record stop
  console | errors [--clear]  Page console / uncaught errors (forwarded)
  check-page                  One-shot health of the current page: 502?, text, broken images, errors
  cart add <variantId> [qty] | cart get | cart clear | cart open
  close                       Close this store's browser session

Verification runs
  smoke [--routes /,/cart,…] [--target …] [--no-screenshots] [--strict]
                              Open every configured route, collect errors + screenshots, write report.{json,md}
  check [--fail-level error] [--all]
                              shopify theme check (Liquid/JSON lint) as JSON
  profile [/path] [--theme ID]
                              shopify theme profile — Liquid render profile, saved to evidence/ (+ self-time summary)
  profile --from <file.json>  Summarize a saved profile offline (no network)

Admin API (shopify store execute)
  gql '<query>' | gql @file.graphql [--variables '{…}'|@vars.json] [--allow-mutations] [--dry-run] [--version 2025-10]
  handles [--limit 5]         Real product/collection/page/blog handles + variant ids for this store

Feature Map
  map [--out path]            Generate .claude/verify-shopify/features/README.generated.md from the theme files

Cleanup
  cleanup [--keep-dev]        Close the browser session and stop the dev server

Config precedence: --store > $SHOPIFY_FLAG_STORE > .claude/verify-shopify.json > shopify.theme.toml
State lives in .shopify/verify/ (pid, log, dev.json, evidence/). Password-protected stores: export SHOPIFY_STORE_PASSWORD.
`);
}

// ---------------------------------------------------------------- main
function main() {
  const argv = process.argv.slice(2);
  const globals = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') ? (eq > -1 ? a.slice(2, eq) : a.slice(2)) : null;
    if (key && GLOBAL_VALUE_FLAGS.includes(key)) { globals[key] = eq > -1 ? a.slice(eq + 1) : argv[++i]; continue; }
    if (key && GLOBAL_BOOL_FLAGS.includes(key)) { globals[key] = true; continue; }
    rest.push(a);
  }
  const cmd = rest.shift();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); return; }
  if (cmd === 'version' || cmd === '--version') { out({ version: VERSION, skillDir: SKILL_DIR }); return; }
  const ctx = buildContext(globals);
  // structured commands keep global flags available to sub-parsers too
  const withGlobals = [...rest, ...Object.entries(globals).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)]))];
  switch (cmd) {
    case 'init': return cmdInit(ctx, withGlobals);
    case 'doctor': return cmdDoctor(ctx);
    case 'auth': return cmdAuth(ctx, withGlobals);
    case 'urls': return cmdUrls(ctx);
    case 'dev': return cmdDev(ctx, withGlobals);
    case 'gql': return cmdGql(ctx, withGlobals);
    case 'handles': return cmdHandles(ctx, withGlobals);
    case 'open': return cmdOpen(ctx, withGlobals);
    case 'screenshot': return cmdScreenshot(ctx, rest);
    case 'record': return cmdRecord(ctx, rest);
    case 'check-page': return cmdCheckPage(ctx);
    case 'cart': return cmdCart(ctx, rest);
    case 'smoke': return cmdSmoke(ctx, withGlobals);
    case 'check': return cmdCheck(ctx, rest);
    case 'profile': return cmdProfile(ctx, withGlobals);
    case 'map': return cmdMap(ctx, rest);
    case 'cleanup': return cmdCleanup(ctx);
    default:
      if (PASSTHROUGH.has(cmd)) {
        const args = [cmd, ...rest];
        if (cmd === 'snapshot' && rest.length === 0) args.push('-i', '-c');
        if (ctx.json && !rest.includes('--json')) args.push('--json');
        const r = spawnSync('agent-browser', args, { stdio: 'inherit', env: { ...process.env, AGENT_BROWSER_SESSION: ctx.session, AGENT_BROWSER_DEFAULT_TIMEOUT: ctx.abTimeout } });
        if (r.error && r.error.code === 'ENOENT') fail('agent-browser not found on PATH.', 'npm i -g agent-browser && agent-browser install');
        process.exit(r.status ?? 1);
      }
      fail(`Unknown command: ${cmd}`, 'Run `help` for the command list.', {}, 2);
  }
}
main();
