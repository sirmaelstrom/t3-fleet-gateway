/**
 * Opt-in developer smoke: real serve CLI processes, public MCP calls, a trusted local-CA HTTPS receiver, and fake T3.
 * Uses only temporary data and loopback sockets; no installed configuration, real jobs, or hosted connector credentials.
 * Requires a supported Node (src/nodeVersion.ts) and openssl. Emits one sanitized JSON receipt, removes temporary keys/data, and stops every child.
 * Run: node scripts/webhooks-smoke.ts [--receipt /path/to/receipt.json]
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tcpConnect, createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeT3 } from '../test/helpers/fakeT3.ts';
import type { FakeT3 } from '../test/helpers/fakeT3.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const runFile = promisify(execFile);
const { values } = parseArgs({ options: { receipt: { type: 'string' } }, strict: true, allowPositionals: false });
const checks: string[] = [];
let stage = 'setup';
let interrupted = false;
const signal = () => { interrupted = true; };
process.once('SIGINT', signal);
process.once('SIGTERM', signal);

interface Payload {
  eventId: string;
  type: string;
  timestamp: string;
  feedSequence: number | null;
  feedCursor: string | null;
  jobId?: string;
  projectAlias?: string;
  host?: string;
  projectId?: string | null;
  title?: string;
  state?: string;
  previousState?: string | null;
  threadId?: string | null;
  link?: string | null;
  standing?: boolean;
  waitingOnDelegatedWork?: boolean;
  turnInitiator?: { kind: string; clientId: string | null };
  excerpt?: string;
  excerptTruncated?: boolean;
}
interface Delivery { path: string; body: string; payload: Payload; auth: string | undefined; at: number; action: string }
interface FeedEvent { cursor: string; jobId: string; type: string; fromState: string | null; toState: string | null }
interface Job { jobId: string; threadId: string | null; state: string; waitingOnDelegatedWork: boolean }
interface CliResult { stdout: string; stderr: string }

function check(condition: unknown, label: string): asserts condition {
  assert.ok(condition, label);
  checks.push(label);
}
async function until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (interrupted) throw new Error('smoke_interrupted');
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(`timeout_${label}`);
}
async function main() {
  const started = Date.now();
  const temp = mkdtempSync(join(tmpdir(), 't3fg-webhooks-smoke-'));
  chmodSync(temp, 0o700);
  const dataDir = join(temp, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  const configPath = join(temp, 'config.json');
  const authValue = `synthetic-sender-${randomUUID()}`;
  const authHeader = 'X-Smoke-Sender';
  const taskMarker = `synthetic-private-task-${randomUUID()}`;
  const workerMarker = `synthetic-private-reply-${randomUUID()}`;
  const questionMarker = `synthetic-private-question-${randomUUID()}`;
  const successPath = `/routine-${randomUUID()}/success`;
  const unstablePath = `/routine-${randomUUID()}/unstable`;
  const deliveries: Delivery[] = [];
  const logs: string[] = [];
  const diagnostics: string[] = [];
  const sockets = new Set<Socket>();
  const clients = new Set<Client>();
  let fake: FakeT3 | undefined;
  let receiver: ReturnType<typeof createHttpsServer> | undefined;
  let door: ReturnType<typeof createTcpServer> | undefined;
  let child: ChildProcess | undefined;
  let destination: number | undefined;
  let instabilityEvent: string | undefined;
  let instabilityAttempts = 0;
  let token = '';
  let clientId = '';
  let starts = 0;
  let crashes = 0;
  let feed: FeedEvent[] = [];
  let publicUrl = '';
  const tracked = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  const env: NodeJS.ProcessEnv = { ...process.env, T3FG_CONFIG: configPath, T3FG_DATA_DIR: dataDir, T3FG_LOG_LEVEL: 'debug',
    NODE_EXTRA_CA_CERTS: join(temp, 'ca.pem') };
  // Ignore ambient TLS bypasses: this smoke must verify the private CA and the receiver's IP SAN.
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const cli = async (args: string[]): Promise<CliResult> => {
    const result = await runFile(process.execPath, [join(root, 'bin/t3-fleet-gateway.js'), ...args],
      { env, cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const disconnect = async () => {
    for (const client of clients) await client.close().catch(() => {});
    clients.clear();
  };
  const stop = async (kill = false) => {
    await disconnect();
    destination = undefined;
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    const exited = once(current, 'exit');
    if (kill) crashes++;
    current.kill(kill ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => current.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const start = async () => {
    stage = `gateway_start_${starts + 1}`;
    let pending = '';
    let ready: number | undefined;
    const current = spawn(process.execPath, [join(root, 'scripts/lib/webhooks-smoke-child.ts')],
      { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child = current;
    starts++;
    current.stdout!.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        logs.push(line);
        try {
          const item = JSON.parse(line) as { event?: string; listen?: string };
          if (item.event === 'gateway.started' && item.listen) ready = Number(item.listen.split(':').at(-1));
        } catch { /* Non-JSON output is still retained for the privacy check. */ }
      }
    });
    current.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    await until('gateway_ready', () => {
      if (current.exitCode !== null || current.signalCode !== null) throw new Error('gateway_exited_before_ready');
      return ready;
    });
    destination = ready;
  };
  const connect = async () => {
    const client = new Client({ name: 'webhooks-smoke', version: '0' });
    clients.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`),
      { authProvider: { token: async () => token } }));
    return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await client.callTool({ name, arguments: args });
      // Never render an error result: a response may contain task text, credentials, or receiver details.
      assert.ok(!result.isError, `public_tool_${name}_failed`);
      return result.structuredContent as T;
    };
  };
  try {
    stage = 'local_test_ca';
    const openssl = async (args: string[]) => { await runFile('openssl', args, { cwd: temp, timeout: 15_000 }); };
    await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Gateway smoke CA',
      '-keyout', 'ca.key', '-out', 'ca.pem']);
    await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
      '-keyout', 'receiver.key', '-out', 'receiver.csr']);
    writeFileSync(join(temp, 'receiver.ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
    await openssl(['x509', '-req', '-in', 'receiver.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'receiver.pem', '-days', '1', '-extfile', 'receiver.ext']);
    for (const name of ['ca.key', 'receiver.key']) chmodSync(join(temp, name), 0o600);
    receiver = createHttpsServer({ key: readFileSync(join(temp, 'receiver.key')), cert: readFileSync(join(temp, 'receiver.pem')) },
      (request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; if (body.length > 32_768) request.destroy(); });
        request.on('end', () => {
          let payload: Payload;
          try { payload = JSON.parse(body) as Payload; } catch { response.writeHead(400).end(); return; }
          const path = request.url ?? '';
          const entry: Delivery = { path, body, payload, auth: request.headers[authHeader.toLowerCase()] as string | undefined,
            at: Date.now(), action: '200' };
          if (path === unstablePath && payload.type !== 'ping') {
            instabilityEvent ??= payload.eventId;
            if (payload.eventId === instabilityEvent) {
              instabilityAttempts++;
              if (instabilityAttempts === 1) entry.action = '503';
              if (instabilityAttempts === 2) entry.action = 'lost_ack';
              if (instabilityAttempts === 3) entry.action = 'hold';
            }
          }
          deliveries.push(entry);
          if (entry.auth !== authValue) { response.writeHead(401).end(); return; }
          if (entry.action === 'lost_ack') { request.socket.destroy(); return; }
          if (entry.action === 'hold') return;
          response.writeHead(entry.action === '503' ? 503 : 200, { 'content-type': 'text/plain' });
          // Response content is deliberately sensitive and must never enter safe attempt diagnostics.
          response.end(`receiver-private-${authValue}`);
        });
      });
    receiver.on('connection', tracked);
    await new Promise<void>((resolve) => receiver!.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as { port: number }).port;
    door = createTcpServer((incoming) => {
      tracked(incoming);
      // Follow AGENTS.md: no reset-on-accept (Node 26 socket initialization can otherwise race it).
      incoming.once('data', (first: Buffer) => {
        if (destination === undefined) { incoming.resetAndDestroy(); return; }
        incoming.pause();
        const upstream = tcpConnect(destination, '127.0.0.1');
        tracked(upstream);
        upstream.write(first);
        incoming.pipe(upstream).pipe(incoming);
        incoming.on('close', () => upstream.destroy());
        upstream.on('close', () => incoming.destroy());
      });
    });
    await new Promise<void>((resolve) => door!.listen(0, '127.0.0.1', resolve));
    const publicPort = (door.address() as { port: number }).port;
    publicUrl = `http://127.0.0.1:${publicPort}`;
    fake = await startFakeT3();
    writeFileSync(join(dataDir, 'sender.key'), `${authValue}\n`, { mode: 0o600 });
    const events = ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended'];
    const subscription = (id: string, path: string, excerptChars: number) => ({ id, enabled: true,
      url: `https://127.0.0.1:${receiverPort}${path}`, auth: { header: authHeader, secretFile: 'sender.key' },
      projects: ['scratch'], hosts: ['synthetic'], events, excerptChars });
    const config = {
      publicUrl, listen: { host: '127.0.0.1', port: publicPort },
      hosts: [{ id: 'synthetic', t3Url: fake.url, mintPairingCode: fake.mintCommand(), access: 'full-access', maxConcurrentJobs: 8 }],
      projects: [{ alias: 'scratch', host: 'synthetic', t3ProjectId: 'project-1', runtimeMode: 'full-access' }],
      watcher: { pollSeconds: 2 }, webhooks: { subscriptions: [subscription('steady', successPath, 64), subscription('unstable', unstablePath, 0)] },
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    stage = 'operator_setup';
    await cli(['hosts', 'enroll', 'synthetic']);
    const issued = await cli(['clients', 'token', '--name', 'Smoke client', '--access', 'operate', '--ttl', '1h']);
    token = issued.stdout.split('\n')[1]?.trim() ?? '';
    clientId = /Created client ([^ ]+)/.exec(issued.stdout)?.[1] ?? '';
    assert.ok(token.length > 20 && clientId, 'operator_token_created');
    await start();
    let call = await connect();
    const fleet = await call<{ hosts: { reachable: boolean }[] }>('fleet_status');
    check(fleet.hosts.length === 1 && fleet.hosts[0]!.reachable, 'real_cli_and_public_mcp_with_enrolled_fake_t3');
    stage = 'ping';
    let rejectedTls = false;
    try {
      await runFile(process.execPath, [join(root, 'bin/t3-fleet-gateway.js'), 'webhooks', 'ping', 'steady'],
        { env: { ...env, NODE_EXTRA_CA_CERTS: '' }, cwd: root, timeout: 15_000 });
    } catch (error) {
      const result = error as { stdout?: string };
      rejectedTls = result.stdout?.includes('tls_error') === true;
    }
    check(rejectedTls && deliveries.length === 0, 'untrusted_receiver_certificate_is_rejected_before_any_http_delivery');
    const ping = await cli(['webhooks', 'ping', 'steady']);
    diagnostics.push(ping.stdout, ping.stderr);
    const pingDelivery = await until('ping', () => deliveries.find((item) => item.payload.type === 'ping'));
    check(pingDelivery.auth === authValue && pingDelivery.payload.feedSequence === null,
      'cli_ping_uses_authenticated_verified_https_without_a_job');
    const begin = async (title: string) => (await call<{ job: Job }>('work_start', {
      project: 'scratch', title, task: taskMarker, requestId: randomUUID(),
    })).job;
    const status = async (jobId: string) => call<Job>('work_status', { jobId });
    const waitState = async (jobId: string, state: string, timeoutMs?: number) => until(state, async () => {
      const item = await status(jobId); return item.state === state ? item : undefined;
    }, timeoutMs);
    const delivery = (jobId: string, type: string, path = successPath) => until(type,
      () => deliveries.find((item) => item.path === path && item.payload.jobId === jobId && item.payload.type === type), 45_000);
    const thread = (job: Job) => fake!.threadForJob(job.jobId).threadId;

    stage = 'idle_and_pending_restart';
    const idle = await begin('Synthetic retry scenario');
    await waitState(idle.jobId, 'running');
    const firstEventAt = Date.now();
    fake.finishTurn(thread(idle), `${workerMarker} ${'bounded excerpt '.repeat(100)}`);
    const idleEvent = await delivery(idle.jobId, 'idle');
    check(idleEvent.at - firstEventAt < 10_000, 'successful_subscription_receives_a_state_change_within_ten_seconds');
    const firstFailure = await delivery(idle.jobId, 'idle', unstablePath);
    check(firstFailure.action === '503' && idleEvent.payload.eventId === firstFailure.payload.eventId,
      'one_logical_event_reaches_independent_subscriptions_despite_503');
    await until('recorded_503', async () => {
      const result = await cli(['webhooks', 'attempts', 'unstable']);
      const status = JSON.parse(result.stdout) as { attempts: { outcome: string; status_code: number | null }[] };
      return status.attempts.some((attempt) => attempt.outcome === 'http_error' && attempt.status_code === 503) ? true : undefined;
    });
    // Kill while the unsuccessful delivery is pending; the durable outbox must survive the actual process loss.
    await stop(true);
    await start();
    call = await connect();
    check((await status(idle.jobId)).state === 'idle', 'gateway_process_restart_preserves_job_state');
    const lostAck = await until('lost_ack', () => deliveries.find((item) => item.action === 'lost_ack'), 30_000);
    check(lostAck.payload.eventId === firstFailure.payload.eventId && lostAck.body === firstFailure.body,
      'pending_delivery_survives_process_crash_with_identical_id_and_bytes');

    stage = 'questions_failures_cancellation';
    const question = await begin('Synthetic question');
    const failed = await begin('Synthetic failure');
    const cancelled = await begin('Synthetic cancellation');
    const delegated = await begin('Synthetic delegation');
    for (const job of [question, failed, cancelled, delegated]) await waitState(job.jobId, 'running');
    const requestId = fake.askQuestion(thread(question), [{ id: 'choice', header: 'Synthetic', question: questionMarker,
      options: [{ label: 'Blue', description: 'Synthetic blue' }, { label: 'Green', description: 'Synthetic green' }] }]);
    fake.failRun(thread(failed));
    await call('work_cancel', { jobId: cancelled.jobId });
    const childTask = fake.delegate(thread(delegated), 'Synthetic delegated task');
    fake.finishTurn(thread(delegated), 'Synthetic parent waits for child.');
    const needed = await delivery(question.jobId, 'needs_input');
    const failure = await delivery(failed.jobId, 'failed');
    const cancellation = await delivery(cancelled.jobId, 'cancelled');
    const waiting = await waitState(delegated.jobId, 'idle');
    check(waiting.waitingOnDelegatedWork, 'public_status_exposes_delegated_work_before_completion');
    fake.settleDelegated(childTask.childThreadId, 'failed');
    // A restart forces a fresh observation of idle jobs instead of waiting for the normal idle polling interval.
    const held = await until('in_flight_delivery', () => deliveries.find((item) => item.action === 'hold'), 30_000);
    stage = 'held_response_isolation';
    const parallelStartedAt = Date.now();
    const parallel = await begin('Synthetic independent delivery');
    // Cancel through public MCP immediately: this can terminate before dispatch, so projectId/threadId may still be null.
    await call('work_cancel', { jobId: parallel.jobId });
    const parallelEvent = await delivery(parallel.jobId, 'cancelled');
    const healthySubscriptionLatencyMs = parallelEvent.at - parallelStartedAt;
    check(healthySubscriptionLatencyMs < 5000 && parallelEvent.at - held.at < 10_000,
      'healthy_subscription_delivers_within_five_seconds_while_another_response_is_still_held');
    check(needed.payload.state === 'needs_input' && failure.payload.state === 'failed' && cancellation.payload.state === 'cancelled',
      'required_action_states_deliver_while_another_subscription_is_retrying');
    await stop(true);
    await start();
    call = await connect();
    const recovered = await until('in_flight_recovery', () => deliveries.find((item) => item.path === unstablePath &&
      item.payload.eventId === held.payload.eventId && item.action === '200'), 60_000);
    check(recovered.body === firstFailure.body, 'in_flight_delivery_survives_process_crash_with_identical_id_and_bytes');
    const delegatedEvent = await delivery(delegated.jobId, 'delegated_work_ended');
    check(delegatedEvent.payload.waitingOnDelegatedWork === false, 'delegated_work_ended_delivers_after_child_finishes_without_parent_turn');
    await call('work_respond', { jobId: question.jobId, requestId, answers: { choice: 'Blue' } });
    fake.finishTurn(thread(question), 'Synthetic answer acknowledged.');
    await delivery(question.jobId, 'idle');
    check((await status(question.jobId)).state === 'idle', 'public_work_respond_resumes_question_and_delivers_finished_turn');

    stage = 'unobserved_operator_turn';
    fake.userTurn(thread(idle), 'Synthetic operator follow-up.');
    fake.finishTurn(thread(idle), 'Synthetic operator turn completed between observations.');
    const unseenTurn = await until('unobserved_turn_finished', () => deliveries.find((item) => item.path === successPath &&
      item.payload.jobId === idle.jobId && item.payload.type === 'idle' && item.payload.eventId !== idleEvent.payload.eventId), 45_000);
    check(unseenTurn.payload.previousState === 'idle' && unseenTurn.payload.state === 'idle',
      'a_whole_turn_between_observations_still_produces_a_finished_turn_event');
    check(unseenTurn.payload.turnInitiator?.kind === 'unknown' && unseenTurn.payload.turnInitiator.clientId === null,
      'unattributable_operator_turn_is_unknown_instead_of_borrowing_the_original_caller');

    stage = 'feed_payload_and_diagnostics';
    let cursor = '0';
    let pages = 0;
    do {
      const page = await call<{ events: FeedEvent[]; nextCursor: string; hasMore: boolean }>('work_feed', { cursor, limit: 5 });
      feed.push(...page.events);
      cursor = page.nextCursor;
      pages++;
      if (!page.hasMore) break;
      assert.ok(pages < 50, 'feed_paging_terminates');
    } while (true);
    const eventDeliveries = deliveries.filter((item) => item.payload.type !== 'ping');
    const expected = new Set(['idle', 'needs_input', 'failed', 'cancelled', 'delegated_work_ended']);
    for (const type of expected) assert.ok(eventDeliveries.some((item) => item.payload.type === type), 'required_event_missing');
    check(true, 'all_five_required_event_types_observed_over_real_https');
    for (const [job, type] of [[question, 'needs_input'], [failed, 'failed'], [cancelled, 'cancelled'], [delegated, 'delegated_work_ended']] as const) {
      const matching = eventDeliveries.filter((item) => item.payload.jobId === job.jobId && item.payload.type === type);
      assert.equal(new Set(matching.map((item) => item.payload.eventId)).size, 1, 'one_logical_event_for_one_observed_transition');
    }
    check(true, 'each_controlled_action_transition_has_exactly_one_logical_event');
    check(eventDeliveries.every((item) => {
      const event = feed.find((entry) => entry.cursor === item.payload.feedCursor);
      return event && event.jobId === item.payload.jobId && Number(event.cursor) === item.payload.feedSequence &&
        (item.payload.type === 'delegated_work_ended' ? event.type === 'delegated_work_ended' : event.toState === item.payload.state);
    }), 'every_webhook_sequence_and_cursor_correlates_to_public_paginated_work_feed');
    const caughtUp = await call<{ events: FeedEvent[]; nextCursor: string }>('work_feed', { cursor });
    check(caughtUp.events.length === 0 && caughtUp.nextCursor === cursor, 'saved_contiguous_feed_cursor_retains_exclusive_catch_up_behavior');
    check(eventDeliveries.every((item) => item.auth === authValue), 'arbitrary_sender_header_is_present_on_all_event_attempts');
    check(eventDeliveries.every((item) => item.payload.projectAlias === 'scratch' && item.payload.host === 'synthetic' &&
      (item.payload.projectId === 'project-1' || (item.payload.jobId === parallel.jobId && item.payload.projectId === null)) &&
      typeof item.payload.title === 'string' && typeof item.payload.standing === 'boolean' &&
      typeof item.payload.waitingOnDelegatedWork === 'boolean' && /Z$/.test(item.payload.timestamp)),
      'payload_contains_required_job_identity_states_flags_and_offset_timestamp');
    check(idleEvent.payload.previousState === 'running' && idleEvent.payload.link === `t3-thread://v1/${idleEvent.payload.threadId}` &&
      idleEvent.payload.turnInitiator?.kind === 'gateway' && idleEvent.payload.turnInitiator.clientId === clientId,
      'event_snapshot_has_previous_state_thread_link_and_authoritative_gateway_initiator');
    check(typeof idleEvent.payload.excerpt === 'string' && idleEvent.payload.excerpt.length <= 64 && idleEvent.payload.excerptTruncated === true,
      'explicit_excerpt_policy_bounds_and_marks_worker_excerpt');
    check(eventDeliveries.filter((item) => item.path === unstablePath).every((item) =>
      !Object.hasOwn(item.payload, 'excerpt') && !Object.hasOwn(item.payload, 'excerptTruncated')),
      'default_excerpt_policy_omits_worker_content');
    const idsBySequence = new Map<number, Set<string>>();
    for (const item of eventDeliveries) {
      const sequence = item.payload.feedSequence!;
      const ids = idsBySequence.get(sequence) ?? new Set<string>();
      ids.add(item.payload.eventId); idsBySequence.set(sequence, ids);
    }
    check([...idsBySequence.values()].every((ids) => ids.size === 1), 'one_stable_logical_event_id_per_feed_event_across_subscriptions_and_retries');
    const repeated = eventDeliveries.filter((item) => item.path === unstablePath && item.payload.eventId === instabilityEvent);
    check(repeated.length >= 4 && repeated.every((item) => item.body === firstFailure.body),
      '503_lost_ack_and_two_crashes_redeliver_identical_bytes_for_receiver_deduplication');
    for (const args of [['webhooks', 'list'], ['webhooks', 'attempts', 'unstable', '--limit', '20']]) {
      const result = await cli(args); diagnostics.push(result.stdout, result.stderr);
    }
    const safe = [...logs, ...diagnostics].join('\n');
    const forbidden = [authValue, token, successPath, unstablePath, taskMarker, workerMarker, questionMarker, ...fake.validTokens];
    check(forbidden.every((value) => !safe.includes(value)), 'gateway_logs_and_cli_diagnostics_exclude_secrets_sensitive_urls_and_worker_content');
    check(diagnostics.join('\n').includes('503'), 'safe_attempt_diagnostics_record_http_failure_status');
    check(eventDeliveries.every((item) => !item.body.includes(taskMarker) && !item.body.includes(questionMarker) &&
      !item.body.includes(authValue) && !item.body.includes(token)), 'payloads_exclude_task_questions_and_authentication_secrets');
    const receipt = {
      schemaVersion: 1, ok: true, checksPassed: checks.length, checks,
      elapsedMs: Date.now() - started, gatewayStarts: starts, processCrashes: crashes,
      requiredEventTypes: [...expected], logicalEvents: idsBySequence.size,
      httpsAttempts: deliveries.length, retryScenarioAttempts: repeated.length, publicFeedPages: pages, publicFeedEvents: feed.length,
      healthySubscriptionLatencyMs,
      isolation: 'Temporary gateway data, test CA, synthetic fake T3, loopback only; removed after completion.',
      unverified: ['Real T3 upstream runtime', 'Hosted Grok routine trigger and connector', 'Production deployment'],
    };
    return receipt;
  } finally {
    stage = stage === 'setup' ? 'cleanup' : stage;
    try {
      await stop();
      for (const socket of sockets) socket.destroy();
      if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()));
      if (door) await new Promise<void>((resolve) => door!.close(() => resolve()));
      await fake?.close();
    } finally {
      // Removed on every exit path; a busy file (the killed gateway's SQLite files on Windows) is retried.
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

try {
  const receipt = await main();
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (values.receipt) {
    const path = resolve(values.receipt);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output, { mode: 0o600 });
  }
  process.stdout.write(output);
} catch (error) {
  // Deliberately omit Error.message/stack: lower layers can include URLs, payloads or credential command output.
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, ok: false, stage, checksPassed: checks.length, checks,
    failure: error instanceof assert.AssertionError ? error.message : error instanceof Error && /^(timeout_|smoke_|gateway_)/.test(error.message)
      ? error.message : 'smoke_step_failed', errorType: error instanceof Error ? error.name : 'unknown' })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', signal);
  process.removeListener('SIGTERM', signal);
}
