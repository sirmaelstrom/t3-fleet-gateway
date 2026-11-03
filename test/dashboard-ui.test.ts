import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DashboardSnapshot } from '../src/dashboard/snapshot.ts';
import { APP_URL, assertSafeTree, FakeWindow, loadApp, VIEWS } from './helpers/dashboardApp.ts';
import { FakeDocument, type FakeNode } from './helpers/fakeDom.ts';

const EVIL = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>';
const NOW = '2026-01-15T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

/** Every string the server could carry from untrusted or operator-written input is hostile here. */
function hostileSnapshot(): DashboardSnapshot {
  const job = (id: string, state: DashboardSnapshot['jobs']['open'][number]['state'], link: string | null) => ({
    id, title: `${EVIL} job`, project: EVIL, projectName: EVIL, hostId: 'h1', state, standing: false, origin: 'gateway',
    startedBy: { clientId: 'c1', label: EVIL }, runtimeMode: EVIL, createdAt: ago(60), stateChangedAt: ago(5), updatedAt: ago(5), finishedAt: ago(5),
    waitingFor: state === 'needs_input' ? 'approval' as const : null, pendingQuestions: 0,
    delegated: { following: 1, untracked: 0, endedAt: null }, hostUnreachableSince: ago(3), error: { code: EVIL, detail: EVIL }, link,
  });
  const jobs = [job('j1', 'needs_input', 'javascript:alert(1)'), job('j2', 'failed', 't3-thread://v1/thread-1'), job('j3', 'running', 'https://attacker.example/x')];
  return {
    generatedAt: NOW,
    demoLabel: EVIL,
    gateway: {
      name: 't3-fleet-gateway', version: EVIL, node: 'v24', startedAt: ago(600), publicUrl: EVIL, mcpListen: EVIL,
      engine: { running: true, intervalSeconds: 10, lastTickAt: ago(0) }, database: { schemaVersion: 8, expectedVersion: 8 },
    },
    checks: {
      startedAt: ago(1), finishedAt: ago(1), reused: false,
      results: [
        { id: 'public_url', group: 'gateway', hostId: null, name: EVIL, level: 'fail', code: EVIL, detail: EVIL },
        { id: 'host:h1:t3', group: 'host', hostId: 'h1', name: EVIL, level: 'warn', code: EVIL, detail: EVIL },
      ],
    },
    hosts: [{
      id: 'h1', label: EVIL, transportNote: EVIL, t3Url: EVIL, loopback: false, status: { tone: 'bad', label: EVIL },
      reachability: { state: 'unreachable', checkedAt: ago(1), t3Version: EVIL, errorCode: EVIL, detail: EVIL },
      engine: { unreachableSince: ago(4), nextAttemptAt: ago(-1), failures: 2, errorCode: EVIL }, jobsUnreachableSince: ago(4),
      credential: { state: 'renewal_due', expiresAt: ago(-3000), daysLeft: 2, renewalError: { code: EVIL, at: ago(30), detail: EVIL } },
      access: EVIL, capacity: { max: 2, used: 5, queued: 1, open: 3, standingOpen: 1 },
      discovery: { enabled: true, allowWorkStart: true, runtimeMode: EVIL },
      projects: [{ alias: EVIL, description: EVIL, runtimeMode: EVIL, allowWorkStart: false, modelConfigured: false, openJobs: 1, standingJobs: 1 }],
      discoveredOpenJobs: 1,
    }],
    clients: {
      items: [{
        id: 'c1', label: EVIL, registeredName: `${EVIL}2`, kind: 'oauth', redirectOrigins: [EVIL],
        access: { text: EVIL, operate: [EVIL], read: 'all', unconfiguredHosts: [EVIL], approved: EVIL },
        grant: { state: 'unusable', usableAccess: false, usableRefresh: false, accessUsableUntil: null, refreshUsableUntil: null, families: 2,
          revokedFamilies: [{ at: ago(10), reason: EVIL, detail: EVIL }] },
        observed: { lastMcpSuccessAt: null, lastRefreshSuccessAt: ago(100), lastUsedAt: ago(100) },
        createdAt: ago(1000), revokedAt: null, status: { tone: 'bad', label: EVIL, detail: EVIL },
      }],
      total: 1,
      pending: { count: 1, recent: [{ id: 'p1', name: EVIL, createdAt: ago(20) }] },
    },
    jobs: { counts: { queued: 0, dispatching: 0, running: 1, needs_input: 1, idle: 0, cancel_requested: 0, cancelled: 0, failed: 1, unknown: 0, released: 0 },
      open: jobs.filter((item) => item.state !== 'failed'), openTotal: 2, recent: jobs.filter((item) => item.state === 'failed'), attention: jobs },
    events: [{ id: 1, at: ago(2), jobId: 'j1', hostId: 'h1', project: EVIL, type: 'state_changed', fromState: 'running', toState: 'needs_input', reason: EVIL, code: EVIL, summary: EVIL }],
    attention: [
      { tone: 'bad', kind: 'job', ref: 'j1', title: EVIL, detail: EVIL, at: ago(1), action: { kind: 'link', label: EVIL, href: 'javascript:alert(1)' } },
      { tone: 'warn', kind: 'host', ref: 'h1', title: EVIL, detail: EVIL, at: null, action: { kind: 'command', label: EVIL, command: EVIL } },
      { tone: 'info', kind: 'client', ref: 'c1', title: EVIL, detail: EVIL, at: null, action: { kind: 'view', label: EVIL, view: '../../evil"' } },
    ],
  } as DashboardSnapshot;
}

