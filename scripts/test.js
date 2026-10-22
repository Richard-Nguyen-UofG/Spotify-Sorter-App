import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcTauriDir = path.resolve(__dirname, '..', 'src-tauri');

const totalCpus = os.cpus().length;
const halfCpus = Math.max(1, Math.floor(totalCpus / 2));

console.log(`[test] Limiting Cargo test to ${halfCpus} threads (half of ${totalCpus} logical cores)`);

const env = {
  ...process.env,
  CARGO_BUILD_JOBS: String(halfCpus),
  RUST_TEST_THREADS: String(halfCpus),
};

const result = spawnSync('cargo', ['test', ...process.argv.slice(2)], {
  cwd: srcTauriDir,
  stdio: 'inherit',
  shell: true,
  env,
});

process.exit(result.status ?? 0);
