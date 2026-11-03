import { isThreadLink } from './threadId.js';

// t3-fleet-gateway operator dashboard: monitoring and private webhook connections.
//
// Security rules for this file, checked by test/dashboard-ui.test.ts:
// - The DOM is built with createElement, createTextNode and setAttribute only. No innerHTML, outerHTML,
//   insertAdjacentHTML, document.write, eval or Function: every value from the server is text, never markup.
// - Links are hash routes inside the dashboard or validated T3 v1/v2 thread links.
// - No browser storage or cookies. Pasted webhook credentials live only in the form and its outgoing request,
//   are cleared before awaiting a submission, and are never received back from the server.

const API_HEADER = 'x-t3fg-dashboard';
const SAFE_ROUTE = /^#\/[A-Za-z0-9/_-]*$/;
const VIEWS = ['overview', 'clients', 'hosts', 'jobs', 'checks', 'webhooks'];
const SETUP_PROMPT = 'For the routine I want to connect, send clickable links to its Webhook URL, Webhook key and Authorization header panels. Send private panel links only; do not print the key or header value.';
const WEBHOOK_ERRORS = {
  invalid_request: 'Check the fields and paste a full authorization header, including its name and colon.',
  invalid_route: 'Use an HTTPS webhook URL and a valid full authorization header.',
  project_not_found: 'That project is no longer configured. Refresh and choose a project again.',
  not_found: 'This connection was disconnected. Refresh the list before continuing.',
  conflict: 'This connection changed while the test was running. Refresh the list before trying again.',
  file_managed: 'This connection is managed in the gateway configuration file.',
  subscription_limit: 'The gateway has reached its limit of 32 webhook connections.',
  busy: 'Another connection operation is still running. Wait a moment and try again.',
  session_expired: 'The gateway restarted. Refresh this page before trying again.',
  request_conflict: 'This request has already been used. Refresh before trying again.',
  request_limit: 'Refresh this page before starting another connection operation.',
  unavailable: 'Connection management is not ready. The gateway may be starting or stopping.',
};
const WEBHOOK_TESTS = {
  delivered: 'Accepted', timeout: 'Timed out', network_error: 'Could not reach the receiver',
  http_error: 'Receiver refused the test', redirect: 'Receiver redirected the test',
  tls_error: 'Could not verify the receiver’s secure connection', response_too_large: 'Receiver response exceeded the limit',
  stopped: 'Test stopped', cancelled: 'Test stopped', abandoned: 'Test interrupted', expired: 'Test expired',
};

