import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, loadJson, writeJsonAtomic } from './intake.mjs';

const VERSION = 1;
const RULES = 'bounded-facts-v1';
const MAX_ATTEMPTS = 2;
const MAX_ACTIVE = 2;
const MAX_CHARS = 12000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

async function localFile(root, target) {
  const absolute = path.resolve(root, target);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(absolute);
  if (!inside(realRoot, real) || !(await fs.lstat(absolute)).isFile()) throw new Error('작업 파일은 intake staging 안의 일반 파일이어야 합니다.');
  return real;
}

async function withRun(runPath, operation) {
  const absolute = path.resolve(runPath);
  const lockPath = `${absolute}.lock`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Only the short-lived controller lock is recoverable by PID. A worker's
    // running state NEVER expires by timeout: its orchestrator must confirm exit.
    const prior = await loadJson(lockPath, 'controller lock').catch(() => null);
    if (!Number.isInteger(prior?.pid) || prior.pid <= 0) throw new Error('controller lock 확인 필요; 실행 중인 프로세스 확인 없이 삭제하지 마세요.');
    try { process.kill(prior.pid, 0); }
    catch (cause) {
      if (cause.code === 'ESRCH') {
        await fs.unlink(lockPath);
        return withRun(absolute, operation);
      }
    }
    throw new Error('다른 intake 명령이 실행 중입니다. 완료 후 다시 실행하세요.');
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    let run = await loadJson(absolute, 'intake run').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (run && (run.schemaVersion !== VERSION || run.rules !== RULES || !Array.isArray(run.units))) throw new Error('지원하지 않는 intake run입니다. 기존 파일을 보존하고 확인하세요.');
    const result = await operation(run, absolute);
    run = result.run;
    await writeJsonAtomic(absolute, run);
    return result.value ?? run;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

function makeUnit(file, scope, extra = {}) {
  return {
    id: `unit-${digest(`${RULES}\n${file.id}\n${file.sha256}\n${scope}`).slice(0, 24)}`,
    fileId: file.id, sourcePath: file.path, sourceHash: file.sha256,
    scope, status: 'pending', attempts: 0, ...extra,
  };
}

async function unitsFor(file) {
  const extension = path.extname(file.path).toLowerCase();
  if (['.md', '.txt', '.csv', '.tsv', '.json'].includes(extension) && file.bytes <= 2 * 1024 * 1024) {
    const text = await fs.readFile(file.path, 'utf8');
    const lines = text.split('\n');
    const units = [];
    let start = 1;
    let size = 0;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].length > MAX_CHARS) return [makeUnit(file, '긴 단일 행: 필요한 항목/구간부터 범위 지정', { status: 'needs-scope' })];
      if (size && size + lines[index].length + 1 > MAX_CHARS) {
        units.push(makeUnit(file, `lines ${start}-${index}`, { startLine: start, endLine: index, chars: size }));
        start = index + 1;
        size = 0;
      }
      size += lines[index].length + 1;
    }
    units.push(makeUnit(file, `lines ${start}-${lines.length}`, { startLine: start, endLine: lines.length, chars: size }));
    return units;
  }
  return [makeUnit(file, '목차/페이지/시트/슬라이드를 확인한 뒤 필요한 구간 지정', { status: 'needs-scope' })];
}

async function artifactValid(run, unit) {
  if (!unit.artifact) return false;
  try {
    const file = await localFile(path.join(run.root, '.work', 'intake'), unit.artifact.path);
    return await hashFile(file) === unit.artifact.sha256;
  } catch { return false; }
}

export async function startRun({ plan, runPath, previous }) {
  const { planId, ...core } = plan;
  if (planId !== `plan-${digest(JSON.stringify(core)).slice(0, 24)}`) throw new Error('plan 내용이 변경되었습니다.');
  const root = path.resolve(plan.root);
  if (!inside(path.join(root, '.work', 'intake'), runPath)) throw new Error('run은 .work/intake/ 아래에 저장하세요.');
  return withRun(runPath, async existing => {
    if (existing) {
      if (existing.plan.planId !== planId) throw new Error('기존 run을 덮어쓸 수 없습니다. 새 경로와 --previous를 사용하세요.');
      return { run: existing };
    }
    const prior = previous ? await loadJson(previous, 'previous run') : null;
    if (prior && (path.resolve(prior.root) !== root || prior.rules !== RULES)) throw new Error('다른 workspace/규칙의 결과는 재사용할 수 없습니다.');
    if (prior?.units.some(unit => unit.status === 'running')) throw new Error('이전 실행의 worker 상태를 확인하고 recover한 뒤 새 계획을 시작하세요.');
    const run = { schemaVersion: VERSION, rules: RULES, root, plan, createdAt: new Date().toISOString(), units: [] };
    const priorByFile = new Map();
    for (const unit of prior?.units ?? []) {
      if (unit.status === 'superseded') continue;
      const key = `${unit.fileId}:${unit.sourceHash}`;
      priorByFile.set(key, [...(priorByFile.get(key) ?? []), unit]);
    }
    for (const file of plan.files.filter(file => plan.execution.requiredFileIds.includes(file.id))) {
      const reusable = priorByFile.get(`${file.id}:${file.sha256}`);
      let units;
      try { units = reusable ?? await unitsFor(file); }
      catch (error) { units = [makeUnit(file, '원자료 재확인', { status: 'blocked', reason: error.message })]; }
      for (const unit of units) {
        const copy = structuredClone(unit);
        if (copy.status === 'extracted' && !await artifactValid(run, copy)) {
          copy.status = 'blocked'; copy.reason = '저장된 추출 결과가 없거나 변경됨';
        }
        run.units.push(copy);
      }
    }
    return { run };
  });
}

