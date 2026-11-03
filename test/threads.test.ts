import { threadLink } from '../src/threadId.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE } from '../src/oauth/scopes.ts';
import { agentWithToken, assertNotLogged, connectAgent, startJob, startJobHarness, type JobHarness } from './helpers/jobs.ts';

const target = { host: 'main', projectId: 'project-1' };
function grant(h: JobHarness, clientId = h.agent.clientId, scopes = [THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE]) {
  return changeThreadScopes(h.gw.services.db, h.gw.clock, clientId, 'grant', scopes);
}
function external(h: JobHarness, title = 'Synthetic external thread') {
  return h.fake.launchDirect({ projectId: 'project-1', title, runtimeMode: 'auto', message: 'Synthetic external task' }).threadId;
}
interface ListedThread { threadId: string; title: string; state: string; archived: boolean | null; settled: boolean | null; gatewayOwned: boolean; jobId: string | null; origin: string | null }
interface Page { threads: ListedThread[]; nextCursor: string | null; total: number; readAt: string }
interface Adoption { job: { jobId: string; origin: string; adoptedBy: string; adoptedAt: string; state: string }; created: boolean }

test('thread discovery pages both shelves, marks ownership, bounds titles and caches/refreshes stable snapshots', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const ids = Array.from({ length: 103 }, () => external(h));
  h.fake.threads.get(ids[0]!)!.settled = true;
  h.fake.threads.get(ids[0]!)!.title = 'Synthetic\u0000' + 'x'.repeat(300);
  const launched = await startJob(h.agent);
  await h.tick();
  const first = await h.agent.call<Page>('fleet_threads', target);
  assert.equal(first.threads.length, 50);
  assert.equal(first.total, 104);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.threads.find((thread) => thread.jobId === launched.jobId)?.gatewayOwned, true);
  const calls = h.fake.calls.length;
  const second = await h.agent.call<Page>('fleet_threads', { ...target, cursor: first.nextCursor });
  const third = await h.agent.call<Page>('fleet_threads', { ...target, cursor: second.nextCursor });
  assert.equal(h.fake.calls.length, calls, 'cursor pages use the held snapshot');
  assert.equal(new Set([...first.threads, ...second.threads, ...third.threads].map((thread) => thread.threadId)).size, 104);
  const settled = third.threads.find((thread) => thread.threadId === ids[0])!;
  assert.equal(settled.settled, true);
  assert.equal(settled.archived, null, 'current T3 list has no archived field');
  assert.equal(settled.title.length, 200);
  assert.equal(settled.title.includes('\u0000'), false);
  external(h);
  assert.equal((await h.agent.call<Page>('fleet_threads', target)).total, 104);
  assert.equal((await h.agent.call<Page>('fleet_threads', { ...target, refresh: true, limit: 100 })).threads.length, 100);
  assert.equal((await h.agent.callError('fleet_threads', { ...target, cursor: first.nextCursor })).code, 'invalid_argument');
  assert.equal((await h.agent.callError('fleet_threads', { ...target, projectId: 'project-2', cursor: second.nextCursor })).code, 'invalid_argument');
  assert.equal((await h.agent.callError('fleet_threads', { ...target, limit: 101 })).code, 'Input validation error');
  h.gw.clock.advance(30_001);
  external(h);
  assert.equal((await h.agent.call<Page>('fleet_threads', target)).total, 106);
});

test('thread discovery and adoption authorize first, refuse disabled discovery and unknown projects, and never return partial oversized catalogs', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  const input = { ...target, threadId: external(h), requestId: 'adopt-1' };
  const calls = h.fake.calls.length;
  assert.equal((await h.agent.callError('fleet_threads', target)).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_adopt', input)).code, 'insufficient_scope');
  assert.equal(h.fake.calls.length, calls);
  grant(h, h.agent.clientId, [THREAD_READ_SCOPE]);
  assert.equal((await h.agent.callError('work_adopt', input)).code, 'insufficient_scope');
  grant(h);
  assert.equal((await h.agent.callError('fleet_threads', { ...target, projectId: 'absent' })).code, 'not_found');
  assert.equal((await h.agent.callError('work_adopt', { ...input, projectId: 'absent' })).code, 'not_found');
  assert.equal((await h.agent.callError('work_adopt', { ...input, threadId: 'absent' })).code, 'not_found');
  const elsewhere = h.fake.launchDirect({ projectId: 'project-2', title: 'Synthetic elsewhere', message: 'Synthetic' }).threadId;
  assert.equal((await h.agent.callError('work_adopt', { ...input, threadId: elsewhere })).code, 'not_found');
  const hidden = h.gw.services.tokens.issueOperatorToken({ name: 'Synthetic restricted client', scopes: ['host:host-a:read', 'host:host-a:operate'], expiresAt: h.gw.clock() + 60_000 });
  grant(h, hidden.clientId);
  const restricted = await agentWithToken(t, h.gw.baseUrl, hidden.clientId, hidden.token);
  const before = h.fake.calls.length;
  for (const host of ['main', 'absent']) {
    assert.equal((await restricted.callError('fleet_threads', { ...target, host })).code, 'not_found');
    assert.equal((await restricted.callError('work_adopt', { ...input, host })).code, 'not_found');
  }
  assert.equal(h.fake.calls.length, before);
  for (let i = 0; i < 2001; i++) external(h);
  assert.equal((await h.agent.callError('fleet_threads', target)).code, 'catalog_limit');
  const disabled = await startJobHarness(t);
  grant(disabled);
  assert.equal((await disabled.agent.callError('fleet_threads', target)).code, 'discovery_disabled');
  assert.equal((await disabled.agent.callError('work_adopt', { ...target, threadId: external(disabled), requestId: 'disabled' })).code, 'discovery_disabled');
});