function webhookTestText(test) {
  const status = Number.isInteger(test?.statusCode) && test.statusCode >= 100 && test.statusCode <= 599
    ? ` (HTTP ${test.statusCode})` : '';
  return `${Object.hasOwn(WEBHOOK_TESTS, test?.outcome) ? WEBHOOK_TESTS[test.outcome] : 'Test did not succeed'}${status}`;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Coming back to the tab after this long reloads the snapshot (database reads only; T3 is never contacted). */
const STALE_MS = 60_000;

export function safeHref(value) {
  return typeof value === 'string' && (SAFE_ROUTE.test(value) || isThreadLink(value));
}

const ICONS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 3.8 2.9 19.5h18.2L12 3.8z', 'M12 10v4.2', 'M12 17.1v.1'],
  bad: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 9l6 6M15 9l-6 6'],
  x: ['M7 7l10 10M17 7 7 17'],
  question: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.6', 'M12 17.1v.1'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5.5', 'M12 7.9v.1'],
  refresh: ['M20 11a8 8 0 0 0-14.6-4.5L4 8', 'M4 3.5V8h4.5', 'M4 13a8 8 0 0 0 14.6 4.5L20 16', 'M20 20.5V16h-4.5'],
  pulse: ['M3 12h4l2.5-6 5 12 2.5-6H21'],
  overview: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  clients: ['M12 3v3', 'M5 9a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z', 'M9.5 11.5v1M14.5 11.5v1', 'M2.5 11v2.5M21.5 11v2.5', 'M9.5 21h5'],
  hosts: ['M4 4.5h16v6.5H4zM4 13h16v6.5H4z', 'M8 7.8h.01M8 16.2h.01', 'M12 7.8h4M12 16.2h4'],
  jobs: ['M9 6h11M9 12h11M9 18h11', 'M4 6h.01M4 12h.01M4 18h.01'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  key: ['M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M10.9 12.1 19 4', 'M15.5 7.5 18 10', 'M13.5 9.5 15.5 11.5'],
  shield: ['M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z', 'M9 12l2 2 4-4'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  gauge: ['M4 18a8 8 0 1 1 16 0', 'M12 18l3.5-5'],
  sliders: ['M4 7h9M17 7h3M4 17h4M12 17h8', 'M15 5v4M10 15v4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  branch: ['M6 4v10', 'M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 9a7 7 0 0 1-7 7H8'],
};

const TONE_ICON = { good: 'check', warn: 'alert', bad: 'bad', unknown: 'question', info: 'info' };
const TONE_RANK = { bad: 0, warn: 1, unknown: 2, info: 3, good: 4 };

// ------------------------------------------------------------------------------------------------ DOM helpers

export function dom(doc) {
  function append(parent, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      parent.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
    }
    return parent;
  }
  function h(tag, attrs, ...children) {
    const el = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'on') {
        for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
        continue;
      }
      // Event handlers only through `on`; links only to dashboard routes and T3 threads.
      if (/^on/i.test(name) || name === 'style' || name === 'srcdoc') throw new Error(`refusing attribute ${name}`);
      if (name === 'href' && !safeHref(value)) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
    return append(el, children);
  }
  function icon(name, cls) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [attr, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(attr, value);
    if (cls) svg.setAttribute('class', cls);
    for (const d of ICONS[name] ?? ICONS.info) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  return { h, icon, append };
}

// ------------------------------------------------------------------------------------------------ formatting

function relative(iso, now) {
  if (!iso) return 'never';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const delta = now - at;
  const abs = Math.abs(delta);
  if (abs < 45_000) return delta >= 0 ? 'just now' : 'in a moment';
  const text = abs < 90_000 ? '1 min' : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return delta >= 0 ? `${text} ago` : `in ${text}`;
}

function span(iso, now) {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

function absolute(iso) {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function accessShort(access) {
  if (access.operate === 'all') return 'Operate · all hosts';
  if (access.operate.length > 0) return `Operate · ${access.operate.join(', ')}`;
  if (access.read === 'all') return 'Read · all hosts';
  if (access.read.length > 0) return `Read · ${access.read.join(', ')}`;
  return 'No access';
}

const GRANT_LABELS = { active: 'Usable', refreshable: 'Refresh only', unusable: 'Unusable', revoked: 'Revoked', pending: 'Pending' };
const REACH_LABELS = { reachable: 'Answered', credential_rejected: 'Refused credential', unreachable: 'No answer', not_enrolled: 'Not enrolled', unchecked: 'Not checked yet' };
const CREDENTIAL_LABELS = { missing: 'None', active: 'Valid', renewal_due: 'Renewal due', expired: 'Expired' };
const STATE_LABELS = {
  queued: 'queued', dispatching: 'dispatching', running: 'running', needs_input: 'needs input', idle: 'idle',
  cancel_requested: 'cancelling', cancelled: 'cancelled', failed: 'failed', unknown: 'unconfirmed', released: 'released',
};

// ------------------------------------------------------------------------------------------------ rendering

/**
 * Render the whole app into `root`. `model` is { snapshot, route, error, notice, loading, checking, fetchedAt, jobFilter },
 * `actions` is { refresh, runChecks, setJobFilter, copy }. Returns the time elements to keep current.
 */
export function render(doc, root, model, actions, nowMs = Date.now()) {
  const { h, icon } = dom(doc);
  const times = [];
  const snap = model.snapshot;
  const now = snap ? Date.parse(snap.generatedAt) + Math.max(0, nowMs - model.fetchedAt) : nowMs;

  const time = (iso, options = {}) => {
    const el = h('time', iso ? { datetime: iso, title: absolute(iso) } : {}, iso ? relative(iso, now) : options.never ?? 'never');
    if (iso) times.push({ el, iso });
    return el;
  };
  const pill = (tone, label) => h('span', { class: `pill tone-${tone}` }, icon(TONE_ICON[tone] ?? 'info', 'pill__icon'), label);
  const tag = (text, mono = false, title) => h('span', { class: mono ? 'tag tag--mono' : 'tag', title }, text);
  const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([term, value]) => [h('dt', null, term), h('dd', null, value)]));
  const button = (label, iconName, onClick, options = {}) => h('button', {
    type: 'button', class: `btn ${options.cls ?? ''}`.trim(), disabled: options.busy, 'aria-busy': options.busy ? 'true' : null, on: { click: onClick },
  }, icon(iconName, 'btn__icon'), h('span', { class: 'btn__label' }, label));
  const threadButton = (link, small = true) => (isThreadLink(link)
    ? h('a', { class: `btn ${small ? 'btn--small' : ''}`, href: link, title: 'Opens the thread in the T3 app' }, h('span', null, 'Open in T3'), icon('external', 'btn__icon'))
    : null);
  const command = (text) => h('span', { class: 'cmd' }, h('code', null, text),
    h('button', { type: 'button', 'aria-label': `Copy command: ${text}`, title: 'Copy', on: { click: () => actions.copy(text) } }, icon('copy')));
  const checksButton = (cls = 'btn--primary') => button(model.checking ? 'Checking…' : 'Run checks', 'pulse', actions.runChecks, { cls: `${cls}${model.checking ? ' is-busy' : ''}`, busy: model.checking });
  const pageHead = (eyebrow, title, lede, ...actionNodes) => h('header', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow' }, eyebrow), h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, title), lede ? h('p', { class: 'lede' }, lede) : null),
    actionNodes.length ? h('div', { class: 'page-actions' }, actionNodes) : null);
  const panel = (title, meta, ...body) => h('section', { class: 'panel' },
    h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, title), meta ? h('span', { class: 'panel__meta' }, meta) : null), ...body);
  const emptyState = (text, iconName = 'check') => h('div', { class: 'empty' }, icon(iconName, 'empty__icon'), text);

  // -------------------------------------------------------------- derived facts

  const derived = snap ? derive(snap) : null;
  const jobIndex = new Map();
  if (snap) for (const job of [...snap.jobs.recent, ...snap.jobs.open, ...snap.jobs.attention]) jobIndex.set(job.id, job);
  const hostLabel = (id) => snap?.hosts.find((host) => host.id === id)?.label ?? id;

  // -------------------------------------------------------------- chrome

  const route = model.route;
  const navItems = [
    ['overview', 'Overview', 'overview', derived ? derived.issueCount : 0, derived?.worstTone],
    ['clients', 'Clients', 'clients', derived ? derived.clientIssues : 0, 'bad'],
    ['hosts', 'Hosts', 'hosts', derived ? derived.hostIssues : 0, 'bad'],
    ['jobs', 'Jobs', 'jobs', derived ? derived.waiting : 0, 'warn'],
    ['checks', 'Checks', 'pulse', derived ? derived.checkFailures : 0, 'bad'],
    ['webhooks', 'Webhooks', 'link', 0, 'info'],
  ];
  const navLink = ([view, label, iconName, count, tone], cls) => h('a', {
    class: cls, href: `#/${view}`, 'aria-current': route.view === view ? 'page' : null,
  }, icon(iconName, 'nav__icon'), h('span', null, label),
  count > 0 ? h('span', { class: `nav__count nav__count--${tone === 'bad' ? 'bad' : 'warn'}`, 'aria-label': `${plural(count, 'item')} ${count === 1 ? 'needs' : 'need'} attention` }, String(count)) : null);

  const updated = snap
    ? h('span', { class: `updated${nowMs - model.fetchedAt > STALE_MS ? ' updated--stale' : ''}` }, 'Updated ', time(snap.generatedAt))
    : null;
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__inner' },
      h('a', { class: 'brand', href: '#/overview' },
        h('img', { class: 'brand__mark', src: 'assets/mark.svg', alt: '', width: '32', height: '32' }),
        h('span', { class: 'brand__name' }, 'Fleet gateway', h('span', null, ' · operator'))),
      snap ? h('span', { class: 'chip chip--version' }, `v${snap.gateway.version}`) : null,
      snap?.demoLabel ? h('span', { class: 'chip chip--demo', title: 'Synthetic data from the demo harness' }, snap.demoLabel) : null,
      h('span', { class: 'topbar__spacer' }),
      updated,
      button(model.loading ? 'Refreshing…' : 'Refresh', 'refresh', actions.refresh, { cls: `btn--ghost icon-only${model.loading ? ' is-busy' : ''}`, busy: model.loading })),
    h('nav', { class: 'nav', 'aria-label': 'Dashboard sections' }, navItems.map((item) => navLink(item, 'nav__link'))));

  const banners = [];
  if (model.error) {
    banners.push(h('div', { class: 'banner banner--bad', role: 'alert' },
      h('span', null, snap ? `${model.error} Showing the last data loaded.` : model.error),
      button('Try again', 'refresh', actions.refresh, { cls: 'btn--small' })));
  } else if (model.notice) {
    banners.push(h('div', { class: 'banner banner--info' }, h('span', null, model.notice)));
  }

  let content;
  if (!snap) {
    content = [h('div', { class: 'skeleton', 'aria-hidden': 'true' }), h('div', { class: 'skeleton section', 'aria-hidden': 'true' })];
  } else if (route.view === 'clients') content = clientsView();
  else if (route.view === 'hosts') content = hostsView();
  else if (route.view === 'jobs') content = jobsView();
  else if (route.view === 'checks') content = checksView();
  else if (route.view === 'webhooks') content = webhooksView();
  else content = overviewView();

  const footer = h('footer', { class: 'footer' },
    h('span', null, 'Private operator dashboard · job controls and approvals stay in T3'),
    h('span', null, 'Saved credentials are never shown or stored in this browser'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Dashboard sections' }, navItems.map((item) => navLink(item, '')));

  root.replaceChildren(topbar, h('main', { class: 'main', id: 'main' }, banners, content), footer, tabbar);
  root.setAttribute('aria-busy', snap ? 'false' : 'true');
  return times;

  // -------------------------------------------------------------- webhook connections

  function webhooksView() {
    const data = model.webhooks;
    const busy = Boolean(model.webhookBusy || model.webhooksLoading);
    const form = model.webhookForm;
    const formTitle = form?.mode === 'replace' ? 'Replace key or webhook URL' : 'Connect Grok Bot';
    const testSummary = (test) => test
      ? [webhookTestText(test), ' · ', time(test.at)] : 'No test recorded';
    const connection = (row) => {
      const managed = row.source === 'dashboard';
      const confirming = model.disconnectId === row.id;
      const projects = row.displayName;
      const credentialAlerts = (row.events ?? []).includes('credential_alert') && (row.events ?? []).includes('credential_resolved');
      const hosts = [...row.hosts, ...(row.targets ?? []).map((t) => t.host)].join(', ');
      return h('article', { class: 'panel webhook-connection', 'aria-label': `Connection for ${projects} on ${hosts || 'all hosts'}` },
        h('div', { class: 'panel__head' }, h('h3', { class: 'panel__title' }, projects),
          pill(row.enabled === false ? 'unknown' : 'good', row.enabled === false ? 'Disabled' : 'Connected')),
        h('div', { class: 'panel__body' },
          kv([
            ['Host', hosts || 'All hosts'],
            ['Managed by', managed ? 'Dashboard' : 'Configuration file'],
            ['Credential alerts', credentialAlerts ? 'Enabled' : 'Off. Use Replace key → Events to add credential_alert and credential_resolved.'],
            ['Events', (row.events ?? []).join(', ') || 'Default events'],
            ['Jobs', (row.jobs ?? []).join(', ') || 'All matching jobs'],
            ['Started by clients', (row.clients ?? []).join(', ') || 'All clients'],
            ['Last test', testSummary(row.lastTest)],
            ['Last delivery', row.health?.lastSuccessAt ? time(row.health.lastSuccessAt) : 'No success recorded'],
            ['Last failure', row.health?.lastFailureAt ? time(row.health.lastFailureAt) : 'No failure recorded'],
            ['Failure streak', String(row.health?.failureStreak ?? 0)],
            ['Pending events', String(row.health?.pending ?? 0)],
            ['Dead-lettered events', String(row.health?.deadLettered ?? 0)],
            ['Omitted events', String(row.health?.overflowCount ?? 0)],
          ]),
          managed ? null : h('p', { class: 'sub webhook-note' }, 'File-managed connection. Change or remove it in the gateway configuration.'),
          h('div', { class: 'webhook-actions' },
            button(model.webhookBusy?.id === row.id && model.webhookBusy.action === 'test' ? 'Testing…' : 'Send test',
              'pulse', () => actions.webhookOperation('test', { id: row.id, revision: row.revision }), { busy }),
            managed ? button('Replace key', 'key', () => actions.openWebhookForm(row), { busy }) : null,
            managed ? button('Disconnect', 'x', () => actions.confirmDisconnect(row.id), { busy }) : null),
          confirming ? h('div', { class: 'webhook-confirm', role: 'group', 'aria-label': 'Confirm disconnect' },
            h('p', null, 'Disconnect this project? Queued notifications will be cancelled. A request already being sent may still arrive.'),
            h('div', { class: 'webhook-actions' },
              button('Yes, disconnect', 'x', () => actions.webhookOperation('disconnect', { id: row.id, revision: row.revision }), { cls: 'btn--danger', busy }),
              button('Keep connection', 'check', () => actions.confirmDisconnect(null), { busy }))) : null));
    };
    return [
      pageHead('Webhooks', 'Let your bot know when work changes',
        'Connect a Grok Bot routine to a project. The gateway sends updates so the bot can follow up. Any HTTPS webhook with an authorization header works too.',
        !form ? button('Connect Grok Bot', 'link', () => actions.openWebhookForm(), { cls: 'btn--accent', busy: busy || !data }) : null),
      model.webhookError ? h('div', { class: 'callout callout--bad', role: 'alert' }, icon('bad', 'callout__icon'), h('span', null, model.webhookError)) : null,
      model.webhookNotice ? h('div', { class: 'callout', role: 'status' }, icon('check', 'callout__icon'), h('span', null, model.webhookNotice)) : null,
      !data ? h('section', { class: 'panel', 'aria-busy': model.webhooksLoading ? 'true' : 'false' },
        emptyState(model.webhooksLoading ? 'Loading connections…' : 'Connections could not be loaded. Use Refresh to try again.', 'link')) : null,
      data && form ? h('div', { class: 'webhook-setup' },
        panel(formTitle, 'Private setup', webhookForm(form, data, busy)),
        panel('Find the two values in Grok', null, h('div', { class: 'panel__body webhook-help' },
          h('p', null, 'Ask your bot for private links to the routine’s setup panels. The prompt below asks for links, not the key itself.'),
          button('Copy setup prompt', 'copy', () => actions.copy(SETUP_PROMPT, 'Setup prompt copied.')),
          h('ol', null,
            h('li', null, h('strong', null, 'Webhook URL: '), 'open this panel and copy the address labelled “POST to”.'),
            h('li', null, h('strong', null, 'Authorization header: '), 'open this panel and copy the value labelled “header”, including its name and colon. There is no separate key field here.'),
            h('li', null, h('strong', null, 'Choose a project: '), 'only updates from that project and its configured host will be sent.')),
          h('p', { class: 'sub' }, 'Recreated the routine? Its URL and key may both have changed. Copy both values from the new routine.')))) : null,
      data ? h('section', { class: 'section', 'aria-labelledby': 'webhook-connections-title' },
        h('h2', { id: 'webhook-connections-title', class: 'webhook-list-title' }, `Connections (${data.connections.length})`),
        data.connections.length ? h('div', { class: 'cards' }, data.connections.map(connection))
          : h('div', { class: 'panel' }, emptyState('No connections yet. Connect and test a routine above to receive project updates.', 'link'))) : null,
      h('p', { class: 'sub section' }, 'Anyone who can reach this private dashboard can manage webhook destinations. Saved URLs and keys are never shown here.'),
    ];
  }

  function webhookForm(form, data, busy) {
    const replacing = form.mode === 'replace';
    const url = h('input', {
      id: 'webhook-url', type: 'url', inputmode: 'url', placeholder: 'https://hooks.example.com/your-routine',
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '4096',
      required: !replacing, disabled: busy, 'aria-describedby': 'webhook-url-help',
    });
    const auth = h('input', {
      id: 'webhook-auth', type: 'password', placeholder: 'Authorization: Bearer …',
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '8192',
      required: true, disabled: busy, 'aria-describedby': 'webhook-auth-help',
    });
    const project = replacing ? null : h('select', {
      id: 'webhook-project', required: true, disabled: busy || data.projects.length === 0, 'aria-describedby': 'webhook-project-help',
    }, [...new Set(data.projects.map((item) => item.host))].map((host) =>
      h('optgroup', { label: host }, data.projects.filter((item) => item.host === host).map((item) =>
        h('option', { value: item.alias }, item.label)))));
    const filters = [
      ['events', 'Events (optional)', 'Includes credential_alert and credential_resolved by default'],
      ['jobs', 'Job IDs (optional)', 'All matching jobs'],
      ['clients', 'Started by client IDs (optional)', 'All clients'],
    ].filter(([key]) => !replacing || key === 'events').map(([key, label, placeholder]) => ({ key, label, input: h('input', {
      id: `webhook-${key}`, type: 'text', maxlength: key === 'clients' ? '12000' : '6400', placeholder, disabled: busy,
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    }) }));
    if (replacing) filters[0].input.value = (form.events ?? []).join(', ');
    const unavailable = (data.hosts ?? []).filter((host) => host.status === 'unavailable');
    const clear = () => { url.value = ''; auth.value = ''; };
    return h('form', {
      class: 'panel__body webhook-form', autocomplete: 'off', 'aria-label': replacing ? 'Replace connection' : 'Connect webhook',
      on: { submit: (event) => {
        event.preventDefault();
        if (busy) return;
        const fields = replacing ? { id: form.id, revision: form.revision } : { project: project.value };
        if (url.value.trim() || !replacing) fields.url = url.value.trim();
        fields.authHeader = auth.value;
        for (const filter of filters) {
          const values = filter.input.value.split(',').map((value) => value.trim()).filter(Boolean);
          if (values.length) fields[filter.key] = values;
        }
        clear();
        return actions.webhookOperation(replacing ? 'replace' : 'connect', fields);
      } },
    },
    unavailable.map((host) => h('p', { class: 'sub' }, `${host.host}: unavailable. Configured aliases remain selectable; refresh to retry discovery.`)),
    replacing ? h('p', { class: 'webhook-replace-note' }, 'If you recreated the routine, paste its new URL and full authorization header. Leave the URL blank only if it has not changed. The current connection stays active unless the new test succeeds.') : null,
    h('div', { class: 'field' }, h('label', { for: 'webhook-url' }, replacing ? 'Webhook URL (if changed)' : 'Webhook URL'), url,
      h('p', { class: 'field__hint', id: 'webhook-url-help' }, 'Where the gateway sends updates. In Grok, copy the “POST to” address.')),
    h('div', { class: 'field' }, h('label', { for: 'webhook-auth' }, 'Full authorization header'), auth,
      h('p', { class: 'field__hint', id: 'webhook-auth-help' }, 'Proves the update came from your gateway. In Grok, copy “header” in full, such as Authorization: Bearer your-key.')),
    project ? h('div', { class: 'field' }, h('label', { for: 'webhook-project' }, 'Project'), project,
      h('p', { class: 'field__hint', id: 'webhook-project-help' }, data.projects.length
        ? 'The host is selected automatically from the project.' : 'Configure a project on the gateway before connecting a webhook.'))
      : h('p', { class: 'sub' }, `Project: ${form.projects.join(', ')} · Host: ${form.hosts.join(', ')}`),
    h('div', { class: 'webhook-defaults' },
      h('p', null, h('strong', null, 'Default updates: '), 'ready for follow-up, needs input, failed, cancelled, delegated work ended, credential alerts and resolutions.'),
      h('p', null, h('strong', null, 'Reply excerpts are off. '), 'Updates identify the job and its state without copying the worker’s reply.')),
    filters.length ? h('details', null, h('summary', null, 'Choose precise notifications'),
      h('p', { class: 'field__hint' }, 'Comma-separated values. Every filter must match the selected project and host. Blank fields keep the defaults.'),
      filters.map((filter) => h('div', { class: 'field' }, h('label', { for: `webhook-${filter.key}` }, filter.label), filter.input))) : null,
    h('div', { class: 'webhook-actions' },
      h('button', { type: 'submit', class: 'btn btn--accent', disabled: busy || (!replacing && data.projects.length === 0),
        'aria-busy': busy ? 'true' : null },
      icon('link', 'btn__icon'), busy ? 'Sending test…' : replacing ? 'Replace & Test' : 'Connect & Test'),
      button('Close', 'x', () => { clear(); actions.closeWebhookForm(); })),
    h('p', { class: 'field__hint' }, 'We send a synthetic test before saving. Both paste fields clear after submission. Then check the bot conversation; an accepted test does not mean the bot has finished.'));
  }

  // -------------------------------------------------------------- overview

  function overviewView() {
    const issues = snap.attention.filter((item) => item.tone === 'bad' || item.tone === 'warn');
    const unchecked = snap.hosts.filter((host) => host.reachability.state === 'unchecked').length;
    let headline;
    let lede;
    if (issues.length === 1) {
      headline = issues[0].title;
      lede = issues[0].detail;
    } else if (issues.length > 1) {
      headline = `${issues.length} things need your attention`;
      lede = 'They are listed below, most serious first. Approvals and job control happen in T3; host and client fixes on the gateway machine.';
    } else if (unchecked > 0) {
      headline = 'Nothing is waiting on you';
      lede = `${plural(unchecked, 'host')} ${unchecked === 1 ? 'has' : 'have'} not been checked since the gateway started. Run checks to ask ${unchecked === 1 ? 'it' : 'them'} now.`;
    } else {
      headline = 'All clear';
      lede = 'Every host answered its last observed call, and no job is waiting on you.';
    }
    return [
      pageHead('Overview', headline, lede, checksButton(),
        h('a', { class: 'btn btn--accent', href: '#/webhooks/connect' }, icon('link', 'btn__icon'), 'Connect Grok Bot')),
      vitals(),
      topology(),
      h('div', { class: 'grid-2' },
        panel('Needs your attention', attentionMeta(issues.length, snap.attention.length),
          snap.attention.length === 0 ? emptyState('Nothing needs you right now.') : h('ul', { class: 'attention' }, snap.attention.map(attentionItem))),
        panel('Recent activity', 'job events, codes only',
          snap.events.length === 0 ? emptyState('No job events yet.', 'jobs') : h('ul', { class: 'feed' }, snap.events.slice(0, 10).map(eventItem)),
          snap.events.length > 10 ? h('div', { class: 'feed__more' }, h('a', { class: 'text-link', href: '#/jobs' }, 'All activity →')) : null)),
    ];
  }

  function attentionMeta(issues, total) {
    if (total === issues) return plural(total, 'item');
    return issues === 0 ? `${total} for information` : `${issues} to act on · ${total - issues} for information`;
  }

  function vitals() {
    const g = snap.gateway;
    const engineText = g.engine.running ? (g.engine.lastTickAt ? ['engine ticked ', time(g.engine.lastTickAt)] : 'engine starting') : 'engine not running';
    const dbOk = g.database.schemaVersion === g.database.expectedVersion;
    const tile = (href, tone, iconName, label, value, sub) => h('a', { class: `panel vital tone-edge-${tone}`, href },
      h('span', { class: 'vital__label' }, icon(iconName), label), h('span', { class: 'vital__value' }, value), h('span', { class: 'vital__sub' }, sub));
    const d = derived;
    const hostSub = [d.unreachable && `${d.unreachable} unreachable`, d.hostWarn && `${d.hostWarn} ${d.hostWarn === 1 ? 'needs' : 'need'} attention`, d.unchecked && `${d.unchecked} not checked`].filter(Boolean).join(' · ') || 'all answered their last observed call';
    const clientSub = [d.needsApproval && `${d.needsApproval} unusable`, d.neverSeen && `${d.neverSeen} never observed`, d.quiet && `${d.quiet} quiet`].filter(Boolean).join(' · ') || 'all seen in the last day';
    const waitingSub = [d.waiting && `${d.waiting} waiting on you`, snap.jobs.counts.queued && `${snap.jobs.counts.queued} queued`, snap.jobs.counts.running && `${snap.jobs.counts.running} running`].filter(Boolean).join(' · ') || 'nothing waiting';
    return h('div', { class: 'vitals' },
      tile('#/checks', !dbOk || d.gatewayIssues ? 'bad' : g.engine.running ? 'good' : 'unknown', 'pulse', 'Gateway', dbOk ? 'Running' : 'Schema mismatch', ['up ', span(g.startedAt, now), ' · ', engineText]),
      tile('#/hosts', d.hostTone, 'hosts', 'Hosts', `${d.answering} of ${snap.hosts.length} answering`, hostSub),
      tile('#/clients', d.clientTone, 'clients', 'Clients', d.activeClients === 0 ? 'None connected' : `${d.seen} of ${d.activeClients} seen today`, d.activeClients === 0 ? 'approve one with t3-fleet-gateway pair' : clientSub),
      tile('#/jobs', d.waiting > 0 ? 'warn' : 'good', 'jobs', 'Jobs', `${snap.jobs.openTotal} open`, waitingSub));
  }

  function topology() {
    const clients = snap.clients.items.filter((client) => client.grant.state !== 'revoked')
      .sort((a, b) => TONE_RANK[a.status.tone] - TONE_RANK[b.status.tone]);
    const shownClients = clients.slice(0, 5);
    const shownHosts = snap.hosts.slice(0, 6);
    const g = snap.gateway;
    const publicCheck = snap.checks?.results.find((result) => result.id === 'public_url');
    const clientNode = (client) => h('a', { class: `node wire-${client.status.tone}`, href: `#/clients/${client.id}`, 'aria-label': `${client.label}: ${client.status.label}` },
      h('span', { class: 'node__title ellipsis' }, client.label),
      h('span', { class: 'node__sub ellipsis' }, `${client.kind === 'bearer' ? 'Bearer token' : 'OAuth'} · ${accessShort(client.access)}`),
      pill(client.status.tone, client.status.label));
    const hostNode = (host) => h('a', { class: `node wire-${host.status.tone}`, href: `#/hosts/${host.id}`, 'aria-label': `${host.label}: ${host.status.label}` },
      h('span', { class: 'node__title ellipsis' }, host.label),
      h('span', { class: 'node__sub ellipsis' }, [host.loopback ? 'Loopback' : 'HTTPS', host.transportNote].filter(Boolean).join(' · ')),
      pill(host.status.tone, host.status.label));
    const more = (count, href, what) => h('a', { class: 'node node--more', href }, `+${count} more ${what}`);
    const hubLine = (label, value) => h('span', { class: 'hub__line' }, h('span', null, label), h('b', null, value));
    return h('section', { class: 'panel topology', 'aria-labelledby': 'topology-title' },
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title', id: 'topology-title' }, 'How work reaches your machines'),
        h('span', { class: 'panel__meta' }, 'agents → gateway → T3')),
      h('div', { class: 'topo' },
        h('div', { class: 'lane lane--clients' }, h('span', { class: 'lane__label' }, 'Agent clients'),
          h('div', { class: 'lane__nodes' }, shownClients.length === 0 ? h('span', { class: 'node node--more' }, 'No clients yet') : shownClients.map(clientNode),
            clients.length > shownClients.length ? more(clients.length - shownClients.length, '#/clients', 'clients') : null)),
        h('div', { class: 'lane lane--gateway' },
          h('a', { class: `hub${shownClients.length ? '' : ' hub--no-clients'}${shownHosts.length ? '' : ' hub--no-hosts'}`, href: '#/checks' },
            h('span', { class: 'hub__head' }, h('img', { class: 'hub__mark', src: 'assets/mark.svg', alt: '', width: '36', height: '36' }),
              h('span', null, h('span', { class: 'hub__title' }, 'Fleet gateway'), h('br'), h('span', { class: 'hub__sub' }, `v${g.version} · MCP on ${g.mcpListen}`))),
            h('span', { class: 'hub__lines' },
              hubLine('Public URL', publicCheck ? (publicCheck.level === 'ok' ? ['reachable · ', time(snap.checks.finishedAt)] : ['failing · ', time(snap.checks.finishedAt)]) : 'not checked yet'),
              hubLine('Job engine', g.engine.running ? (g.engine.lastTickAt ? ['ticked ', time(g.engine.lastTickAt)] : 'starting') : 'not running'),
              hubLine('Database', `schema ${g.database.schemaVersion}`)))),
        h('div', { class: 'lane lane--hosts' }, h('span', { class: 'lane__label' }, 'T3 hosts'),
          h('div', { class: 'lane__nodes' }, shownHosts.map(hostNode),
            snap.hosts.length > shownHosts.length ? more(snap.hosts.length - shownHosts.length, '#/hosts', 'hosts') : null))));
  }

  function settleAction(job) {
    if (!job || !job.link || job.settlementAcknowledged || !['idle', 'failed', 'cancelled', 'released'].includes(job.state)) return null;
    if (model.settleId === job.id) return h('span', { role: 'group', 'aria-label': 'Confirm settlement' },
      h('span', null, 'Settle this thread in T3 and clear its attention alert? '),
      button('Confirm settle', 'check', () => actions.settle(job.id), { busy: Boolean(model.settleBusy) }),
      button('Keep open', 'x', () => actions.confirmSettle(null), { busy: Boolean(model.settleBusy) }));
    return button('Settle', 'check', () => actions.confirmSettle(job.id), { busy: Boolean(model.settleBusy) });
  }

  function attentionItem(item) {
    let action = null;
    if (item.action?.kind === 'link') action = threadButton(item.action.href);
    else if (item.action?.kind === 'command') action = command(item.action.command);
    else if (item.action?.kind === 'view') action = h('a', { class: 'btn btn--small', href: `#/${item.action.view}` }, item.action.label);
    return h('li', { class: 'attention__item' },
      h('span', { class: `attention__icon tone-${item.tone}` }, icon(TONE_ICON[item.tone] ?? 'info')),
      h('div', null, h('p', { class: 'attention__title' }, item.title), h('p', { class: 'attention__detail' }, item.detail)),
      h('div', { class: 'attention__foot' }, action, item.kind === 'job' ? settleAction(jobIndex.get(item.ref)) : null, item.at ? h('span', { class: 'sub' }, time(item.at)) : null));
  }

  function eventItem(event) {
    const job = jobIndex.get(event.jobId);
    return h('li', { class: 'feed__item' },
      h('span', { class: 'feed__time' }, time(event.at)),
      h('div', null,
        h('p', { class: 'feed__title' }, job ? job.title : `Job ${event.jobId}`),
        h('p', { class: 'feed__summary' }, event.summary),
        h('div', { class: 'feed__meta' }, tag(event.project, true), tag(hostLabel(event.hostId)), event.code ? tag(event.code, true, 'Code recorded with the event') : null)));
  }

  // -------------------------------------------------------------- clients

  function clientsView() {
    const active = snap.clients.items.filter((client) => client.grant.state !== 'revoked');
    const revoked = snap.clients.items.filter((client) => client.grant.state === 'revoked');
    const pending = snap.clients.pending;
    return [
      pageHead('Clients', 'Who can connect, and who did',
        'Authorization is what the gateway would accept today. Observed is what actually reached it. A usable grant does not prove a connector still holds its token, and a quiet client is not necessarily broken.'),
      active.length === 0
        ? h('section', { class: 'panel' }, emptyState('No agent is connected yet. Mint an approval code with t3-fleet-gateway pair, or a bearer token with clients token.', 'clients'))
        : h('div', { class: 'cards' }, active.map(clientCard)),
      snap.clients.total > snap.clients.items.length
        ? h('p', { class: 'sub section' }, `Showing ${snap.clients.items.length} of ${snap.clients.total} clients. t3-fleet-gateway clients list shows all.`) : null,
      revoked.length > 0 ? h('details', { class: 'disclosure' }, h('summary', null, 'Revoked clients', h('span', { class: 'sub' }, String(revoked.length))),
        h('div', { class: 'cards list' }, revoked.map(clientCard))) : null,
      pending.count > 0 ? h('details', { class: 'disclosure' },
        h('summary', null, 'Registrations without an approval', h('span', { class: 'sub' }, String(pending.count))),
        h('div', { class: 'panel list' },
          h('p', { class: 'list__item sub' }, 'Anyone who can reach the public URL can register a client; registering grants nothing. Names are as the registrant sent them. Unapproved registrations are removed after a day.'),
          pending.recent.map((client) => h('div', { class: 'list__item' }, h('span', { class: 'strong' }, client.name), h('span', { class: 'sub' }, 'registered ', time(client.createdAt), ' · ', h('span', { class: 'ref' }, client.id)))))) : null,
    ];
  }

  function clientCard(client) {
    const g = client.grant;
    const o = client.observed;
    const accessUntil = g.accessUsableUntil === 'never' ? 'usable · never expires' : g.accessUsableUntil ? ['usable · expires ', time(g.accessUsableUntil)] : h('span', { class: 'muted' }, 'none usable');
    const refresh = client.kind === 'bearer' ? h('span', { class: 'muted' }, 'none (bearer tokens do not refresh)')
      : g.refreshUsableUntil ? ['usable · expires ', time(g.refreshUsableUntil)] : h('span', { class: 'muted' }, 'none usable');
    const unknown = (iso) => (iso ? time(iso) : h('span', { class: 'muted' }, 'unknown'));
    const selected = route.view === 'clients' && route.id === client.id;
    return h('article', { class: `panel entity${selected ? ' is-selected' : ''}`, id: `client-${client.id}` },
      h('div', { class: 'entity__head' },
        h('div', { class: 'entity__ident' },
          h('h2', { class: 'entity__title' }, client.label),
          h('p', { class: 'entity__sub' }, client.label !== client.registeredName ? `Registered as “${client.registeredName}”` : client.kind === 'oauth' ? 'OAuth client' : 'Operator-minted bearer token'),
          h('div', { class: 'entity__tags' },
            tag(client.kind === 'oauth' ? 'OAuth' : 'Bearer token'),
            client.redirectOrigins.map((origin) => tag(`signs in via ${origin.replace(/^https:\/\//, '')}`, false, origin)),
            tag(client.access.text, true, 'Access its usable tokens carry now'),
            client.access.unconfiguredHosts.length ? h('span', { class: 'tag tone-warn' }, `not configured: ${client.access.unconfiguredHosts.join(', ')}`) : null)),
        h('div', { class: 'entity__status' }, pill(client.status.tone, client.status.label))),
      h('p', { class: 'entity__summary' }, client.status.detail),
      h('div', { class: 'entity__cols' },
        h('div', { class: 'entity__col' }, h('h3', null, icon('shield'), 'Authorization'),
          kv([
            ['Grant', GRANT_LABELS[g.state] ?? g.state],
            ['Access now', client.access.text === '-' ? h('span', { class: 'muted' }, 'none') : client.access.text],
            client.access.approved ? ['Approved for', client.access.approved] : null,
            ['Access token', accessUntil],
            ['Refresh', refresh],
            ['Grants issued', g.families === 0 ? 'none' : `${g.families}${g.revokedFamilies.length ? ` · ${g.revokedFamilies.length} revoked` : ''}`],
          ]),
          client.access.approved ? h('p', { class: 'entity__note' }, 'Its usable tokens carry less than it was approved for: a refresh narrowed them, or the wider tokens expired or were revoked.') : null,
          g.revokedFamilies.slice(0, 2).map((family) => h('p', { class: 'entity__note' }, 'A grant was ', family.detail, family.at ? [' ', time(family.at)] : null, '.'))),
        h('div', { class: 'entity__col' }, h('h3', null, icon('eye'), 'Observed'),
          kv([
            ['Last successful request', unknown(o.lastMcpSuccessAt)],
            client.kind === 'oauth' ? ['Last successful refresh', unknown(o.lastRefreshSuccessAt)] : null,
            ['Last use (legacy)', o.lastUsedAt ? time(o.lastUsedAt) : h('span', { class: 'muted' }, '—')],
          ]),
          h('p', { class: 'entity__note' }, 'Requests are sampled at most once a minute. Unknown means none was recorded: it never succeeded, or it was before v0.1.3.'))),
      h('div', { class: 'entity__foot' }, h('span', { class: 'ref' }, `client ${client.id} · since `, time(client.createdAt)), command(`t3-fleet-gateway clients diagnose ${client.id}`)));
  }

  // -------------------------------------------------------------- hosts

  function hostsView() {
    return [
      pageHead('Hosts', 'T3 machines',
        'Reachability reflects the last completed host call or background probe; this page never contacts T3 by itself. Transport notes are your own description from the config: the gateway checks only whether T3 answers at its URL.', checksButton()),
      h('div', { class: 'cards cards--wide' }, snap.hosts.map(hostCard)),
    ];
  }

  function hostCard(host) {
    const r = host.reachability;
    const c = host.credential;
    const cap = host.capacity;
    const selected = route.view === 'hosts' && route.id === host.id;
    const reachTone = r.state === 'reachable' ? 'good' : r.state === 'unchecked' ? 'unknown' : r.state === 'not_enrolled' ? 'warn' : 'bad';
    const credTone = c.state === 'active' ? 'good' : c.state === 'missing' ? 'warn' : c.state === 'expired' ? 'bad' : 'warn';
    const used = Math.min(cap.used, cap.max);
    return h('article', { class: `panel entity${selected ? ' is-selected' : ''}`, id: `host-${host.id}` },
      h('div', { class: 'entity__head' },
        h('div', { class: 'entity__ident' },
          h('h2', { class: 'entity__title' }, host.label, ' ', h('span', { class: 'ref' }, host.id)),
          h('p', { class: 'entity__sub' }, host.t3Url, host.transportNote ? ` · ${host.transportNote}` : ''),
          h('div', { class: 'entity__tags' },
            tag(host.loopback ? 'Loopback' : 'HTTPS'),
            tag(`T3 access: ${host.access}`, true, 'The approval level the gateway holds; a ceiling for runtime modes'),
            host.discovery.enabled ? tag(host.discovery.allowWorkStart ? `discovery · launches ${host.discovery.runtimeMode}` : 'discovery · browse only') : null)),
        h('div', { class: 'entity__status' }, pill(host.status.tone, host.status.label))),
      h('p', { class: 'entity__summary' }, r.detail,
        host.engine ? ` The job engine has been backing off since ${absolute(host.engine.unreachableSince)} (${plural(host.engine.failures, 'failure')}).` : ''),
      h('div', { class: 'entity__cols entity__cols--3' },
        h('div', { class: 'entity__col' }, h('h3', null, icon('link'), 'Reachability'),
          kv([
            ['Last observation', r.checkedAt ? time(r.checkedAt) : h('span', { class: 'muted' }, 'none yet')],
            ['Result', pill(reachTone, REACH_LABELS[r.state] ?? r.state)],
            ['Model catalog', (() => {
              const signal = host.signals?.find((entry) => entry.kind === 'models');
              if (!signal) return h('span', { class: 'muted' }, 'not observed');
              const tone = signal.stale ? 'unknown' : signal.problem ? 'bad' : 'good';
              const label = signal.stale ? `Last failure: ${signal.code}` : signal.code ?? 'OK';
              return [pill(tone, label), ' checked ', time(new Date(signal.checkedAt).toISOString())];
            })()],
            ...(host.signals ?? []).filter((signal) => signal.problem).map((signal) =>
              [signal.kind, h('span', { class: signal.stale ? 'muted' : '' }, tag(signal.code, true), ` ${signal.message} Count: ${signal.problem.count}. First seen: `,
                time(new Date(signal.problem.firstSeen).toISOString()), ' Last seen: ', time(new Date(signal.problem.lastSeen).toISOString()))]),
            r.t3Version ? ['T3 version', r.t3Version] : null,
            r.errorCode ? ['Code', tag(r.errorCode, true)] : null,
            host.engine ? ['Engine retries', ['next ', time(host.engine.nextAttemptAt)]] : null,
            host.jobsUnreachableSince ? ['Jobs see it down since', time(host.jobsUnreachableSince)] : null,
          ])),
        h('div', { class: 'entity__col' }, h('h3', null, icon('key'), 'Credential'),
          kv([
            ['State', pill(credTone, CREDENTIAL_LABELS[c.state] ?? c.state)],
            c.expiresAt ? ['Expires', time(c.expiresAt)] : null,
            ['Last renewal', c.renewalError ? ['failed ', time(c.renewalError.at)] : h('span', { class: 'muted' }, 'no failure recorded')],
            c.renewalError?.code ? ['Code', tag(c.renewalError.code, true)] : null,
          ]),
          h('div', null, (c.alerts ?? []).map((alert) => h('p', { class: 'entity__note' },
            alert.resolvedAt ? `Resolved: ${alert.kind}` : `Active alert: ${alert.kind}`))),
          model.repairHost === host.id && model.repairConfirmation
            ? h('div', { role: 'group', 'aria-label': 'Confirm re-pair' },
                h('p', null, 'Re-pair this host using its configured pairing command? The old credential stays until the replacement is verified.'),
                button('Confirm re-pair', 'check', () => actions.repair(host.id), { busy: model.repairBusy }),
                button('Cancel', 'x', () => actions.cancelRepair(), { busy: model.repairBusy }))
            : button('Re-pair', 'key', () => actions.prepareRepair(host.id), { busy: model.repairBusy }),
          c.renewalError ? h('p', { class: 'entity__note' }, c.renewalError.detail) : h('p', { class: 'entity__note' }, 'T3 credentials last 30 days; serve renews them before they expire.')),
        h('div', { class: 'entity__col' }, h('h3', null, icon('gauge'), 'Capacity'),
          h('div', { class: 'meter', role: 'img', 'aria-label': `${cap.used} of ${cap.max} job slots in use` },
            h('div', { class: 'meter__bar' }, h('span', { class: `meter__fill meter__fill--${Math.round((used / Math.max(1, cap.max)) * 10)}` })),
            h('div', { class: 'meter__legend' }, h('span', null, `${cap.used} of ${cap.max} slots`), h('span', null, `${cap.queued} queued`))),
          kv([
            ['Open jobs', String(cap.open)],
            ['Standing jobs', String(cap.standingOpen)],
            host.discoveredOpenJobs ? ['In unaliased projects', String(host.discoveredOpenJobs)] : null,
          ]))),
      host.projects.length > 0 ? h('div', { class: 'projects', role: 'table', 'aria-label': `Projects on ${host.label}` },
        h('div', { class: 'projects__head', role: 'row' }, ['Project', 'Runtime mode', 'New work', 'Model', 'Open'].map((label) => h('span', { role: 'columnheader' }, label))),
        host.projects.map((project) => h('div', { class: 'project', role: 'row' },
          h('div', { role: 'cell' }, h('div', { class: 'project__alias' }, project.alias), project.description ? h('div', { class: 'project__desc' }, project.description) : null),
          h('span', { role: 'cell' }, tag(project.runtimeMode, true)),
          h('span', { role: 'cell' }, project.allowWorkStart ? 'work_start allowed' : 'coordinator only'),
          h('span', { role: 'cell', class: project.modelConfigured ? '' : 'muted' }, project.modelConfigured ? 'configured' : "T3's default"),
          h('span', { role: 'cell', class: 'project__num' }, String(project.openJobs), project.standingJobs ? h('span', { class: 'sub' }, ` (${project.standingJobs} standing)`) : null)))) : null,
      h('div', { class: 'entity__foot' }, h('span', { class: 'sub' }, 'Credential and reachability details on the gateway machine:'), command('t3-fleet-gateway hosts status')));
  }

  // -------------------------------------------------------------- jobs

  function jobsView() {
    const filter = model.jobFilter;
    const lists = { attention: snap.jobs.attention, open: snap.jobs.open, finished: snap.jobs.recent };
    const counts = { attention: snap.jobs.attention.length, open: snap.jobs.openTotal, finished: snap.jobs.recent.length };
    const labels = { attention: 'Waiting or recent', open: 'Open', finished: 'Finished' };
    const empty = {
      attention: 'No job is waiting on anyone, and none went idle or failed in the last day.',
      open: 'No open jobs.',
      finished: 'No finished jobs yet.',
    };
    const list = lists[filter] ?? lists.attention;
    const stateCounts = Object.entries(snap.jobs.counts).filter(([, n]) => n > 0);
    return [
      pageHead('Jobs', 'Work in the fleet',
        'Every job is an ordinary T3 thread. To approve, answer, stop or steer one, open it in T3. Task text, replies and questions are never shown here.'),
      stateCounts.length ? h('div', { class: 'counts' }, stateCounts.map(([state, n]) => h('span', { class: `state st-${state}` }, `${n} ${STATE_LABELS[state] ?? state}`))) : null,
      h('div', { class: 'section' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show jobs' }, Object.keys(lists).map((key) =>
          h('button', { type: 'button', 'aria-pressed': key === filter ? 'true' : 'false', on: { click: () => actions.setJobFilter(key) } },
            labels[key], h('span', { class: 'count' }, String(counts[key]))))),
        list.length === 0 ? h('section', { class: 'panel section' }, emptyState(empty[filter] ?? empty.attention)) : h('ul', { class: 'jobs' }, list.map(jobRow)),
        filter === 'open' && snap.jobs.openTotal > snap.jobs.open.length
          ? h('p', { class: 'sub section' }, `Showing the newest ${snap.jobs.open.length} of ${snap.jobs.openTotal} open jobs. t3-fleet-gateway jobs list shows all.`) : null),
      h('div', { class: 'section' },
        panel('Activity log', `latest ${snap.events.length} events · codes only`,
          snap.events.length === 0 ? emptyState('No job events yet.', 'jobs') : h('ul', { class: 'feed' }, snap.events.map(eventItem)))),
    ];
  }

  function jobRow(job) {
    const flags = [];
    if (job.waitingFor === 'approval') flags.push(h('span', { class: 'tag tone-warn' }, 'approval waiting in T3'));
    if (job.waitingFor === 'question') flags.push(h('span', { class: 'tag tone-warn' }, plural(job.pendingQuestions, 'question') + ' pending'));
    if (job.delegated.following + job.delegated.untracked > 0) flags.push(h('span', { class: 'tag tone-info' }, `waiting on ${plural(job.delegated.following + job.delegated.untracked, 'delegated task')}`));
    else if (job.delegated.endedAt && job.state === 'idle') flags.push(h('span', { class: 'tag tone-info' }, 'delegated work ended; not resumed'));
    if (job.hostUnreachableSince) flags.push(h('span', { class: 'tag tone-bad' }, 'host unreachable since ', time(job.hostUnreachableSince)));
    if (job.error) flags.push(h('span', { class: 'tag tag--mono tone-bad', title: job.error.detail ?? 'Error code recorded on the job' }, job.error.code));
    return h('li', { class: 'panel job' },
      h('div', null,
        h('p', { class: 'job__title' }, job.title, job.origin === 'adopted' ? tag('adopted') : job.standing ? tag('standing') : null,
          ...(job.pullRequests ?? []).map((pr) => tag(`PR #${pr.number} ${pr.state ?? 'unknown'}`))),
        h('p', { class: 'job__meta' },
          h('span', { class: 'mono' }, job.projectName ? `${job.projectName}` : job.project),
          h('span', null, icon('hosts'), hostLabel(job.hostId)),
          h('span', null, icon('user'), job.startedBy.label),
          h('span', null, icon('clock'), STATE_LABELS[job.state] ?? job.state, ' ', time(job.stateChangedAt)),
          h('span', { class: 'ref' }, `job ${job.id}`)),
        flags.length ? h('div', { class: 'job__flags' }, flags) : null,
        job.error?.detail ? h('p', { class: 'sub' }, job.error.detail) : null),
      h('div', { class: 'job__side' }, h('span', { class: `state st-${job.state}` }, STATE_LABELS[job.state] ?? job.state), threadButton(job.link), job.settlementAcknowledged ? tag('settled') : settleAction(job)));
  }

  // -------------------------------------------------------------- checks

  function checksView() {
    const run = snap.checks;
    const n = (level) => (run ? run.results.filter((result) => result.level === level).length : 0);
    const groups = run ? [
      ['Gateway', run.results.filter((result) => result.group === 'gateway')],
      ...snap.hosts.map((host) => [host.label, run.results.filter((result) => result.hostId === host.id)]),
    ] : [];
    const levelTone = { ok: 'good', warn: 'warn', fail: 'bad' };
    const limits = [
      'Whether a cloud connector (Grok Bot, Notion, any agent) can reach the public URL from where it runs. Only its own successful requests show that, on Clients.',
      'Which hop failed when a host does not answer: a tunnel, the network or T3 itself.',
      'Whether a connector still holds the token or refresh token the gateway issued to it.',
      'Project resolution, model defaults and explicit mint probes: run t3-fleet-gateway doctor on the gateway machine.',
      'Pending approvals and questions: those are answered in T3.',
    ];
    return [
      pageHead('Checks', 'Ask every layer, right now',
        "Read-only checks from the gateway machine: each host's T3 answer and credential, the public MCP URL, the database and data directory, and whether the renewal command resolves. Nothing is enrolled, renewed or executed.",
        checksButton()),
      run ? h('div', { class: `callout ${n('fail') ? 'callout--bad' : n('warn') ? 'callout--warn' : ''}`, role: 'status' },
        icon(n('fail') ? 'bad' : n('warn') ? 'alert' : 'check', 'callout__icon'),
        h('span', null, 'Checked ', time(run.finishedAt), ` · ${n('ok')} passed, ${plural(n('warn'), 'warning')}, ${n('fail')} failed.`)) : null,
      run ? h('section', { class: 'panel' }, h('div', { class: 'checks' }, groups.filter(([, results]) => results.length > 0).map(([title, results]) => [
        h('h2', { class: 'group-title' }, title),
        results.map((result) => h('div', { class: 'check' },
          h('span', { class: `check__icon tone-${levelTone[result.level]}` }, icon(TONE_ICON[levelTone[result.level]])),
          h('div', null, h('p', { class: 'check__name' }, result.name), h('p', { class: 'check__detail' }, result.detail)),
          h('span', { class: 'check__code' }, tag(result.code, true)))),
      ]))) : h('section', { class: 'panel' }, emptyState('No checks have run since the gateway started. Run them to ask every host and the public URL now.', 'pulse')),
      h('div', { class: 'section' }, panel('What these checks cannot tell you', null,
        h('div', { class: 'panel__body' }, h('ul', { class: 'limits' }, limits.map((text) => h('li', null, icon('info'), h('span', null, text))))))),
    ];
  }
}

