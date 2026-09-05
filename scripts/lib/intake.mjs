import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readClaims } from './profile.mjs';

export const INTAKE_SCHEMA_VERSION = 1;
export const DEFAULT_MANIFEST = path.join('state', 'intake-manifest.json');

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'build', 'dist', 'cache', 'private', 'generated',
  'workspace', 'profile', 'companies', '.work',
  '.venv', 'venv', '__pycache__', '.agents', '.claude', '.codex', '.next', '.updates',
]);
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java',
  '.js', '.jsx', '.kt', '.m', '.mjs', '.php', '.ps1', '.py', '.rb', '.rs',
  '.sh', '.sql', '.swift', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.hwp', '.hwpx', '.json', '.md', '.odt', '.pdf',
  '.ppt', '.pptx', '.rtf', '.txt', '.xls', '.xlsx', '.xlsm', '.tsv',
]);
const PROJECT_MARKERS = new Set([
  '.git', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile',
]);
const LARGE_FILE_BYTES = 20 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileId(filePath) {
  return `file-${sha256(comparable(filePath)).slice(0, 24)}`;
}

function sourceId(sourcePath) {
  return `source-${sha256(comparable(sourcePath)).slice(0, 16)}`;
}

function asPortablePath(value) {
  return value.split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isIgnoredDirectory(name) {
  return IGNORED_DIRECTORIES.has(name.toLowerCase());
}

function protectedWorkspaceDirectory(root, target) {
  for (const name of ['profile', 'companies', '.work']) {
    const protectedPath = path.join(root, name);
    if (isInside(protectedPath, target)) return protectedPath;
  }
  return null;
}

function displayPath(root, absolute) {
  return isInside(root, absolute) ? asPortablePath(path.relative(root, absolute) || '.') : absolute;
}

async function pathState(target) {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) return { status: 'symlink' };
    if (stats.isDirectory()) return { status: 'ready', type: 'directory', stats };
    if (stats.isFile()) return { status: 'ready', type: 'file', stats };
    return { status: 'unsupported' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'inaccessible', error: error?.message ?? String(error) };
  }
}

async function looksLikeProject(directory) {
  try {
    const names = await fs.readdir(directory);
    return names.some((name) => PROJECT_MARKERS.has(name.toLowerCase()));
  } catch {
    return false;
  }
}

function classifyFile(absolute, bytes, project, sourcePath) {
  const extension = path.extname(absolute).toLowerCase();
  const name = path.basename(absolute).toLowerCase();
  const projectDocument = /(^readme(?:\.|$)|report|보고서|(^|[-_.])log(?:[-_.]|$))/.test(name);
  const large = bytes > LARGE_FILE_BYTES;
  if (large) {
    return { kind: 'large-file', extraction: 'drill-down', reason: '20 MiB를 넘는 파일' };
  }
  if (project && CODE_EXTENSIONS.has(extension)) {
    return { kind: 'project-code', extraction: 'drill-down', reason: '프로젝트 코드는 요청 시 상세 확인' };
  }
  if (project && !projectDocument && ['.csv', '.tsv', '.json', '.xlsx', '.xlsm'].includes(extension)) {
    return { kind: 'project-data', extraction: 'drill-down', reason: '데이터·설정 파일은 문서의 주장 검증에 필요할 때 확인' };
  }
  if (DOCUMENT_EXTENSIONS.has(extension) || projectDocument) {
    if (project && (path.dirname(absolute) !== sourcePath || /(^|[-_.])log(?:[-_.]|$)|작업기록|changelog/.test(name))) {
      return { kind: 'project-reference', extraction: 'drill-down', reason: '상세 문서·실행 로그는 요약의 주장 검증에 필요한 부분만 확인' };
    }
    return {
      kind: project ? 'project-document' : 'document',
      extraction: 'summary',
      reason: projectDocument ? 'README/report/log 우선 문서' : '구조화할 문서',
    };
  }
  return {
    kind: project ? 'project-binary' : 'other-file',
    extraction: 'drill-down',
    reason: '요청 시 상세 확인',
  };
}

