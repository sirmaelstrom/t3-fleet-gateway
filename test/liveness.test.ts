import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveLiveness, linkEnvironment, LIVENESS_RUN_SCAN, LIVENESS_TAIL } from '../src/hosts/liveness.ts';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { THREAD_READ_SCOPE } from '../src/oauth/scopes.ts';
import { threadReadSchema, type ThreadRead } from '../src/t3/schemas.ts';
import { testClock } from './helpers/clock.ts';
import { agentWithToken, startJob, startJobHarness, type JobHarness } from './helpers/jobs.ts';

const target = { host: 'main', projectId: 'project-1' };
const READ_TOOLS = new Set(['t3_project_list', 't3_thread_list', 't3_thread_read', 't3_pending_request_list', 't3_pending_request', 'tools/list']);

interface Liveness {
  threadId: string; parentThreadId: string | null; phase: string; waitingOn: string | null; status: string; activeRunId: string | null;
  latestRun: { runId: string; status: string; startedAt: string | null } | null;
  lastActivityAt: string | null; activitySource: string; activityComplete: boolean; openItems: number; delegatedActive: number;
  pendingQuestions: number; pendingRequests: number; approval: string; metadataUpdatedAt: string | null; settled: boolean | null;
}
interface Report { complete: boolean; listed: number; considered: number; omitted: number; environmentId: string | null; readAt: string; threads: Liveness[]; errors: { threadId: string | null; code: string }[] }

async function harness(t: Parameters<typeof startJobHarness>[0], discovery = true): Promise<JobHarness> {
  // The fake T3 stamps items with the wall clock; the gateway clock starts there too so activity is never "in the future".
  const h = await startJobHarness(t, { clock: testClock(Date.now()), ...(discovery ? { host: { discovery: { enabled: true } } } : {}) });
  h.fake.threadLinkFormat = 'v2';
  return h;
}
const grantRead = (h: JobHarness, clientId = h.agent.clientId) => changeThreadScopes(h.gw.services.db, h.gw.clock, clientId, 'grant', [THREAD_READ_SCOPE]);
const external = (h: JobHarness, title = 'Synthetic external thread') =>
  h.fake.launchDirect({ projectId: 'project-1', title, runtimeMode: 'auto', message: 'Synthetic external task' }).threadId;
const fresh = async (h: JobHarness, extra: Record<string, unknown> = {}) => {
  h.gw.clock.advance(30_001);
  return h.agent.call<Report>('fleet_thread_liveness', { ...target, ...extra });
};
const byId = (report: Report, id: string) => report.threads.find((thread) => thread.threadId === id);

test('liveness authorizes before any T3 thread call and refuses disabled discovery, unknown hosts and projects', async (t) => {
  const h = await harness(t);
  external(h);
  const before = h.fake.calls.length;
  assert.equal((await h.agent.callError('fleet_thread_liveness', target)).code, 'insufficient_scope');
  assert.equal(h.fake.calls.length, before, 'no T3 call without threads:read');
  grantRead(h);
  assert.equal((await h.agent.callError('fleet_thread_liveness', { ...target, host: 'absent' })).code, 'not_found');
  assert.equal((await h.agent.callError('fleet_thread_liveness', { ...target, projectId: 'absent' })).code, 'not_found');
  assert.equal((await h.agent.callError('fleet_thread_liveness', { ...target, threadIds: Array(21).fill('thread-1') })).code, 'Input validation error');
  const hidden = h.gw.services.tokens.issueOperatorToken({ name: 'Synthetic other host', scopes: ['host:host-a:read'], expiresAt: h.gw.clock() + 60_000 });
  grantRead(h, hidden.clientId);
  const elsewhere = await agentWithToken(t, h.gw.baseUrl, hidden.clientId, hidden.token);
  const calls = h.fake.calls.length;
  assert.equal((await elsewhere.callError('fleet_thread_liveness', target)).code, 'not_found');
  assert.equal(h.fake.calls.length, calls, 'a client without Read on the host reaches no T3 tool');
  const off = await harness(t, false);
  grantRead(off);
  assert.equal((await off.agent.callError('fleet_thread_liveness', target)).code, 'discovery_disabled');
});

