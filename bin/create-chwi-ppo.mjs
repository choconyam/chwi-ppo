#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const REPOSITORY = 'choconyam/chwi-ppo';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DEFAULT_DIRECTORY = 'chwi-ppo';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeArchivePath(value) {
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    parts.includes('..')
  ) {
    throw new Error(`안전하지 않은 압축 경로입니다: ${value}`);
  }
  return parts.join('/');
}

function requireVersion(value) {
  const version = String(value ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`지원하지 않는 릴리스 버전입니다: ${value}`);
  }
  return version;
}

export function verifyReleaseArchive(buffer, expectedVersion) {
  const version = requireVersion(expectedVersion);
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  for (const entry of entries) {
    normalizeArchivePath(entry.entryName);
    const mode = (entry.attr >>> 16) & 0o170000;
    if (mode === 0o120000) {
      throw new Error(`심볼릭 링크는 설치할 수 없습니다: ${entry.entryName}`);
    }
  }

  const manifestEntries = entries.filter(
    (entry) => !entry.isDirectory && normalizeArchivePath(entry.entryName).endsWith('/release-manifest.json'),
  );
  if (manifestEntries.length !== 1) {
    throw new Error('릴리스에 release-manifest.json이 정확히 하나 있어야 합니다.');
  }

  const manifestEntry = manifestEntries[0];
  const manifestPath = normalizeArchivePath(manifestEntry.entryName);
  const rootPrefix = manifestPath.slice(0, -'release-manifest.json'.length);
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new Error('release-manifest.json을 읽을 수 없습니다.');
  }

  if (manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.files)) {
    throw new Error('릴리스 manifest의 버전 또는 형식이 올바르지 않습니다.');
  }

  const archiveFiles = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    archiveFiles.set(normalizeArchivePath(entry.entryName), entry);
  }

  const declaredFiles = new Set();
  for (const item of manifest.files) {
    const relative = normalizeArchivePath(String(item?.path ?? ''));
    if (!relative || !/^[0-9a-f]{64}$/i.test(String(item?.sha256 ?? ''))) {
      throw new Error('릴리스 manifest에 올바르지 않은 파일 항목이 있습니다.');
    }
    if (declaredFiles.has(relative)) {
      throw new Error(`릴리스 manifest에 중복된 파일이 있습니다: ${relative}`);
    }
    declaredFiles.add(relative);

    const archivePath = `${rootPrefix}${relative}`;
    const entry = archiveFiles.get(archivePath);
    if (!entry) {
      throw new Error(`릴리스 manifest에 선언된 파일이 없습니다: ${relative}`);
    }
    if (sha256(entry.getData()) !== item.sha256.toLowerCase()) {
      throw new Error(`릴리스 내부 파일 검증에 실패했습니다: ${relative}`);
    }
  }

  const undeclared = [...archiveFiles.keys()].filter(
    (archivePath) => archivePath !== manifestPath && !declaredFiles.has(archivePath.slice(rootPrefix.length)),
  );
  if (undeclared.length > 0) {
    throw new Error(`릴리스 manifest에 없는 파일이 포함되어 있습니다: ${undeclared[0]}`);
  }

  return { zip, rootPrefix, version };
}

export async function installReleaseArchive(buffer, expectedVersion, targetDirectory) {
  const target = path.resolve(targetDirectory);
  try {
    await fs.access(target);
    throw new Error(`설치할 폴더가 이미 존재합니다: ${target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chwi-ppo-extract-'));
  const stage = await fs.mkdtemp(path.join(parent, '.chwi-ppo-install-'));

  try {
    const { zip, rootPrefix, version } = verifyReleaseArchive(buffer, expectedVersion);
    zip.extractAllTo(extractRoot, true);
    const source = path.join(extractRoot, ...rootPrefix.split('/').filter(Boolean));
    for (const item of await fs.readdir(source)) {
      await fs.cp(path.join(source, item), path.join(stage, item), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    await fs.rename(stage, target);
    return { target, version };
  } finally {
    await fs.rm(extractRoot, { recursive: true, force: true });
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function fetchLatestRelease() {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'chwi-ppo-installer',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`최신 릴리스 정보를 가져오지 못했습니다. HTTP ${response.status}`);
  }

  const release = await response.json();
  const version = requireVersion(release.tag_name);
  const assetName = `chwi-ppo-v${version}-release.zip`;
  const asset = release.assets?.find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`최신 릴리스에서 ${assetName}을 찾지 못했습니다.`);
  }
  const digest = String(asset.digest ?? '').match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  if (!digest) {
    throw new Error('GitHub 릴리스에 SHA-256 digest가 없어 설치를 중단했습니다.');
  }

  const download = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'chwi-ppo-installer' },
  });
  if (!download.ok) {
    throw new Error(`릴리스 ZIP을 내려받지 못했습니다. HTTP ${download.status}`);
  }
  const buffer = Buffer.from(await download.arrayBuffer());
  if (sha256(buffer) !== digest) {
    throw new Error('릴리스 ZIP의 SHA-256이 GitHub digest와 일치하지 않습니다.');
  }
  return { buffer, version };
}

function printHelp() {
  console.log(`create-chwi-ppo 설치기

사용법:
  npm create chwi-ppo@latest             현재 위치의 chwi-ppo 폴더에 설치
  npm create chwi-ppo@latest my-career   지정한 새 폴더에 설치

기존 폴더를 덮어쓰지 않습니다.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) {
    throw new Error('설치 폴더 하나만 입력할 수 있습니다. 도움말: npm create chwi-ppo@latest -- --help');
  }

  const target = path.resolve(args[0] || DEFAULT_DIRECTORY);
  console.log('chwi-ppo 최신 릴리스를 확인합니다...');
  const { buffer, version } = await fetchLatestRelease();
  console.log(`v${version} 릴리스와 내부 파일을 검증했습니다.`);
  const installed = await installReleaseArchive(buffer, version, target);
  console.log(`\n설치 완료: ${installed.target}`);
  console.log(`다음 단계: 이 폴더를 Codex 또는 Claude Code에서 열고 /intake를 실행하세요.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`\n설치 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
