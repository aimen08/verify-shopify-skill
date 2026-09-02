#!/usr/bin/env node
// control-shopify.mjs — agent-friendly CLI for verifying Shopify theme work.
//
// One binary that knows how to: run `shopify theme dev`, drive the storefront in a
// real Chromium (agent-browser), collect evidence (screenshots / video / console),
// lint the theme, and talk to the Admin GraphQL API via `shopify store`.
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

const VERSION = '2.0.0';
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 9292;
// Only what verification actually reads: fixtures (products/inventory/locations), theme files for
// the "does this theme carry my code" md5 proof, and pages behind page.<suffix> templates. Keep this
// list minimal -- `shopify store auth` REPLACES the token's scopes, so asking for extras can silently
// drop scopes the user granted for other work.
const DEFAULT_SCOPES = [
  'read_products', 'write_products',
  'read_inventory', 'write_inventory', 'read_locations',
  'read_files', 'write_files',
  'read_content', 'write_content',
  'read_themes',
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
  'tab', 'back', 'forward', 'reload', 'diff', 'console',
  'errors', 'highlight', 'read', 'dialog', 'pdf', 'inspect', 'session', 'close',
]);
const GLOBAL_VALUE_FLAGS = ['store', 'port', 'target', 'session', 'theme', 'cwd', 'timeout', 'country'];
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
    // Only trust a persisted theme id if it was recorded for THIS store; a dev.json written while
    // another project's server was adopted would otherwise reach `theme dev --theme`, which fails
    // with "No themes on the store ... match the ID".
    themeId: globals.theme
      || (devState && devState.themeId && (!devState.store || normalizeStore(devState.store) === store) ? devState.themeId : null)
      || config.themeId || null,
    target: globals.target || config.defaultTarget || 'dev',
    country: globals.country || config.country || null,
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
    country: null,
    consoleNoise: [],
    featureMap: '.claude/verify-shopify/features/README.md',
  };
  writeJSON(ctx.configFile, cfg);
  const featuresDir = path.join(ctx.root, '.claude', 'verify-shopify', 'features');
  fs.mkdirSync(featuresDir, { recursive: true });
  const readme = path.join(featuresDir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# Feature Map — ${store}\n\nNot written yet. Record only what you had to discover: selectors, click paths, and\ngotchas. See "Feature Map" in ~/.claude/skills/verify-shopify/SKILL.md.\n`);
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
  // Several installs (npm / bun / homebrew) routinely shadow each other, and a version pin applied
  // to one while another wins PATH is invisible until a command misbehaves. Report what RUNS.
  const paths = run('sh', ['-c', 'command -v -a shopify || which -a shopify'], { timeout: 15000 }).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const shadowed = [...new Set(paths)];
  checks.shopifyCli = { ok: !sv.missing && sv.code === 0, version: stripAnsi(sv.stdout).trim().split('\n').pop(),
    path: shadowed[0] || null, shadowedBy: shadowed.length > 1 ? shadowed.slice(1) : undefined,
    hint: sv.missing ? 'npm i -g @shopify/cli'
      : shadowed.length > 1 ? `${shadowed.length} shopify installs on PATH; ${shadowed[0]} wins. Version pins applied to the others have no effect.`
      : undefined };
  // `theme` commands use a session distinct from the `store execute` token. When it expires the CLI
  // starts a device-code OAuth and, with nobody at the browser, dies with "The operation was
  // aborted" — which reads like a hard breakage and sends you off building live-only workarounds.
  const tl = run('shopify', ['theme', 'list', ...(ctx.store ? ['--store', ctx.store] : [])], { timeout: 25000 });
  const tlText = stripAnsi(tl.stdout + tl.stderr);
  const needsLogin = /log in to Shopify|operation was aborted|verification code/i.test(tlText) || tl.code !== 0;
  checks.themeSession = { ok: !needsLogin,
    hint: needsLogin ? `theme session expired — ask the user to run this once interactively: \`! shopify theme list --store ${ctx.store || '<shop>'}\` (it needs a browser; a non-TTY agent shell cannot complete the device-code login). \`gql\` keeps working meanwhile.` : undefined };
  const av = run('agent-browser', ['--version'], { timeout: 30000 });
  checks.agentBrowser = { ok: !av.missing && av.code === 0, version: stripAnsi(av.stdout).trim(), hint: av.missing ? 'npm i -g agent-browser && agent-browser install' : undefined };
  checks.config = { ok: fs.existsSync(ctx.configFile), file: ctx.configFile, store: ctx.store, hint: fs.existsSync(ctx.configFile) ? undefined : 'control-shopify init --store <shop>.myshopify.com' };
  const listening = portListening(ctx.port);
  // "Something is listening" is not the same as "our store's dev server is listening".
  // 3 attempts, not 1: the dev proxy 401s intermittently, and a single miss would report a healthy
  // server as "not a Shopify storefront".
  const serving = listening ? identifyServer(`http://127.0.0.1:${ctx.port}/`, 3) : null;
  const servingShop = serving && serving.shop;
  const ownsPort = !listening ? false : (ctx.store ? (!!servingShop && normalizeStore(servingShop) === ctx.store) : true);
  checks.devServer = { ok: listening && ownsPort, port: ctx.port, servingShop: servingShop || null,
    pid: ctx.devState && ctx.devState.pid, alive: ctx.devState ? isAlive(ctx.devState.pid) : false,
    previewUrl: listening ? `http://127.0.0.1:${ctx.port}` : null, shareUrl: ctx.devState && ctx.devState.shareUrl,
    hint: !listening ? 'control-shopify dev start'
      : ownsPort ? undefined
      : servingShop ? `port ${ctx.port} serves ${servingShop} (another project) — control-shopify dev start --port <free>`
      : `port ${ctx.port} is busy but did not identify as a Shopify storefront — dev logs, or use a free --port` };
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
  checks.featureMap = { ok: fs.existsSync(fm) && fs.readFileSync(fm, 'utf8').length > 300, file: fm, hint: fs.existsSync(fm) ? undefined : `write the Feature Map at ${fm} — selectors, click paths and gotchas only` };
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
// Every Shopify storefront inlines `Shopify.shop` and `Shopify.theme = {...}`; use them to learn
// which STORE and which theme a URL actually renders. The shop is the important half: a server
// listening on our port may belong to a completely different project (see assertOwnServer).
function identifyServer(url, attempts = 3) {
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    const res = fetchText(url);
    status = res.status || status;
    const body = res.body || '';
    const ms = body.match(/Shopify\.shop\s*=\s*["']([^"']+)["']/);
    const mt = body.match(/Shopify\.theme\s*=\s*(\{[^;]*\});/);
    let theme = null;
    if (mt) { try { theme = JSON.parse(mt[1]); } catch {} }
    if (ms || theme) return { shop: ms ? ms[1] : null, theme, status };
    sleep(1500 * (i + 1));
  }
  return { shop: null, theme: null, status };
}
function discoverTheme(url, attempts = 3) { return identifyServer(url, attempts).theme; }
// Refuse to use a dev server that is serving somebody else's store. Without this every screenshot,
// assertion silently describes the wrong storefront -- and a foreign theme id gets
// persisted into .shopify/verify/dev.json, which then breaks the next real `dev start`.
function assertOwnServer(ctx, store, context = 'dev server') {
  const id = identifyServer(`http://127.0.0.1:${ctx.port}/`);
  if (id.shop && normalizeStore(id.shop) === normalizeStore(store)) return id;
  const relCfg = path.relative(ctx.root, ctx.configFile) || ctx.configFile;
  if (id.shop) {
    fail(`Port ${ctx.port} is serving ${id.shop}, not ${store}.`,
      `Another project's \`shopify theme dev\` owns this port. Run yours on a free port: control-shopify dev start --port <free>  (and set "port" in ${relCfg}).`,
      { port: ctx.port, servingShop: id.shop, expectedStore: store, context });
  }
  fail(`Could not identify the ${context} on port ${ctx.port}.`,
    'It answered but did not look like a Shopify storefront (502, or still booting). Try `dev logs`, `dev restart`, or a different --port.',
    { port: ctx.port, expectedStore: store, httpStatus: id.status, context });
}
function adoptDevServer(ctx, store) {
  // A dev server is listening but we did not start it. Prove it belongs to THIS store before
  // adopting it, then learn the theme id from the page and persist it.
  const theme = assertOwnServer(ctx, store, 'adopted dev server').theme;
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
    // State recorded for a different port or a different store tells us nothing about the process
    // listening on THIS port -- discard it rather than reporting its theme id against a stranger.
    if (state && ((state.port && Number(state.port) !== Number(ctx.port))
      || (state.store && normalizeStore(state.store) !== store))) state = null;
    // Re-verify identity whenever we cannot prove we own the listener: no state, no theme id, a
    // previously adopted server, or a recorded pid that has died (the port may have been reused).
    const livePid = (state && state.pid && isAlive(state.pid)) ? state.pid : (pid && isAlive(pid) ? pid : null);
    const owned = !!(state && state.themeId && !state.adopted && livePid);
    if (listening && !owned) state = adoptDevServer(ctx, store);
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
// ---------------------------------------------------------------- commands: browser
function baseFor(ctx, target) {
  if (target === 'dev') return `http://127.0.0.1:${ctx.port}`;
  if (target === 'live') return ctx.primaryDomain || `https://${ctx.store}`;
  if (target === 'preview') return `https://${ctx.store}`;
  fail(`Unknown target: ${target}`, '--target dev | preview | live');
}
function resolveUrl(ctx, target, pathOrUrl, country = ctx.country) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const p = pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl;
  const u = new URL(p, baseFor(ctx, target));
  // The dev proxy geolocates from the machine's IP, so it can render a different market than
  // live (ES/EUR vs US/USD). `product.available` is market-dependent, so anything gated on it
  // silently vanishes and dev/live disagree on byte-identical code. Pin it.
  if (country && !u.searchParams.has('country')) u.searchParams.set('country', String(country).toUpperCase());
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
    if (/\/password(\?|$)/.test(cur) && ctx.storePassword) {
      unlockPassword(ctx); ab(ctx, ['open', url]);
      title = abText(ctx, ['get', 'title']); cur = abText(ctx, ['get', 'url']);
    }
    // The dev proxy fails in more ways than the documented 502. It also serves a bare 401 body
    // ("The access token provided is expired, revoked, malformed...") with an EMPTY <title>, and
    // the old check (`title || exit === 0`) accepted that page -- after which every selector
    // matches 0 elements and the run reports a confident, wrong answer. Prove a storefront
    // rendered (Shopify.shop is inlined on every storefront page) before accepting the load.
    const probe = abEval(ctx, `JSON.stringify({ shop: (window.Shopify && Shopify.shop) || null, len: (document.body && document.body.innerText || '').length, head: (document.body && document.body.innerText || '').slice(0, 160) })`);
    let p = probe.value;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
    p = p || {};
    const badTitle = /Failed to render storefront|Bad Gateway|502|503|504/i.test(title);
    const authError = /access token provided is expired|revoked, malformed/i.test(p.head || '');
    const notStorefront = !p.shop && Number(p.len || 0) < 400;
    const bad = badTitle || authError || notStorefront;
    attempts.push({ attempt: i, title, url: cur, exit: r.code, timedOut: r.timedOut,
      shop: p.shop || null, bodyTextLength: p.len == null ? null : p.len,
      reason: !bad ? null : badTitle ? 'storefront error page'
        : authError ? 'dev proxy 401 (expired CLI token)'
        : 'page did not render a storefront' });
    if (!bad) {
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
  if (facts.brokenImages && facts.brokenImages.length) problems.push(`${facts.brokenImages.length} broken image(s)`);
  if (logs.pageErrors.length) problems.push(`${logs.pageErrors.length} uncaught page error(s)`);
  if (ctx.strict && logs.consoleErrors.length) problems.push(`${logs.consoleErrors.length} console error(s)`);
  out({ ok: problems.length === 0, problems, ...facts, ...logs });
  if (problems.length) process.exit(1);
}

// ---------------------------------------------------------------- commands: assert / verify
// One round trip, many DOM assertions. Every check runs inside a single `eval` in the page and is
// individually try/caught, so one bad selector cannot void the rest of the batch.
function buildChecksJs(checks) {
  return `JSON.stringify((() => {
  const specs = ${JSON.stringify(checks)};
  const round = (n) => Math.round(n * 100) / 100;
  const textOf = (els) => els.map((e) => (e.innerText || e.textContent || '')).join('\\n');
  return specs.map((s, i) => {
    const name = s.name || s.selector || ('check ' + (i + 1));
    const r = { name, selector: s.selector || null, ok: true, matched: 0, detail: {} };
    const bad = (why, detail) => { r.ok = false; r.why = why; if (detail) Object.assign(r.detail, detail); };
    try {
      const els = s.selector ? Array.prototype.slice.call(document.querySelectorAll(s.selector)) : [];
      r.matched = els.length;
      if (s.exists === false) { if (els.length) bad('expected no match, found ' + els.length); return r; }
      if (typeof s.count === 'number' && els.length !== s.count) bad('expected count ' + s.count + ', got ' + els.length);
      if (typeof s.minCount === 'number' && els.length < s.minCount) bad('expected at least ' + s.minCount + ', got ' + els.length);
      // Absence checks stay meaningful with zero matches -- run them before the element gate.
      if (s.textNotContains != null) {
        const t = textOf(els);
        if (t.indexOf(s.textNotContains) !== -1) bad('text contains "' + s.textNotContains + '"', { text: t.slice(0, 200) });
      }
      const needsEl = s.exists === true || s.textContains != null || s.textEquals != null || s.attr != null
        || s.css != null || s.centeredIn != null || s.animating != null || s.visible != null;
      if (needsEl && !els.length) { bad('selector matched 0 elements'); return r; }
      if (s.textContains != null) {
        const t = textOf(els);
        if (t.indexOf(s.textContains) === -1) bad('text does not contain "' + s.textContains + '"', { text: t.slice(0, 200) });
      }
      if (s.textEquals != null) { const t = textOf(els).trim(); if (t !== s.textEquals) bad('text is "' + t.slice(0, 120) + '"'); }
      const el = els[0];
      if (s.attr != null) {
        const v = el.getAttribute(s.attr);
        r.detail[s.attr] = v;
        if (s.equals != null && v !== s.equals) bad('attr ' + s.attr + ' = "' + v + '"');
        if (s.contains != null && (v == null || v.indexOf(s.contains) === -1)) bad('attr ' + s.attr + ' does not contain "' + s.contains + '"');
      }
      if (s.css) {
        const cs = getComputedStyle(el);
        Object.keys(s.css).forEach((p) => {
          const got = String(cs.getPropertyValue(p)).trim();
          r.detail[p] = got;
          if (got !== String(s.css[p])) bad('css ' + p + ' = "' + got + '" (want "' + s.css[p] + '")');
        });
      }
      if (s.visible != null) {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const vis = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
        r.detail.visible = vis;
        if (vis !== !!s.visible) bad('visible = ' + vis);
      }
      // The bug class this exists for: an element that is text-align:center inside a box that is
      // itself off-centre still "looks centred" in a screenshot. Compare centres, in pixels.
      if (s.centeredIn != null) {
        const parent = document.querySelector(s.centeredIn);
        if (!parent) { bad('centeredIn selector matched nothing: ' + s.centeredIn); return r; }
        const a = el.getBoundingClientRect(), b = parent.getBoundingClientRect();
        const delta = round((a.left + a.width / 2) - (b.left + b.width / 2));
        const tol = s.tolerance == null ? 2 : s.tolerance;
        r.detail.centerOffsetPx = delta;
        r.detail.child = { left: round(a.left), width: round(a.width) };
        r.detail.container = { left: round(b.left), width: round(b.width) };
        if (Math.abs(delta) > tol) bad('horizontal centre is off by ' + delta + 'px (tolerance ' + tol + 'px)');
      }
      // subtree:true because the animated node is usually a child (a marquee track, a slider rail),
      // and scan EVERY match: a selector like [class*="__stats_marquee"] hits both the section and
      // its background wrapper, and only one of them carries the animation.
      if (s.animating != null) {
        let anims = [];
        els.forEach((node) => {
          try {
            (node.getAnimations ? node.getAnimations({ subtree: true }) : []).forEach((a) => {
              let dur = null;
              try { dur = a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null; } catch (e) {}
              anims.push({ playState: a.playState, durationMs: typeof dur === 'number' ? round(dur) : dur, name: a.animationName || null });
            });
          } catch (e) {}
        });
        const running = anims.filter((a) => a.playState === 'running' && typeof a.durationMs === 'number' && a.durationMs > 0);
        r.detail.animations = anims.slice(0, 6);
        r.detail.runningDurationsMs = running.map((a) => a.durationMs);
        if (!!s.animating !== (running.length > 0)) bad('animating = ' + (running.length > 0));
      }
      return r;
    } catch (e) { bad('check threw: ' + (e && e.message ? e.message : String(e))); return r; }
  });
})())`;
}
function loadSpec(ctx, file) {
  const name = String(file).replace(/^@/, '');
  const candidates = [
    path.isAbsolute(name) ? name : path.join(ctx.root, name),
    path.join(ctx.root, '.claude', 'verify-shopify', 'specs', name),
    path.join(ctx.root, '.claude', 'verify-shopify', 'specs', name + '.json'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) fail(`Spec file not found: ${file}`, `Looked in: ${candidates.join(', ')}`);
  const spec = readJSON(found, null);
  if (!spec) fail(`Spec file is not valid JSON: ${found}`);
  return { file: found, spec: Array.isArray(spec) ? { checks: spec } : spec };
}
function runChecks(ctx, checks) {
  const r = abEval(ctx, buildChecksJs(checks));
  let v = r.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
  if (!Array.isArray(v)) fail('Could not run the checks in the page.', 'Is a page open? Run `open <path>` (or use `verify`, which opens for you).', { raw: String(r.raw).slice(0, 400) });
  return v;
}
function cmdAssert(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  let checks = null; let specFile = null;
  const src = flags.spec || pos[0];
  if (flags.stdin) { try { checks = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { fail('--stdin did not receive valid JSON', String(e.message)); } }
  else if (typeof src === 'string' && /^\s*[[{]/.test(src)) { try { checks = JSON.parse(src); } catch (e) { fail('inline spec is not valid JSON', String(e.message)); } }
  else if (src) { const l = loadSpec(ctx, src); specFile = l.file; checks = l.spec.checks; }
  if (Array.isArray(checks) === false && checks && Array.isArray(checks.checks)) checks = checks.checks;
  if (!Array.isArray(checks) || !checks.length) {
    fail('assert needs checks.', 'assert <spec-name|path> | assert --stdin < spec.json | assert \'[{"selector":"h1","exists":true}]\'');
  }
  const results = runChecks(ctx, checks);
  const failed = results.filter((r) => !r.ok);
  out({ ok: failed.length === 0, specFile, url: abText(ctx, ['get', 'url']), passed: results.length - failed.length, failed: failed.length, checks: results });
  if (failed.length) process.exit(1);
}
// The whole loop in one command: open -> settle -> assert -> check-page -> evidence.
function specsDir(ctx) { return path.join(ctx.root, '.claude', 'verify-shopify', 'specs'); }
function cmdVerifyAll(ctx, rest) {
  const dir = specsDir(ctx);
  if (!fs.existsSync(dir)) fail(`No specs directory: ${dir}`, 'Write a spec first — see SKILL.md "The loop".');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  if (!names.length) fail(`No specs in ${dir}.`, 'Write a spec first — see SKILL.md "The loop".');
  const self = process.argv[1];
  const results = [];
  for (const name of names) {
    const args = [self, 'verify', name, ...rest.filter((a) => a !== '--all')];
    const r = run(process.execPath, args, { timeout: 300000, cwd: ctx.root });
    let parsed = null; try { parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch {}
    results.push(parsed
      ? { spec: name, ok: parsed.ok, route: parsed.route, target: parsed.target, passed: parsed.passed, failed: parsed.failed,
          failures: (parsed.checks || []).filter((c) => !c.ok).map((c) => ({ name: c.name, why: c.why })),
          problems: parsed.problems, screenshot: parsed.screenshot && parsed.screenshot.file }
      : { spec: name, ok: false, error: tail(stripAnsi(r.stderr || r.stdout), 6) });
  }
  const failed = results.filter((r) => !r.ok);
  out({ ok: failed.length === 0, specs: results.length,
    passed: results.length - failed.length, failed: failed.length,
    totalChecks: results.reduce((a, r) => a + (r.passed || 0) + (r.failed || 0), 0),
    results });
  if (failed.length) process.exit(1);
}
function cmdVerify(ctx, rest) {
  const { flags, pos } = parseArgs(rest);
  if (flags.all) return cmdVerifyAll(ctx, rest);
  const store = requireStore(ctx);
  let spec = { checks: [] }; let specFile = null;
  const src = flags.spec || pos[0];
  if (src) { const l = loadSpec(ctx, src); specFile = l.file; spec = l.spec; }
  const route = flags.route || spec.route || '/';
  const target = flags.target || spec.target || ctx.target;
  const country = flags.country || spec.country || ctx.country;
  if (target === 'dev') {
    if (!portListening(ctx.port)) fail(`Nothing is listening on 127.0.0.1:${ctx.port}.`, 'Run `dev start` first (or --target preview|live).');
    assertOwnServer(ctx, store);
  }
  const url = resolveUrl(ctx, target, route, country);
  const opened = openWithRetry(ctx, url, { retries: Number(flags.retries || 3) });
  if (!opened.ok) fail(`Could not open ${url}.`, 'Check `dev logs`; the dev proxy 502s intermittently — or use --target preview.', { attempts: opened.attempts });
  const waitFn = flags['wait-fn'] || spec.waitFn;
  let waited = null;
  if (waitFn) { const w = ab(ctx, ['wait', '--fn', String(waitFn)]); waited = { fn: String(waitFn), ok: w.code === 0 }; }
  const settle = flags.settle || spec.settleMs;
  if (settle) ab(ctx, ['wait', String(settle)]);
  const results = (spec.checks && spec.checks.length) ? runChecks(ctx, spec.checks) : [];
  const failedChecks = results.filter((r) => !r.ok);
  const facts = pageFacts(ctx);
  const logs = consoleLines(ctx);
  const problems = [];
  if (facts.storefrontError) problems.push('storefront 502 page');
  if (facts.textLength !== undefined && facts.textLength < 20) problems.push('page has (almost) no text');
  if (facts.brokenImages && facts.brokenImages.length) problems.push(`${facts.brokenImages.length} broken image(s)`);
  if (logs.pageErrors.length) problems.push(`${logs.pageErrors.length} uncaught page error(s)`);
  if (ctx.strict && logs.consoleErrors.length) problems.push(`${logs.consoleErrors.length} console error(s)`);
  // Hand-over screenshots come from `preview`, not the local proxy (see SKILL.md "Targets").
  let screenshot = null;
  if (flags.screenshot) {
    const shotTarget = flags['screenshot-target'] || (target === 'dev' ? 'preview' : target);
    if (shotTarget !== target) {
      const o2 = openWithRetry(ctx, resolveUrl(ctx, shotTarget, route, country), { retries: 2, quiet: true });
      if (o2.ok && waitFn) ab(ctx, ['wait', '--fn', String(waitFn)]);
      if (o2.ok && settle) ab(ctx, ['wait', String(settle)]);
    }
    const file = evidencePath(ctx, 'verify-' + route);
    const sr = ab(ctx, ['screenshot', ...(flags.full ? ['--full'] : []), file]);
    screenshot = (sr.code === 0 && fs.existsSync(file))
      ? { file, target: shotTarget }
      : { file: null, target: shotTarget, error: tail(stripAnsi(sr.stderr + sr.stdout), 4) };
  }
  const ok = failedChecks.length === 0 && problems.length === 0;
  out({ ok, route, target, country: country || null, url: opened.url, title: opened.title, specFile,
    theme: facts.theme, template: facts.template, waited,
    passed: results.length - failedChecks.length, failed: failedChecks.length, checks: results,
    problems, pageErrors: logs.pageErrors, consoleErrors: logs.consoleErrors, brokenImages: facts.brokenImages, screenshot });
  if (!ok) process.exit(1);
}

// ---------------------------------------------------------------- commands: theme tooling
function changedFiles(ctx) {
  const tracked = run('git', ['-C', ctx.root, 'diff', '--name-only', 'HEAD'], { timeout: 15000 });
  const untracked = run('git', ['-C', ctx.root, 'ls-files', '--others', '--exclude-standard'], { timeout: 15000 });
  if (tracked.code !== 0 && untracked.code !== 0) return null;
  const names = [...tracked.stdout.split('\n'), ...untracked.stdout.split('\n')].map((l) => l.trim()).filter(Boolean);
  return [...new Set(names)];
}
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
    const all = files.flatMap((f) => (f.offenses || []).map((o) => ({ file: f.path, severity: o.severity, check: o.check, message: o.message, line: o.start_row !== undefined ? o.start_row + 1 : undefined })));
    const counts = all.reduce((a, o) => { a[o.severity] = (a[o.severity] || 0) + 1; return a; }, {});
    // A mature theme carries thousands of pre-existing offenses in vendor/legacy files; reporting
    // them all buries the handful you just introduced. Default to the files you actually touched.
    const changed = flags.all ? null : changedFiles(ctx);
    const offenses = changed ? all.filter((o) => changed.some((c) => o.file && o.file.endsWith(c))) : all;
    const scopedCounts = offenses.reduce((a, o) => { a[o.severity] = (a[o.severity] || 0) + 1; return a; }, {});
    out({ ok: offenses.every((o) => o.severity !== 'error'), exitCode: r.code,
      scope: changed ? 'changed files (git); pass --all for the whole theme' : 'whole theme',
      changedFiles: changed || undefined, themeWideCounts: counts, counts: scopedCounts,
      offenses: offenses.slice(0, 100), truncated: offenses.length > 100 });
    if (offenses.some((o) => o.severity === 'error')) process.exit(1);
    return;
  } else {
    process.stdout.write(text + '\n' + stripAnsi(r.stderr));
  }
  if (r.code !== 0) process.exit(r.code);
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

Usage: control-shopify <command> [args]
Globals: --store X --port N --target dev|preview|live --country US --session S --theme ID
         --dry-run --headed --strict --json --timeout MS

Setup & health
  init --store <shop>.myshopify.com [--port 9292] [--primary-domain https://…] [--gitignore] [--force]
  doctor                      node, shopify CLI (+ shadowing installs), agent-browser, config,
                              dev server identity, theme session, store token + scopes
  auth [--scopes a,b] [--dry-run]     shopify store auth (interactive; re-auth REPLACES scopes)
  urls                        dev / preview / live / editor URLs

Dev server
  dev start [--theme ID] [--wait SECONDS] | dev status | stop | restart | logs [--tail N]

Verify — the loop
  verify <spec> [--route /p] [--target …] [--country US] [--screenshot [--full]]
         [--wait-fn "<js>"] [--settle MS] [--retries 3]
                              open -> wait -> assert -> check-page -> screenshot; exit 1 on any failure
  verify --all [--target …]   Run every spec in .claude/verify-shopify/specs/ as a regression suite
  assert <spec|'[{…}]'|--stdin>       Check the page that is already open

  Spec: .claude/verify-shopify/specs/<name>.json
        { "route", "country", "waitFn", "settleMs", "checks": [ … ] }
        Check keys: exists | count | minCount | visible | textContains | textNotContains |
                    textEquals | attr + equals/contains | css | centeredIn + tolerance | animating

Browser (real Chromium, one isolated session per store)
  open <path|url> [--target …] [--retries 3]    Navigate; retries the dev proxy's 502/401 pages
  eval "<js>"                 Run JS in the page — the fastest way to find out why a check failed
  snapshot [-i -c -s <css>]   Accessibility tree with @eN refs
  screenshot [file] [--full]  PNG into .shopify/verify/evidence/ — then Read it; that is the point
  click|fill|type|press|hover|select|wait|get|find|is|console|errors …   forwarded to agent-browser
  check-page                  502? empty body? broken images? uncaught errors?
  close                       Close this store's browser session

Lint
  check [--all] [--fail-level error]  shopify theme check, scoped to files you changed (--all = theme-wide)

Admin API
  gql '<query>' | gql @file.graphql [--variables '{…}'|@vars.json] [--allow-mutations] [--dry-run]

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
    case 'open': return cmdOpen(ctx, withGlobals);
    case 'screenshot': return cmdScreenshot(ctx, rest);
    case 'check-page': return cmdCheckPage(ctx);
    case 'assert': return cmdAssert(ctx, withGlobals);
    case 'verify': return cmdVerify(ctx, withGlobals);
    case 'check': return cmdCheck(ctx, rest);
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
