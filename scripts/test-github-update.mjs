import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';

const projectRoot = path.resolve(import.meta.dirname, '..');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createReleaseArchive() {
  const files = new Map([
    ['.gitignore', Buffer.from('updated public ignore rules\n', 'utf8')],
    ['VERSION', Buffer.from('1.0.1\n', 'utf8')],
    ['README.md', Buffer.from('# updated public readme\n', 'utf8')],
    ['LICENSE.md', Buffer.from('updated license\n', 'utf8')],
    ['assets/example.txt', Buffer.from('updated asset\n', 'utf8')],
    ['bin/create-chwi-ppo.mjs', Buffer.from('// retained compatibility installer\n', 'utf8')],
    ['package-lock.json', Buffer.from('{"lockfileVersion":3}\n', 'utf8')],
  ]);
  const manifest = {
    schemaVersion: 1,
    version: '1.0.1',
    files: [...files].map(([filePath, content]) => ({ path: filePath, sha256: sha256(content) })),
  };
  const zip = new AdmZip();
  for (const [filePath, content] of files) zip.addFile(`chwi-ppo/${filePath}`, content);
  zip.addFile('chwi-ppo/release-manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
  return zip.toBuffer();
}

function runUpdater(scriptPath, releaseApi) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Force', '-ReleaseApi', releaseApi],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chwi-ppo-github-update-test-'));
const installRoot = path.join(tempRoot, 'chwi-ppo-main');
const releaseArchive = createReleaseArchive();
let server;

try {
  await fs.mkdir(path.join(installRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(installRoot, 'profile', 'experiences'), { recursive: true });
  await fs.mkdir(path.join(installRoot, 'companies', 'RealCo'), { recursive: true });
  await fs.mkdir(path.join(installRoot, 'data'), { recursive: true });
  await fs.copyFile(path.join(projectRoot, 'scripts', 'update-chwi-ppo.ps1'), path.join(installRoot, 'scripts', 'update-chwi-ppo.ps1'));
  await fs.writeFile(path.join(installRoot, 'VERSION'), '1.0.0\n');
  await fs.writeFile(path.join(installRoot, 'README.md'), '# source ZIP readme\n');
  await fs.writeFile(path.join(installRoot, '.gitignore'), 'local ignore rules\n');
  await fs.writeFile(path.join(installRoot, 'profile', 'PROFILE.md'), '# private profile\n');
  await fs.writeFile(path.join(installRoot, 'profile', 'experiences', 'private.md'), '# private experience\n');
  await fs.writeFile(path.join(installRoot, 'companies', 'RealCo', 'application.md'), '# private application\n');
  await fs.writeFile(path.join(installRoot, 'data', 'opportunities.json'), '{"private":true}\n');

  assert.equal(await fs.stat(path.join(installRoot, 'release-manifest.json')).catch(() => null), null);

  server = http.createServer((request, response) => {
    if (request.url === '/release.zip') {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': releaseArchive.length });
      response.end(releaseArchive);
      return;
    }
    if (request.url === '/latest') {
      const address = server.address();
      const body = Buffer.from(JSON.stringify({
        tag_name: 'v1.0.1',
        assets: [{
          name: 'chwi-ppo-v1.0.1-release.zip',
          digest: `sha256:${sha256(releaseArchive)}`,
          browser_download_url: `http://127.0.0.1:${address.port}/release.zip`,
        }],
      }));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const result = await runUpdater(
    path.join(installRoot, 'scripts', 'update-chwi-ppo.ps1'),
    `http://127.0.0.1:${port}/latest`,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Updated to v1\.0\.1 using verified release ZIP/);
  assert.equal(await fs.readFile(path.join(installRoot, 'VERSION'), 'utf8'), '1.0.1\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'README.md'), 'utf8'), '# updated public readme\n');
  assert.equal(await fs.readFile(path.join(installRoot, '.gitignore'), 'utf8'), 'local ignore rules\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'assets', 'example.txt'), 'utf8'), 'updated asset\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'bin', 'create-chwi-ppo.mjs'), 'utf8'), '// retained compatibility installer\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'profile', 'PROFILE.md'), 'utf8'), '# private profile\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'profile', 'experiences', 'private.md'), 'utf8'), '# private experience\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'companies', 'RealCo', 'application.md'), 'utf8'), '# private application\n');
  assert.equal(await fs.readFile(path.join(installRoot, 'data', 'opportunities.json'), 'utf8'), '{"private":true}\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(installRoot, 'release-manifest.json'), 'utf8')).version, '1.0.1');
  assert.equal(JSON.parse(await fs.readFile(path.join(installRoot, '.updates', 'installed-manifest.json'), 'utf8')).version, '1.0.1');
  const backupNames = await fs.readdir(path.join(installRoot, '.updates', 'backups'));
  assert.equal(backupNames.length, 1);
  assert.equal(
    await fs.readFile(path.join(installRoot, '.updates', 'backups', backupNames[0], 'README.md'), 'utf8'),
    '# source ZIP readme\n',
  );
  console.log('GitHub source ZIP updater verification passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true });
}