test('liveness covers delegated children and unadopted threads with read tools only, creating no job', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const parent = external(h, 'Synthetic coordinator');
  const { childThreadId } = h.fake.delegate(parent, 'Synthetic child task');
  h.fake.endTurn(parent);
  const before = h.fake.calls.length;
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  assert.equal(report.complete, true);
  assert.equal(report.environmentId, 'env-synthetic');
  const child = byId(report, childThreadId)!;
  assert.equal(child.parentThreadId, parent, 'delegated children are listed with their parent');
  assert.equal(child.phase, 'working');
  const coordinator = byId(report, parent)!;
  assert.equal(coordinator.phase, 'waiting');
  assert.equal(coordinator.waitingOn, 'child');
  assert.equal(coordinator.delegatedActive, 1);
  assert.ok(h.fake.calls.slice(before).every((call) => READ_TOOLS.has(call)), `only reads: ${h.fake.calls.slice(before).join(', ')}`);
  assert.equal(h.fake.sends.length, 0);
  assert.equal(h.gw.services.jobs.store.jobForThread('main', parent, { projects: h.gw.services.jobs.projectAccess(h.agent) }), undefined);
  assert.equal(h.gw.services.jobs.store.jobForThread('main', childThreadId, { projects: h.gw.services.jobs.projectAccess(h.agent) }), undefined);
  // A gateway job is read the same way, without changing its ledger state.
  const job = await startJob(h.agent);
  await h.tick();
  const owned = h.fake.threadForJob(job.jobId).threadId;
  assert.equal(byId(await fresh(h), owned)?.phase, 'working');
});

test('liveness classifies questions, approvals, unclassified requests, ended and failed turns, and cleans them up', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const asking = external(h, 'Synthetic asking');
  h.fake.askQuestion(asking, [{ id: 'q', header: 'Pick', question: 'Synthetic question?', options: [{ label: 'A', description: 'a' }] }]);
  const unclassified = external(h, 'Synthetic unclassified request');
  h.fake.requestApproval(unclassified);
  const approving = external(h, 'Synthetic approval');
  h.fake.addActivity(approving, 'approval_request', 1, 'pending');
  h.fake.requestApproval(approving);
  const toolRunning = external(h, 'Synthetic tool with a pending runtime request');
  h.fake.threadDetailOverrides.set(toolRunning, { pendingRequestCount: 1 });
  const done = external(h, 'Synthetic done');
  h.fake.finishTurn(done, 'Synthetic final reply');
  const failed = external(h, 'Synthetic failed');
  h.fake.failRun(failed);
  let report = await h.agent.call<Report>('fleet_thread_liveness', target);
  assert.deepEqual([byId(report, asking)?.phase, byId(report, asking)?.waitingOn, byId(report, asking)?.pendingQuestions], ['waiting', 'question', 1]);
  assert.deepEqual([byId(report, unclassified)?.waitingOn, byId(report, unclassified)?.approval], ['request', 'unclassified']);
  assert.deepEqual([byId(report, approving)?.waitingOn, byId(report, approving)?.approval], ['approval', 'confirmed']);
  assert.equal(byId(report, toolRunning)?.phase, 'working', 'a pending count on a running thread is not a human wait');
  assert.deepEqual([byId(report, done)?.phase, byId(report, done)?.latestRun?.status], ['turn_ended', 'completed']);
  assert.deepEqual([byId(report, failed)?.phase, byId(report, failed)?.latestRun?.status], ['turn_ended', 'failed']);
  h.fake.grantApprovals(unclassified);
  h.fake.threads.get(asking)!.questions.clear();
  h.fake.threads.get(asking)!.status = 'running';
  report = await fresh(h);
  assert.equal(byId(report, unclassified)?.phase, 'working');
  assert.equal(byId(report, asking)?.phase, 'working');
});

