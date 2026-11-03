import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { projectAccess, projectGrant, setProjectAccess } from '../src/oauth/projectAccess.ts';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { NEVER_EXPIRES } from '../src/oauth/tokens.ts';
import { agentWithToken, startJob, startJobHarness } from './helpers/jobs.ts';

interface Fleet { projects: { alias: string; standingJobs: { jobId: string }[] }[]; hosts: { runningJobs: number; queuedJobs: number; defaultProject: string | null }[] }
interface Projects { hosts: { projects: { projectId: string }[]; total: number; nextCursor: string | null }[] }
interface Feed { events: { jobId: string }[]; attention: { jobId: string }[]; hasMore: boolean; nextCursor: string }

test('project policy filters catalogs, counts, feed pages and attention and refuses every cross-project job action', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true, allowWorkStart: true } } });
  const { db, jobs, config } = h.gw.services;
  const visible = await startJob(h.agent, 'Allowed task', { requestId: 'visible' });
  const hidden = await startJob(h.agent, 'Hidden task', { project: 'docs', requestId: 'hidden' });
  await h.tick();
  const hiddenJob = jobs.store.require(hidden.jobId);
  h.fake.finishTurn(hiddenJob.threadId!, 'Hidden worker content');
  await h.tick();
  jobs.store.transition(hidden.jobId, { from: ['idle'], to: 'needs_input' });
  db.prepare('UPDATE jobs SET launch_spec = ? WHERE id = ?').run('unreadable-hidden-plan', hidden.jobId);
  setProjectAccess(db, h.agent.clientId, [projectGrant(config, 'pilot')]);
  const fleet = await h.agent.call<Fleet>('fleet_status');
  assert.deepEqual(fleet.projects.map((p) => p.alias), ['pilot']);
  assert.equal(fleet.hosts[0]!.runningJobs, 1);
  const projects = await h.agent.call<Projects>('fleet_projects', { host: 'main', limit: 1 });
  assert.deepEqual(projects.hosts[0]!.projects.map((p) => p.projectId), ['project-1']);
  assert.equal(projects.hosts[0]!.total, 1);
  assert.equal(projects.hosts[0]!.nextCursor, null, 'filtered before pagination and total');
  const list = await h.agent.call<{ jobs: { jobId: string }[] }>('work_list', { limit: 1 });
  assert.deepEqual(list.jobs.map((j) => j.jobId), [visible.jobId], 'newer hidden job does not fill page');
  const feed = await h.agent.call<Feed>('work_feed', { limit: 1, mine: false });
  assert.ok(feed.events.every((e) => e.jobId === visible.jobId));
  assert.ok(feed.attention.every((j) => j.jobId !== hidden.jobId));
  let cursor = feed.nextCursor;
  let more = feed.hasMore;
  for (let n = 0; more && n < 20; n++) {
    const page = await h.agent.call<Feed>('work_feed', { cursor, limit: 1, mine: false });
    assert.ok(page.events.every((e) => e.jobId === visible.jobId));
    assert.ok(!JSON.stringify(page).includes('Hidden'));
    cursor = page.nextCursor; more = page.hasMore;
  }
  assert.equal(more, false);
  for (const secret of ['Hidden task', 'Hidden worker content', 'Allowed task']) assert.ok(!h.gw.logs.join('\n').includes(secret));
  const reads = h.fake.reads.length;
  for (const [name, args] of [
    ['work_status', {}], ['work_messages', {}], ['work_continue', { message: 'no', requestId: 'continue' }],
    ['work_cancel', {}], ['work_settle', { requestId: 'settle' }], ['work_respond', { requestId: 'pending-1', answers: {} }],
  ] as const) {
    assert.equal((await h.agent.callError(name, { jobId: hidden.jobId, ...args })).code, 'insufficient_scope', name);
  }
  assert.equal(h.fake.reads.length, reads, 'refused before thread reads');
  assert.equal((await h.agent.callError('work_start', { project: 'docs', task: 'no', requestId: 'new-hidden' })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_start', { project: 'docs', task: 'Hidden task', requestId: 'hidden' })).code, 'insufficient_scope', 'replays reauthorize');
  assert.equal((await h.agent.callError('work_start', { target: { host: 'main', projectId: 'project-2' }, task: 'no', requestId: 'by-id' })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_list', { target: { host: 'main', projectId: 'project-2' } })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_start', { project: 'missing', task: 'no', requestId: 'missing' })).text.includes('docs'), false);
  assert.equal((await h.agent.call<{ job: { jobId: string } }>('work_start', { project: 'pilot', task: 'Allowed task', requestId: 'visible' })).job.jobId, visible.jobId);
});

