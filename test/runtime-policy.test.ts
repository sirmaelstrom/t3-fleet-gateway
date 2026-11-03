import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jobState, startJobHarness, type StartedJob } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

const probe = fileURLToPath(new URL('./helpers/workspaceProbe.js', import.meta.url));
const selection = { instanceId: 'synthetic-provider', model: 'synthetic-model', options: { 'synthetic-effort': 'low' } };
const discovery = { enabled: true, allowWorkStart: true, runtimeMode: 'full-access' };

// Every way a queued job can record its launch, each accepted while its policy allowed `full-access`.
const variants = [
  { name: 'an alias job with no launch spec', spec: undefined, probe: false, policy: 'alias', input: { project: 'pilot' } },
  { name: 'a version 1 alias job', spec: 1, probe: false, policy: 'alias', input: { project: 'pilot', modelSelection: selection } },
  { name: 'a version 1 discovered job', spec: 1, probe: false, policy: 'discovery', input: { target: { host: 'main', projectId: 'project-3' } } },
  { name: 'a version 3 discovered job', spec: 3, probe: true, policy: 'discovery', input: { target: { host: 'main', projectId: 'project-3' } } },
  { name: 'a version 3 alias job', spec: 3, probe: true, policy: 'alias', input: { project: 'pilot' } },
] as const;

describe('a queued job launches only with a runtime mode its current policy allows', () => {
  for (const variant of variants) {
    for (const drift of ['unchanged', 'policy', 'ceiling'] as const) {
      test(`${variant.name}, ${drift === 'unchanged' ? 'policy unchanged' : `${drift} reduced`}`, async (t) => {
        const { fake, gw, agent, tick } = await startJobHarness(t, {
          host: {
            access: 'full-access',
            discovery,
            defaultModelSelection: selection,
            ...(variant.probe ? { workspaceProbeCommand: [process.execPath, probe, tempDir(t)] } : {}),
          },
          pilot: { runtimeMode: 'full-access' },
        });
        for (const project of fake.projects) project.workspaceRoot = `/synthetic/${project.id}`;
        const { job } = await agent.call<{ job: StartedJob }>('work_start', { task: 'Synthetic task', requestId: `${variant.name.replaceAll(' ', '-')}-${drift}`, ...variant.input });
        assert.equal(gw.services.jobs.store.require(job.jobId).launchSpec?.v, variant.spec);
        assert.equal(gw.services.jobs.store.require(job.jobId).runtimeMode, 'full-access');

        // The operator narrows the policy before the job is dispatched (the engine reads the configuration it has now).
        const host = gw.services.config.hosts[0]!;
        if (drift === 'ceiling') host.access = 'auto';
        if (drift === 'policy' && variant.policy === 'alias') gw.services.config.projects[0]!.runtimeMode = 'approval-required';
        if (drift === 'policy' && variant.policy === 'discovery') host.discovery.runtimeMode = 'approval-required';
        await tick();

        if (drift === 'unchanged') {
          assert.equal(await jobState(agent, job.jobId), 'running');
          assert.deepEqual(fake.launches.map((launch) => launch.runtimeMode), ['full-access']);
        } else {
          assert.equal(await jobState(agent, job.jobId), 'failed');
          assert.equal(gw.services.jobs.store.require(job.jobId).lastErrorCode, 'launch_policy_changed');
          assert.equal(fake.launches.length, 0, 'nothing is launched, not even with another runtime mode');
        }
      });
    }
  }

  test('a job recorded under a narrower mode still launches with it after the policy widens', async (t) => {
    const { fake, gw, agent, tick } = await startJobHarness(t, { host: { access: 'full-access' }, pilot: { runtimeMode: 'auto' } });
    const { job } = await agent.call<{ job: StartedJob }>('work_start', { task: 'Synthetic task', requestId: 'widened', project: 'pilot' });
    gw.services.config.projects[0]!.runtimeMode = 'full-access';
    await tick();
    assert.equal(await jobState(agent, job.jobId), 'running');
    assert.deepEqual(fake.launches.map((launch) => launch.runtimeMode), ['auto']);
  });
});