const actions = () => {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      refresh: () => calls.push('refresh'),
      runChecks: () => calls.push('runChecks'),
      setJobFilter: (filter: unknown) => calls.push(`filter:${String(filter)}`),
      copy: (text: unknown) => calls.push(`copy:${String(text)}`),
    },
  };
};

describe('dashboard page: safe rendering', () => {
  test('the browser code has no HTML-parsing, eval, storage or cookie APIs, and the page shell no inline code', () => {
    // Comments name the forbidden APIs; code must not use them.
    const source = readFileSync(APP_URL, 'utf8').replaceAll(/^\s*\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /localStorage/, /sessionStorage/, /document\.cookie/, /\.style\s*=/, /setAttribute\(\s*['"]style/]) {
      assert.equal(pattern.test(source), false, String(pattern));
    }
    const html = readFileSync(new URL('../src/dashboard/assets/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=|https?:\/\//i);
    const css = readFileSync(new URL('../src/dashboard/assets/app.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /url\(|@import|https?:/, 'no external or embedded resources in the stylesheet');
  });

  test('hostile text renders as text in every view; unsafe links are dropped', async () => {
    const app = await loadApp();
    const snap = hostileSnapshot();
    for (const view of VIEWS) {
      const doc = new FakeDocument();
      const root = doc.createElement('div');
      const { handlers } = actions();
      app.render(doc, root, { snapshot: snap, route: { view, id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
      assertSafeTree(root);
      assert.ok(root.textContent.includes(EVIL), `${view} shows hostile text verbatim, as text`);
      const hrefs = root.elements('a').map((link) => link.getAttribute('href'));
      assert.equal(hrefs.some((href) => href?.startsWith('javascript') || href?.startsWith('https://attacker')), false, view);
    }
  });

  test('a thread link of the documented form is kept; the job and its actions are wired', async () => {
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const { calls, handlers } = actions();
    const model = { snapshot: hostileSnapshot(), route: { view: 'jobs', id: null }, error: null, notice: null, loading: false, checking: false, fetchedAt: Date.parse(NOW), jobFilter: 'attention' };
    app.render(doc, root, model, handlers, Date.parse(NOW));
    const threadLinks = root.elements('a').filter((link) => link.getAttribute('href')?.startsWith('t3-thread:'));
    assert.deepEqual(threadLinks.map((link) => link.getAttribute('href')), ['t3-thread://v1/thread-1'], 'only the safe link of the three');
    root.click('Open');
    assert.deepEqual(calls, ['filter:open']);
    app.render(doc, root, { ...model, route: { view: 'checks', id: null } }, handlers, Date.parse(NOW));
    root.click('Run checks');
    app.render(doc, root, { ...model, route: { view: 'overview', id: null } }, handlers, Date.parse(NOW));
    root.click('Copy');
    assert.deepEqual(calls, ['filter:open', 'runChecks', `copy:${EVIL}`]);
  });

  test('an adopted thread is distinguished from an operator standing job', async () => {
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const snapshot = hostileSnapshot();
    snapshot.jobs.attention[0]!.origin = 'adopted';
    snapshot.jobs.attention[0]!.standing = true;
    app.render(doc, root, { snapshot, route: { view: 'jobs', id: null }, error: null, notice: null, loading: false, checking: false,
      fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, actions().handlers, Date.parse(NOW));
    assert.ok(root.textContent.includes('adopted'));
    assertSafeTree(root);
  });

  test('loading, error and busy states; unknown times are never invented', async () => {
    const app = await loadApp();
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const { handlers } = actions();
    app.render(doc, root, { snapshot: null, route: { view: 'overview', id: null }, error: 'The gateway did not answer.', notice: null, loading: true, checking: false, fetchedAt: 0, jobFilter: 'attention' }, handlers);
    assert.match(root.textContent, /The gateway did not answer\./);
    assert.equal(root.getAttribute('aria-busy'), 'true');
    const snap = hostileSnapshot();
    app.render(doc, root, { snapshot: snap, route: { view: 'clients', id: 'c1' }, error: null, notice: null, loading: false, checking: true, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
    assert.match(root.textContent, /Last successful requestunknown/, 'a null success time reads unknown');
    assert.ok(root.elements('article').some((card) => card.getAttribute('class')?.includes('is-selected')), 'the linked client is highlighted');
    app.render(doc, root, { snapshot: snap, route: { view: 'checks', id: null }, error: null, notice: null, loading: false, checking: true, fetchedAt: Date.parse(NOW), jobFilter: 'attention' }, handlers, Date.parse(NOW));
    const busy = root.elements('button').find((button) => button.textContent.includes('Checking'));
    assert.equal(busy?.getAttribute('aria-busy'), 'true');
    assert.equal(busy?.getAttribute('disabled'), '');
  });

  test('routes and links are parsed strictly', async () => {
    const app = await loadApp();
    assert.deepEqual(app.parseRoute('#/hosts/forge'), { view: 'hosts', id: 'forge' });
    assert.deepEqual(app.parseRoute('#/webhooks/connect'), { view: 'webhooks', id: 'connect' });
    assert.deepEqual(app.parseRoute('#/clients/a"b'), { view: 'clients', id: null });
    assert.deepEqual(app.parseRoute('#/nowhere'), { view: 'overview', id: null });
    assert.deepEqual(app.parseRoute(''), { view: 'overview', id: null });
    for (const good of ['#/jobs', '#/hosts/forge', 't3-thread://v1/abc-1']) assert.equal(app.safeHref(good), true, good);
    for (const bad of ['javascript:alert(1)', 'https://example.com', '//evil', 't3-thread://v1/a b', 't3-thread://v2/x', '#/x"y', 'data:text/html,x', null]) {
      assert.equal(app.safeHref(bad), false, String(bad));
    }
  });
});

const WEBHOOK_URL = 'https://hooks.example.test/private-synthetic-route';
const AUTH_HEADER = 'Authorization: Bearer synthetic-private-key';
const webhookRow = (source: 'config' | 'dashboard' = 'dashboard') => ({
  id: source === 'dashboard' ? 'ui-connection' : 'file-connection', revision: 3, source, enabled: true,
  displayName: 'alpha', projects: ['alpha'], hosts: ['h1'], lastTest: { at: NOW, outcome: 'delivered', statusCode: 202 },
});
type WebhookRow = ReturnType<typeof webhookRow>;

async function webhookPage(options: {
  connections?: WebhookRow[];
  projects?: { alias: string; host: string; projectId?: string; name?: string; label: string }[];
  hosts?: { host: string; status: string }[];
  post?: (path: string, body: Record<string, unknown>) => Promise<Response> | Response;
} = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.append(root);
  const posts: { path: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  let reads = 0;
  let rows = options.connections ?? [];
  let session = 'synthetic-session';
  const win = new FakeWindow(async (path, init = {}) => {
    assert.equal(new Headers(init.headers).get('x-t3fg-dashboard'), '1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    if (path === 'api/snapshot') return Response.json(hostileSnapshot());
    if (path === 'api/webhooks') {
      reads++;
      assert.equal(init.method ?? 'GET', 'GET');
      return Response.json({ projects: options.projects ?? [{ alias: 'alpha', host: 'h1', label: 'alpha' }, { alias: 'beta', host: 'h2', label: 'beta' }], hosts: options.hosts ?? [], connections: rows, session });
    }
    assert.match(path, /^api\/webhooks\/(connect|replace|test|disconnect)$/);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.match(String(body.requestId), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(body.session, session);
    posts.push({ path, body, init });
    if (options.post) return options.post(path, body);
    if (path.endsWith('/connect')) rows = [...rows, webhookRow()];
    if (path.endsWith('/disconnect')) rows = rows.filter((row) => row.id !== body.id);
    return Response.json({ ok: true, code: path.split('/').at(-1), test: { outcome: 'delivered', statusCode: 202 } });
  });
  const app = await loadApp();
  await app.boot(win, doc).ready;
  const button = (label: string) => {
    const node = root.elements('button').find((item) => item.textContent === label);
    assert.ok(node, `button ${label} exists`);
    return node;
  };
  const field = (id: string) => {
    const node = doc.getElementById(id);
    assert.ok(node, `field ${id} exists`);
    return node;
  };
  const form = () => {
    const node = root.elements('form')[0];
    assert.ok(node, 'setup form exists');
    return node;
  };
  const fill = (url = WEBHOOK_URL) => {
    field('webhook-url').value = url;
    field('webhook-auth').value = AUTH_HEADER;
  };
  const assertNoSecrets = () => {
    const all = [...doc.body.walk()].map((node) => [node.textContent, node.value, ...node.attributes.values()].join(' ')).join(' ');
    for (const secret of [WEBHOOK_URL, AUTH_HEADER, 'synthetic-private-key', session]) assert.equal(all.includes(secret), false, `no ${secret}`);
    assertSafeTree(root);
  };
  return { app, doc, root, win, posts, button, field, form, fill, assertNoSecrets,
    reads: () => reads, setSession: (next: string) => { session = next; }, setConnections: (next: WebhookRow[]) => { rows = next; } };
}

describe('dashboard webhook connections: running browser handlers', () => {
  test('connection cards render the gateway display name without resolving project names', async () => {
    const page = await webhookPage({ connections: [{ ...webhookRow(), displayName: 'Gateway supplied name' }] });
    const card = page.root.elements('article')[0]!;
    assert.equal(card.elements('h3')[0]!.textContent, 'Gateway supplied name');
    assert.equal(card.getAttribute('aria-label'), 'Connection for Gateway supplied name on h1');
  });

  test('overview entry and setup use two accessible paste fields, configured projects and a safe private-panel prompt', async () => {
    const page = await webhookPage();
    assert.equal(page.root.elements('input').filter((node) => ['webhook-url', 'webhook-auth'].includes(node.getAttribute('id') ?? '')).length, 2, 'two receiver fields');
    assert.equal(page.root.elements('input').filter((node) => node.getAttribute('type') === 'password').length, 1, 'one complete auth field');
    assert.equal(page.field('webhook-auth').getAttribute('type'), 'password');
    for (const id of ['webhook-url', 'webhook-auth', 'webhook-project']) {
      assert.ok(page.root.elements('label').some((label) => label.getAttribute('for') === id));
      assert.ok(page.doc.getElementById(page.field(id).getAttribute('aria-describedby')!));
    }
    assert.deepEqual(page.field('webhook-project').elements('option').map((option) => option.textContent), ['alpha', 'beta']);
    assert.deepEqual(page.field('webhook-project').elements('optgroup').map((group) => group.getAttribute('label')), ['h1', 'h2']);
    assert.match(page.root.textContent, /POST to/);
    assert.match(page.root.textContent, /value labelled “header”/);
    assert.match(page.root.textContent, /Reply excerpts are off/);
    assert.match(page.root.textContent, /ready for follow-up, needs input, failed, cancelled, delegated work ended, credential alerts and resolutions/);
    await page.button('Copy setup prompt').dispatch('click');
    assert.match(page.win.copied[0]!, /clickable links to its Webhook URL, Webhook key and Authorization header panels/);
    assert.match(page.win.copied[0]!, /do not print the key or header value/);
    page.assertNoSecrets();
    page.win.location.hash = '#/overview';
    await page.win.dispatch('hashchange');
    assert.ok(page.root.elements('a').some((node) => node.textContent === 'Connect Grok Bot' && node.getAttribute('href') === '#/webhooks/connect'));
  });

  test('connect submits JSON once, clears detached inputs before awaiting, then reports accepted rather than bot completion', async () => {
    const pending = Promise.withResolvers<Response>();
    const page = await webhookPage({ post: () => pending.promise });
    page.fill();
    page.field('webhook-project').value = 'beta';
    const oldForm = page.form();
    const url = page.field('webhook-url');
    const auth = page.field('webhook-auth');
    const sending = oldForm.dispatch('submit');
    assert.equal(page.posts.length, 1);
    assert.equal(url.value, '');
    assert.equal(auth.value, '');
    assert.equal(page.button('Sending test…').getAttribute('disabled'), '');
    assert.equal(page.button('Sending test…').getAttribute('aria-busy'), 'true');
    await oldForm.dispatch('submit');
    assert.equal(page.posts.length, 1, 'a repeated submit cannot create a second request while awaiting the first');
    assert.equal(page.posts[0]!.body.project, 'beta');
    assert.equal(page.posts[0]!.body.url, WEBHOOK_URL);
    assert.equal(page.posts[0]!.body.authHeader, AUTH_HEADER);
    page.assertNoSecrets();
    pending.resolve(Response.json({ ok: true, code: 'connected', test: { outcome: 'delivered', statusCode: 202 } }));
    await sending;
    assert.match(page.root.textContent, /Connected\. Test accepted\. Check the bot conversation; the bot may still be working/);
    assert.equal(page.root.elements('form').length, 0);
    assert.equal(page.reads(), 2, 'successful setup reloads the safe list');
    page.assertNoSecrets();
  });

  test('HTTP refusal and timeout show fixed safe guidance, leave blank inputs, and do not reflect server text', async () => {
    for (const failure of [{ outcome: 'http_error', statusCode: 401 }, { outcome: 'timeout', statusCode: null }]) {
      const page = await webhookPage({ post: () => Response.json({ error: 'ping_failed', test: failure,
        message: `${WEBHOOK_URL} ${AUTH_HEADER}`, details: EVIL }, { status: 422 }) });
      page.fill();
      await page.form().dispatch('submit');
      assert.match(page.root.textContent, /No connection was saved/);
      assert.match(page.root.textContent, failure.statusCode ? /HTTP 401/ : /Timed out/);
      assert.equal(page.field('webhook-url').value, '');
      assert.equal(page.field('webhook-auth').value, '');
      page.assertNoSecrets();
    }
  });

  test('failed replacement keeps the existing connection and supports both a changed URL and retaining the URL', async () => {
    const page = await webhookPage({ connections: [webhookRow()], post: () => Response.json({ error: 'ping_failed',
      test: { outcome: 'http_error', statusCode: 401 } }, { status: 422 }) });
    await page.button('Replace key').dispatch('click');
    assert.match(page.root.textContent, /If you recreated the routine, paste its new URL and full authorization header/);
    assert.equal(page.field('webhook-url').getAttribute('required'), null);
    assert.equal(page.root.elements('select').length, 0, 'replacement preserves the project');
    page.fill();
    await page.form().dispatch('submit');
    assert.equal(page.posts[0]!.body.id, 'ui-connection');
    assert.equal(page.posts[0]!.body.revision, 3);
    assert.equal(page.posts[0]!.body.url, WEBHOOK_URL);
    assert.match(page.root.textContent, /The current connection was kept/);
    assert.match(page.root.textContent, /Connections \(1\)/);
    page.fill('');
    await page.form().dispatch('submit');
    assert.equal(Object.hasOwn(page.posts[1]!.body, 'url'), false, 'blank URL means retain; it is never fetched into the form');
    assert.equal(page.posts[1]!.body.authHeader, AUTH_HEADER);
    assert.notEqual(page.posts[1]!.body.requestId, page.posts[0]!.body.requestId, 'corrected values are a new explicit operation');
    page.assertNoSecrets();
  });

  test('disconnect requires confirmation; file-managed rows can only send tests', async () => {
    const page = await webhookPage({ connections: [webhookRow(), webhookRow('config')] });
    const cards = page.root.elements('article');
    const fileCard = cards.find((card) => card.textContent.includes('File-managed'))!;
    assert.ok(fileCard);
    assert.deepEqual(fileCard.elements('button').map((button) => button.textContent), ['Send test']);
    await page.button('Disconnect').dispatch('click');
    assert.equal(page.posts.length, 0);
    assert.match(page.root.textContent, /A request already being sent may still arrive/);
    await page.button('Keep connection').dispatch('click');
    assert.equal(page.root.elements().some((node) => node.getAttribute('aria-label') === 'Confirm disconnect'), false);
    await page.button('Disconnect').dispatch('click');
    await page.button('Yes, disconnect').dispatch('click');
    assert.equal(page.posts.length, 1);
    assert.equal(page.posts[0]!.path, 'api/webhooks/disconnect');
    assert.equal(page.posts[0]!.body.id, 'ui-connection');
    assert.equal(page.posts[0]!.body.revision, 3);
    assert.equal(Object.hasOwn(page.posts[0]!.body, 'url'), false);
    assert.equal(Object.hasOwn(page.posts[0]!.body, 'authHeader'), false);
    assert.match(page.root.textContent, /Connections \(1\)/);
    assert.match(page.root.textContent, /Disconnected\. Queued notifications were cancelled/);
    page.assertNoSecrets();
  });

  test('test buttons use only id and revision, prevent competing clicks, and show a conflict safely', async () => {
    const pending = Promise.withResolvers<Response>();
    const page = await webhookPage({ connections: [webhookRow()], post: () => pending.promise });
    const testButton = page.button('Send test');
    const sending = testButton.dispatch('click');
    await testButton.dispatch('click');
    assert.equal(page.posts.length, 1);
    assert.equal(page.button('Disconnect').getAttribute('disabled'), '');
    assert.equal(page.button('Replace key').getAttribute('disabled'), '');
    assert.deepEqual(Object.keys(page.posts[0]!.body).sort(), ['id', 'requestId', 'revision', 'session']);
    pending.resolve(Response.json({ error: 'conflict', message: AUTH_HEADER }, { status: 409 }));
    await sending;
    assert.match(page.root.textContent, /changed while the test was running/);
    assert.equal(page.button('Send test').getAttribute('disabled'), null);
    page.assertNoSecrets();
  });

  test('refreshing existing connections is safe and closes an outdated replacement without rebasing its revision', async () => {
    const page = await webhookPage({ connections: [webhookRow()] });
    await page.button('Replace key').dispatch('click');
    page.fill();
    const oldAuth = page.field('webhook-auth');
    page.setConnections([{ ...webhookRow(), revision: 4 }]);
    await page.button('Refresh').dispatch('click');
    assert.equal(oldAuth.value, '');
    assert.equal(page.root.elements('form').length, 0, 'operator must reopen replacement after another edit');
    assert.equal(page.button('Replace key').getAttribute('disabled'), null);
    await page.button('Replace key').dispatch('click');
    page.fill();
    await page.form().dispatch('submit');
    assert.equal(page.posts[0]!.body.revision, 4);
    page.assertNoSecrets();
  });

  test('closing, navigating and leaving the page clear the original input nodes', async () => {
    const page = await webhookPage();
    const assertCleared = (fields: FakeNode[]) => fields.forEach((field) => assert.equal(field.value, ''));
    page.fill();
    let fields = [page.field('webhook-url'), page.field('webhook-auth')];
    await page.button('Close').dispatch('click');
    assertCleared(fields);
    assert.equal(page.root.elements('form').length, 0);
    await page.button('Connect Grok Bot').dispatch('click');
    page.fill();
    fields = [page.field('webhook-url'), page.field('webhook-auth')];
    page.win.location.hash = '#/clients';
    await page.win.dispatch('hashchange');
    assertCleared(fields);
    page.win.location.hash = '#/webhooks';
    await page.win.dispatch('hashchange');
    page.fill();
    fields = [page.field('webhook-url'), page.field('webhook-auth')];
    await page.win.dispatch('pagehide');
    assertCleared(fields);
    page.assertNoSecrets();
    assert.equal(page.posts.length, 0);
  });

  test('returning from Grok after a minute preserves partially pasted setup; explicit Refresh still clears it', async (t) => {
    const page = await webhookPage();
    page.field('webhook-url').value = WEBHOOK_URL;
    const url = page.field('webhook-url');
    const later = Date.now() + 61_000;
    t.mock.method(Date, 'now', () => later);
    page.doc.visibilityState = 'hidden';
    await page.doc.dispatch('visibilitychange');
    page.doc.visibilityState = 'visible';
    await page.doc.dispatch('visibilitychange');
    assert.equal(page.reads(), 1, 'no automatic request while the setup form is open');
    assert.equal(url.value, WEBHOOK_URL);
    assert.equal(page.field('webhook-url'), url, 'the partly completed form is not replaced');
    await page.button('Refresh').dispatch('click');
    assert.equal(page.reads(), 2);
    assert.equal(url.value, '');
    page.assertNoSecrets();
  });

  test('a lost response is not replayed, raw errors are hidden, and restart requires another explicit action with the refreshed session', async () => {
    const page = await webhookPage({ post: () => { throw new Error(`${AUTH_HEADER} ${WEBHOOK_URL}`); } });
    page.fill();
    await page.form().dispatch('submit');
    assert.equal(page.posts.length, 1);
    assert.match(page.root.textContent, /did not confirm the result/);
    assert.equal(page.reads(), 2);
    page.assertNoSecrets();

    let first = true;
    const restarted = await webhookPage({ post: () => {
      if (first) {
        first = false;
        restarted.setSession('new-synthetic-session');
        return Response.json({ error: 'session_expired' }, { status: 409 });
      }
      return Response.json({ ok: true, code: 'connected' });
    } });
    restarted.fill();
    await restarted.form().dispatch('submit');
    assert.match(restarted.root.textContent, /gateway restarted/);
    assert.equal(restarted.posts.length, 1);
    restarted.fill();
    await restarted.form().dispatch('submit');
    assert.equal(restarted.posts[1]!.body.session, 'new-synthetic-session');
    restarted.assertNoSecrets();
  });
});

test('job PR badges show number and state without adding arbitrary links', async () => {
  const app = await loadApp();
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const snap = hostileSnapshot();
  snap.jobs.open[0]!.pullRequests = [{ number: 21, state: 'open' }, { number: 22, state: 'merged' }];
  app.render(doc, root, { snapshot: snap, route: { view: 'jobs', id: null }, jobFilter: 'open' }, actions().handlers, Date.parse(NOW));
  assert.match(root.textContent, /PR #21 open/);
  assert.match(root.textContent, /PR #22 merged/);
  assertSafeTree(root);
});


test('webhook picker renders gateway labels grouped by host and explains unavailable hosts without hiding usable choices', async () => {
  const key = JSON.stringify(['host-b', 'project-1']);
  const page = await webhookPage({ projects: [
    { alias: 'local-alias', host: 'host-a', label: 'Server alias label' },
    { alias: key, host: 'host-b', projectId: 'project-1', name: 'Synthetic reader', label: 'Server project label' },
  ], hosts: [{ host: 'host-c', status: 'unavailable' }] });
  const picker = page.field('webhook-project');
  assert.deepEqual(picker.elements('optgroup').map((g) => g.getAttribute('label')), ['host-a', 'host-b']);
  assert.deepEqual(picker.elements('option').map((o) => o.textContent), ['Server alias label', 'Server project label']);
  assert.match(page.root.textContent, /host-c: unavailable/);
  assert.ok(picker.elements('option').some((o) => o.getAttribute('value') === key));
});

test('settlement browser action confirms, retains request id on error, then updates attention', async () => {
  const app = await loadApp();
  const doc = new FakeDocument();
  const root = doc.createElement('main');
  root.setAttribute('id', 'app');
  doc.body.append(root);
  const snap = hostileSnapshot();
  snap.attention = [{ tone: 'bad', kind: 'job', ref: 'j2', title: 'Synthetic failed job', detail: 'Run failed', at: NOW, action: null }];
  const posts: { jobId: string; requestId: string }[] = [];
  const win = new FakeWindow(async (url, init) => {
    if (url === 'api/snapshot') return Response.json(snap);
    assert.equal(url, 'api/jobs/settle');
    assert.equal((init?.headers as Record<string, string>)['x-t3fg-dashboard'], '1');
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length === 1) return Response.json({ error: 'job_state_conflict', detail: 'Settlement scan limit reached.' }, { status: 409 });
    return Response.json({ snapshot: { ...snap, attention: [], jobs: { ...snap.jobs, attention: [] } } });
  });
  win.location.hash = '#/overview';
  await app.boot(win, doc).ready;
  const click = async (label: string) => {
    const node = root.elements('button').find((item) => item.textContent === label);
    assert.ok(node, label);
    await node.dispatch('click');
  };
  await click('Settle');
  assert.equal(posts.length, 0, 'confirmation does not write');
  await click('Keep open');
  assert.equal(posts.length, 0);
  await click('Settle');
  await click('Confirm settle');
  assert.match(root.textContent, /Settlement scan limit/);
  assert.match(root.textContent, /Synthetic failed job/);
  await click('Confirm settle');
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.requestId, posts[1]!.requestId);
  assert.equal(posts[0]!.jobId, 'j2');
  assert.doesNotMatch(root.textContent, /Synthetic failed job/);
  assert.match(root.textContent, /Thread settled/);
  assertSafeTree(root);
});

test('precise dashboard filters submit bounded JSON lists and render health as text', async () => {
  const page = await webhookPage();
  page.fill();
  page.field('webhook-project').value = 'alpha';
  page.field('webhook-jobs').value = 'job-a, job-b';
  page.field('webhook-clients').value = 'client-a';
  page.field('webhook-events').value = 'idle, needs_input';
  await page.form().dispatch('submit');
  assert.deepEqual(page.posts[0]!.body.jobs, ['job-a', 'job-b']);
  assert.deepEqual(page.posts[0]!.body.clients, ['client-a']);
  assert.deepEqual(page.posts[0]!.body.events, ['idle', 'needs_input']);
  assert.match(page.root.textContent, /Failure streak/);
  assert.match(page.root.textContent, /Dead-lettered events/);
  page.assertNoSecrets();
});

test('dashboard re-pair runs only after explicit confirmation and disables duplicate clicks', async () => {
  const app = await loadApp();
  const doc = new FakeDocument();
  const root = doc.createElement('div'); root.setAttribute('id', 'app'); doc.body.append(root);
  const snap = hostileSnapshot();
  const calls: { url: string; body: Record<string, string> }[] = [];
  const win = new FakeWindow(async (url, init) => {
    if (url === 'api/snapshot') return Response.json(snap);
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    if (url.endsWith('/prepare')) return Response.json({ confirmationId: 'synthetic-confirmation' });
    return Response.json({ ok: true, snapshot: snap });
  });
  win.location.hash = '#/hosts';
  await app.boot(win, doc).ready;
  const button = (text: string) => root.elements('button').find((node) => node.textContent === text)!;
  await button('Re-pair').dispatch('click');
  assert.deepEqual(calls.map((call) => call.url), ['api/hosts/repair/prepare']);
  assert.match(root.textContent, /old credential stays until the replacement is verified/);
  await button('Cancel').dispatch('click');
  assert.equal(calls.length, 1);
  await button('Re-pair').dispatch('click');
  await button('Confirm re-pair').dispatch('click');
  assert.equal(calls.at(-1)!.url, 'api/hosts/repair/confirm');
  assert.equal(calls.at(-1)!.body.confirmationId, 'synthetic-confirmation');
  assert.match(root.textContent, /Credential verified and installed/);
  assertSafeTree(root);
});