test('thread discovery, cached cursors, adoption and standing jobs cannot bypass project restrictions', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  const { db, config, jobs } = h.gw.services;
  changeThreadScopes(db, h.gw.clock, h.agent.clientId, 'grant', ['threads:read', 'threads:control']);
  const external = h.fake.launchDirect({ projectId: 'project-2', title: 'Hidden external', runtimeMode: 'auto', message: 'Hidden task' });
  const standing = await jobs.adopt({ project: 'docs', threadId: external.threadId });
  h.fake.launchDirect({ projectId: 'project-2', title: 'Another hidden thread', runtimeMode: 'auto', message: 'Hidden task 2' });
  const cached = await h.agent.call<{ nextCursor: string | null }>('fleet_threads', { host: 'main', projectId: 'project-2', limit: 1 });
  assert.ok(cached.nextCursor);
  setProjectAccess(db, h.agent.clientId, [projectGrant(config, 'pilot')]);
  const reads = h.fake.reads.length;
  for (const extra of [{}, ...(cached.nextCursor ? [{ cursor: cached.nextCursor }] : [])]) {
    assert.equal((await h.agent.callError('fleet_threads', { host: 'main', projectId: 'project-2', ...extra })).code, 'insufficient_scope');
  }
  assert.equal((await h.agent.callError('work_adopt', { host: 'main', projectId: 'project-2', threadId: external.threadId, requestId: 'adopt-hidden' })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_continue', { jobId: standing.job.id, message: 'no', requestId: 'standing' })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_adopt', { host: 'main', projectId: 'project-1', threadId: external.threadId, requestId: 'wrong-project' })).code, 'not_found');
  assert.ok(h.fake.reads.length >= reads);
  assert.ok(!JSON.stringify(await h.agent.call('fleet_status')).includes(standing.job.id));
  assert.ok(!JSON.stringify(await h.agent.call('work_feed', { mine: false })).includes(standing.job.id));
});

test('client policy survives rotation, intersects host grants, denies all explicitly and is backward compatible when removed', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  const { db, tokens, config } = h.gw.services;
  const bearer = tokens.issueOperatorToken({ name: 'Restricted bot', scopes: ['host:main:read', 'host:main:operate'], expiresAt: NEVER_EXPIRES });
  setProjectAccess(db, bearer.clientId, [{ host: 'other', projectId: 'project-1' }]);
  const bot = await agentWithToken(t, h.gw.baseUrl, bearer.clientId, bearer.token);
  assert.deepEqual((await bot.call<Fleet>('fleet_status')).projects, []);
  assert.equal((await bot.callError('work_start', { target: { host: 'other', projectId: 'project-1' }, task: 'no', requestId: 'host' })).code, 'not_found');
  setProjectAccess(db, bearer.clientId, [projectGrant(config, '@main/project-1')]);
  const allowed = await startJob(bot, 'Queued allowed');
  assert.equal((await bot.call<{ jobId: string }>('work_status', { jobId: allowed.jobId })).jobId, allowed.jobId);
  const replacement = tokens.rotateOperatorToken(bearer.clientId, bearer.tokenId, 1000, NEVER_EXPIRES);
  const next = await agentWithToken(t, h.gw.baseUrl, bearer.clientId, replacement.token);
  assert.deepEqual((await next.call<Fleet>('fleet_status')).projects.map((p) => p.alias), ['pilot']);
  setProjectAccess(db, bearer.clientId, []);
  assert.deepEqual((await next.call<Fleet>('fleet_status')).projects, []);
  assert.deepEqual((await next.call<Projects>('fleet_projects', { host: 'main' })).hosts[0]!.projects, []);
  assert.equal((await next.callError('work_status', { jobId: allowed.jobId })).code, 'insufficient_scope');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(allowed.jobId).lastErrorCode, 'insufficient_scope', 'queued work is checked again before launch');
  assert.equal(h.fake.threads.size, 0);
  setProjectAccess(db, bearer.clientId, undefined);
  assert.equal((await next.call<Fleet>('fleet_status')).projects.length, 2);
  assert.equal(projectAccess(db, bearer.clientId), undefined);
  assert.equal((await h.agent.call<Fleet>('fleet_status')).projects.length, 2, 'other unrestricted OAuth client unchanged');
});