test('adoption is read-only, concurrent/request/thread idempotent, records provenance, and refuses existing gateway ownership even after cancellation', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  h.fake.finishTurn(threadId, 'Synthetic old reply');
  const input = { ...target, threadId, requestId: 'adopt-once' };
  const before = h.fake.calls.length;
  const results = await Promise.all([h.agent.call<Adoption>('work_adopt', input), h.agent.call<Adoption>('work_adopt', input)]);
  const { job } = results[0]!;
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results[1]!.job.jobId, job.jobId);
  assert.equal(job.origin, 'adopted');
  assert.equal(job.adoptedBy, h.agent.clientId);
  assert.equal(job.adoptedAt, new Date(h.gw.clock()).toISOString());
  assert.equal(job.state, 'idle');
  assert.ok(h.fake.calls.slice(before).every((call) => ['t3_project_list', 't3_thread_read', 't3_pending_request_list'].includes(call)));
  assert.equal((await h.agent.call<Adoption>('work_adopt', { ...input, requestId: 'another-id' })).job.jobId, job.jobId);
  assert.equal((await h.agent.callError('work_adopt', { ...input, threadId: external(h) })).code, 'request_id_conflict');
  const page = await h.agent.call<Page>('fleet_threads', target);
  assert.deepEqual(page.threads.find((thread) => thread.threadId === threadId)?.origin, 'adopted');
  const launched = await startJob(h.agent);
  await h.tick();
  const owned = h.fake.threadForJob(launched.jobId).threadId;
  await h.agent.call('work_cancel', { jobId: launched.jobId });
  await h.tick();
  assert.equal((await h.agent.callError('work_adopt', { ...input, threadId: owned, requestId: 'already-owned' })).code, 'job_state_conflict');
  assert.equal(h.gw.services.jobs.store.slotHolders('main'), 0);
});

test('adopted threads use uniform control, messages and feed; cancel interrupts only the current turn and release leaves T3 alone', async (t) => {
  const h = await startJobHarness(t, { maxConcurrentJobs: 1, host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'adopt-running' });
  assert.equal(job.state, 'running');
  assert.equal(h.gw.services.jobs.store.slotHolders('main'), 0);
  const launched = await startJob(h.agent);
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(launched.jobId).state, 'running');
  const question = h.fake.askQuestion(threadId, [{ id: 'q1', header: 'Synthetic choice', question: 'Synthetic question', options: [{ label: 'Proceed', description: 'Synthetic option' }] }]);
  await h.tick();
  const status = await h.agent.call<{ state: string; pendingRequests: { requestId: string }[] }>('work_status', { jobId: job.jobId });
  assert.equal(status.state, 'needs_input');
  assert.equal(status.pendingRequests[0]?.requestId, question);
  await h.agent.call('work_respond', { jobId: job.jobId, requestId: question, answers: { q1: 'Proceed' } });
  h.fake.finishTurn(threadId, 'Synthetic external reply');
  await h.tick();
  const messages = await h.agent.call<{ messages: { text: string }[] }>('work_messages', { jobId: job.jobId });
  assert.equal(messages.messages[0]?.text, 'Synthetic external reply');
  await h.agent.call('work_settle', { jobId: job.jobId, requestId: 'settle-external' });
  await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic private follow-up', requestId: 'continue-external' });
  const cancel = await h.agent.call<{ outcome: string }>('work_cancel', { jobId: job.jobId });
  assert.equal(cancel.outcome, 'interrupt_requested');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'idle');
  const feed = await h.agent.call<{ events: { jobId: string; type: string }[] }>('work_feed', {});
  for (const type of ['created', 'input_answered', 'thread_settled', 'interrupt_requested']) {
    assert.ok(feed.events.some((event) => event.jobId === job.jobId && event.type === type), type);
  }
  const audits = h.gw.logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'threads.control');
  for (const action of ['adopt', 'continue', 'respond', 'settle', 'interrupt']) {
    assert.ok(audits.some((entry) => entry.action === action && entry.clientId === h.agent.clientId && entry.hostId === 'main' && entry.jobId === job.jobId), action);
  }
  const calls = h.fake.calls.length;
  assert.equal(h.gw.services.jobs.release(job.jobId).job.state, 'released');
  assert.equal(h.fake.calls.length, calls);
  assert.equal((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'after-release' })).code, 'job_state_conflict');
  assertNotLogged(h.gw, ['Synthetic private follow-up', 'Synthetic question', 'Synthetic external reply', 'Synthetic external thread']);
});