async function inspectFile(absolute, root, project, source, summaryOnly = false, projectRoot = source.path) {
  try {
    const stats = await fs.stat(absolute);
    const classification = classifyFile(absolute, stats.size, project, projectRoot);
    // An explicitly named file is a bounded selection, including a large PDF.
    if (source.type === 'file') classification.extraction = 'summary';
    const deferred = summaryOnly && classification.extraction === 'drill-down';
    const contentHash = deferred ? null : await hashFile(absolute);
    return {
      id: fileId(absolute),
      path: absolute,
      displayPath: displayPath(root, absolute),
      sourceId: source.id,
      sourcePath: source.path,
      bytes: stats.size,
      sha256: contentHash,
      inventoryOnly: deferred,
      ...classification,
    };
  } catch (error) {
    return {
      error: {
        type: error?.code === 'ENOENT' ? 'disappeared-during-scan' : 'access-failed',
        path: absolute,
        sourceId: source.id,
        message: error?.message ?? String(error),
      },
    };
  }
}

async function scanDirectory(directory, root, project, source, collected, errors, inaccessiblePrefixes, summaryOnly = false, projectRoot = source.path) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    errors.push({
      type: error?.code === 'ENOENT' ? 'disappeared-during-scan' : 'access-failed',
      path: directory,
      sourceId: source.id,
      message: error?.message ?? String(error),
    });
    inaccessiblePrefixes.push(directory);
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!project && entries.some(entry => PROJECT_MARKERS.has(entry.name.toLowerCase()))) {
    project = true;
    projectRoot = directory;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push({ type: 'symlink-skipped', path: absolute, sourceId: source.id });
      inaccessiblePrefixes.push(absolute);
      continue;
    }
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(entry.name)) {
        await scanDirectory(absolute, root, project, source, collected, errors, inaccessiblePrefixes, summaryOnly, projectRoot);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const inspected = await inspectFile(absolute, root, project, source, summaryOnly, projectRoot);
    if (inspected.error) {
      errors.push(inspected.error);
      inaccessiblePrefixes.push(absolute);
    } else {
      collected.set(comparable(absolute), inspected);
    }
  }
}

async function readManifest(manifestPath) {
  try {
    const value = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (value?.schemaVersion !== INTAKE_SCHEMA_VERSION || !Array.isArray(value.files) || !Array.isArray(value.sources)) {
      throw new Error('지원하지 않는 intake manifest 형식입니다.');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`intake manifest JSON을 읽을 수 없습니다: ${manifestPath}`);
    throw error;
  }
}