test('migration 21 preserves populated tokens and defaults every client to unrestricted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 20));
    db.exec(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('bot', 'Bot', '[]', 1);
      INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES ('grant', 'bot', 'fleet:read', 'https://gateway.example.com/mcp', 1);
      INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
      VALUES ('synthetic-hash', 'grant', '', 'fleet:read', 1, 9999);
      INSERT INTO operator_tokens (id, token_hash) VALUES ('token-id', 'synthetic-hash');`);
    const before = db.prepare('SELECT * FROM access_tokens').all();
    migrate(db);
    assert.deepEqual(db.prepare('SELECT * FROM access_tokens').all(), before);
    assert.equal(projectAccess(db, 'bot'), undefined);
    setProjectAccess(db, 'bot', []);
    assert.deepEqual(projectAccess(db, 'bot'), []);
    db.prepare('UPDATE client_project_access SET projects = ?').run('damaged');
    assert.deepEqual(projectAccess(db, 'bot'), [], 'damaged policy fails closed');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => migrate(db, MIGRATIONS.slice(0, 20)), /newer than this build supports/);
  } finally { db.close(); }
});


test('a disallowed default scratch alias is hidden and cannot be launched through host-only targeting', async (t) => {
  const h = await startJobHarness(t, { host: { defaultProject: 'pilot' }, pilot: { workspaceMode: 'scratch' } });
  setProjectAccess(h.gw.services.db, h.agent.clientId, [projectGrant(h.gw.services.config, 'docs')]);
  const status = await h.agent.call<Fleet>('fleet_status');
  assert.equal(status.hosts[0]!.defaultProject, null);
  assert.deepEqual(status.projects.map((p) => p.alias), ['docs']);
  assert.equal((await h.agent.callError('work_start', { target: { host: 'main' }, task: 'no', requestId: 'scratch' })).code, 'insufficient_scope');
  assert.equal(h.fake.threads.size, 0);
});


test('a title-only alias can browse and target its uniquely resolved project without admitting other catalogs', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true, allowWorkStart: true } } });
  const { db, config } = h.gw.services;
  setProjectAccess(db, h.agent.clientId, [projectGrant(config, 'docs')]);
  changeThreadScopes(db, h.gw.clock, h.agent.clientId, 'grant', ['threads:read']);
  const catalog = await h.agent.call<Projects>('fleet_projects', { host: 'main' });
  assert.deepEqual(catalog.hosts[0]!.projects.map((p) => p.projectId), ['project-2']);
  const launched = await h.agent.call<{ job: { jobId: string } }>('work_start', {
    target: { host: 'main', projectId: 'project-2' }, task: 'Allowed docs work', requestId: 'title-target',
  });
  assert.equal((await h.agent.call<{ jobId: string }>('work_status', { jobId: launched.job.jobId })).jobId, launched.job.jobId);
  assert.equal((await h.agent.callError('fleet_threads', { host: 'main', projectId: 'project-1' })).code, 'insufficient_scope');
});

test('project authorization preserves operate-only target launches and external adoption', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true, allowWorkStart: true } } });
  const { tokens, db, config } = h.gw.services;
  const minted = tokens.issueOperatorToken({ name: 'Operate only', scopes: ['host:main:operate'], expiresAt: NEVER_EXPIRES });
  const bot = await agentWithToken(t, h.gw.baseUrl, minted.clientId, minted.token);
  changeThreadScopes(db, h.gw.clock, minted.clientId, 'grant', ['threads:read', 'threads:control']);
  const external = h.fake.launchDirect({ projectId: 'project-1', title: 'Allowed external', runtimeMode: 'auto', message: 'Allowed task' });
  for (const restricted of [false, true]) {
    setProjectAccess(db, minted.clientId, restricted ? [projectGrant(config, 'pilot')] : undefined);
    await bot.call('work_start', { target: { host: 'main', projectId: 'project-1' }, task: 'Allowed', requestId: `operate-${restricted}` });
    await bot.call('work_adopt', { host: 'main', projectId: 'project-1', threadId: external.threadId, requestId: `adopt-${restricted}` });
  }
});

test('read-only host errors cannot confirm the host of an excluded alias', async (t) => {
  const h = await startJobHarness(t);
  const { tokens, db } = h.gw.services;
  const minted = tokens.issueOperatorToken({ name: 'Read only here', scopes: ['host:main:read', 'host:other:operate'], expiresAt: NEVER_EXPIRES });
  setProjectAccess(db, minted.clientId, []);
  const bot = await agentWithToken(t, h.gw.baseUrl, minted.clientId, minted.token);
  const denied = await bot.callError('work_start', { project: 'pilot', task: 'No', requestId: 'read-only-hidden' });
  assert.equal(denied.code, 'insufficient_scope');
  assert.ok(!denied.text.includes('pilot') && !denied.text.includes('main'));
});
