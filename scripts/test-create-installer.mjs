import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { installReleaseArchive, verifyReleaseArchive } from '../bin/create-chwi-ppo.mjs';

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createRelease({ corrupt = false } = {}) {
  const zip = new AdmZip();
  const file = Buffer.from('# test project\n', 'utf8');
  zip.addFile('chwi-ppo/AGENTS.md', file);
  zip.addFile(
    'chwi-ppo/release-manifest.json',
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        files: [{ path: 'AGENTS.md', sha256: corrupt ? '0'.repeat(64) : digest(file) }],
      }),
      'utf8',
    ),
  );
  return zip.toBuffer();
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chwi-ppo-installer-test-'));
try {
  const target = path.join(temp, 'installed');
  const valid = createRelease();
  verifyReleaseArchive(valid, '1.0.0');
  const result = await installReleaseArchive(valid, '1.0.0', target);
  assert.equal(result.version, '1.0.0');
  assert.equal(await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8'), '# test project\n');
  await assert.rejects(() => installReleaseArchive(valid, '1.0.0', target), /이미 존재/);
  assert.throws(() => verifyReleaseArchive(createRelease({ corrupt: true }), '1.0.0'), /검증에 실패/);
  console.log('기존 릴리스 설치기 호환성 검증 통과');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