function findUnit(run, id) {
  const unit = run.units.find(item => item.id === id);
  if (!unit) throw new Error(`작업을 찾을 수 없습니다: ${id}`);
  return unit;
}

function workerOwns(unit, worker, lease) {
  if (unit.status !== 'running' || !worker || unit.worker !== worker || !lease || unit.lease !== lease) throw new Error('현재 작업을 claim한 worker만 해당 lease로 결과를 기록할 수 있습니다.');
}

export async function splitUnit({ runPath, id, scopes }) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 100 || scopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 500)) throw new Error('scopes는 실제 읽을 구간을 적은 문자열 배열(1~100개)이어야 합니다.');
  if (new Set(scopes).size !== scopes.length) throw new Error('중복 구간이 있습니다.');
  return withRun(runPath, async run => {
    const unit = findUnit(run, id);
    if (!['pending', 'needs-scope', 'blocked'].includes(unit.status)) throw new Error('대기/범위 지정/보류 작업만 분할할 수 있습니다.');
    const file = run.plan.files.find(file => file.id === unit.fileId);
    const children = scopes.map(scope => makeUnit(file, `${unit.scope} > ${scope}`));
    if (children.some(child => run.units.some(existing => existing.id === child.id))) throw new Error('이미 등록된 구간입니다.');
    unit.status = 'superseded';
    unit.children = children.map(child => child.id);
    run.units.push(...children);
    return { run, value: children };
  });
}

async function checkSourcesAndArtifacts(run) {
  const hashes = new Map();
  for (const unit of run.units.filter(unit => !['superseded', 'running'].includes(unit.status))) {
    if (!hashes.has(unit.sourcePath)) hashes.set(unit.sourcePath, await hashFile(unit.sourcePath).catch(() => null));
    if (hashes.get(unit.sourcePath) !== unit.sourceHash) {
      unit.status = 'blocked'; unit.reason = '원자료 변경/접근 실패: 새 plan 필요';
    } else if (unit.status === 'extracted' && !await artifactValid(run, unit)) {
      unit.status = 'blocked'; unit.reason = '저장된 추출 결과가 없거나 변경됨';
    }
  }
}

export function progress(run) {
  const units = run.units.filter(unit => unit.status !== 'superseded');
  const count = status => units.filter(unit => unit.status === status).length;
  return {
    total: units.length, extracted: count('extracted'), running: count('running'),
    pending: count('pending'), needsScope: count('needs-scope'), blocked: count('blocked'),
    unselectedFiles: (run.plan.inventory?.length ?? 0) + run.plan.execution.optionalFileIds.length,
    sourceErrors: run.plan.errors.length,
    next: units.filter(unit => ['pending', 'needs-scope', 'blocked', 'running'].includes(unit.status)).slice(0, 8),
    note: '추출 완료는 사실 검증/프로필 반영 완료가 아닙니다. 통합은 한 작성자가 수행합니다.',
  };
}

export async function runStatus({ runPath }) {
  return withRun(runPath, async run => {
    if (!run) throw new Error('start로 intake 실행을 먼저 등록하세요.');
    await checkSourcesAndArtifacts(run);
    return { run, value: progress(run) };
  });
}

export async function claimUnit({ runPath, worker }) {
  if (!worker?.trim()) throw new Error('worker ID가 필요합니다.');
  return withRun(runPath, async (run, absolute) => {
    if (!run) throw new Error('start로 intake 실행을 먼저 등록하세요.');
    const owned = run.units.find(unit => unit.status === 'running' && unit.worker === worker);
    if (owned) return { run, value: owned };
    if (run.units.filter(unit => unit.status === 'running').length >= MAX_ACTIVE) throw new Error('동시 작업은 최대 2개입니다. 기존 worker 완료를 기다리세요.');
    // Do not repeatedly hash all completed files when claiming the next task.
    for (const unit of run.units.filter(unit => unit.status === 'pending')) {
      if (await hashFile(unit.sourcePath).catch(() => null) !== unit.sourceHash) {
        unit.status = 'blocked'; unit.reason = '원자료 변경/접근 실패: 새 plan 필요'; continue;
      }
      if (unit.attempts >= MAX_ATTEMPTS) { unit.status = 'blocked'; unit.reason = '재시도 한도 도달: 원인 확인/구간 축소 필요'; continue; }
      unit.status = 'running'; unit.worker = worker; unit.attempts++;
      unit.lease = crypto.randomUUID();
      unit.startedAt = new Date().toISOString();
      unit.outputPath = path.join(path.dirname(absolute), 'staging', `${unit.id}.md`);
      await fs.mkdir(path.dirname(unit.outputPath), { recursive: true });
      return { run, value: unit };
    }
    return { run, value: { next: null, ...progress(run) } };
  });
}

