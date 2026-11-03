import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test, type TestContext } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { randomId } from '../src/crypto.ts';
import { openStorage } from '../src/gateway.ts';
import { ApprovalCodes, MAX_FAILURES_PER_HOUR } from '../src/oauth/approvalCodes.ts';
import { ClientStore, MAX_REGISTRATIONS_PER_HOUR } from '../src/oauth/clients.ts';
import { TokenService } from '../src/oauth/tokens.ts';
import { systemClock } from '../src/time.ts';
import { startFakeT3, type FakeT3 } from './helpers/fakeT3.ts';
import { openFrontDoor, type FrontDoor } from './helpers/frontDoor.ts';
import { agentWithToken } from './helpers/jobs.ts';
import { pkcePair } from './helpers/oauthFlow.ts';
import { tempDir } from './helpers/tmp.ts';

interface Env {
  dir: string;
  configPath: string;
  dataDir: string;
  /** The public URL's port; `serve` listens on a port of its own behind it. */
  door: FrontDoor;
}

async function environment(t: TestContext, fake?: FakeT3, extra: Record<string, unknown> = {}): Promise<Env> {
  const dir = tempDir(t);
  const door = await openFrontDoor(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      publicUrl: door.url,
      listen: { host: '127.0.0.1', port: door.port },
      hosts: [{ id: 'main', t3Url: fake?.url ?? 'http://127.0.0.1:9', mintPairingCode: fake?.mintCommand() ?? ['false'] }],
      ...extra,
    }),
  );
  return { dir, configPath, dataDir: join(dir, 'data'), door };
}

