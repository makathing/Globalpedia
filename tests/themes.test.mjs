/**
 * Runs tests/ts/themes.cases.ts, which imports src/core/themes.ts directly,
 * under Node's type stripping (Node >= 22.6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);

/** Without this the grandchild believes it is a test-runner worker and emits serialized output. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('themes.ts guards (TypeScript, via --experimental-strip-types)', { skip: major < 22 || (major === 22 && minor < 6) ? `Node ${process.version} lacks --experimental-strip-types` : false }, () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--test', '--test-reporter=spec', join(root, 'tests', 'ts', 'themes.cases.ts')],
    { cwd: root, encoding: 'utf8', env: childEnv() },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const passed = Number(/^ℹ pass (\d+)/m.exec(output)?.[1] ?? /# pass (\d+)/.exec(output)?.[1] ?? 0);
  const failed = Number(/^ℹ fail (\d+)/m.exec(output)?.[1] ?? /# fail (\d+)/.exec(output)?.[1] ?? 0);
  if (result.status !== 0 || failed > 0 || passed === 0) {
    console.error(output);
  }
  assert.equal(result.status, 0, 'child test process exited non-zero');
  assert.equal(failed, 0, `${failed} theme test(s) failed`);
  assert.ok(passed >= 8, `expected at least 8 passing theme tests, got ${passed}`);
});