export async function recordUnit({ runPath, id, worker, lease, factsPath }) {
  return withRun(runPath, async (run, absolute) => {
    const unit = findUnit(run, id);
    workerOwns(unit, worker, lease);
    if (await hashFile(unit.sourcePath).catch(() => null) !== unit.sourceHash) throw new Error('원자료가 변경되었습니다. fail 기록 후 새 plan을 만드세요.');
    const file = await localFile(path.join(run.root, '.work', 'intake'), factsPath);
    if ((await fs.stat(file)).size > 128 * 1024) throw new Error('추출 결과가 너무 큽니다. 작업 구간을 더 작게 나누세요.');
    const content = await fs.readFile(file, 'utf8');
    if (!/^- 출처:\s*\S/m.test(content) || !(/^- 사실:\s*\S/m.test(content) || /^- 추출 결과: 관련 사실 없음\s*$/m.test(content))) throw new Error('추출 결과에는 사실(또는 관련 사실 없음)과 출처가 필요합니다.');
    const artifactPath = path.join(path.dirname(absolute), 'facts', `${unit.id}-${crypto.randomUUID()}.md`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const saved = `<!-- unit: ${unit.id}; source-sha256: ${unit.sourceHash} -->\n<!-- scope: ${unit.scope.replaceAll('--', '—')} -->\n${content}`;
    await fs.writeFile(artifactPath, saved, { flag: 'wx' });
    unit.artifact = { path: artifactPath, sha256: digest(saved) };
    unit.status = 'extracted'; unit.completedAt = new Date().toISOString();
    delete unit.reason;
    return { run, value: unit };
  });
}

export async function failUnit({ runPath, id, worker, lease, reason }) {
  if (!reason?.trim()) throw new Error('실패 사유가 필요합니다.');
  return withRun(runPath, async run => {
    const unit = findUnit(run, id); workerOwns(unit, worker, lease);
    unit.status = 'blocked'; unit.reason = reason;
    return { run, value: unit };
  });
}

export async function recoverUnit({ runPath, id, confirmedStopped = false }) {
  return withRun(runPath, async run => {
    const unit = findUnit(run, id);
    if (!['running', 'blocked'].includes(unit.status)) throw new Error('실행 중/보류 작업만 재개할 수 있습니다.');
    if (unit.status === 'running' && !confirmedStopped) throw new Error('worker 종료를 확인한 후 --confirmed-stopped를 사용하세요. 시간 초과만으로 재실행하지 않습니다.');
    if (unit.attempts >= MAX_ATTEMPTS) throw new Error('재시도 한도 도달: 원인을 확인하고 split으로 작업을 축소하세요.');
    if (await hashFile(unit.sourcePath).catch(() => null) !== unit.sourceHash) throw new Error('원자료 변경/접근 실패: 새 plan이 필요합니다.');
    unit.status = 'pending'; delete unit.worker; delete unit.reason;
    return { run, value: unit };
  });
}

export async function runReceipt({ runPath, review }) {
  return withRun(runPath, async run => {
    if (review?.validation?.status !== 'passed' || !Array.isArray(review.fileIds) || !review.fileIds.length) throw new Error('통합·검수한 fileIds와 validation.status=passed가 필요합니다.');
    if (!Array.isArray(review.outputs) || !review.outputs.length) throw new Error('실제 통합한 profile 산출물이 필요합니다.');
    await checkSourcesAndArtifacts(run);
    const processedFiles = [];
    for (const id of new Set(review.fileIds)) {
      const units = run.units.filter(unit => unit.fileId === id && unit.status !== 'superseded');
      if (!units.length || units.some(unit => unit.status !== 'extracted')) throw new Error(`해당 자료의 선택 구간이 모두 추출되지 않았습니다: ${id}`);
      processedFiles.push({ id, sha256: units[0].sourceHash, outcome: 'extracted',
        coverage: units.map(unit => ({ scope: unit.scope, artifact: unit.artifact })) });
    }
    const outputs = [];
    for (const output of review.outputs) {
      const target = typeof output === 'string' ? output : output.path;
      const absolute = await localFile(path.join(run.root, 'profile'), path.resolve(run.root, target));
      outputs.push({ path: path.relative(run.root, absolute).replaceAll('\\', '/'), sha256: await hashFile(absolute) });
    }
    const claimChanges = [];
    for (const change of review.claimChanges ?? []) {
      const evidence = await localFile(path.join(run.root, '.work', 'intake'), path.resolve(run.root, change.evidence));
      claimChanges.push({ ...change, evidence: path.relative(run.root, evidence).replaceAll('\\', '/'), sha256: await hashFile(evidence) });
    }
    const receipt = { schemaVersion: 1, planId: run.plan.planId, status: 'success',
      partial: true, validation: { status: 'passed' }, processedFiles, removedFiles: [], outputs,
      legacyReviewApproved: review.legacyReviewApproved === true, claimChanges };
    return { run, value: receipt };
  });
}