/** `waitForShutdown` may wait for output with `until` before letting `serve` stop. */
async function run(env: Env, args: string[], waitForShutdown?: (until: (pattern: RegExp) => Promise<void>) => Promise<void>,
  processEnv: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  const until = (pattern: RegExp) =>
    out.some((text) => pattern.test(text)) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ pattern, resolve }));
  const serving = waitForShutdown && {
    listenPort: 0,
    waitForShutdown: async (gateway: { port: number }) => {
      env.door.target = gateway.port;
      await waitForShutdown(until);
      env.door.target = undefined;
    },
  };
  const code = await runCli(args, {
    env: { ...process.env, ...processEnv, T3FG_CONFIG: env.configPath, T3FG_DATA_DIR: env.dataDir },
    out: (text) => {
      out.push(text);
      for (const waiter of waiters) if (waiter.pattern.test(text)) waiter.resolve();
    },
    err: (text) => err.push(text),
    ...serving,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  test('help, version and usage errors', async (t) => {
    const env = await environment(t);
    assert.equal((await run(env, ['--help'])).code, 0);
    assert.match((await run(env, ['--version'])).out, /^\d+\.\d+\.\d+$/);
    assert.equal((await run(env, [])).code, 2);
    const unknown = await run(env, ['launch']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /Unknown command: launch/);
    assert.equal((await run(env, ['--nope'])).code, 2);
    assert.equal((await run(env, ['clients', 'list', 'x', 'y'])).code, 2);
    for (const [args, message] of [
      [['clients', 'list', '--all'], /--all is only for jobs list/],
      [['jobs', 'release', 'job1', '--all'], /--all is only for jobs list/],
      [['jobs', 'list', '--title', 'x'], /--title is only for jobs adopt/],
      [['hosts', 'status', '--title', 'x'], /--title is only for jobs adopt/],
      [['jobs', 'list', '--ttl', '5m'], /--ttl is only for pair/],
    ] as const) {
      const misplaced = await run(env, [...args]);
      assert.deepEqual([misplaced.code, misplaced.out], [2, ''], args.join(' '));
      assert.match(misplaced.err, message);
    }
  });

  test('reports a missing config with a stable code', async (t) => {
    const env = await environment(t);
    const result = await run({ ...env, configPath: join(env.dir, 'missing.json') }, ['hosts', 'status']);
    assert.equal(result.code, 1);
    assert.match(result.err, /config_not_found/);
  });

  test('pair mints a one-time code; --ttl is validated', async (t) => {
    const env = await environment(t);
    const result = await run(env, ['pair', '--ttl', '30m']);
    assert.equal(result.code, 0);
    assert.match(result.out, /^Approval code: [0-9A-Z]{5}-[0-9A-Z]{5}$/m);
    assert.match(result.out, /in 29m|in 30m/);
    assert.equal((await run(env, ['pair', '--ttl', '2d'])).code, 2);
    assert.equal((await run(env, ['pair', '--ttl', 'soon'])).code, 2);
  });

  test('throttle status and reset; pair reports a lifted approval pause', async (t) => {
    const env = await environment(t);
    const fail = (count: number) => {
      const storage = openStorage(env.dataDir);
      const approvals = new ApprovalCodes(storage.db, storage.key, systemClock);
      for (let i = 0; i < count; i++) approvals.redeem('WRONG-CODE0', `request-${i % 4}`, 'client');
      storage.db.close();
    };
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20 .*\(ok\)\nregistrations: +0\/30 .*\(ok\)/);
    fail(MAX_FAILURES_PER_HOUR);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +20\/20 failed attempts in the last hour \(LIMIT REACHED\)/);
    const paired = await run(env, ['pair']);
    assert.match(paired.out, /^Approvals were paused after 20 failed attempts within an hour; minting this code lifted the pause\.$/m);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20/);
    assert.doesNotMatch((await run(env, ['pair'])).out, /paused/);

    fail(3);
    const storage = openStorage(env.dataDir);
    const store = new ClientStore(storage.db, systemClock);
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) store.register({ redirect_uris: ['https://agent.example.com/cb'] });
    storage.db.close();
    assert.match((await run(env, ['throttle', 'status'])).out, /registrations: +30\/30 counted in the last hour \(LIMIT REACHED\)/);
    const reset = await run(env, ['throttle', 'reset']);
    assert.equal(reset.code, 0);
    assert.match(reset.out, /^Cleared the failed approval attempts/);
    assert.match((await run(env, ['throttle', 'status'])).out, /approvals: +0\/20 .*\nregistrations: +0\/30/);
    assert.equal((await run(env, ['throttle'])).code, 2);
    assert.equal((await run(env, ['throttle', 'reset', 'extra'])).code, 2);
  });

  test('clients list and revoke', async (t) => {
    const env = await environment(t);
    assert.equal((await run(env, ['clients', 'list'])).out, 'No clients registered.');
    const storage = openStorage(env.dataDir);
    const client = new ClientStore(storage.db, systemClock).register({ client_name: 'Hosted agent', redirect_uris: ['https://agent.example.com/cb'] });
    storage.db.close();
    const listed = await run(env, ['clients', 'list']);
    assert.match(listed.out, new RegExp(`${client.id}\\s+Hosted agent\\s+-\\s+pending`));
    assert.match(listed.out, /https:\/\/agent\.example\.com/);
    const revoked = await run(env, ['clients', 'revoke', client.id]);
    assert.equal(revoked.code, 0, revoked.err);
    // Ids never start with '-', and `--` ends the options for one stored before that rule.
    assert.equal((await run(env, ['clients', 'revoke', '--', client.id])).code, 0);
    assert.ok(Array.from({ length: 2000 }, () => randomId()).every((id) => !id.startsWith('-')));
    assert.match((await run(env, ['clients', 'list'])).out, /revoked/);
    const unknown = await run(env, ['clients', 'revoke', 'nope']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /not_found/);
    assert.equal((await run(env, ['clients', 'revoke'])).code, 2);
  });

  test('clients diagnose reports pending auth separately from unknown reachability without contacting hosts', async (t) => {
    const env = await environment(t);
    const storage = openStorage(env.dataDir);
    const client = new ClientStore(storage.db, systemClock).register({ redirect_uris: ['https://agent.example.com/cb'] });
    storage.db.close();
    const result = await run(env, ['clients', 'diagnose', client.id]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Kind: oauth/);
    assert.match(result.out, /State: pending/);
    assert.match(result.out, /Reachability: unknown/);
    assert.match(result.out, /Last successful MCP: unknown/);
    assert.match(result.out, /Last successful refresh: unknown/);
    assert.match(result.out, /doctor/);
    assert.doesNotMatch(result.out, /token_hash|access_token|refresh_token|https:\/\/agent/);
    assert.equal((await run(env, ['clients', 'diagnose'])).code, 2);
    assert.equal((await run(env, ['clients', 'diagnose', 'missing'])).code, 1);
  });

  test('clients list distinguishes replay-revoked grants from pending approval and preserves mixed families', async (t) => {
    const env = await environment(t);
    const storage = openStorage(env.dataDir);
    t.after(() => storage.db.close());
    const clients = new ClientStore(storage.db, systemClock);
    const tokens = new TokenService(storage.db, systemClock, {
      resource: `${env.door.url}/mcp`, accessTtlSeconds: 3600, refreshIdleTtlDays: 30,
    });
    for (const replay of ['refresh_token', 'authorization_code'] as const) {
      const redirectUri = 'https://agent.example.com/cb';
      const client = clients.register({ client_name: 'Replay agent', redirect_uris: [redirectUri] });
      const grant = () => {
        const { verifier, challenge } = pkcePair();
        const code = tokens.issueAuthorizationCode({
          clientId: client.id, redirectUri, codeChallenge: challenge, scopes: ['fleet:read'],
        });
        const request = { clientId: client.id, code, redirectUri, codeVerifier: verifier, resource: tokens.resource };
        return { request, pair: tokens.exchangeAuthorizationCode(request) };
      };
      const refresh = (refreshToken: string) => tokens.refresh({
        clientId: client.id, refreshToken, scope: undefined, resource: tokens.resource,
      });
      const expectStatus = async (access: string, status: string) => {
        const listed = await run(env, ['clients', 'list']);
        assert.equal(listed.code, 0, listed.err);
        assert.match(listed.out, new RegExp(`${client.id}\\s+Replay agent\\s+${access}\\s+${status}\\s`));
        return listed.out.split('\n').find((line) => line.startsWith(client.id))!;
      };
      await expectStatus('-', 'pending');
      const { request, pair } = grant();
      await expectStatus('read \\(all hosts\\)', 'unrevoked');
      if (replay === 'refresh_token') {
        const child = refresh(pair.refresh_token);
        refresh(child.refresh_token);
        assert.throws(() => refresh(pair.refresh_token), /already used/);
      } else {
        assert.throws(() => tokens.exchangeAuthorizationCode(request), /already used/);
      }
      assert.equal(clients.get(client.id)?.revokedAt, null, 'replay revokes the family, not the client');
      const diagnostic = await run(env, ['clients', 'diagnose', client.id]);
      assert.equal(diagnostic.code, 0, diagnostic.err);
      assert.match(diagnostic.out, new RegExp(`reason ${replay}_reuse`));
      assert.match(await expectStatus('-', 'grants revoked'), /\(0 unrevoked grants; diagnose for usability\)/);
      grant();
      assert.match(await expectStatus('read \\(all hosts\\)', 'unrevoked'), /\(1 unrevoked grants; diagnose for usability\)/);
      clients.revoke(client.id);
      await expectStatus('-', 'revoked');
    }
  });

  test('clients list keeps expired bearer status and gives client revocation precedence', async (t) => {
    const env = await environment(t);
    const storage = openStorage(env.dataDir);
    t.after(() => storage.db.close());
    const tokens = new TokenService(storage.db, systemClock, {
      resource: `${env.door.url}/mcp`, accessTtlSeconds: 3600, refreshIdleTtlDays: 30,
    });
    const { clientId } = tokens.issueOperatorToken({ name: 'Expired bearer', scopes: ['fleet:read'], expiresAt: systemClock() });
    const listed = await run(env, ['clients', 'list']);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`${clientId}\\s+Expired bearer\\s+read \\(all hosts\\)\\s+expired\\s`));
    assert.equal((await run(env, ['clients', 'revoke', clientId])).code, 0);
    assert.match((await run(env, ['clients', 'list'])).out, new RegExp(`${clientId}\\s+Expired bearer\\s+-\\s+revoked\\s`));
  });

  test('clients list reports all bearer tokens revoked without revoking their client', async (t) => {
    const env = await environment(t);
    const minted = await run(env, ['clients', 'token', '--name', 'Revocation bot']);
    const clientId = /^Created client (\S+)/.exec(minted.out)![1]!;
    const inventory = JSON.parse((await run(env, ['clients', 'tokens', clientId])).out);
    const rotated = await run(env, ['clients', 'rotate', clientId, '--token-id', inventory[0].id, '--overlap', '1d']);
    assert.equal(rotated.code, 0, rotated.err);
    const tokens = JSON.parse((await run(env, ['clients', 'tokens', clientId])).out);
    assert.equal(tokens.length, 2);
    for (const token of tokens) {
      assert.equal((await run(env, ['clients', 'revoke-token', clientId, '--token-id', token.id])).code, 0);
    }
    assert.match((await run(env, ['clients', 'list'])).out, /Revocation bot\s+read \(all hosts\)\s+tokens revoked|Revocation bot\s+operate \(all hosts\)\s+tokens revoked/);
    assert.match((await run(env, ['clients', 'list'])).out, /bearer token, none unrevoked/);
  });

  test('clients projects inspects, replaces and removes a policy without changing bearer secrets', async (t) => {
    const env = await environment(t, undefined, { projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1' }] });
    const minted = await run(env, ['clients', 'token', '--name', 'Project bot']);
    const clientId = /^Created client (\S+)/.exec(minted.out)![1]!;
    assert.deepEqual(JSON.parse((await run(env, ['clients', 'projects', clientId])).out), { projects: null });
    const selected = await run(env, ['clients', 'projects', clientId, '--project', 'pilot', '--project', '@main/project-2']);
    assert.equal(selected.code, 0, selected.err);
    assert.deepEqual(JSON.parse(selected.out).projects, [{ host: 'main', alias: 'pilot', projectId: 'project-1' }, { host: 'main', projectId: 'project-2' }]);
    assert.equal((await run(env, ['clients', 'projects', clientId, '--project', 'unknown'])).code, 1);
    assert.equal((await run(env, ['clients', 'projects', clientId, '--project', 'pilot', '--all-projects'])).code, 2);
    assert.deepEqual(JSON.parse((await run(env, ['clients', 'projects', clientId, '--no-projects'])).out), { projects: [] });
    assert.deepEqual(JSON.parse((await run(env, ['clients', 'projects', clientId, '--all-projects'])).out), { projects: null });
    assert.equal(JSON.parse((await run(env, ['clients', 'tokens', clientId])).out).length, 1, 'same token remains');
  });

  test('clients token mints a bearer token that works at /mcp until it is revoked', async (t) => {
    const env = await environment(t);
    for (const [args, message] of [
      [['clients', 'token'], /clients token needs --name/],
      [['clients', 'token', '--name', '  '], /clients token needs --name/],
      [['clients', 'token', '--name', 'x', '--access', 'admin'], /--access must be operate/],
      [['clients', 'token', '--name', 'x', '--ttl', '30m'], /--ttl must be a duration from 1h to 100y/],
      [['clients', 'token', '--name', 'x', '--ttl', '999999y'], /--ttl must be a duration from 1h to 100y/],
      [['clients', 'token', '--name', 'x', '--ttl', 'soon'], /--ttl must be/],
      [['clients', 'token', 'extra', '--name', 'x'], /Unexpected arguments: extra/],
      [['clients', 'list', '--name', 'x'], /--name is only for clients token/],
      [['pair', '--access', 'read'], /--access is only for clients token/],
    ] as const) {
      const refused = await run(env, [...args]);
      assert.deepEqual([refused.code, refused.out], [2, ''], args.join(' '));
      assert.match(refused.err, message);
    }
    assert.equal((await run(env, ['clients', 'list'])).out, 'No clients registered.', 'a refused request creates nothing');
    assert.equal((await run(env, ['clients', 'token', '--name', 'Synthetic long-lived', '--ttl', '100y'])).code, 0);
    assert.match((await run(env, ['clients', 'list'])).out, /Synthetic long-lived\s+operate \(all hosts\)\s+active\s.*bearer token, expires \S+$/m);
    const minted = await run(env, ['clients', 'token', '--name', 'Synthetic notebook agent']);
    assert.equal(minted.code, 0, minted.err);
    const [, clientId = ''] = /^Created client (\S+) \("Synthetic notebook agent", operate access to all hosts, including hosts added later\)\. Its token expires \S+ \(in 365d\):$/m.exec(minted.out) ?? [];
    const token = minted.out.split('\n')[1] ?? '';
    assert.match(token, /^[\w-]{43}$/);
    const diagnostic = await run(env, ['clients', 'diagnose', clientId]);
    assert.equal(diagnostic.code, 0, diagnostic.err);
    assert.match(diagnostic.out, /Kind: bearer\nState: active/);
    assert.match(diagnostic.out, /Usable access grant: true\nUsable refresh grant: false/);
    assert.match(diagnostic.out, /refresh: none/);
    assert.ok(!diagnostic.out.includes(token));
    const reader = await run(env, ['clients', 'token', '--name', 'Synthetic reader', '--access', 'read', '--ttl', 'never']);
    assert.match(reader.out, /\("Synthetic reader", read access to all hosts, including hosts added later\)\. Its token never expires:/);
    const readToken = reader.out.split('\n')[1] ?? '';
    const listed = (await run(env, ['clients', 'list'])).out;
    assert.match(listed, new RegExp(`${clientId}\\s+Synthetic notebook agent\\s+operate \\(all hosts\\)\\s+active\\s.*bearer token, expires \\S+$`, 'm'));
    assert.match(listed, /Synthetic reader\s+read \(all hosts\)\s+active\s.*bearer token, never expires$/m);
    assert.match((await run(env, ['throttle', 'status'])).out, /registrations: +0\/30/, 'operator tokens do not count as registrations');

    const initialize = (bearer: string) =>
      fetch(`${env.door.url}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }),
      });
    const served = await run(env, ['serve'], async (until) => {
      await until(/"event":"gateway.started"/);
      const agent = await agentWithToken(t, env.door.url, clientId, token);
      assert.deepEqual(await agent.call('work_list', {}), { jobs: [] });
      const usage = JSON.parse((await run(env, ['clients', 'tokens', clientId])).out);
      assert.equal(usage[0].callsThisHour, 1);
      assert.ok(usage[0].lastUsedAt);
      const rotated = await run(env, ['clients', 'rotate', clientId, '--token-id', usage[0].id, '--overlap', '7d']);
      assert.equal(rotated.code, 0, rotated.err);
      const replacement = rotated.out.split('\n')[1]!;
      assert.equal((await initialize(token)).status, 200);
      assert.equal((await initialize(replacement)).status, 200);
      assert.equal((await run(env, ['clients', 'revoke-token', clientId, '--token-id', usage[0].id])).code, 0);
      assert.equal((await initialize(token)).status, 401);
      assert.equal((await initialize(replacement)).status, 200);
      const readOnly = await agentWithToken(t, env.door.url, '', readToken);
      assert.equal((await readOnly.callError('work_start', { project: 'x', task: 'x', requestId: 'r1' })).code, 'insufficient_scope');
      assert.equal((await run(env, ['clients', 'revoke', clientId])).code, 0);
      assert.equal((await initialize(token)).status, 401, 'revoked at once');
      assert.equal((await initialize(readToken)).status, 200);
    });
    assert.equal(served.code, 0, served.err);
    const revokedDiagnostic = await run(env, ['clients', 'diagnose', clientId]);
    assert.match(revokedDiagnostic.out, /State: revoked/);
    assert.match(revokedDiagnostic.out, /reason client_revoked/);
    assert.match(revokedDiagnostic.out, /Last successful MCP: \d{4}-/);
    assert.match(revokedDiagnostic.out, /Last successful refresh: unknown/);
    assert.equal(served.out.includes(token) || served.out.includes(readToken), false, 'tokens never reach the logs');
    assert.match((await run(env, ['clients', 'list'])).out, new RegExp(`${clientId}\\s+Synthetic notebook agent\\s+-\\s+revoked`));
  });

  test('hosts enroll and hosts status, without printing credentials', async (t) => {
    const fake = await startFakeT3({ serverVersion: '9.9.9' });
    t.after(() => fake.close());
    const env = await environment(t, fake);
    const before = await run(env, ['hosts', 'status']);
    assert.match(before.out, /credential: missing/);
    const enrolled = await run(env, ['hosts', 'enroll', 'main']);
    assert.equal(enrolled.code, 0, enrolled.err);
    assert.match(enrolled.out, /Enrolled main: T3 9\.9\.9, credential expires \S+ \(in (29|30)d\)/);
    const status = await run(env, ['hosts', 'status']);
    assert.match(status.out, /reachable:  yes, T3 9\.9\.9/);
    assert.match(status.out, /credential: active, expires/);
    for (const token of fake.issuedTokens) assert.equal(enrolled.out.includes(token) || status.out.includes(token), false);
    assert.equal((await run(env, ['hosts', 'enroll', 'other'])).code, 1);
    fake.revokeAllTokens();
    const rejected = await run(env, ['hosts', 'status']);
    assert.match(rejected.out, /reachable:  yes\n  credential: rejected by T3, expires/);
    assert.match(rejected.out, /error:      t3_unauthorized: .*hosts enroll main/);
    assert.doesNotMatch(rejected.out, /T3 null/);
  });

  test('a failing enrollment exits nonzero with the reason', async (t) => {
    const env = await environment(t);
    const result = await run(env, ['hosts', 'enroll', 'main']);
    assert.equal(result.code, 1);
    assert.match(result.err, /error \((host_unreachable|enrollment_failed)\)/);
  });

  test('doctor fails until the host is enrolled and the gateway is serving, then passes', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    const env = await environment(t, fake, {
      projects: [{ alias: 'pilot', host: 'main', t3ProjectTitle: 'Synthetic project 1', description: 'Scratch' }],
    });
    const failing = await run(env, ['doctor']);
    assert.equal(failing.code, 1);
    assert.match(failing.out, /FAIL  host main: not enrolled/);
    assert.match(failing.out, /FAIL  public URL/);
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);

    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    const serving = run(env, ['serve'], () => {
      ready();
      return stopped;
    });
    await started;
    const passing = await run(env, ['doctor']);
    stop();
    const served = await serving;
    assert.equal(passing.code, 0, passing.out);
    assert.match(passing.out, /OK    database: integrity ok/);
    assert.match(passing.out, /OK    project pilot: T3 project project-1 on main/);
    assert.match(passing.out, /OK    public URL/);
    assert.equal(served.code, 0);
    assert.match(served.out, /"event":"gateway.started"/);
    assert.match(served.out, /"event":"gateway.stopped"/);
  });

  test('doctor checks the dashboard only when it is enabled, and says when it cannot verify it', async (t) => {
    const off = await run(await environment(t), ['doctor']);
    assert.doesNotMatch(off.out, /dashboard/);
    // Port 9 (discard) has no listener here: nothing serves the dashboard, and the public URL has no gateway behind it.
    const env = await environment(t, undefined, { dashboard: { enabled: true, listen: { host: '127.0.0.1', port: 9 }, basePath: '/fleet' } });
    const result = await run(env, ['doctor']);
    assert.match(result.out, /WARN  dashboard: http:\/\/127\.0\.0\.1:9\/fleet\/ is not answering\. Is serve running\?/);
    assert.match(result.out, /WARN  dashboard exposure: Could not ask the public URL/);
  });

  test('doctor detects a missing renewal executable while the enrolled host is healthy', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    const env = await environment(t, fake);
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);
    const config = JSON.parse(readFileSync(env.configPath, 'utf8'));
    config.hosts[0].mintPairingCode = [join(env.dir, 'missing-synthetic-mint'), 'secret-argument'];
    writeFileSync(env.configPath, JSON.stringify(config));
    let stop = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let ready = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    const serving = run(env, ['serve'], () => { ready(); return stopped; });
    await started;
    try {
      const doctor = await run(env, ['doctor']);
      assert.equal(doctor.code, 1, doctor.out);
      assert.match(doctor.out, /FAIL  host main pairing command: executable_missing/);
      assert.doesNotMatch(doctor.out, /secret-argument|missing-synthetic-mint/);
      assert.equal(fake.decisions.length, 1, 'preflight never enrolls');
    } finally {
      stop();
      await serving;
    }
  });

  test('doctor and serve use their actual PATH, diagnose pinned commands and explicit probe failures without leakage', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    const env = await environment(t, fake);
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);
    const bin = join(env.dir, 'runtime', 'versions', '1.2.3');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'synthetic-t3');
    writeFileSync(command, `#!/bin/sh\necho 't3 v1.2.3'\n`, { mode: 0o700 });
    const config = JSON.parse(readFileSync(env.configPath, 'utf8'));
    config.hosts[0].mintPairingCode = ['synthetic-t3', 'secret-mint-argv'];
    config.hosts[0].mintPairingCodeProbe = ['synthetic-t3', '--version'];
    writeFileSync(env.configPath, JSON.stringify(config));
    const serviceEnv = { PATH: bin };
    const passing = await run(env, ['doctor'], undefined, serviceEnv);
    assert.match(passing.out, /OK    host main pairing command: executable_resolved/);
    assert.match(passing.out, /WARN  host main pairing command: version_pinned_path/);
    assert.match(passing.out, /WARN  host main pairing command: version_disagreement/);
    writeFileSync(command, `#!/bin/sh\necho 't3 v${fake.serverVersion}'\n`);
    const matching = await run(env, ['doctor'], undefined, serviceEnv);
    assert.match(matching.out, /OK    host main pairing command: version_matches/);
    const missing = await run(env, ['doctor'], undefined, { PATH: '' });
    assert.match(missing.out, /FAIL  host main pairing command: executable_missing/);
    assert.equal(missing.code, 1);
    writeFileSync(command, '#!/bin/sh\necho secret-probe-output\necho secret-probe-stderr >&2\nexit 9\n');
    const failed = await run(env, ['doctor'], undefined, serviceEnv);
    assert.match(failed.out, /FAIL  host main pairing command: probe_failed/);
    chmodSync(command, 0o600);
    const denied = await run(env, ['doctor'], undefined, serviceEnv);
    assert.match(denied.out, /FAIL  host main pairing command: executable_not_executable/);
    const served = await run(env, ['serve'], async (until) => { await until(/executable_not_executable/); }, serviceEnv);
    assert.match(served.out, /host.pairing_preflight/);
    assert.equal(served.code, 0, 'diagnostics do not prevent serving with an existing credential');
    assert.equal(fake.decisions.length, 1, 'doctor and startup never mint');
    const outputs = [passing, matching, missing, failed, denied, served].map((result) => result.out + result.err).join('\n');
    assert.doesNotMatch(outputs, /secret-mint-argv|secret-probe-output|secret-probe-stderr|--version/);
  });

  test("doctor fails a public URL that serves another server's metadata for the same resource", async (t) => {
    const env = await environment(t);
    // T3's own MCP server, say, behind a different proxy on the same URL.
    const other = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: `${env.door.url}/mcp`, authorization_servers: [env.door.url], resource_name: 'T3 Code' }));
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
    env.door.target = (other.address() as AddressInfo).port;
    const result = await run(env, ['doctor']);
    env.door.target = undefined;
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL  public URL: .* serves a different server's metadata \(resource_name T3 Code, expected t3-fleet-gateway\)/);
  });

  test('doctor fails a project whose launches T3 would refuse for want of a model, and serve warns about it', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    fake.projects[0]!.defaultModelSelection = null;
    const env = await environment(t, fake, {
      projects: [
        { alias: 'pilot', host: 'main', t3ProjectTitle: 'Synthetic project 1' },
        { alias: 'docs', host: 'main', t3ProjectId: 'project-2' },
      ],
    });
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);
    const doctor = await run(env, ['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /FAIL  project pilot: no model: T3 project project-1 has no default model/);
    assert.match(doctor.out, /Set projects\[\]\.modelSelection or hosts\[\]\.defaultModelSelection for host main/);
    assert.match(doctor.out, /OK    project docs: model from the default of T3 project project-2/);

    // The check runs in the background; shutdown does not wait for it.
    const served = await run(env, ['serve'], (until) => until(/"event":"project.model_missing"/));
    const warnings = served.out.split('\n').filter((line) => line.includes('"event":"project.model_missing"'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /"project":"pilot"/);
  });

  test('a host default model satisfies doctor for every project on the host', async (t) => {
    const fake = await startFakeT3();
    t.after(() => fake.close());
    fake.projects[0]!.defaultModelSelection = null;
    const env = await environment(t, fake, { projects: [{ alias: 'pilot', host: 'main', t3ProjectTitle: 'Synthetic project 1' }] });
    const config = JSON.parse(readFileSync(env.configPath, 'utf8')) as { hosts: Record<string, unknown>[] };
    config.hosts[0]!.defaultModelSelection = { instanceId: 'synthetic-provider', model: 'synthetic-model' };
    writeFileSync(env.configPath, JSON.stringify(config));
    assert.equal((await run(env, ['hosts', 'enroll', 'main'])).code, 0);
    const doctor = await run(env, ['doctor']);
    assert.match(doctor.out, /OK    project pilot: model from host main defaultModelSelection/);
    assert.doesNotMatch(doctor.out, /FAIL  project/);
  });

  test('the bin launcher runs the TypeScript entrypoint', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 't3-fleet-gateway.js'), '--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
