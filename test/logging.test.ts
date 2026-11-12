import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { THREAD_READ_SCOPE } from '../src/oauth/scopes.ts';
import { HOUR } from '../src/time.ts';
import { TestAgentProvider } from './helpers/agent.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway } from './helpers/gateway.ts';
import { assertNotLogged, startJobHarness } from './helpers/jobs.ts';
import { tokenRequest } from './helpers/oauthFlow.ts';

test('no secret value ever appears in the logs', async (t) => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  const gw = await startTestGateway(t, {
    config: { hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }] },
  });
  await gw.services.registry.enroll('main');

  const approvalCodes: string[] = [];
  const provider = new TestAgentProvider(() => {
    const code = gw.mintApprovalCode();
    approvalCodes.push(code);
    return code;
  }, 'operate');
  const url = new URL(`${gw.baseUrl}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await new Client({ name: 'agent', version: '0' }).connect(transport).catch(() => {});
  const authorizationCode = provider.callbackParams?.get('code') ?? '';
  await transport.finishAuth(provider.callbackParams ?? new URLSearchParams());
  const issued = [provider.savedTokens?.access_token, provider.savedTokens?.refresh_token];

  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  await client.callTool({ name: 'fleet_status', arguments: {} });
  gw.clock.advance(13 * HOUR);
  await client.callTool({ name: 'fleet_status', arguments: {} });
  issued.push(provider.savedTokens?.access_token, provider.savedTokens?.refresh_token);
  await client.close();
  // Failure paths log too: a bad approval code, a replayed code and a bogus bearer token.
  await tokenRequest(gw.baseUrl, { grant_type: 'authorization_code', code: authorizationCode, client_id: provider.clientInfo?.client_id ?? '' });
  await fetch(url, { method: 'POST', headers: { authorization: 'Bearer bogus-secret-token-value', 'content-type': 'application/json' }, body: '{}' });

  const secrets = [
    ...issued,
    authorizationCode,
    provider.codeVerifier(),
    ...approvalCodes,
    ...approvalCodes.map((code) => code.replace('-', '')),
    ...fake.issuedTokens,
    'bogus-secret-token-value',
  ].filter((value): value is string => typeof value === 'string' && value.length >= 8);
  assert.ok(secrets.length >= 9, `collected ${secrets.length} secrets`);
  assert.ok(gw.logs.length > 10);
  const log = gw.logs.join('\n');
  for (const secret of secrets) assert.equal(log.includes(secret), false, 'a secret leaked into the logs');
  assert.doesNotMatch(log, /"authorization"|bearer /i);
});

test('no task text, message, question, answer or worker output ever appears in the logs', async (t) => {
  const { fake, gw, agent, tick } = await startJobHarness(t);
  const content = {
    task: 'Synthetic-task-text-7d1f: refactor the parser',
    title: 'Synthetic-title-0b2e',
    followUp: 'Synthetic-follow-up-91ac: now add tests',
    question: 'Synthetic-question-55e0: which parser?',
    answer: 'Synthetic-answer-c3d9',
    header: 'Synthetic-question-header-12ca',
    optionLabel: 'Synthetic-option-label-a2f3',
    optionDescription: 'Synthetic-option-description-cde4',
    optionValue: 'Synthetic-option-value-678f',
    excerpt: 'Synthetic-worker-output-a6f2: parser refactored',
  };
  const { job } = await agent.call<{ job: { jobId: string } }>('work_start', { project: 'pilot', task: content.task, title: content.title, requestId: 'log-1' });
  await tick();
  const { threadId } = fake.threadForJob(job.jobId);
  const requestId = fake.askQuestion(threadId, [{ id: 'q', header: content.header, question: content.question,
    options: [{ label: content.optionLabel, description: content.optionDescription, value: content.optionValue }],
    allowCustomAnswer: true, required: true, multiSelect: false }]);
  await tick();
  await agent.call('work_status', { jobId: job.jobId });
  await agent.call('work_respond', { jobId: job.jobId, requestId, answers: { q: content.answer } });
  fake.finishTurn(threadId, content.excerpt);
  await tick();
  await agent.call('work_continue', { jobId: job.jobId, message: content.followUp, requestId: 'log-2' });
  fake.failures.set('t3_thread_launch', { code: 'invalid_input', message: `Rejected: ${content.task}` });
  await agent.call('work_start', { project: 'pilot', task: `${content.task} again`, requestId: 'log-3' });
  await tick();
  await agent.call('work_feed', {});
  await agent.call('work_messages', { jobId: job.jobId, limit: 5 });
  await agent.call('work_cancel', { jobId: job.jobId });

  assert.ok(gw.logs.some((line) => line.includes('"event":"job.state_changed"')));
  assertNotLogged(gw, [...Object.values(content), 'Synthetic-task-text', 'Synthetic-worker-output']);
  const events = JSON.stringify(gw.services.db.prepare('SELECT * FROM job_events').all());
  for (const value of Object.values(content)) assert.equal(events.includes(value), false, 'content leaked into events');
  fake.failures.set('t3_pending_request_read', { code: 'unavailable', message: content.question + content.optionDescription });
  // The cancelled job has no listed ids; use a second job to exercise the failed read path.
  const second = await agent.call<{ job: { jobId: string } }>('work_start', { project: 'pilot', task: content.task, requestId: 'log-4' });
  fake.failures.delete('t3_thread_launch');
  await tick();
  fake.askQuestion(fake.threadForJob(second.job.jobId).threadId, [{ id: 'q', header: content.header, question: content.question, options: [] }]);
  await tick();
  await agent.call('work_status', { jobId: second.job.jobId });
  assert.ok(gw.logs.some((line) => line.includes('jobs.question_read_failed')));
  assertNotLogged(gw, Object.values(content));
});

test('mint and probe stdout, stderr and argv never enter logs, returned diagnostics or renewal records', async (t) => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  const secrets = ['Synthetic-command-output-849d', 'Synthetic-command-error-912c', 'Synthetic-command-argv-391a'];
  const command = [process.execPath, '-e', `console.log(${JSON.stringify(secrets[0])}); console.error(${JSON.stringify(secrets[1])}); process.exit(9)`, secrets[2]!];
  const gw = await startTestGateway(t, { config: { hosts: [{ id: 'main', t3Url: fake.url,
    mintPairingCode: command, mintPairingCodeProbe: command }] } });
  const checks = await gw.services.registry.preflight('main');
  assert.ok(checks.some((check) => check.code === 'probe_failed'));
  await assert.rejects(gw.services.registry.enroll('main'), { code: 'pairing_command_failed' });
  assertNotLogged(gw, secrets);
  const returned = JSON.stringify(checks) + JSON.stringify(gw.services.registry.credentialStatus('main'));
  for (const secret of secrets) assert.equal(returned.includes(secret), false);
});

test('no T3 project name, model, option or constraint from discovery ever appears in the logs or events', async (t) => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  const { gw, agent, tick } = await startJobHarness(t, { fake, host: { discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'auto' } } });
  const content = {
    project: 'Synthetic-project-name-4e1a',
    model: 'synthetic-model-9c2b',
    optionId: 'synthetic-option-7f3d',
    choice: 'synthetic-choice-d8e1',
    constraint: 'Synthetic-constraint-b6a0',
    task: 'Synthetic-discovered-task-33af',
  };
  fake.projects[1]!.title = content.project;
  fake.providers = [{
    providerInstanceId: 'synthetic-provider', driverKind: 'synthetic', displayName: 'Synthetic', canRunChildTask: true, canRunCrossProviderChildTask: false,
    constraints: [content.constraint],
    models: [{ id: content.model, label: null, options: [{ id: content.optionId, label: 'Synthetic', type: 'select', options: [{ id: content.choice, label: 'Synthetic' }] }] }],
  }];
  await agent.call('fleet_projects', { refresh: true });
  await agent.call('fleet_models', { refresh: true });
  const { job } = await agent.call<{ job: { jobId: string } }>('work_start', {
    target: { host: 'main', projectId: 'project-2' }, task: content.task, requestId: 'disc-1',
    modelSelection: { instanceId: 'synthetic-provider', model: content.model, options: { [content.optionId]: content.choice } },
  });
  await agent.callError('work_start', {
    target: { host: 'main', projectId: 'project-2' }, task: content.task, requestId: 'disc-2',
    modelSelection: { instanceId: 'synthetic-provider', model: content.model, options: { [content.optionId]: 'Synthetic-wrong-value-1c9e' } },
  });
  await tick();
  fake.providers[0]!.models[0]!.options![0]!.options = [];
  const second = await agent.call<{ job: { jobId: string } }>('work_start', {
    target: { host: 'main', projectId: 'project-2' }, task: content.task, requestId: 'disc-3',
    modelSelection: { instanceId: 'synthetic-provider', model: content.model },
  });
  gw.services.jobs.store.update(second.job.jobId, {});
  await tick();
  await agent.call('work_status', { jobId: job.jobId });
  await agent.call('work_feed', {});
  assert.ok(gw.logs.some((line) => line.includes('"event":"job.created"')));
  assertNotLogged(gw, [...Object.values(content), 'Synthetic-wrong-value']);
  const events = JSON.stringify(gw.services.db.prepare('SELECT * FROM job_events').all());
  for (const value of [...Object.values(content), 'Synthetic-wrong-value-1c9e']) assert.equal(events.includes(value), false, 'content leaked into events');
});

test('a thread\'s model and provider in the liveness report never reach the logs, even when a read fails', async (t) => {
  const { gw, agent, fake } = await startJobHarness(t, { host: { discovery: { enabled: true } } });
  changeThreadScopes(gw.services.db, gw.clock, agent.clientId, 'grant', [THREAD_READ_SCOPE]);
  const content = { model: 'synthetic-liveness-model-5d1e', provider: 'synthetic-liveness-provider-b39c' };
  const launch = (title: string) => fake.launchDirect({ projectId: 'project-1', title, runtimeMode: 'auto', message: 'Synthetic task',
    modelSelection: { instanceId: content.provider, model: content.model } }).threadId;
  launch('Synthetic readable');
  fake.readFailures.set(launch('Synthetic unreadable'), { code: 'orchestration_error', message: `Synthetic failure ${content.model}` });
  const report = await agent.call<{ threads: { model: string | null; provider: string | null }[]; errors: unknown[] }>('fleet_thread_liveness', { host: 'main', projectId: 'project-1' });
  assert.deepEqual(report.threads.map((thread) => [thread.model, thread.provider]), [[content.model, content.provider]], 'authorized output carries them');
  assert.ok(report.errors.length > 0, 'the failing read was exercised');
  assertNotLogged(gw, Object.values(content));
});

test('scratch work leaks no task, title, T3 project name or catalog content through drift, a lost launch or a refused replay', async (t) => {
  const content = {
    task: 'Synthetic-scratch-task-55c1',
    title: 'Synthetic-scratch-title-8d02',
    project: 'Synthetic-scratch-project-name-1be7',
    model: 'synthetic-scratch-model-a47c',
    optionId: 'synthetic-scratch-option-3f9d',
    choice: 'synthetic-scratch-choice-62e8',
    constraint: 'Synthetic-scratch-constraint-90b4',
  };
  const selection = { instanceId: 'synthetic-provider', model: content.model, options: { [content.optionId]: content.choice } };
  const h = await startJobHarness(t, {
    maxConcurrentJobs: 4,
    host: { access: 'full-access', discovery: { enabled: true }, defaultProject: 'pilot' },
    pilot: { workspaceMode: 'scratch', runtimeMode: 'full-access' },
  });
  const { fake, gw, agent, tick } = h;
  fake.projects[0]!.title = content.project;
  fake.providers = [{
    providerInstanceId: 'synthetic-provider', driverKind: 'synthetic', displayName: 'Synthetic', canRunChildTask: true, canRunCrossProviderChildTask: false,
    constraints: [content.constraint],
    models: [{ id: content.model, label: null, options: [{ id: content.optionId, label: 'Synthetic', type: 'select', options: [{ id: content.choice, label: 'Synthetic' }] }] }],
  }];
  const start = (requestId: string, extra: Record<string, unknown> = {}) =>
    agent.call<{ job: { jobId: string } }>('work_start', { target: { host: 'main' }, task: content.task, title: content.title, requestId, ...extra });

  // A scratch job with an explicit selection, one reached by its id, and a mismatched filing: all launch.
  const selected = await start('selected', { modelSelection: selection });
  const byId = await start('by-id', { target: { host: 'main', projectId: 'project-1' } });
  await tick();
  fake.scratchProjectId = 'project-2';
  const mismatched = await start('mismatch');
  await tick();
  fake.scratchProjectId = 'project-1';

  // Drift while queued: the job fails with launch_policy_changed and its fixed text.
  const drifted = await start('drift');
  gw.services.config.projects[0]!.runtimeMode = 'auto';
  await tick();
  gw.services.config.projects[0]!.runtimeMode = 'full-access';
  assert.equal(gw.services.jobs.store.require(drifted.job.jobId).lastErrorCode, 'launch_policy_changed');

  // A lost launch response: the job is unknown, then found by its marker in the pinned project.
  fake.dropResponseOnce.add('t3_thread_launch');
  const lost = await start('lost');
  await tick();
  assert.equal(gw.services.jobs.store.require(lost.job.jobId).state, 'unknown');
  await h.tickAfter(60_000);
  assert.equal(gw.services.jobs.store.require(lost.job.jobId).state, 'running');

  // A replay the caller may not operate, and a conflicting reuse of a request id.
  const narrowed = { clientId: agent.clientId, scopes: ['host:other:read', 'host:other:operate'] as const };
  await assert.rejects(gw.services.jobs.start(narrowed, { target: { host: 'main' }, task: content.task, title: content.title, requestId: 'selected', modelSelection: selection }), { code: 'insufficient_scope' });
  assert.equal((await agent.callError('work_start', { target: { host: 'main' }, task: `${content.task} changed`, requestId: 'selected', modelSelection: selection })).code, 'request_id_conflict');

  for (const { job } of [selected, byId, mismatched, drifted, lost]) {
    await agent.call('work_status', { jobId: job.jobId });
  }
  await agent.call('work_feed', {});
  await agent.call('work_list', {});
  const events = ['job.created', 'job.scratch_project_mismatch'].map((event) => gw.logs.some((line) => line.includes(`"event":"${event}"`)));
  assert.deepEqual(events, [true, true]);
  assertNotLogged(gw, Object.values(content));
  const stored = JSON.stringify(gw.services.db.prepare('SELECT detail FROM job_events').all());
  for (const value of [content.task, content.title, content.project, content.constraint]) assert.equal(stored.includes(value), false, `content leaked into events: ${value}`);
});
