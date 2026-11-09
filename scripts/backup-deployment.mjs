import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = resolve(fileURLToPath(import.meta.url), '../..');

export function parseBackupArgs(args) {
  const options = { project: '', context: '', compose: resolve(root, 'compose.coolify.yaml'), envFile: '', output: '' };
  const names = { '--project': 'project', '--context': 'context', '--compose': 'compose', '--env-file': 'envFile', '--output': 'output' };
  for (let i = 0; i < args.length; i++) {
    const name = names[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('USAGE');
    options[name] = args[++i];
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project) || !options.context || !options.envFile || !options.output) {
    throw new Error('EXPLICIT_TARGET_REQUIRED');
  }
  options.compose = resolve(options.compose);
  options.envFile = resolve(options.envFile);
  options.output = resolve(options.output);
  return options;
}

export function runBackupCommand(command, args, env, destination, signal) {
  if (signal?.aborted) return Promise.reject(new Error("BACKUP_INTERRUPTED"));
  return new Promise((accept, reject) => {
    // Never echo command output: resolved Compose, logs or dumps may contain secrets.
    const child = spawn(command, args, { env, stdio: ['ignore', destination ? 'pipe' : 'ignore', 'ignore'] });
    const stream = destination
      ? pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      : Promise.resolve();
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    stream.catch(cancel);
    let childError;
    const completion = new Promise((done, fail) => {
      child.once('error', error => { childError = error; });
      child.once('close', code => {
        signal?.removeEventListener('abort', cancel);
        if (childError || code !== 0) fail(new Error('COMMAND_FAILED')); else done();
      });
    });
    Promise.allSettled([stream, completion]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) reject(failed.reason); else accept();
    });
  });
}

async function fingerprint(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: (await stat(path)).size, sha256: hash.digest('hex') };
}

/** Pauses only writers of the validated named project; always attempts to restart them. */
export async function createBackup(options, invoke = runBackupCommand) {
  const operate = (command, args, env, destination) => invoke(command, args, env, destination, options.signal);
  const env = { ...process.env, DOCKER_CONTEXT: options.context };
  const compose = ['compose', '-p', options.project, '--env-file', options.envFile, '-f', options.compose];
  await operate(process.execPath, [resolve(root, 'scripts/check-deployment.mjs'), '--env-file', options.envFile, '--compose', options.compose], env);
  await operate(process.execPath, [resolve(root, 'scripts/smoke-deployment.mjs'), '--project', options.project, '--env-file', options.envFile, '--compose', options.compose], env);
  // A new directory is mandatory: never replace an older backup.
  await mkdir(options.output, { mode: 0o700 });
  const manifestPath = resolve(options.output, 'manifest.json');
  const manifest = { project: options.project, context: options.context, startedAt: new Date().toISOString(), status: 'incomplete' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  let paused = false;
  let failure;
  try {
    // Even a partially failed stop must be followed by a restart attempt.
    paused = true;
    await operate('docker', [...compose, 'stop', 'web', 'worker'], env);
    await operate('docker', [...compose, 'exec', '-T', 'db', 'pg_dump', '-U', 'sage', '-d', 'sage', '-Fc'], env, resolve(options.output, 'database.dump'));
    await operate('docker', [...compose, 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'tar', 'worker', '-C', '/app/storage', '-cf', '-', '.'], env, resolve(options.output, 'storage.tar'));
    manifest.database = await fingerprint(resolve(options.output, 'database.dump'));
    manifest.storage = await fingerprint(resolve(options.output, 'storage.tar'));
    if (!manifest.database.bytes || !manifest.storage.bytes) throw new Error('EMPTY_BACKUP');
    manifest.status = 'copied';
  } catch (error) {
    failure = error;
  } finally {
    if (paused) {
      try {
        await invoke('docker', [...compose, 'start', '--wait', '--wait-timeout', '180', 'web', 'worker'], env);
        manifest.writersRestarted = true;
      } catch {
        manifest.writersRestarted = false;
        failure = new Error('WRITERS_RESTART_REQUIRED');
      }
    }
    manifest.finishedAt = new Date().toISOString();
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    } catch {
      failure ??= new Error('MANIFEST_WRITE_FAILED');
    }
  }
  if (failure) throw failure;
  return manifest;
}

export function installBackupInterruptHandlers() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  return { signal: controller.signal, dispose() { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const interrupts = installBackupInterruptHandlers();
  try {
    await createBackup({ ...parseBackupArgs(process.argv.slice(2)), signal: interrupts.signal });
    console.log('BACKUP_COPIED; check manifest hashes and perform an isolated restore before calling it recoverable');
  } catch (error) {
    console.error(error.message === 'WRITERS_RESTART_REQUIRED' ? 'BACKUP_FAILED WRITERS_RESTART_REQUIRED' : 'BACKUP_FAILED; retain incomplete files and inspect the target privately');
    process.exitCode = interrupts.signal.aborted ? 130 : 1;
  } finally { interrupts.dispose(); }
}