test('external jobs never leak through work listings, feed or fleet_status after scope removal; read-only opt-in cannot control', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId: external(h), requestId: 'adopt' });
  changeThreadScopes(h.gw.services.db, h.gw.clock, h.agent.clientId, 'revoke', [THREAD_CONTROL_SCOPE]);
  await h.agent.call('work_status', { jobId: job.jobId });
  for (const [tool, args] of [
    ['work_continue', { message: 'Synthetic', requestId: 'no-control' }], ['work_respond', { requestId: 'q', answers: {} }],
    ['work_settle', { requestId: 'no-settle' }], ['work_cancel', {}],
  ] as const) assert.equal((await h.agent.callError(tool, { jobId: job.jobId, ...args })).code, 'insufficient_scope');
  changeThreadScopes(h.gw.services.db, h.gw.clock, h.agent.clientId, 'revoke', [THREAD_READ_SCOPE]);
  assert.deepEqual((await h.agent.call<{ jobs: unknown[] }>('work_list', {})).jobs, []);
  const feed = await h.agent.call<{ events: unknown[]; attention: unknown[] }>('work_feed', {});
  assert.deepEqual([feed.events, feed.attention], [[], []]);
  assert.ok((await h.agent.call<{ projects: { standingJobs: unknown[] }[] }>('fleet_status', {})).projects.every((project) => project.standingJobs.length === 0));
  assert.equal((await h.agent.callError('work_status', { jobId: job.jobId })).code, 'insufficient_scope');
  assert.equal((await h.agent.callError('work_messages', { jobId: job.jobId })).code, 'insufficient_scope');
  const readOnly = await connectAgent(t, h.gw, 'read');
  grant(h, readOnly.clientId);
  assert.equal((await readOnly.callError('work_adopt', { ...target, threadId: external(h), requestId: 'read-only' })).code, 'insufficient_scope');
});

