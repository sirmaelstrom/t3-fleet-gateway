import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { scopesOnHosts, type Scope } from '../src/oauth/scopes.ts';
import { changeThreadScopes } from '../src/oauth/threadScopes.ts';
import { HOUR } from '../src/time.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';
import { agentWithToken, type Agent } from './helpers/jobs.ts';
import { signIn } from './helpers/oauthFlow.ts';

// `hosts[].fleetScopes: false` takes a host out of the fleet scopes: fleet:read and fleet:operate reach every other
// host as before, and only a grant that names the host (host:<id>:read|operate) reaches it.

const FLEET: Scope[] = ['fleet:read', 'fleet:operate'];

describe('scopesOnHosts', () => {
  test('returns the scopes unchanged while every host accepts fleet scopes', () => {
    const hosts = [{ id: 'main', fleetScopes: true }, { id: 'studio', fleetScopes: true }];
    assert.deepEqual(scopesOnHosts(FLEET, hosts), FLEET);
    assert.deepEqual(scopesOnHosts(['fleet:read', 'threads:read'], hosts), ['fleet:read', 'threads:read']);
    assert.deepEqual(scopesOnHosts(['host:main:read'], hosts), ['host:main:read']);
  });

  test('a fleet scope stands for the other hosts\' host scopes once one host opts out; explicit host scopes stay', () => {
    const hosts = [{ id: 'main', fleetScopes: true }, { id: 'studio', fleetScopes: false }, { id: 'host-a', fleetScopes: true }];
    assert.deepEqual(scopesOnHosts(FLEET, hosts), ['host:host-a:read', 'host:host-a:operate', 'host:main:read', 'host:main:operate']);
    assert.deepEqual(scopesOnHosts(['fleet:read', 'threads:read'], hosts), ['host:host-a:read', 'host:main:read', 'threads:read']);
    assert.deepEqual(scopesOnHosts(['host:studio:read'], hosts), ['host:studio:read']);
    assert.deepEqual(scopesOnHosts(['fleet:operate', 'host:studio:read'], hosts), ['host:host-a:operate', 'host:main:operate', 'host:studio:read']);
    assert.deepEqual(scopesOnHosts(FLEET, [{ id: 'studio', fleetScopes: false }]), []);
  });

  test('the config defaults fleetScopes to true and accepts false', () => {
    const config = parseConfig({
      publicUrl: 'https://gateway.example.ts.net',
      hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:9' }, { id: 'studio', t3Url: 'http://127.0.0.1:9', fleetScopes: false }],
    });
    assert.deepEqual(config.hosts.map((host) => host.fleetScopes), [true, false]);
  });
});

interface Fleet {
  mini: FakeT3;
  studio: FakeT3;
  gw: TestGateway;
  /** Signed in with All machines: fleet:read fleet:operate, as a fleet-wide bot holds. */
  fleetAgent: Agent;
  tick(): Promise<void>;
}

async function startFleet(t: TestContext): Promise<Fleet> {
  const mini = await startFakeT3();
  const studio = await startFakeT3();
  t.after(() => mini.close());
  t.after(() => studio.close());
  const gw = await startTestGateway(t, {
    config: {
      hosts: [
        { id: 'mini', t3Url: mini.url, mintPairingCode: mini.mintCommand() },
        // Browse-only and outside the fleet scopes, as a machine joining read-only would be.
        { id: 'studio', t3Url: studio.url, mintPairingCode: studio.mintCommand(), fleetScopes: false, discovery: { enabled: true, allowWorkStart: false } },
      ],
      projects: [
        { alias: 'alpha', description: 'Synthetic alpha', host: 'mini', t3ProjectId: 'project-1', runtimeMode: 'auto' },
        { alias: 'beta', description: 'Synthetic beta', host: 'studio', t3ProjectId: 'project-1', runtimeMode: 'auto' },
      ],
    },
    jobEngine: { autoStart: false },
  });
  await gw.services.registry.enroll('mini');
  await gw.services.registry.enroll('studio');
  const fleetAgent = await connect(t, gw, 'operate', 'all');
  return { mini, studio, gw, fleetAgent, tick: () => gw.gateway.engine.tick() };
}

