import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { escapeControls, table } from '../src/cli/format.ts';
import { runCli } from '../src/cli/main.ts';
import { startJobHarness, type StartedJob } from './helpers/jobs.ts';
import { tempDir } from './helpers/tmp.ts';

// Anything a terminal would act on rather than print, apart from the newlines between rows.
const TERMINAL_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const HOSTILE = '\u001b[2J\u001b[HNo open jobs.\r\u009b2K\u202eSynthetic';

describe('CLI output shows stored text, never terminal controls', () => {
  test('escapeControls makes C0, C1, DEL, line separators and bidirectional overrides visible and keeps other text', () => {
    assert.equal(escapeControls('\u001b[2J\r\n\t\u0000\u007f\u009b\u2028\u202e\u2066'), '\\x1b[2J\\x0d\\x0a\\x09\\x00\\x7f\\x9b\\u2028\\u202e\\u2066');
    assert.equal(escapeControls('C:\\path\\x1b'), 'C:\\\\path\\\\x1b', 'a literal backslash is doubled');
    assert.equal(escapeControls('Plain title: café ✓ 日本'), 'Plain title: café ✓ 日本');
  });

  test('a literal backslash sequence reads differently from an escaped control character', () => {
    const literal = escapeControls('\\x1b[2J');
    const control = escapeControls('\u001b[2J');
    assert.notEqual(literal, control);
    assert.equal(literal, '\\\\x1b[2J');
    assert.equal(control, '\\x1b[2J');
    const rendered = table(['TITLE'], [['\\x1b[2J'], ['\u001b[2J']]).split('\n');
    assert.deepEqual(rendered.slice(1), ['\\\\x1b[2J', '\\x1b[2J']);
  });

  test('table measures escaped cells, so every row stays aligned and on its own line', () => {
    const rendered = table(['ID', 'TITLE', 'STATE'], [['a', `x${HOSTILE}`, 'queued'], ['b', 'short', 'running']]);
    assert.doesNotMatch(rendered, TERMINAL_CONTROLS);
    const lines = rendered.split('\n');
    assert.equal(lines.length, 3);
    const stateColumn = lines[0]!.indexOf('STATE');
    assert.equal(lines[1]!.indexOf('queued'), stateColumn);
    assert.equal(lines[2]!.indexOf('running'), stateColumn);
  });

  test('jobs list escapes a title stored through work_start and keeps the other jobs visible', async (t) => {
    const { fake, gw, agent } = await startJobHarness(t);
    const benign = (await agent.call<{ job: StartedJob }>('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'benign', title: 'Synthetic benign job' })).job;
    const hostile = (await agent.call<{ job: StartedJob }>('work_start', { project: 'pilot', task: 'Synthetic task', requestId: 'hostile', title: HOSTILE })).job;
    assert.match(gw.services.jobs.store.require(hostile.jobId).title, /\u001b\[2J/, 'the title is stored as given; only output escapes it');

    const dir = tempDir(t);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      publicUrl: gw.baseUrl,
      hosts: [{ id: 'main', t3Url: fake.url, mintPairingCode: fake.mintCommand() }],
      projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1', runtimeMode: 'auto' }],
    }));
    const out: string[] = [];
    const code = await runCli(['jobs', 'list'], { env: { T3FG_CONFIG: configPath, T3FG_DATA_DIR: gw.dataDir }, out: (text) => out.push(text), err: () => {} });
    assert.equal(code, 0);
    const listed = out.join('\n');
    assert.doesNotMatch(listed, TERMINAL_CONTROLS);
    const lines = listed.split('\n');
    assert.equal(lines.length, 3, 'a header and one line per job');
    assert.match(lines[0]!, /^ID +PROJECT +STATE +STANDING +TITLE +LINK$/);
    assert.ok(lines.some((line) => line.startsWith(`${benign.jobId}  `) && line.includes('Synthetic benign job')));
    const hostileLine = lines.find((line) => line.startsWith(`${hostile.jobId}  `));
    assert.ok(hostileLine?.includes('\\x1b[2J\\x1b[HNo open jobs. \\x9b2K\\u202eSynthetic'), 'the title is shown with its controls escaped (work_start already turned the carriage return into a space)');
    const linkColumn = lines[0]!.indexOf('LINK');
    for (const line of lines.slice(1)) assert.equal(line.lastIndexOf('  ', linkColumn - 1), linkColumn - 2, 'columns stay aligned');
  });
});