test('operator grants/ungrants existing client scopes in place, idempotently, without changing token secrets or other clients', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  const client = h.gw.services.tokens.issueOperatorToken({ name: 'Synthetic connector label', scopes: ['host:main:read', 'host:main:operate'], expiresAt: h.gw.clock() + 60_000 });
  const agent = await agentWithToken(t, h.gw.baseUrl, client.clientId, client.token);
  const cli = async (...args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(['clients', ...args], { env: { T3FG_DATA_DIR: h.gw.dataDir }, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const stored = () => h.gw.services.db.prepare('SELECT * FROM access_tokens ORDER BY created_at, token_hash').all();
  const before = stored();
  const grantsBefore = ['refresh_tokens', 'token_families'].map((table) => h.gw.services.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  assert.equal((await agent.callError('fleet_threads', target)).code, 'insufficient_scope');
  const args = ['--scope', THREAD_READ_SCOPE, '--scope', THREAD_CONTROL_SCOPE];
  assert.equal((await cli('grant', client.clientId, ...args)).code, 0);
  assert.match((await cli('grant', client.clientId, ...args)).out, /unchanged/);
  assert.deepEqual(stored(), before, 'token hash, grant and expiry are byte-for-byte unchanged');
  await agent.call('fleet_threads', target);
  assert.equal((await h.agent.callError('fleet_threads', target)).code, 'insufficient_scope', 'another client stays off');
  const shown = await cli('list');
  for (const text of [client.clientId, 'Synthetic connector label', 'threads:read', 'threads:control', 'CREATED', 'LAST USED', 'SCOPES']) assert.ok(shown.out.includes(text), text);
  const scopes = await cli('scopes', client.clientId);
  assert.match(scopes.out, /host:main:read/);
  for (const output of [shown.out, scopes.out]) {
    assert.equal(output.includes(client.token), false);
    for (const row of before) assert.equal(output.includes(String(row.token_hash)), false);
  }
  assert.equal((await cli('grant', 'unknown', ...args)).code, 1);
  assert.equal((await cli('grant', client.clientId, '--scope', 'threads:unknown')).code, 1);
  assert.equal((await cli('grant', client.clientId, '--scope', 'fleet:operate')).code, 1);
  const rejectedRevoke = await cli('revoke', client.clientId, ...args);
  assert.equal(rejectedRevoke.code, 2);
  assert.match(rejectedRevoke.err, /clients ungrant/);
  assert.equal(rejectedRevoke.out, '');
  assert.equal((await cli('grant', client.clientId)).code, 2);
  assert.equal((await cli('ungrant', client.clientId)).code, 2);
  await agent.call('fleet_threads', target);
  assert.equal(h.gw.services.clients.get(client.clientId)?.revokedAt, null);
  assert.equal((await cli('ungrant', 'unknown', ...args)).code, 1);
  assert.equal((await cli('ungrant', client.clientId, '--scope', 'threads:unknown')).code, 1);
  assert.equal((await cli('ungrant', client.clientId, ...args)).code, 0);
  assert.match((await cli('ungrant', client.clientId, ...args)).out, /unchanged/);
  assert.equal((await agent.callError('fleet_threads', target)).code, 'insufficient_scope');
  assert.deepEqual(stored(), before);
  assert.deepEqual(['refresh_tokens', 'token_families'].map((table) => h.gw.services.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), grantsBefore);
  await agent.call('fleet_status');
  const audits = h.gw.services.db.prepare('SELECT client_id, action, scope, changed FROM operator_scope_events ORDER BY id').all();
  assert.equal(audits.length, 8);
  assert.ok(audits.every((entry) => entry.client_id === client.clientId));
  assert.deepEqual(audits.map((entry) => entry.changed), [1, 1, 0, 0, 1, 1, 0, 0]);
});

test('host grants retain operator standing-job visibility and controls while client adoptions stay scoped', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } }, pilot: { allowWorkStart: false } });
  const standingThread = external(h, 'Synthetic operator coordinator');
  h.fake.finishTurn(standingThread, 'Synthetic standing reply');
  const { job: standing } = await h.gw.services.jobs.adopt({ project: 'pilot', threadId: standingThread });
  grant(h);
  const { job: adopted } = await h.agent.call<Adoption>('work_adopt', {
    ...target, threadId: external(h, 'Synthetic client adoption'), requestId: 'adopt-separated',
  });
  for (const access of ['read', 'operate'] as const) {
    const issued = h.gw.services.tokens.issueOperatorToken({ name: `Synthetic host ${access}`,
      scopes: access === 'read' ? ['host:main:read'] : ['host:main:read', 'host:main:operate'], expiresAt: h.gw.clock() + 60_000 });
    const agent = await agentWithToken(t, h.gw.baseUrl, issued.clientId, issued.token);
    const fleet = await agent.call<{ projects: { standingJobs: { jobId: string }[] }[] }>('fleet_status');
    assert.deepEqual(fleet.projects.flatMap((project) => project.standingJobs.map((job) => job.jobId)), [standing.id]);
    for (const mine of [false, true]) {
      const listed = await agent.call<{ jobs: { jobId: string }[] }>('work_list', { mine, limit: 1 });
      assert.deepEqual(listed.jobs.map((job) => job.jobId), [standing.id], 'adopted rows do not consume the SQL limit');
      const feed = await agent.call<{ events: { jobId: string }[]; attention: { jobId: string }[] }>('work_feed', { mine });
      assert.ok(feed.events.some((event) => event.jobId === standing.id));
      assert.ok(feed.attention.some((job) => job.jobId === standing.id));
      assert.ok([...feed.events, ...feed.attention].every((entry) => entry.jobId !== adopted.jobId));
    }
    const status = await agent.call<{ state: string; origin: string }>('work_status', { jobId: standing.id });
    assert.deepEqual([status.state, status.origin], ['idle', 'standing']);
    await agent.call('work_messages', { jobId: standing.id });
    assert.equal((await agent.callError('fleet_threads', target)).code, 'insufficient_scope');
    assert.equal((await agent.callError('work_adopt', { ...target, threadId: external(h), requestId: 'host-only' })).code, 'insufficient_scope');
    for (const tool of ['work_status', 'work_messages']) {
      assert.equal((await agent.callError(tool, { jobId: adopted.jobId })).code, 'insufficient_scope');
    }
    for (const [tool, input] of [
      ['work_continue', { message: 'Synthetic', requestId: 'blocked' }], ['work_respond', { requestId: 'q', answers: {} }],
      ['work_cancel', {}], ['work_settle', { requestId: 'blocked' }],
    ] as const) {
      assert.equal((await agent.callError(tool, { ...input, jobId: adopted.jobId })).code, 'insufficient_scope');
      if (access === 'read') assert.equal((await agent.callError(tool, { ...input, jobId: standing.id })).code, 'insufficient_scope');
    }
    if (access === 'operate') {
      const disabled = await agent.callError('work_start', { project: 'pilot', task: 'Synthetic', requestId: 'disabled-standing' });
      assert.equal(disabled.code, 'start_disabled');
      assert.ok(disabled.text.includes(standing.id));
      assert.equal(disabled.text.includes(adopted.jobId), false);
      await agent.call('work_continue', { jobId: standing.id, message: 'Synthetic coordinator instruction', requestId: 'standing-continue' });
      assert.equal(h.fake.sends.at(-1)?.threadId, standingThread);
      const question = h.fake.askQuestion(standingThread, [{ id: 'choice', header: 'Synthetic', question: 'Synthetic coordinator question', options: [] }]);
      await h.tick();
      await agent.call('work_respond', { jobId: standing.id, requestId: question, answers: { choice: 'Synthetic answer' } });
      assert.equal(h.fake.responses.at(-1)?.threadId, standingThread);
      const cancelled = await agent.call<{ outcome: string }>('work_cancel', { jobId: standing.id });
      assert.equal(cancelled.outcome, 'interrupt_requested');
      await h.tick();
      assert.equal((await agent.call<{ state: string }>('work_status', { jobId: standing.id })).state, 'idle');
      const settled = await agent.call<{ settled: boolean }>('work_settle', { jobId: standing.id, requestId: 'standing-settle' });
      assert.equal(settled.settled, true);
    }
  }
});