test('settled and long-dormant threads drop out unless named; a named settled thread is read directly', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const settled = external(h, 'Synthetic settled');
  h.fake.finishTurn(settled, 'Synthetic reply');
  h.fake.threads.get(settled)!.settled = true;
  const dormant = external(h, 'Synthetic dormant');
  h.fake.finishTurn(dormant, 'Synthetic reply');
  h.fake.threads.get(dormant)!.updatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  assert.equal(byId(report, settled), undefined);
  assert.equal(byId(report, dormant), undefined);
  assert.equal(report.listed, 1, 'the settled thread is not in the non-settled list');
  const named = await h.agent.call<Report>('fleet_thread_liveness', { ...target, threadIds: [settled] });
  assert.equal(byId(named, settled)?.settled, true);
  assert.equal(byId(named, settled)?.phase, 'turn_ended');
  const wide = await h.agent.call<Report>('fleet_thread_liveness', { ...target, withinHours: 72 });
  assert.equal(byId(wide, dormant)?.phase, 'turn_ended');
  const other = h.fake.launchDirect({ projectId: 'project-2', title: 'Synthetic elsewhere', message: 'Synthetic' }).threadId;
  const crossed = await h.agent.call<Report>('fleet_thread_liveness', { ...target, threadIds: [other] });
  assert.equal(byId(crossed, other), undefined, 'a thread of another project is never returned');
  assert.deepEqual(crossed.errors, [{ threadId: other, code: 'not_found' }]);
  assert.equal(crossed.complete, false);
});

test('the heartbeat is own provider activity in the current run: not metadata, user messages, children or this read', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const id = external(h, 'Synthetic quiet worker');
  const thread = h.fake.threads.get(id)!;
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  h.fake.addActivity(id, 'command_execution');
  for (const item of thread.items) item.updatedAt = old;
  thread.runs[0]!.startedAt = old;
  thread.updatedAt = new Date().toISOString();
  thread.title = 'Synthetic renamed';
  let report = await h.agent.call<Report>('fleet_thread_liveness', target);
  assert.equal(byId(report, id)?.lastActivityAt, old, 'a metadata change is not activity');
  assert.notEqual(byId(report, id)?.metadataUpdatedAt, old);
  h.fake.delegate(id, 'Synthetic child');
  const child = [...h.fake.threads.values()].find((candidate) => candidate.title === 'Synthetic child')!;
  for (const item of thread.items) item.updatedAt = old;
  child.updatedAt = new Date().toISOString();
  report = await fresh(h);
  assert.equal(byId(report, id)?.lastActivityAt, old, 'delegation items and a child\'s progress do not refresh the parent');
  const [running] = h.fake.addActivity(id, 'command_execution', 1, 'running');
  running!.updatedAt = old;
  report = await fresh(h);
  assert.equal(byId(report, id)?.openItems, 1, 'a command still running is reported, so quiet is explained');
  const [latest] = h.fake.addActivity(id, 'reasoning');
  report = await fresh(h);
  assert.equal(byId(report, id)?.lastActivityAt, new Date(Date.parse(latest!.updatedAt)).toISOString());
  assert.equal(byId(report, id)?.activitySource, 'timeline');
});