async function connect(t: TestContext, gw: TestGateway, access: 'read' | 'operate', hosts: 'all' | string[]): Promise<Agent> {
  const signedIn = await signIn(gw.baseUrl, gw.mintApprovalCode, { access, hosts });
  return agentWithToken(t, gw.baseUrl, signedIn.clientId, signedIn.tokens.access_token);
}

const grantThreadRead = (gw: TestGateway, clientId: string) => changeThreadScopes(gw.services.db, gw.clock, clientId, 'grant', ['threads:read']);
const unknownJob = (jobId: string) => `not_found: No job ${jobId}. Use work_list to see jobs.`;
const hostIds = async (agent: Agent) => (await agent.call<{ hosts: { id: string }[] }>('fleet_status')).hosts.map((host) => host.id);

describe('hosts[].fleetScopes: false', () => {
  test('fleet:read fleet:operate grants, OAuth and bearer, see and operate nothing on the opted-out host', async (t) => {
    const { mini, studio, gw, fleetAgent, tick } = await startFleet(t);
    // Studio work exists, started by an agent granted studio by name.
    const studioOperator = await connect(t, gw, 'operate', ['studio']);
    const beta = (await studioOperator.call<{ job: { jobId: string } }>('work_start', { project: 'beta', task: 'Synthetic studio task', requestId: 'beta-1' })).job;
    await tick();
    const betaThread = studio.threadForJob(beta.jobId).threadId;
    studio.finishTurn(betaThread, 'Synthetic studio reply');
    const question = studio.askQuestion(betaThread, [{ id: 'q', header: 'Synthetic', question: 'Synthetic studio question?', options: [] }]);
    const external = studio.launchDirect({ projectId: 'project-1', title: 'Synthetic studio thread', runtimeMode: 'auto', message: 'Synthetic' }).threadId;
    await tick();

    const bearer = gw.services.tokens.issueOperatorToken({ name: 'Synthetic fleet bearer', scopes: FLEET, expiresAt: gw.clock() + HOUR });
    const bearerAgent = await agentWithToken(t, gw.baseUrl, bearer.clientId, bearer.token);
    for (const agent of [fleetAgent, bearerAgent]) grantThreadRead(gw, agent.clientId);

    const studioCalls = studio.calls.length;
    for (const agent of [fleetAgent, bearerAgent]) {
      const status = await agent.call<{ hosts: { id: string }[]; projects: { alias: string }[] }>('fleet_status');
      assert.deepEqual(status.hosts.map((host) => host.id), ['mini']);
      assert.deepEqual(status.projects.map((project) => project.alias), ['alpha']);
      assert.equal(JSON.stringify(status).includes('studio'), false);
      assert.deepEqual((await agent.call<{ jobs: unknown[] }>('work_list')).jobs, []);
      const feed = await agent.call<{ events: { jobId: string }[]; attention: { jobId: string }[] }>('work_feed', { limit: 200 });
      assert.ok(feed.events.every((event) => event.jobId !== beta.jobId), 'no studio events');
      assert.ok(feed.attention.every((job) => job.jobId !== beta.jobId), 'no studio attention');

      const denied: [string, Record<string, unknown>][] = [
        ['work_status', { jobId: beta.jobId }],
        ['work_messages', { jobId: beta.jobId }],
        ['work_continue', { jobId: beta.jobId, message: 'Synthetic steer', requestId: `steer-${agent.clientId}` }],
        ['work_respond', { jobId: beta.jobId, requestId: question, answers: { q: 'Synthetic' } }],
        ['work_cancel', { jobId: beta.jobId }],
      ];
      for (const [tool, args] of denied) assert.equal((await agent.callError(tool, args)).text, unknownJob(beta.jobId), tool);
      assert.equal((await agent.callError('work_start', { project: 'beta', task: 'Synthetic', requestId: `start-${agent.clientId}` })).text,
        'not_found: No project "beta". Known projects: alpha. fleet_status lists them.');
      assert.equal((await agent.callError('work_start', { target: { host: 'studio', projectId: 'project-1' }, task: 'Synthetic', requestId: `target-${agent.clientId}` })).code, 'not_found');
      for (const tool of ['fleet_projects', 'fleet_models']) assert.equal((await agent.callError(tool, { host: 'studio' })).code, 'not_found', tool);
      for (const tool of ['fleet_threads', 'fleet_thread_liveness']) {
        assert.equal((await agent.callError(tool, { host: 'studio', projectId: 'project-1' })).code, 'not_found', tool);
      }
    }
    assert.equal(studio.calls.length, studioCalls, 'no call reached the opted-out host');
    assert.equal(studio.sends.some((send) => send.message === 'Synthetic steer'), false);
    assert.equal(gw.services.jobs.store.list({ limit: 100 }).length, 1, 'no job was created');

    // The rest of the fleet behaves as before for the same grants.
    const alpha = (await fleetAgent.call<{ job: { jobId: string } }>('work_start', { project: 'alpha', task: 'Synthetic mini task', requestId: 'alpha-1' })).job;
    await tick();
    assert.equal((await fleetAgent.call<{ delivery: string }>('work_continue', { jobId: alpha.jobId, message: 'Synthetic follow-up', requestId: 'alpha-steer' })).delivery, 'steered');
    assert.equal(mini.sends.at(-1)?.message, 'Synthetic follow-up');
    assert.equal((await bearerAgent.call<{ jobId: string }>('work_status', { jobId: alpha.jobId })).jobId, alpha.jobId);
  });

  test('a host:<id>:read grant reaches the opted-out host: status, jobs, catalogs and live threads, read only', async (t) => {
    const { studio, gw, fleetAgent, tick } = await startFleet(t);
    const studioOperator = await connect(t, gw, 'operate', ['studio']);
    const beta = (await studioOperator.call<{ job: { jobId: string } }>('work_start', { project: 'beta', task: 'Synthetic studio task', requestId: 'beta-1' })).job;
    await tick();
    studio.finishTurn(studio.threadForJob(beta.jobId).threadId, 'Synthetic studio reply');
    const external = studio.launchDirect({ projectId: 'project-1', title: 'Synthetic studio thread', runtimeMode: 'auto', message: 'Synthetic' }).threadId;
    await tick();

    const reader = await connect(t, gw, 'read', ['studio']);
    grantThreadRead(gw, reader.clientId);
    assert.deepEqual(await hostIds(reader), ['studio']);
    assert.deepEqual((await reader.call<{ jobs: { jobId: string }[] }>('work_list')).jobs.map((job) => job.jobId), [beta.jobId]);
    assert.equal((await reader.call<{ jobId: string }>('work_status', { jobId: beta.jobId })).jobId, beta.jobId);
    assert.ok((await reader.call<{ messages: unknown[] }>('work_messages', { jobId: beta.jobId })).messages.length > 0);
    assert.ok((await reader.call<{ hosts: unknown[] }>('fleet_projects', { host: 'studio' })).hosts.length > 0);
    const threads = await reader.call<{ threads: { threadId: string }[] }>('fleet_threads', { host: 'studio', projectId: 'project-1' });
    assert.ok(threads.threads.some((thread) => thread.threadId === external), 'a thread opened in T3 is listed');
    gw.clock.advance(30_001);
    const liveness = await reader.call<{ threads: { threadId: string }[] }>('fleet_thread_liveness', { host: 'studio', projectId: 'project-1' });
    assert.ok(liveness.threads.some((thread) => thread.threadId === external));

    assert.equal((await reader.callError('work_continue', { jobId: beta.jobId, message: 'Synthetic', requestId: 'r' })).code, 'insufficient_scope');
    assert.equal((await reader.callError('work_cancel', { jobId: beta.jobId })).code, 'insufficient_scope');

    // A grant naming both kinds of host reaches both; the fleet grant still reaches only the other.
    const both = await connect(t, gw, 'read', ['mini', 'studio']);
    assert.deepEqual(await hostIds(both), ['mini', 'studio']);
    assert.deepEqual(await hostIds(fleetAgent), ['mini']);
  });
});