test('adopted resumes revalidate project membership and runtime ceilings; observation never changes T3 settings', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  h.fake.finishTurn(threadId, 'Synthetic reply');
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'adopt-policy' });
  const thread = h.fake.threads.get(threadId)!;
  thread.runtimeMode = 'full-access';
  assert.equal((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'resume' })).code, 'job_state_conflict');
  assert.equal(h.fake.sends.length, 0);
  const question = h.fake.askQuestion(threadId, [{ id: 'q', header: 'Synthetic', question: 'Synthetic', options: [] }]);
  assert.equal((await h.agent.callError('work_respond', { jobId: job.jobId, requestId: question, answers: {} })).code, 'job_state_conflict');
  assert.equal(h.fake.responses.length, 0);
  await h.agent.call('work_status', { jobId: job.jobId });
  thread.runtimeMode = 'auto';
  thread.projectId = 'project-2';
  assert.equal((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'resume' })).code, 'job_state_conflict');
  assert.equal(h.fake.sends.length, 0);
  thread.projectId = 'project-1';
  thread.questions.clear();
  await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'resume' });
  assert.equal(h.fake.sends.length, 1, 'a refused preflight does not poison the request id');
  assert.equal(thread.runtimeMode, 'auto');
});

test('archived and delegated child threads cannot be adopted; gateway launch markers cannot be hijacked before reconciliation', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const parent = external(h);
  const { childThreadId } = h.fake.delegate(parent, 'Synthetic delegated work');
  const archived = external(h);
  h.fake.threads.get(archived)!.archived = true;
  for (const threadId of [childThreadId, archived]) {
    assert.equal((await h.agent.callError('work_adopt', { ...target, threadId, requestId: threadId })).code, 'job_state_conflict');
  }
  const page = await h.agent.call<Page>('fleet_threads', target);
  assert.deepEqual(page.threads.map((thread) => thread.threadId), [parent]);
  const queued = await startJob(h.agent);
  const marker = external(h, h.gw.services.jobs.store.require(queued.jobId).title);
  assert.equal((await h.agent.callError('work_adopt', { ...target, threadId: marker, requestId: 'marker' })).code, 'job_state_conflict');
  assert.equal(h.gw.services.jobs.store.require(queued.jobId).threadId, null);
});

test('durable thread audits include every authorized action and are append-only and content-free', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  const input = { ...target, threadId, requestId: 'adopt-audit' };
  const { job } = await h.agent.call<Adoption>('work_adopt', input);
  await h.agent.call('work_adopt', input);
  await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic sensitive follow-up', requestId: 'send-audit' });
  await h.agent.call('work_cancel', { jobId: job.jobId });
  h.gw.services.jobs.release(job.jobId);
  const rows = h.gw.services.db.prepare('SELECT * FROM thread_action_events ORDER BY id').all();
  assert.deepEqual(rows.map((row) => row.action), ['adopt', 'adopt_replayed', 'continue', 'interrupt', 'release']);
  assert.ok(rows.every((row) => row.host_id === 'main' && row.thread_id === threadId && row.job_id === job.jobId));
  assert.equal(rows.at(-1)?.client_id, 'operator');
  assert.equal(JSON.stringify(rows).includes('Synthetic'), false);
  assert.throws(() => h.gw.services.db.exec('UPDATE thread_action_events SET action = action'), /append-only/);
  assert.throws(() => h.gw.services.db.exec('DELETE FROM thread_action_events'), /append-only/);
  assert.throws(() => h.gw.services.db.exec('UPDATE operator_scope_events SET action = action'), /append-only/);
});

test('release during an adopted resume preflight prevents the later send', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'adopt-release-race' });
  h.fake.holdResponses.add('t3_project_list');
  const sending = h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'release-race' });
  await h.fake.whenHeld('t3_project_list');
  h.gw.services.jobs.release(job.jobId);
  h.fake.holdResponses.delete('t3_project_list');
  h.fake.releaseHeld();
  assert.equal((await sending).code, 'job_state_conflict');
  assert.equal(h.fake.sends.length, 0);
});

