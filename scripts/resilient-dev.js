/**
 * Resilient dev runner — replaces nodemon + ts-node-dev.
 * Watches src/ for changes AND restarts on crashes.
 * Usage: npm run dev:resilient
 */
const { spawn } = require('child_process');
const { watch } = require('fs');
const path = require('path');

const RESTART_DELAY_MS = 3000;
const FILE_DEBOUNCE_MS = 1000;
let restartCount = 0;
let child = null;
let fileChangeTimer = null;
let stopping = false;

function start() {
  if (stopping) return;

  const ts = new Date().toISOString().substring(11, 19);
  console.log(`\n[resilient] ${ts} Starting server${restartCount > 0 ? ` (restart #${restartCount})` : ''}...\n`);

  child = spawn('npx', ['ts-node-dev', '--respawn', '--transpile-only', 'src/server.ts'], {
    stdio: 'inherit',
    shell: true,
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '1' },
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    const ts = new Date().toISOString().substring(11, 19);
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      // Intentional kill (file change restart) — restart immediately
      console.log(`\n[resilient] ${ts} Restarting (file change)...\n`);
      restartCount++;
      start();
    } else {
      // Crash — wait then restart
      console.log(`\n[resilient] ${ts} Process crashed (code=${code}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
      restartCount++;
      setTimeout(start, RESTART_DELAY_MS);
    }
  });

  child.on('error', (err) => {
    child = null;
    if (stopping) return;
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`\n[resilient] ${ts} Spawn error: ${err.message}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    restartCount++;
    setTimeout(start, RESTART_DELAY_MS);
  });
}

function gracefulShutdown() {
  stopping = true;
  console.log('\n[resilient] Shutting down...');
  if (child) {
    child.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

start();
