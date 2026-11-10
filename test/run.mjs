/**
 * Assertion-style runner: no framework, so `node test/run.mjs` works on the bare
 * runtime Magpie ships. Each suite exports `{name: fn}`; a test may return a
 * promise and may take a `t` with an `after` hook.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'yaml.test.mjs',
  'sync.test.mjs',
  'catalog.test.mjs',
  'supervise.test.mjs',
  'app-reader.test.mjs',
  'checkin.test.mjs',
  'login.test.mjs',
];

let passed = 0;
const failures = [];

for (const file of SUITES) {
  const module = await import(pathToFileURL(path.join(HERE, file)).href);
  const suites = Object.entries(module).filter(([name, value]) => value && typeof value === 'object');
  const tests = Object.assign({}, ...suites.map(([, value]) => value));
  for (const [name, fn] of Object.entries(tests)) {
    const cleanups = [];
    const t = { after: (cb) => cleanups.push(cb) };
    try {
      await fn(t);
      passed++;
      process.stdout.write(`  ok   ${file} › ${name}\n`);
    } catch (error) {
      failures.push({ file, name, error });
      process.stdout.write(`  FAIL ${file} › ${name}\n`);
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {}
      }
    }
  }
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
for (const failure of failures) {
  process.stdout.write(`\n${failure.file} › ${failure.name}\n${failure.error?.stack || failure.error}\n`);
}
process.exitCode = failures.length ? 1 : 0;
