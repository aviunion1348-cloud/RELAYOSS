#!/usr/bin/env node
/**
 * Reproduce Vercel's per-service build, one service at a time.
 *
 * Vercel builds each service in its own container: cwd = the service `root`, env
 * from the project, production `NODE_ENV`, then `installCommand` and
 * `buildCommand` from `vercel.json`. This harness does the same thing locally so a
 * failure like `vite: command not found` is reproducible without deploying.
 *
 * It runs ONE service per invocation, so a pass proves that service builds alone
 * rather than borrowing anything a sibling produced.
 *
 *   node scripts/verify-service-builds.mjs <repo-root> <service>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [rootArg, serviceArg] = process.argv.slice(2);
if (!rootArg || !serviceArg) {
  console.error('usage: verify-service-builds.mjs <repo-root> <service>');
  process.exit(2);
}
const repoRoot = path.resolve(rootArg);
const cfg = JSON.parse(readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
const service = cfg.services?.[serviceArg];
if (!service) {
  console.error(`no service "${serviceArg}" in vercel.json`);
  process.exit(2);
}

const serviceRoot = path.resolve(repoRoot, String(service.root ?? '.'));
const rel = path.relative(repoRoot, serviceRoot) || '.';

// A production Vercel build. NODE_ENV=production is what made the original failure
// subtle: npm drops devDependencies for it, and the build then cannot find its tools.
const env = {
  ...process.env,
  NODE_ENV: 'production',
  CI: '1',
  VERCEL: '1',
  VERCEL_ENV: 'production',
};

function run(label, command, args) {
  process.stdout.write(`\n[${serviceArg}] ${label}\n  ${command} ${args.join(' ')}\n`);
  const res = spawnSync(command, args, {
    cwd: serviceRoot,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const tail = out.trim().split('\n').slice(-6).join('\n');
  if (tail) process.stdout.write(tail.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
  if (res.status !== 0) {
    console.error(`\n✗ [${serviceArg}] FAILED at: ${label} (exit ${res.status})`);
    // Surface the exact class of error that broke production, so it is unmistakable.
    if (/command not found|not found/.test(out) && /\b(vite|tsc)\b/.test(out)) {
      console.error('  This is the missing-build-tool failure: the install omitted devDependencies.');
      console.error('  Check that the service installCommand carries --include=dev.');
    }
    process.exit(1);
  }
  return out;
}

/*
 * Clear stale build output, so a green build cannot be a previous build's artifact.
 *
 * node_modules is deliberately *not* removed here: `npm ci` already deletes it before
 * installing, so the install below is guaranteed clean, and a harness that wipes a
 * developer's node_modules as a side effect is one people stop running. The clean
 * install is the guarantee; the explicit rm would only add surprise.
 */
if (service.outputDirectory) {
  rmSync(path.join(serviceRoot, String(service.outputDirectory)), { recursive: true, force: true });
}

if (!service.installCommand) {
  console.error(`✗ [${serviceArg}] has no installCommand; Vercel's default omits devDependencies`);
  process.exit(1);
}
if (!service.buildCommand) {
  console.error(`✗ [${serviceArg}] has no buildCommand`);
  process.exit(1);
}

console.log(`[${serviceArg}] root=${rel}  NODE_ENV=production  (clean: no node_modules)`);

// Shell-split the commands as Vercel would: they are command lines, not argv.
const split = (line) => line.split(/\s+/).filter(Boolean);
const [ic, ...iargs] = split(service.installCommand);
run('install', ic, iargs);

// Prove the build tool exists BEFORE the build that needs it. A green build that
// happened to find a leftover binary is not evidence; a missing one must fail here.
const tool = serviceArg === 'web' ? 'vite' : 'tsc';
const toolPath = [
  path.join(serviceRoot, 'node_modules', '.bin', tool),
  path.join(repoRoot, 'node_modules', '.bin', tool),
].find((p) => existsSync(p));
if (!toolPath) {
  console.error(`\n✗ [${serviceArg}] "${tool}" is not installed after "${service.installCommand}"`);
  process.exit(1);
}
console.log(`\n[${serviceArg}] ${tool} resolved: ${path.relative(repoRoot, toolPath)}`);

const [bc, ...bargs] = split(service.buildCommand);
run('build', bc, bargs);

if (service.outputDirectory) {
  const outDir = path.join(serviceRoot, String(service.outputDirectory));
  if (!existsSync(outDir)) {
    console.error(`\n✗ [${serviceArg}] build produced no "${service.outputDirectory}" directory`);
    process.exit(1);
  }
  console.log(`\n✓ [${serviceArg}] built; output at ${path.relative(repoRoot, outDir)}`);
}

if (serviceArg === 'api') {
  const artefact = path.join(serviceRoot, 'apps', 'api', 'dist', 'entrypoints', 'vercel.js');
  if (!existsSync(artefact)) {
    console.error(`\n✗ [api] the serverless handler ${path.relative(repoRoot, artefact)} was not compiled`);
    process.exit(1);
  }
  console.log(`✓ [api] handler compiled: ${path.relative(repoRoot, artefact)}`);
}

console.log(`\n✓ [${serviceArg}] service build passed independently`);