test('overlapping adoptions deduplicate by host/thread even if project-to-alias mapping changes during their reads', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } },
    pilot: { t3ProjectId: undefined, t3ProjectTitle: 'Synthetic project 1' } });
  grant(h);
  const threadId = external(h);
  h.fake.holdResponses.add('t3_thread_read');
  const first = h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'adopt-before-rename' });
  await h.fake.whenHeld('t3_thread_read');
  // The first adopter classified the alias already; the second sees the same project with a changed title.
  h.fake.projects[0]!.title = 'Synthetic renamed project';
  h.fake.holdResponses.delete('t3_thread_read');
  const second = await h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'adopt-after-rename' });
  h.fake.releaseHeld();
  const replay = await first;
  assert.equal(second.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.job.jobId, second.job.jobId);
  assert.equal(h.gw.services.jobs.store.list({ limit: 10 }).length, 1);
});

test('client adoption/resume fails closed when archive or lineage metadata is missing or unfamiliar', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const threadId = external(h);
  for (const metadata of [{ archived: undefined }, { relationshipToParent: undefined }, { relationshipToParent: 'synthetic-future-lineage' }]) {
    h.fake.threadDetailOverrides.set(threadId, metadata);
    assert.equal((await h.agent.callError('work_adopt', { ...target, threadId, requestId: 'metadata' })).code, 't3_invalid_response');
    assert.equal(h.gw.services.jobs.store.list({ limit: 10 }).length, 0);
  }
  h.fake.threadDetailOverrides.delete(threadId);
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId, requestId: 'metadata' });
  h.fake.threadDetailOverrides.set(threadId, { archived: undefined });
  assert.equal((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'missing-metadata' })).code, 't3_invalid_response');
  assert.equal(h.fake.sends.length, 0);
  await h.agent.call('work_status', { jobId: job.jobId });
});

const uuid = '11111111-2222-4333-8444-555555555555';
const realisticIds = [uuid, `mcp:${uuid}`, `thread:provider:codex:native-thread:${uuid}`,
  `thread:provider:claudeAgent:native-thread:provider-thread%3Apending%253Arun%253A${uuid}`,
  `thread:delegated-task:command%3Amcp%3A${uuid}%3Adelegate-task%3Asynthetic`,
  'thread:mcp:synthetic%3Anamespace:synthetic-key:0'];
function summary(threadId: string, title = 'Synthetic thread', updatedAt = '2026-01-01T00:00:00Z') {
  return { threadId, title, updatedAt, status: 'idle', latestRunId: null, createdAt: '2026-01-01T00:00:00Z' };
}

test('thread catalog accepts T3 minted ids and skips malformed entries with one content-free warning', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const malformed = [null, {}, summary('bad/id'), summary('bad\nvalue'), { ...summary('missing-title'), title: undefined },
    { ...summary('bad-status'), status: 42 }];
  const threads = [...realisticIds.map((id) => summary(id)), ...malformed];
  h.fake.threadListPages.set(0, { projectId: target.projectId, threads, total: threads.length, nextCursor: null });
  const page = await h.agent.call<Page>('fleet_threads', target);
  assert.deepEqual(page.threads.map((thread) => thread.threadId), realisticIds);
  assert.equal(page.total, realisticIds.length);
  const warnings = h.gw.logs.map((line) => JSON.parse(line)).filter((line) => line.event === 'catalog.threads_skipped');
  assert.deepEqual(warnings.map(({ time, ...line }) => line), [{ level: 'warn', event: 'catalog.threads_skipped', hostId: 'main', count: malformed.length }]);
  assertNotLogged(h.gw, [...realisticIds, 'missing-title', 'bad-status', 'Synthetic thread']);
});

test('offset page duplicates keep the newest copy, with an order-independent tie-break and raw page accounting', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const newer = summary(`mcp:${uuid}`, 'Synthetic newer', '2026-01-02T00:00:00Z');
  const older = summary(newer.threadId, 'Synthetic older');
  const tiedA = summary(uuid, 'Synthetic A');
  const tiedZ = summary(uuid, 'Synthetic Z');
  const first = [older, tiedA, ...Array.from({ length: 98 }, (_, i) => summary(`synthetic-${i}`))];
  const last = [newer, tiedZ, null];
  const setPages = (a: unknown[], b: unknown[]) => {
    h.fake.threadListPages.set(0, { projectId: target.projectId, threads: a, total: 103, nextCursor: 100 });
    h.fake.threadListPages.set(100, { projectId: target.projectId, threads: b, total: 103, nextCursor: null });
  };
  setPages(first, last);
  const page = await h.agent.call<Page>('fleet_threads', { ...target, limit: 100 });
  assert.equal(page.total, 100);
  assert.equal(page.threads.find((thread) => thread.threadId === newer.threadId)?.title, newer.title);
  assert.equal(page.threads.find((thread) => thread.threadId === uuid)?.title, tiedZ.title);
  setPages([newer, tiedZ, ...first.slice(2)], [older, tiedA, null]);
  const refreshed = await h.agent.call<Page>('fleet_threads', { ...target, refresh: true, limit: 100 });
  assert.deepEqual(refreshed.threads, page.threads);
});