test('long timelines whose current run fits the tail are read from the tail only, and a failed thread read is explicit without hiding the others', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const long = external(h, 'Synthetic long thread');
  h.fake.addActivity(long, 'dynamic_tool', 500);
  h.fake.endTurn(long);
  h.fake.userTurn(long, 'Synthetic follow-up');
  h.fake.addActivity(long, 'reasoning', 3);
  const broken = external(h, 'Synthetic unreadable');
  h.fake.readFailures.set(broken, { code: 'orchestration_error', message: 'Synthetic failure' });
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  const tail = h.fake.reads.filter((read) => read.threadId === long);
  assert.equal(tail.length, 1, 'an older run inside the tail shows where the current run starts');
  assert.equal(tail[0]!.afterPosition, h.fake.threads.get(long)!.items.length - LIVENESS_TAIL - 1);
  assert.equal(tail[0]!.maxCharsPerItem, 1, 'no message or command text is read');
  assert.equal(byId(report, long)?.activityComplete, true);
  assert.equal(byId(report, broken), undefined);
  assert.equal(report.complete, false);
  assert.equal(report.errors.some((error) => error.threadId === broken), true);
  const calls = h.fake.calls.length;
  await h.agent.call<Report>('fleet_thread_liveness', target);
  assert.equal(h.fake.calls.length, calls, 'a repeat within 30 seconds is served from the cache');
  const text = JSON.stringify(report);
  assert.equal(text.includes('Synthetic external task'), false, 'no message text in the report');
});

test('an old child still running past the 40-item tail keeps its parent waiting on it', async (t) => {
  const h = await harness(t);
  grantRead(h);
  // A coordinator delegates, works on for more than a tail's worth of items, then ends its turn while the child works.
  const parent = external(h, 'Synthetic old coordinator');
  const { childThreadId } = h.fake.delegate(parent, 'Synthetic long child');
  h.fake.addActivity(parent, 'dynamic_tool', LIVENESS_TAIL + 5);
  h.fake.endTurn(parent);
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  const coordinator = byId(report, parent)!;
  assert.deepEqual([coordinator.phase, coordinator.waitingOn, coordinator.delegatedActive], ['waiting', 'child', 1],
    'an old delegated child still running is not an ended turn');
  assert.equal(coordinator.activityComplete, true);
  assert.equal(byId(report, childThreadId)?.phase, 'working');
  assert.equal(report.complete, true);
});

test('an old command updated in place past the 40-item tail is activity and still open', async (t) => {
  const h = await harness(t);
  grantRead(h);
  // A worker starts a long command, does more than a tail's worth of other work, then the command updates in place.
  const worker = external(h, 'Synthetic old command');
  const thread = h.fake.threads.get(worker)!;
  const [command] = h.fake.addActivity(worker, 'command_execution', 1, 'running');
  h.fake.addActivity(worker, 'reasoning', LIVENESS_TAIL + 5);
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  for (const entry of thread.items) entry.updatedAt = old;
  thread.runs[0]!.startedAt = old;
  command!.updatedAt = recent;
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  const busy = byId(report, worker)!;
  assert.equal(busy.lastActivityAt, recent, 'an old command updated in place is activity');
  assert.equal(busy.openItems, 1, 'the old command still running is an open item');
  assert.equal(busy.activityComplete, true);
  assert.equal(report.complete, true);
});

test('a current run longer than the bounded read is partial, never complete, and a listed child still counts', async (t) => {
  const h = await harness(t);
  grantRead(h);
  const parent = external(h, 'Synthetic very long coordinator');
  h.fake.delegate(parent, 'Synthetic child behind a long run');
  h.fake.addActivity(parent, 'dynamic_tool', 2000);
  h.fake.endTurn(parent);
  const report = await h.agent.call<Report>('fleet_thread_liveness', target);
  const coordinator = byId(report, parent)!;
  assert.equal(coordinator.activityComplete, false, 'history the read could not reach is not labelled complete');
  assert.deepEqual([coordinator.phase, coordinator.waitingOn], ['waiting', 'child'], 'the listed child shows the wait without the old item');
  assert.equal(report.complete, false);
  assert.deepEqual(report.errors.filter((error) => error.threadId === parent).map((error) => error.code), ['activity_partial']);
  const reads = h.fake.reads.filter((entry) => entry.threadId === parent);
  assert.ok(reads.length <= 1 + 3 + LIVENESS_RUN_SCAN / 100, `bounded reads: ${reads.length}`);
  const lowest = Math.min(...reads.map((entry) => entry.afterPosition ?? -1));
  const count = h.fake.threads.get(parent)!.items.length;
  assert.equal(lowest, count - LIVENESS_TAIL - LIVENESS_RUN_SCAN - 1, `no full-history scan: read from position ${lowest} of ${count}`);
});

