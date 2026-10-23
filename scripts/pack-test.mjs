import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'decision-router-pack-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))[0];
  const archive = path.join(tmp, packed.filename);
  const pkg = path.join(tmp, 'node_modules', '@rvboris', 'opencode-decision-router');
  await mkdir(pkg, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', pkg]);

  const files = packed.files.map(({ path: name }) => name).sort();
  const required = [
    'LICENSE', 'README.md', 'README.ru.md', 'VALIDATION.md', 'index.js', 'package.json',
    'src/client.js', 'src/config.js', 'src/index.js', 'src/policy.js',
    'tui/dist/index.js', 'tui/dist/format.js',
    'examples/config.json', 'examples/profiles.json',
  ];
  for (const name of required) assert.ok(files.includes(name), `npm archive missing ${name}`);
  for (const name of files) {
    assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|state|artifacts|node_modules|logs?)(?:\/|$)/i.test(name), `unexpected private path in archive: ${name}`);
    assert.ok(!/\.(?:log|jsonl|pem|key|secret)$/i.test(name), `unexpected sensitive file in archive: ${name}`);
  }

  const manifest = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'));
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@rvboris/opencode-decision-router');
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.exports['./tui'], './tui/dist/index.js');
  for (const peer of ['@opencode/plugin', '@opentui/core', '@opentui/solid', 'solid-js']) {
    assert.ok(manifest.peerDependencies[peer], `missing host peer dependency: ${peer}`);
    assert.equal(manifest.peerDependenciesMeta[peer]?.optional, true, `host peer must remain optional: ${peer}`);
  }
  const tui = await readFile(path.join(pkg, 'tui/dist/index.js'), 'utf8');
  for (const external of ['@opencode/plugin/tui', '@opentui/solid', 'solid-js']) {
    assert.ok(tui.includes(`from "${external}"`) || tui.includes(`from '${external}'`), `host runtime import missing: ${external}`);
  }

  const importCheck = `const pkg = await import('@rvboris/opencode-decision-router');
const server = await import('@rvboris/opencode-decision-router/server');
if (typeof pkg.default?.setup !== 'function' || typeof server.createRouter !== 'function') process.exit(1);
const directoryEntry = await import(${JSON.stringify(pathToFileURL(path.join(pkg, 'index.js')).href)});
if (typeof directoryEntry.default?.setup !== 'function') process.exit(2);
`;
  execFileSync(process.execPath, ['--input-type=module', '-e', importCheck], {
    cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  await import(pathToFileURL(path.join(pkg, 'tui/dist/format.js')));
  console.log(`npm archive verified: ${packed.filename} (${files.length} files, ${packed.size} bytes)`);
  console.log('unpacked package imports passed: root, ./server and direct directory index.js; ./tui verified structurally (host peer imports stay external, no host singleton bundled)');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