test('work_adopt accepts an MCP id through persistence, watcher, feed and dashboard and rejects dangerous ids', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } }, dashboard: { enabled: true } });
  grant(h);
  const oldId = external(h);
  const thread = h.fake.threads.get(oldId)!;
  h.fake.threads.delete(oldId);
  thread.threadId = `mcp:${uuid}`;
  h.fake.threads.set(thread.threadId, thread);
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId: thread.threadId, requestId: 'mcp-adopt' });
  assert.equal(h.gw.services.jobs.store.require(job.jobId).threadId, thread.threadId);
  await h.tick();
  const status = await h.agent.call<{ threadId: string }>('work_status', { jobId: job.jobId });
  assert.equal(status.threadId, thread.threadId);
  const feed = await h.agent.call<{ attention: { threadId: string }[]; events: { jobId: string }[] }>('work_feed', {});
  assert.ok(feed.events.some((event) => event.jobId === job.jobId));
  const dashboard = await fetch(`http://127.0.0.1:${h.gw.gateway.dashboard!.port}/api/snapshot`, { headers: { 'x-t3fg-dashboard': '1' } });
  assert.equal(dashboard.status, 200);
  const snapshot = await dashboard.json() as { jobs: { open: { id: string; link: string }[] } };
  assert.equal(snapshot.jobs.open.find((entry) => entry.id === job.jobId)?.link, threadLink(thread.threadId));
  assert.equal(threadLink(thread.threadId), `t3-thread://v1/mcp:${uuid}`);
  const calls = h.fake.calls.length;
  for (const threadId of ['bad/id', '../bad', 'bad\\id', 'bad id', 'bad\nvalue', 'bad?x', 'bad#x', 'bad%xx', '<bad>']) {
    assert.equal((await h.agent.callError('work_adopt', { ...target, threadId, requestId: 'invalid-id' })).code, 'Input validation error');
  }
  assert.equal(h.fake.calls.length, calls);
});

test('gateway launches and follows T3 branded ids through job reads and discovery', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  for (const threadId of [`mcp:${uuid}`, realisticIds[3]!]) {
    h.fake.nextThreadId = threadId;
    const job = await startJob(h.agent);
    await h.tick();
    assert.equal(h.gw.services.jobs.store.require(job.jobId).threadId, threadId);
    h.fake.finishTurn(threadId, 'Synthetic completed work');
    await h.tick();
    const status = await h.agent.call<{ threadId: string; link: string; state: string }>('work_status', { jobId: job.jobId });
    assert.equal(status.state, 'idle');
    assert.equal(status.threadId, threadId);
    assert.equal(status.link, threadLink(threadId));
    const page = await h.agent.call<Page>('fleet_threads', { ...target, refresh: true });
    assert.equal(page.threads.find((entry) => entry.threadId === threadId)?.gatewayOwned, true);
  }
});

test('thread page and text limits still fail closed even with skipped and duplicate entries', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const page = (threads: unknown[], total: number, nextCursor: number | null) => ({ projectId: target.projectId, threads, total, nextCursor });
  for (const invalid of [page([summary(uuid)], 2, null), page([null], 1, 0), page([null], 1, 2),
    page(Array(101).fill(null), 101, null), { ...page([], 0, null), projectId: 'wrong-project' }]) {
    h.fake.threadListPages.set(0, invalid);
    assert.equal((await h.agent.callError('fleet_threads', { ...target, refresh: true })).code, 't3_invalid_response');
  }
  h.fake.threadListPages.set(0, page([null], 2001, null));
  assert.equal((await h.agent.callError('fleet_threads', { ...target, refresh: true })).code, 'catalog_limit');
  // Twenty full pages are still a hard bound even when every row is the same valid id.
  for (let offset = 0; offset < 2000; offset += 100) {
    h.fake.threadListPages.set(offset, page(Array(100).fill(summary(uuid)), 2000, offset + 100));
  }
  assert.equal((await h.agent.callError('fleet_threads', { ...target, refresh: true })).code, 'catalog_limit');
  // Sanitized text budget applies to distinct valid entries, independently of the page count.
  for (let offset = 0; offset < 600; offset += 100) {
    h.fake.threadListPages.set(offset, page(Array.from({ length: 100 }, (_, i) => summary(`synthetic-${offset + i}-${'a'.repeat(2000)}`)),
      600, offset === 500 ? null : offset + 100));
  }
  assert.equal((await h.agent.callError('fleet_threads', { ...target, refresh: true })).code, 'catalog_limit');
});