/** Counts used by the overview and the navigation badges. */
export function derive(snap) {
  const hosts = snap.hosts;
  const activeClients = snap.clients.items.filter((client) => client.grant.state !== 'revoked');
  const answering = hosts.filter((host) => host.status.tone === 'good' || (host.status.tone === 'warn' && host.reachability.state === 'reachable')).length;
  const unreachable = hosts.filter((host) => host.status.tone === 'bad').length;
  const unchecked = hosts.filter((host) => host.reachability.state === 'unchecked').length;
  const hostWarn = hosts.filter((host) => host.status.tone === 'warn').length;
  const seen = activeClients.filter((client) => client.status.tone === 'good').length;
  const needsApproval = activeClients.filter((client) => client.status.tone === 'bad').length;
  const neverSeen = activeClients.filter((client) => client.status.tone === 'unknown').length;
  const quiet = activeClients.filter((client) => client.status.tone === 'info').length;
  const issues = snap.attention.filter((item) => item.tone === 'bad' || item.tone === 'warn');
  const worst = (tones) => tones.reduce((acc, tone) => (TONE_RANK[tone] < TONE_RANK[acc] ? tone : acc), 'good');
  return {
    answering, unreachable, unchecked, hostWarn, seen, needsApproval, neverSeen, quiet,
    activeClients: activeClients.length,
    hostTone: unreachable ? 'bad' : hostWarn ? 'warn' : unchecked ? 'unknown' : 'good',
    clientTone: needsApproval ? 'bad' : neverSeen ? 'unknown' : quiet ? 'info' : 'good',
    issueCount: issues.length,
    worstTone: worst(issues.map((item) => item.tone)),
    clientIssues: snap.attention.filter((item) => item.kind === 'client' && item.tone === 'bad').length,
    hostIssues: snap.attention.filter((item) => item.kind === 'host' && item.tone === 'bad').length,
    gatewayIssues: snap.attention.filter((item) => item.kind === 'gateway' && item.tone === 'bad').length,
    waiting: snap.jobs.open.filter((job) => job.state === 'needs_input').length,
    checkFailures: snap.checks ? snap.checks.results.filter((result) => result.level === 'fail').length : 0,
  };
}

