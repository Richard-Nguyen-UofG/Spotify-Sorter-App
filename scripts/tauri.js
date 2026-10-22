import os from 'node:os';
import { spawnSync } from 'node:child_process';

const totalCpus = os.cpus().length;
const halfCpus = Math.max(1, Math.floor(totalCpus / 2));

console.log(`[tauri] Limiting Cargo build to ${halfCpus} threads (half of ${totalCpus} logical cores)`);

const env = { ...process.env, CARGO_BUILD_JOBS: String(halfCpus) };
const result = spawnSync('npx', ['tauri', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env,
});

process.exit(result.status ?? 0);