test('unfamiliar T3 ids remain operable in persisted job output and are skipped only in discovery and links', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  for (const threadId of ['synthetic/future-thread', 'synthetic future thread']) {
    h.fake.nextThreadId = threadId;
    const job = await startJob(h.agent);
    await h.tick();
    const stored = h.gw.services.jobs.store.require(job.jobId);
    assert.equal(stored.threadId, threadId);
    assert.equal(stored.threadLink, null);
    assert.equal(stored.state, 'running');
    const status = await h.agent.call<{ threadId: string; link: string | null }>('work_status', { jobId: job.jobId });
    assert.equal(status.threadId, threadId);
    assert.equal(status.link, null);
    const list = await h.agent.call<{ jobs: { threadId: string }[] }>('work_list', {});
    assert.ok(list.jobs.some((entry) => entry.threadId === threadId));
    await h.agent.call('work_continue', { jobId: job.jobId, message: 'Synthetic follow-up', requestId: `follow-${job.jobId}` });
    assert.equal(h.fake.sends.at(-1)?.threadId, threadId);
    await h.agent.call('work_cancel', { jobId: job.jobId });
    await h.tick();
  }
  assert.equal((await h.agent.call<Page>('fleet_threads', target)).total, 0, 'unfamiliar ids do not break or enter discovery');
});

test('a lost launch response with an unfamiliar T3 id reconciles without launching twice', async (t) => {
  const h = await startJobHarness(t);
  h.fake.nextThreadId = 'synthetic/recovered thread';
  const job = await startJob(h.agent);
  h.fake.dropResponseOnce.add('t3_thread_launch');
  await h.tick();
  assert.equal(h.gw.services.jobs.store.require(job.jobId).state, 'unknown');
  await h.tickAfter(60_000);
  const stored = h.gw.services.jobs.store.require(job.jobId);
  assert.equal(stored.state, 'running');
  assert.equal(stored.threadId, 'synthetic/recovered thread');
  assert.equal(stored.threadLink, null);
  assert.equal(h.fake.launches.length, 1);
});

test('side chats are hidden from discovery and cannot be adopted by id; ordinary forks remain adoptable', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  grant(h);
  const sideChat = external(h, 'Synthetic side chat');
  Object.assign(h.fake.threads.get(sideChat)!, { sideChat: true, relationshipToParent: 'fork' });
  const fork = external(h, 'Synthetic ordinary fork');
  h.fake.threads.get(fork)!.relationshipToParent = 'fork';
  const page = await h.agent.call<Page>('fleet_threads', target);
  assert.deepEqual(page.threads.map((thread) => thread.threadId), [fork]);
  assert.equal((await h.agent.callError('work_adopt', { ...target, threadId: sideChat, requestId: 'side-chat' })).code, 'job_state_conflict');
  const { job } = await h.agent.call<Adoption>('work_adopt', { ...target, threadId: fork, requestId: 'ordinary-fork' });
  const readsBeforeWatch = h.fake.reads.length;
  await h.tick();
  assert.deepEqual(h.gw.services.jobs.store.onHost('main', ['running']).map((row) => row.id), [job.jobId]);
  assert.ok(!h.fake.reads.slice(readsBeforeWatch).some((read) => read.threadId === sideChat), 'watcher never imports hidden side chats');
  // Even a direct id must be checked again before a resume; the earlier list snapshot is insufficient.
  h.fake.finishTurn(fork, 'Synthetic fork reply');
  await h.tick();
  h.fake.threads.get(fork)!.sideChat = true;
  const sends = h.fake.calls.filter((call) => call === 't3_thread_send').length;
  assert.equal((await h.agent.callError('work_continue', { jobId: job.jobId, message: 'Synthetic', requestId: 'hidden-fork' })).code, 'job_state_conflict');
  assert.equal(h.fake.calls.filter((call) => call === 't3_thread_send').length, sends);
});

test('project organization is additive and flags archived projects without changing configured launch policy', async (t) => {
  const h = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  Object.assign(h.fake.projects[0]!, { pinnedAt: '2026-10-31T00:00:00.000Z', archivedAt: '2026-10-31T01:00:00.000Z' });
  Object.assign(h.fake.projects[1]!, { pinnedAt: null, archivedAt: null });
  const result = await h.agent.call<{ hosts: { projects: { projectId: string; pinned: boolean | null; archived: boolean | null; guidance: string; launch: { allowed: boolean } }[] }[] }>('fleet_projects', { host: 'main' });
  const projects = result.hosts[0]!.projects;
  assert.deepEqual(projects.map((project) => [project.pinned, project.archived]), [[true, true], [false, false], [null, null]]);
  assert.equal(projects[0]!.launch.allowed, true, 'organization does not change the operator policy');
  assert.match(projects[0]!.guidance, /Archived in T3/);
});