function read(overrides: { thread?: Record<string, unknown>; runs?: Record<string, unknown>[]; items?: Record<string, unknown>[] } = {}): ThreadRead {
  return threadReadSchema.parse({
    thread: { threadId: 'thread-a', projectId: 'p', title: 'Synthetic', status: 'running', latestRunId: 'run-2', activeRunId: 'run-2',
      pendingRequestCount: 0, branch: null, updatedAt: '2026-01-01T00:50:00.000Z', ...overrides.thread },
    recentRuns: overrides.runs ?? [
      { runId: 'run-2', ordinal: 2, status: 'running', requestedAt: '2026-01-01T00:20:00.000Z', startedAt: '2026-01-01T00:20:01.000Z', completedAt: null },
      { runId: 'run-1', ordinal: 1, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:10:00.000Z' },
    ],
    items: overrides.items ?? [], nextPosition: null, hasMore: false,
  });
}
const item = (position: number, runId: string, type: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  position, itemId: `i${position}`, runId, createdBy: null, creationSource: null, type, status: 'completed', text: '', textTruncated: true, updatedAt, ...extra,
});
const NOW = Date.parse('2026-01-01T01:00:00.000Z');

test('derive: a new run resets the baseline; the active run wins over a queued latest; foreign, user and future items never count', () => {
  const items = [item(1, 'run-1', 'assistant_message', '2026-01-01T00:09:00.000Z')];
  const a = read({ items });
  const restarted = deriveLiveness(a, a.items, 0, true, NOW);
  assert.equal(restarted.lastActivityAt, '2026-01-01T00:20:01.000Z', 'an old run\'s message does not count for the new run; its start does');
  assert.equal(restarted.activitySource, 'run_start');
  const queued = read({
    thread: { latestRunId: 'run-3', activeRunId: 'run-2' },
    runs: [{ runId: 'run-3', ordinal: 3, status: 'queued', startedAt: null, completedAt: null },
      { runId: 'run-2', ordinal: 2, status: 'running', startedAt: '2026-01-01T00:20:01.000Z', completedAt: null }],
    items: [item(1, 'run-2', 'reasoning', '2026-01-01T00:30:00.000Z'),
      item(2, 'run-2', 'assistant_message', '2026-01-01T00:45:00.000Z', { sourceThreadId: 'thread-parent' }),
      item(3, 'run-2', 'user_message', '2026-01-01T00:46:00.000Z', { createdBy: 'user' }),
      item(4, 'run-2', 'checkpoint', '2026-01-01T00:47:00.000Z'),
      item(5, 'run-2', 'command_execution', '2026-01-01T02:00:00.000Z')],
  });
  const live = deriveLiveness(queued, queued.items, 0, true, NOW);
  assert.equal(live.phase, 'working');
  assert.equal(live.latestRun?.status, 'queued');
  assert.equal(live.lastActivityAt, '2026-01-01T00:30:00.000Z');
  assert.equal(live.activitySource, 'timeline');
  const idle = read({ thread: { status: 'idle', latestRunId: null, activeRunId: null }, runs: [] });
  const none = deriveLiveness(idle, [], 0, true, NOW);
  assert.deepEqual([none.phase, none.lastActivityAt, none.activitySource], ['idle', null, 'none']);
  assert.equal(linkEnvironment('<t3-thread://v2/env-x/thread-a>'), 'env-x');
  assert.equal(linkEnvironment('t3-thread://v1/thread-a'), null);
});