function normalizeSources(root, requested, manifest) {
  const input = requested?.length ? requested : (manifest?.sources ?? []).map((item) => item.path);
  if (!input.length) throw new Error('--source를 한 번 이상 지정해야 합니다. 저장된 source도 없습니다.');
  const seen = new Set();
  return input.map((item) => path.resolve(root, item)).filter((item) => {
    const key = comparable(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function previousAppliesToSource(previous, source) {
  if (source.type === 'file') return comparable(previous.path) === comparable(source.path);
  return source.type === 'directory' && isInside(source.path, previous.path);
}

function protectedByScanError(previousPath, inaccessiblePrefixes) {
  return inaccessiblePrefixes.some((prefix) => isInside(prefix, previousPath));
}

function planFingerprint(files, sources, errors) {
  const snapshot = {
    files: files.map(({ path: filePath, sha256: hash, bytes }) => [comparable(filePath), hash, bytes])
      .sort((a, b) => a[0].localeCompare(b[0], 'en')),
    sources: sources.map(({ path: sourcePath, status, type, project }) => [comparable(sourcePath), status, type ?? null, Boolean(project)])
      .sort((a, b) => a[0].localeCompare(b[0], 'en')),
    errors: errors.map(({ type, path: errorPath }) => [type, comparable(errorPath)])
      .sort((a, b) => a[1].localeCompare(b[1], 'en')),
  };
  return sha256(JSON.stringify(snapshot));
}

async function scanSources({ root, sourcePaths, manifest, summaryOnly = false }) {
  const files = new Map();
  const sources = [];
  const errors = [];
  const inaccessiblePrefixes = [];

  for (const sourcePath of sourcePaths) {
    const source = { id: sourceId(sourcePath), path: sourcePath };
    const protectedPath = protectedWorkspaceDirectory(root, sourcePath);
    if (protectedPath) {
      Object.assign(source, { status: 'excluded', type: null });
      sources.push(source);
      errors.push({ type: 'excluded-source', path: sourcePath, sourceId: source.id });
      inaccessiblePrefixes.push(sourcePath);
      continue;
    }
    const state = await pathState(sourcePath);
    Object.assign(source, { status: state.status, type: state.type ?? null });
    sources.push(source);
    if (state.status !== 'ready') {
      errors.push({
        type: state.status === 'missing' ? 'missing-source' : state.status === 'symlink' ? 'symlink-source-rejected' : 'source-inaccessible',
        path: sourcePath,
        sourceId: source.id,
        message: state.error,
      });
      inaccessiblePrefixes.push(sourcePath);
      continue;
    }
    if (state.type === 'directory' && isIgnoredDirectory(path.basename(sourcePath))) {
      source.status = 'excluded';
      errors.push({ type: 'excluded-source', path: sourcePath, sourceId: source.id });
      inaccessiblePrefixes.push(sourcePath);
      continue;
    }
    const project = state.type === 'directory' ? await looksLikeProject(sourcePath) : false;
    source.project = project;
    if (state.type === 'file') {
      const inspected = await inspectFile(sourcePath, root, project, source, summaryOnly);
      if (inspected.error) {
        errors.push(inspected.error);
        inaccessiblePrefixes.push(sourcePath);
      } else {
        files.set(comparable(sourcePath), inspected);
      }
    } else {
      await scanDirectory(sourcePath, root, project, source, files, errors, inaccessiblePrefixes, summaryOnly);
    }
  }

  const inventory = [...files.values()].filter(file => file.inventoryOnly);
  const scanned = [...files.values()].filter(file => !file.inventoryOnly).sort((a, b) => comparable(a.path).localeCompare(comparable(b.path), 'en'));
  const previousById = new Map((manifest?.files ?? []).map((item) => [item.id, item]));
  const currentIds = new Set([...scanned, ...inventory].map((item) => item.id));
  const result = scanned.map((item) => {
    const previous = previousById.get(item.id);
    let status = 'new';
    if (previous?.status !== 'removed') status = previous?.sha256 === item.sha256 ? 'unchanged' : previous ? 'changed' : 'new';
    return { ...item, status, previousSha256: previous?.sha256 ?? null };
  });

  for (const previous of manifest?.files ?? []) {
    if (previous.status === 'removed' || currentIds.has(previous.id)) continue;
    const covered = sources.some((source) => source.status === 'ready' && previousAppliesToSource(previous, source));
    if (!covered || protectedByScanError(previous.path, inaccessiblePrefixes)) continue;
    result.push({
      ...previous,
      displayPath: displayPath(root, previous.path),
      status: 'removed',
      previousSha256: previous.sha256,
      sha256: null,
      reason: '접근 가능한 source 범위에서 파일이 삭제됨',
    });
  }

  result.sort((a, b) => comparable(a.path).localeCompare(comparable(b.path), 'en'));
  return {
    files: result,
    inventory,
    currentFiles: scanned,
    sources,
    errors,
    snapshotHash: planFingerprint(scanned, sources, errors),
  };
}

function summarize(files) {
  const fileCounts = { total: files.length, new: 0, changed: 0, unchanged: 0, removed: 0, 'legacy-review': 0 };
  const bytes = { total: 0, new: 0, changed: 0, unchanged: 0, removed: 0, 'legacy-review': 0 };
  for (const file of files) {
    fileCounts[file.status] += 1;
    bytes[file.status] += file.bytes ?? 0;
    if (file.status !== 'removed') bytes.total += file.bytes ?? 0;
  }
  return { files: fileCounts, bytes };
}

function modelCallPlan(files, legacyReview) {
  if (legacyReview) return { count: null, reason: '기존 프로필과 원자료를 대조한 후 처리 범위를 정합니다.' };
  const actionable = files.filter((file) => ['new', 'changed'].includes(file.status));
  const removed = files.filter((file) => file.status === 'removed');
  if (!actionable.length && !removed.length) return { count: 0, reason: '원자료 변경이 없습니다.' };
  return { count: 1, reason: '변경 목록에서 관련 claim과 필요한 상세읽기만 판단합니다. 소량은 메인이 처리하고 큰 독립 묶음만 위임합니다.' };
}

async function profileExists(root) {
  const targets = [path.join(root, 'profile', 'PROFILE.md'), path.join(root, 'profile', 'experiences')];
  for (const target of targets) {
    try {
      const stats = await fs.stat(target);
      if (stats.isFile()) return true;
      if (stats.isDirectory() && (await fs.readdir(target)).some((name) => name.endsWith('.md') && !name.startsWith('_'))) return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function profileBaseline(root) {
  const directory = path.join(root, 'profile', 'experiences');
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const paths = [path.join(root, 'profile', 'PROFILE.md'), ...names.filter(name => name.endsWith('.md') && !name.startsWith('_')).map(name => path.join(directory, name))];
  const claims = [];
  for (const file of paths) {
    const content = await fs.readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    // Keep recognizable old claims even when a legacy profile has other format errors.
    for (const match of content.replaceAll('\r\n', '\n').matchAll(/^###\s+([A-Z][A-Z0-9-]*-\d{3,})\s*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm)) {
      claims.push({ id: match[1], status: match[2].match(/^- 상태:\s*(.+)$/m)?.[1]?.trim() ?? null });
    }
  }
  return claims;
}

export async function createIntakePlan({ root = process.cwd(), sources, now = new Date(), summaryOnly = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const rootState = await pathState(absoluteRoot);
  if (rootState.status !== 'ready' || rootState.type !== 'directory') throw new Error(`workspace root를 읽을 수 없습니다: ${absoluteRoot}`);
  const manifestPath = path.join(absoluteRoot, DEFAULT_MANIFEST);
  const manifest = await readManifest(manifestPath);
  const sourcePaths = normalizeSources(absoluteRoot, sources, manifest);
  const scan = await scanSources({ root: absoluteRoot, sourcePaths, manifest, summaryOnly });
  const legacyReview = !manifest && await profileExists(absoluteRoot);
  const files = scan.files.map((file) => legacyReview && file.status !== 'removed' ? { ...file, status: 'legacy-review' } : file);
  const calls = modelCallPlan(files, legacyReview);
  const requiredFileIds = files
    .filter((file) => ['new', 'changed', 'legacy-review'].includes(file.status) && file.extraction === 'summary')
    .map((file) => file.id);
  const optionalFileIds = files
    .filter((file) => ['new', 'changed', 'legacy-review'].includes(file.status) && file.extraction === 'drill-down')
    .map((file) => file.id);
  const removedFileIds = files.filter((file) => file.status === 'removed').map((file) => file.id);
  const createdAt = now.toISOString();
  const planCore = {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    createdAt,
    root: absoluteRoot,
    manifestPath,
    manifestUpdatedAt: manifest?.updatedAt ?? null,
    mode: legacyReview ? 'legacy-review' : manifest ? 'incremental' : 'initial',
    sourcePaths,
    sources: scan.sources,
    files,
    summaryOnly,
    profileBaseline: await profileBaseline(absoluteRoot),
    inventory: scan.inventory,
    errors: scan.errors,
    snapshotHash: scan.snapshotHash,
    summary: summarize(files),
    modelCalls: calls.count,
    modelCallReason: calls.reason,
    execution: {
      requiredFileIds,
      optionalFileIds,
      receiptFileIds: [...requiredFileIds, ...optionalFileIds],
      removedFileIds,
      automaticExtractionAllowed: !legacyReview,
    },
    canCommit: scan.errors.every((error) => error.type === 'symlink-skipped'),
  };
  return { ...planCore, planId: `plan-${sha256(JSON.stringify(planCore)).slice(0, 24)}` };
}

export function renderPlanMarkdown(plan) {
  const counts = plan.summary.files;
  const bytes = plan.summary.bytes;
  const lines = [
    '# Intake 증분 계획', '',
    `- 계획 ID: \`${plan.planId}\``,
    `- 모드: \`${plan.mode}\``,
    `- source: ${plan.sources.length}개`,
    `- 상세읽기 대기: ${plan.inventory?.length ?? 0}개 (내용을 읽거나 처리 완료로 등록하지 않음)`,
    `- 의미 검토: ${plan.modelCalls === null ? '기존 정본 대조 후 범위 결정' : plan.modelCalls === 0 ? '불필요' : '변경 목록의 영향 확인 필요'}`,
    `- commit 가능: ${plan.canCommit ? '예' : '아니요'}`, '',
    '## 파일·용량 요약', '',
    '| 상태 | 파일 | bytes |', '|---|---:|---:|',
    ...['new', 'changed', 'unchanged', 'removed', 'legacy-review'].map((status) => `| ${status} | ${counts[status]} | ${bytes[status]} |`),
    `| 계획 항목 합계 | ${counts.total} | ${bytes.total} |`, '',
  ];
  if (plan.mode === 'legacy-review') {
    lines.push('> 기존 프로필은 있지만 manifest가 없습니다. 원자료와 기존 claim-id를 대조해 확인한 범위만 재사용 기준에 기록합니다.', '');
  }
  if (plan.errors.length) {
    lines.push('## 접근/범위 알림', '');
    for (const error of plan.errors) lines.push(`- ${error.type}: \`${error.path}\``);
    lines.push('');
  }
  const changed = plan.files.filter((file) => file.status !== 'unchanged');
  if (changed.length) {
    lines.push('## 처리 대상', '', '| 상태 | 방식 | 파일 | bytes |', '|---|---|---|---:|');
    for (const file of changed) lines.push(`| ${file.status} | ${file.extraction ?? 'review'} | ${file.displayPath} | ${file.bytes ?? 0} |`);
    lines.push('');
  } else {
    lines.push('변경이 없어 추출 에이전트를 호출하지 않습니다.', '');
  }
  return `${lines.join('\n')}\n`;
}

export async function writeIntakePlan(plan, outPath) {
  const absolute = path.resolve(plan.root, outPath);
  const jsonPath = path.extname(absolute).toLowerCase() === '.json' ? absolute : path.join(absolute, 'plan.json');
  const markdownPath = jsonPath.replace(/\.json$/i, '.md');
  const existing = await loadJson(jsonPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && existing.planId !== plan.planId) throw new Error('기존 plan을 덮어쓸 수 없습니다. 새 run 경로를 사용하세요.');
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await writeJsonAtomic(jsonPath, plan);
  await fs.writeFile(markdownPath, renderPlanMarkdown(plan), 'utf8');
  return { jsonPath, markdownPath };
}

function receiptValidationPassed(receipt) {
  return receipt?.status === 'success'
    && (receipt?.validated === true || receipt?.validation === 'passed' || receipt?.validation?.status === 'passed');
}

function normalizeOutput(output, root) {
  const item = typeof output === 'string' ? { path: output } : output;
  if (!item || typeof item.path !== 'string') throw new Error('receipt.outputs 항목에는 path가 필요합니다.');
  const absolute = path.resolve(root, item.path);
  const profileRoot = path.join(root, 'profile');
  if (!isInside(profileRoot, absolute)) throw new Error(`산출물은 profile/ 아래에 있어야 합니다: ${item.path}`);
  return { ...item, absolute };
}

async function validateOutputs(receipt, root) {
  if (!Array.isArray(receipt.outputs) || !receipt.outputs.length) throw new Error('receipt.outputs가 비어 있습니다.');
  const outputs = receipt.outputs.map((item) => normalizeOutput(item, root));
  let hasProfile = false;
  let hasExperience = false;
  const realRoot = await fs.realpath(root);
  const realProfileRoot = await fs.realpath(path.join(root, 'profile')).catch(() => path.join(root, 'profile'));
  if (!isInside(realRoot, realProfileRoot)) throw new Error('profile/ 디렉터리가 workspace 밖을 가리킵니다.');
  for (const output of outputs) {
    let stats;
    try {
      stats = await fs.lstat(output.absolute);
    } catch {
      throw new Error(`receipt 산출물이 없습니다: ${output.path}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`receipt 산출물은 일반 파일이어야 합니다: ${output.path}`);
    const realOutput = await fs.realpath(output.absolute);
    if (!isInside(realProfileRoot, realOutput)) throw new Error(`receipt 산출물이 profile/ 밖을 가리킵니다: ${output.path}`);
    if (output.sha256 && await hashFile(output.absolute) !== output.sha256) throw new Error(`receipt 산출물 hash가 다릅니다: ${output.path}`);
    const relative = asPortablePath(path.relative(path.join(root, 'profile'), output.absolute));
    if (relative === 'PROFILE.md') hasProfile = true;
    if (relative.startsWith('experiences/') && relative.endsWith('.md') && !path.basename(relative).startsWith('_')) hasExperience = true;
  }
  if (!hasProfile || !hasExperience) throw new Error('receipt에는 profile/PROFILE.md와 profile/experiences/*.md 산출물이 모두 필요합니다.');
  readClaims(root);
  return outputs;
}

async function validateClaimPreservation(plan, receipt, root) {
  const current = readClaims(root);
  for (const prior of plan.profileBaseline ?? []) {
    const next = current.get(prior.id);
    const rank = { '사용 금지': 0, '확인 필요': 1, '검증됨': 2 };
    const action = !next ? 'remove' : (rank[next.status] > (rank[prior.status] ?? 0) ? 'verify' : null);
    if (!action) continue;
    const change = receipt.claimChanges?.find(item => item.id === prior.id && item.action === action);
    if (!change?.reason?.trim() || typeof change.evidence !== 'string') {
      throw new Error(`기존 claim ${prior.id}의 ${action === 'remove' ? '삭제' : '상태 승격'}에는 claimChanges의 사유와 확인 기록이 필요합니다.`);
    }
    const evidence = path.resolve(root, change.evidence);
    if (!isInside(path.join(root, '.work', 'intake'), evidence)) throw new Error('claim 변경 확인 기록은 .work/intake/ 안에 보관하세요.');
    if (!(await fs.lstat(evidence)).isFile() || !isInside(await fs.realpath(path.join(root, '.work', 'intake')), await fs.realpath(evidence))) throw new Error('claim 변경 확인 기록 경로가 올바르지 않습니다.');
    if (!change.sha256 || await hashFile(evidence) !== change.sha256) throw new Error('claim 변경 확인 기록의 hash가 다릅니다.');
    if (!(await fs.readFile(evidence, 'utf8')).includes(prior.id)) throw new Error('확인 기록에 해당 claim-id가 없습니다.');
  }
}

function assertProcessedFiles(plan, receipt) {
  if (!Array.isArray(receipt.processedFiles)) throw new Error('receipt.processedFiles 배열이 필요합니다.');
  const planById = new Map(plan.files.map((file) => [file.id, file]));
  const processed = new Map();
  for (const item of receipt.processedFiles) {
    if (!item || typeof item.id !== 'string' || typeof item.sha256 !== 'string') throw new Error('processedFiles에는 id와 sha256가 필요합니다.');
    if (!['extracted', 'reviewed', 'deferred'].includes(item.outcome)) throw new Error('processedFiles.outcome은 extracted/reviewed/deferred 중 하나여야 합니다.');
    if (processed.has(item.id)) throw new Error(`processedFiles 중복 id: ${item.id}`);
    const planned = planById.get(item.id);
    if (!planned || !['new', 'changed', 'legacy-review'].includes(planned.status)) throw new Error(`계획의 처리 대상이 아닌 파일입니다: ${item.id}`);
    if (planned.sha256 !== item.sha256) throw new Error(`처리한 source hash가 계획과 다릅니다: ${item.id}`);
    if (planned.extraction === 'summary' && item.outcome === 'deferred') throw new Error(`요약 필수 파일을 deferred로 처리할 수 없습니다: ${item.id}`);
    processed.set(item.id, item);
  }
  for (const id of receipt.partial === true ? [] : (plan.execution.receiptFileIds ?? plan.execution.requiredFileIds)) {
    if (!processed.has(id)) throw new Error(`필수 처리 파일이 receipt에서 누락되었습니다: ${id}`);
  }
  return processed;
}

function assertRemovedFiles(plan, receipt) {
  const declared = Array.isArray(receipt.removedFiles) ? receipt.removedFiles : [];
  const plannedById = new Map(plan.files.filter((file) => file.status === 'removed').map((file) => [file.id, file]));
  const removed = new Map();
  for (const item of declared) {
    const planned = plannedById.get(item?.id);
    if (!planned || item.sha256 !== planned.previousSha256) throw new Error(`삭제 검토 항목이 계획과 다릅니다: ${item?.id ?? '(id 없음)'}`);
    removed.set(item.id, item);
  }
  for (const id of receipt.partial === true ? [] : plan.execution.removedFileIds) {
    if (!removed.has(id)) throw new Error(`삭제 검토 결과가 receipt에서 누락되었습니다: ${id}`);
  }
  return removed;
}

export async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

export async function commitIntakePlan({ root = process.cwd(), plan, receipt, now = new Date() } = {}) {
  const absoluteRoot = path.resolve(root);
  if (!plan || plan.schemaVersion !== INTAKE_SCHEMA_VERSION || !plan.planId) throw new Error('올바른 intake plan이 아닙니다.');
  const { planId, ...planCore } = plan;
  if (planId !== `plan-${sha256(JSON.stringify(planCore)).slice(0, 24)}`) throw new Error('plan 내용 또는 planId가 변경되었습니다.');
  if (path.resolve(plan.root) !== absoluteRoot) throw new Error('plan의 workspace root와 --root가 다릅니다.');
  if (!plan.canCommit && receipt?.partial !== true) throw new Error('접근 실패 또는 누락 source가 있는 plan은 commit할 수 없습니다.');
  if (receipt?.schemaVersion !== INTAKE_SCHEMA_VERSION || !receiptValidationPassed(receipt)) throw new Error('receipt는 schemaVersion=1, status=success, validation=passed를 포함해야 합니다.');
  if (receipt.planId !== plan.planId) throw new Error('receipt.planId가 plan과 다릅니다.');
  if (plan.mode === 'legacy-review' && receipt.legacyReviewApproved !== true) {
    throw new Error('legacy-review plan은 기존 정본과 원자료 대조 완료를 legacyReviewApproved=true로 기록해야 합니다.');
  }

  const processed = assertProcessedFiles(plan, receipt);
  const removed = assertRemovedFiles(plan, receipt);
  if (receipt.partial === true && !processed.size && !removed.size) throw new Error('부분 반영할 처리 항목이 없습니다.');
  await validateOutputs(receipt, absoluteRoot);
  await validateClaimPreservation(plan, receipt, absoluteRoot);

  const currentManifest = await readManifest(path.join(absoluteRoot, DEFAULT_MANIFEST));
  if (plan.mode === 'initial' || plan.mode === 'legacy-review') {
    if (currentManifest) throw new Error('plan 이후 manifest가 생겼습니다. 새 plan을 만드세요.');
  } else if (!currentManifest || currentManifest.updatedAt !== plan.manifestUpdatedAt) {
    throw new Error('plan 이후 manifest가 변경되었습니다. 새 plan을 만드세요.');
  }

  if (receipt.partial === true) {
    // A bad/unavailable file must not block already reviewed independent files.
    for (const id of processed.keys()) {
      const file = plan.files.find(item => item.id === id);
      if (await hashFile(file.path) !== file.sha256) throw new Error('plan 이후 source가 변경되었습니다. 새 plan을 만드세요.');
    }
    for (const id of removed.keys()) {
      const file = plan.files.find(item => item.id === id);
      if ((await pathState(file.sourcePath)).status !== 'ready' || (await pathState(file.path)).status !== 'missing') {
        throw new Error('삭제 검토 source 상태가 변경되었습니다. 새 plan을 만드세요.');
      }
    }
  } else {
    const rescanned = await scanSources({ root: absoluteRoot, sourcePaths: plan.sourcePaths, manifest: currentManifest, summaryOnly: plan.summaryOnly });
    if (rescanned.snapshotHash !== plan.snapshotHash) throw new Error('plan 이후 source가 변경되었습니다. 새 plan을 만드세요.');
  }

  const previous = new Map((currentManifest?.files ?? []).map((file) => [file.id, file]));
  const committedAt = now.toISOString();
  const planById = new Map(plan.files.map((file) => [file.id, file]));
  for (const [id, receiptItem] of processed) {
    const file = planById.get(id);
    previous.set(id, {
      id: file.id,
      path: file.path,
      sourceId: file.sourceId,
      sourcePath: file.sourcePath,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
      extraction: file.extraction,
      outcome: receiptItem.outcome ?? 'extracted',
      ...(receiptItem.coverage ? { coverage: receiptItem.coverage } : {}),
      status: 'active',
      processedAt: committedAt,
    });
  }
  for (const id of removed.keys()) {
    const prior = previous.get(id) ?? planById.get(id);
    previous.set(id, { ...prior, status: 'removed', removedAt: committedAt });
  }
  const sourceMap = new Map((currentManifest?.sources ?? []).map((source) => [source.id, source]));
  for (const source of plan.sources) {
    sourceMap.set(source.id, {
      ...sourceMap.get(source.id), id: source.id, path: source.path, type: source.type,
      project: Boolean(source.project), status: source.status, lastAttemptedAt: committedAt,
      ...(source.status === 'ready' ? { lastScannedAt: committedAt } : {}),
    });
  }
  const manifest = {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    updatedAt: committedAt,
    sources: [...sourceMap.values()].sort((a, b) => comparable(a.path).localeCompare(comparable(b.path), 'en')),
    files: [...previous.values()].sort((a, b) => comparable(a.path).localeCompare(comparable(b.path), 'en')),
    lastCommit: { planId: plan.planId, receiptId: receipt.receiptId ?? null },
  };
  await writeJsonAtomic(path.join(absoluteRoot, DEFAULT_MANIFEST), manifest);
  return { manifestPath: path.join(absoluteRoot, DEFAULT_MANIFEST), manifest, processed: processed.size, removed: removed.size };
}

export async function loadJson(filePath, label = 'JSON') {
  try {
    return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} 형식이 올바르지 않습니다: ${filePath}`);
    throw error;
  }
}

export function defaultPlanOutput(root, now = new Date()) {
  const runId = now.toISOString().replace(/[:.]/g, '-');
  return path.join(path.resolve(root), '.work', 'intake', runId, 'plan.json');
}
