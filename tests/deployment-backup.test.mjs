import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, parseBackupArgs } from '../scripts/backup-deployment.mjs';

test('requires an explicit remote context and target without overwriting prior backups', () => {
  assert.throws(() => parseBackupArgs([]), /EXPLICIT_TARGET_REQUIRED/);
  assert.throws(() => parseBackupArgs(['--project', 'sage', '--context', 'remote']), /EXPLICIT_TARGET_REQUIRED/);
});

for (const failingStage of [null, 'stop', 'pg_dump', 'tar']) {
  test(`backup restarts writers and preserves evidence after ${failingStage ?? 'successful copy'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sage-backup-test-'));
    const output = join(dir, 'new-backup');
    const calls = [];
    const invoke = async (command, args, env, destination) => {
      calls.push({ command, args, context: env.DOCKER_CONTEXT });
      if (failingStage && args.includes(failingStage)) throw new Error('CONTROLLED_FAILURE');
      if (destination) await writeFile(destination, `synthetic ${args.includes('pg_dump') ? 'database' : 'storage'}`);
    };
    try {
      const promise = createBackup({ project: 'sage-test', context: 'explicit-remote', compose: '/operator/compose.yaml', envFile: '/operator/private.env', output }, invoke);
      if (failingStage) await assert.rejects(promise, /CONTROLLED_FAILURE/);
      else {
        const result = await promise;
        assert.equal(result.status, 'copied');
        assert.match(result.database.sha256, /^[a-f0-9]{64}$/);
      }
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
      assert.equal(manifest.writersRestarted, true);
      assert.equal(manifest.status, failingStage ? 'incomplete' : 'copied');
      assert.ok(calls.at(-1).args.includes('start'));
      assert.ok(calls.every(call => call.context === 'explicit-remote'));
      await assert.rejects(createBackup({ project: 'sage-test', context: 'explicit-remote', compose: '/operator/compose.yaml', envFile: '/operator/private.env', output }, invoke), /EEXIST/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('never stops writers when target preflight fails', async () => {
  const calls = [];
  await assert.rejects(createBackup({ context: 'explicit-remote', compose: '/bad/compose', envFile: '/bad/env', project: 'sage', output: '/unused' }, async (...args) => { calls.push(args); throw new Error('PREFLIGHT'); }), /PREFLIGHT/);
  assert.equal(calls.length, 1);
});

test('rejects stale Compose volume mapping even within the same project', async () => {
  const { runtimeVolumeMatches } = await import('../scripts/smoke-deployment.mjs');
  const mount = [{ Type: 'volume', Name: 'sage_storage', Destination: '/app/storage', RW: true }];
  const inspect = () => JSON.stringify({ Driver: 'local', Options: null });
  assert.equal(runtimeVolumeMatches(mount, '/app/storage', true, 'sage', 'sage_storage', inspect), true);
  assert.equal(runtimeVolumeMatches(mount, '/app/storage', true, 'sage', 'sage_storage_v2', inspect), false);
});

test('restart failure remains actionable when final manifest cannot be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sage-backup-failure-'));
  const output = join(dir, 'backup');
  try {
    await assert.rejects(createBackup({ project: 'sage', context: 'remote', compose: '/compose', envFile: '/env', output }, async (command, args) => {
      if (args.includes('pg_dump')) throw new Error('DUMP_FAILED');
      if (args.includes('start')) {
        await rm(join(output, 'manifest.json'));
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(output, 'manifest.json'));
        throw new Error('RESTART_FAILED');
      }
    }), /WRITERS_RESTART_REQUIRED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const signalName of ['SIGINT', 'SIGTERM']) {
  test(`subprocess ${signalName} during copy awaits cancellation and restarts writers`, async () => {
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'sage-backup-signal-'));
    const moduleUrl = new URL('../scripts/backup-deployment.mjs', import.meta.url).href;
    const script = `
      import {createBackup,installBackupInterruptHandlers,runBackupCommand} from ${JSON.stringify(moduleUrl)};
      import {writeFile} from 'node:fs/promises';
      const control=installBackupInterruptHandlers();
      const invoke=async(command,args,env,destination,signal)=>{
        if(args.includes('pg_dump')) {
          process.stdout.write('COPY_STARTED\\n');
          await runBackupCommand(process.execPath,['-e','setInterval(()=>{},1000)'],env,destination,signal);
        }
        if(args.includes('start')) await writeFile(${JSON.stringify(join(dir, 'restarted'))},'yes');
      };
      try {await createBackup({project:'sage',context:'remote',compose:'/compose',envFile:'/env',output:${JSON.stringify(join(dir, 'backup'))},signal:control.signal},invoke);}
      catch {process.exitCode=130;} finally {control.dispose();}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const completed = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    try {
      await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error('START_TIMEOUT')), 5000);
        child.stdout.on('data', chunk => { if (chunk.toString().includes('COPY_STARTED')) { clearTimeout(timeout); accept(); } });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('EARLY_EXIT')); });
      });
      child.kill(signalName);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      const result = await completed;
      clearTimeout(timeout);
      assert.equal(result.signal, null);
      assert.equal(result.code, 130);
      assert.equal(await readFile(join(dir, 'restarted'), 'utf8'), 'yes');
      const manifest = JSON.parse(await readFile(join(dir, 'backup', 'manifest.json'), 'utf8'));
      assert.equal(manifest.writersRestarted, true);
      assert.equal(manifest.status, 'incomplete');
    } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
  });
}