export function parseRoute(hash) {
  const [view, id] = String(hash ?? '').replace(/^#\/?/, '').split('/');
  return VIEWS.includes(view) ? { view, id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null } : { view: 'overview', id: null };
}

// ------------------------------------------------------------------------------------------------ the running app

async function readError(response) {
  const text = (await response.text().catch(() => '')).slice(0, 200);
  return `The gateway answered HTTP ${response.status}${text ? `: ${text}` : '.'}`;
}

export function boot(win, doc) {
  const root = doc.getElementById('app');
  const live = doc.createElement('div');
  live.setAttribute('class', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  doc.body.append(live);
  const route = parseRoute(win.location.hash);
  const model = {
    snapshot: null, route, error: null, notice: null, loading: false, checking: false, fetchedAt: 0, jobFilter: 'attention',
    repairHost: null, repairConfirmation: null, repairBusy: false,
    settleId: null, settleRequestId: null, settleBusy: false,
    webhooks: null, webhooksLoading: false, webhookBusy: null, webhookError: null, webhookNotice: null,
    webhookForm: route.view === 'webhooks' ? { mode: 'connect' } : null, disconnectId: null,
  };
  let webhookLoadVersion = 0;
  let times = [];
  const clearWebhookFields = () => {
    for (const id of ['webhook-url', 'webhook-auth']) {
      const field = doc.getElementById(id);
      if (field) field.value = '';
    }
  };
  const announce = (text) => {
    live.textContent = '';
    win.setTimeout(() => { live.textContent = text; }, 50);
  };
  const draw = (focus = false) => {
    // Clear detached inputs too: navigating, refreshing or closing must leave no secret in the old form.
    clearWebhookFields();
    times = render(doc, root, model, actions);
    if (focus) {
      const target = model.route.id ? doc.getElementById(`${model.route.view === 'clients' ? 'client' : 'host'}-${model.route.id}`) : null;
      if (target?.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else win.scrollTo?.(0, 0);
      doc.getElementById('page-title')?.focus({ preventScroll: Boolean(target) });
    }
  };
  const request = (path, init = {}) => win.fetch(path, {
    cache: 'no-store', credentials: 'same-origin', ...init, headers: { [API_HEADER]: '1', ...(init.headers ?? {}) },
  });
  const actions = {
    cancelRepair() {
      model.repairHost = null;
      model.repairConfirmation = null;
      draw();
    },
    async prepareRepair(host) {
      if (model.repairBusy) return;
      model.repairBusy = true;
      draw();
      try {
        const response = await request('api/hosts/repair/prepare', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host }) });
        if (!response.ok) throw new Error();
        model.repairConfirmation = (await response.json()).confirmationId;
        model.repairHost = host;
      } catch {
        model.error = 'Could not prepare re-pair. Refresh and try again.';
      } finally { model.repairBusy = false; draw(); }
    },
    async repair(host) {
      if (model.repairBusy || !model.repairConfirmation || model.repairHost !== host) return;
      model.repairBusy = true;
      draw();
      try {
        const response = await request('api/hosts/repair/confirm', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host, confirmationId: model.repairConfirmation }) });
        const result = await response.json();
        if (result.snapshot) model.snapshot = result.snapshot;
        if (!response.ok) throw new Error();
        model.notice = 'Credential verified and installed.';
        model.error = null;
      } catch {
        model.error = 'Re-pair was not confirmed. Check Hosts and the pairing command before trying again.';
      } finally {
        model.repairBusy = false;
        actions.cancelRepair();
      }
    },
    confirmSettle(id) {
      model.settleId = id;
      model.settleRequestId = id ? win.crypto.randomUUID() : null;
      draw();
    },
    async settle(id) {
      if (model.settleBusy) return;
      model.settleBusy = true;
      draw();
      try {
        const response = await request('api/jobs/settle', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: id, requestId: model.settleRequestId }) });
        if (!response.ok) throw new Error(await readError(response));
        model.snapshot = (await response.json()).snapshot;
        model.settleId = null;
        model.error = null;
        model.notice = 'Thread settled. Its history is still available in Jobs.';
        announce(model.notice);
      } catch (error) {
        model.error = String(error.message ?? error);
        announce(model.error);
      } finally {
        model.settleBusy = false;
        draw();
      }
    },
    async refresh() {
      if (model.loading) return;
      model.loading = true;
      const first = model.snapshot === null;
      draw();
      try {
        const response = await request('api/snapshot');
        if (!response.ok) throw new Error(await readError(response));
        model.snapshot = await response.json();
        // A deep link (#/hosts/<id>) scrolls to its card once there is one.
        if (first && model.route.id) win.setTimeout(() => draw(true), 0);
        model.fetchedAt = Date.now();
        model.error = null;
        announce('Dashboard updated.');
      } catch (error) {
        model.error = error instanceof TypeError ? 'The gateway did not answer. It may be restarting.' : String(error.message ?? error);
        announce(model.error);
      } finally {
        model.loading = false;
        draw();
      }
      if (model.route.view === 'webhooks') await actions.loadWebhooks(true);
    },
    async runChecks() {
      if (model.checking) return;
      model.checking = true;
      model.notice = null;
      draw();
      try {
        const response = await request('api/checks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error(await readError(response));
        const body = await response.json();
        model.snapshot = body.snapshot;
        model.fetchedAt = Date.now();
        model.error = null;
        const failed = body.run.results.filter((result) => result.level === 'fail').length;
        model.notice = failed ? `Checks finished: ${plural(failed, 'check')} failed.` : 'Checks finished: nothing failed.';
        announce(model.notice);
      } catch (error) {
        model.error = error instanceof TypeError ? 'The gateway did not answer. It may be restarting.' : String(error.message ?? error);
        announce(model.error);
      } finally {
        model.checking = false;
        draw();
      }
    },
    setJobFilter(filter) {
      model.jobFilter = filter;
      draw();
    },
    async loadWebhooks(clearError = false) {
      const version = ++webhookLoadVersion;
      model.webhooksLoading = true;
      draw();
      try {
        const response = await request('api/webhooks');
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (version !== webhookLoadVersion) return;
        model.webhooks = data;
        if (clearError) model.webhookError = null;
        if (model.webhookForm?.mode === 'replace' && !data.connections.some((row) =>
          row.id === model.webhookForm.id && row.revision === model.webhookForm.revision && row.source === 'dashboard')) {
          model.webhookForm = null;
        }
        if (model.disconnectId && !data.connections.some((row) => row.id === model.disconnectId)) model.disconnectId = null;
      } catch {
        if (version === webhookLoadVersion) model.webhookError = 'Connections could not be refreshed. Use Refresh before trying another action.';
      } finally {
        if (version === webhookLoadVersion) {
          model.webhooksLoading = false;
          draw();
        }
      }
    },
    openWebhookForm(row) {
      if (model.webhookBusy) return;
      model.webhookForm = row ? { mode: 'replace', id: row.id, revision: row.revision, projects: row.projects, hosts: row.hosts, events: row.events }
        : { mode: 'connect' };
      model.disconnectId = null;
      model.webhookError = null;
      model.webhookNotice = null;
      draw();
      doc.getElementById('webhook-url')?.focus();
    },
    closeWebhookForm() {
      model.webhookForm = null;
      draw();
    },
    confirmDisconnect(id) {
      model.disconnectId = id;
      draw();
    },
    async webhookOperation(action, fields) {
      if (model.webhookBusy || !model.webhooks) return;
      model.webhookBusy = { action, id: fields.id ?? null };
      model.webhookError = null;
      model.webhookNotice = null;
      draw();
      try {
        const response = await request(`api/webhooks/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, session: model.webhooks.session, requestId: win.crypto.randomUUID() }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) {
          const failure = body.error === 'ping_failed' ? `${webhookTestText(body.test)}. ${action === 'replace'
            ? 'The current connection was kept. Paste the corrected values to try again.'
            : action === 'connect' ? 'No connection was saved. Paste the corrected values to try again.' : 'The connection was kept.'}`
            : Object.hasOwn(WEBHOOK_ERRORS, body.error) ? WEBHOOK_ERRORS[body.error]
              : 'The connection action failed. Refresh the list before trying again.';
          model.webhookError = failure;
          announce(failure);
        } else {
          model.webhookNotice = action === 'disconnect'
            ? 'Disconnected. Queued notifications were cancelled. A request already being sent may still arrive.'
            : `${action === 'connect' ? 'Connected. ' : action === 'replace' ? 'Connection updated. ' : ''}Test accepted. Check the bot conversation; the bot may still be working.`;
          if (action === 'connect' || action === 'replace') model.webhookForm = null;
          model.disconnectId = null;
          announce(model.webhookNotice);
        }
      } catch {
        model.webhookError = 'The gateway did not confirm the result. Refresh the connections before trying again; the action may have completed.';
        announce(model.webhookError);
      } finally {
        // The list is safe to reload even after a lost response; never automatically replay a secret-bearing POST.
        await actions.loadWebhooks();
        model.webhookBusy = null;
        draw();
      }
    },
    async copy(text, message = 'Command copied.') {
      try {
        await win.navigator.clipboard.writeText(text);
        announce(message);
      } catch {
        announce('Copy is not available here; select the command instead.');
      }
    },
  };
  win.addEventListener('hashchange', () => {
    model.route = parseRoute(win.location.hash);
    model.notice = null;
    model.webhookForm = model.route.view === 'webhooks' ? { mode: 'connect' } : null;
    model.disconnectId = null;
    model.webhookError = null;
    model.webhookNotice = null;
    draw(true);
    if (model.route.view === 'webhooks') return actions.loadWebhooks();
  });
  doc.addEventListener('visibilitychange', () => {
    // Operators switch to the bot's panels while pasting. Do not erase a partly filled form when they return.
    if (doc.visibilityState === 'visible' && !model.webhookForm && Date.now() - model.fetchedAt > STALE_MS) return actions.refresh();
  });
  win.addEventListener('pagehide', clearWebhookFields);
  // Keep relative times current without asking the server.
  win.setInterval(() => {
    if (!model.snapshot) return;
    const now = Date.parse(model.snapshot.generatedAt) + (Date.now() - model.fetchedAt);
    for (const { el, iso } of times) el.textContent = relative(iso, now);
  }, 20_000);
  draw();
  return { ready: actions.refresh() };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('app')) boot(window, document);
