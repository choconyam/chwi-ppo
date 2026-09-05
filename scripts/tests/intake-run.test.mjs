import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIntakePlan, commitIntakePlan, writeIntakePlan, loadJson } from '../lib/intake.mjs';
import { startRun, claimUnit, recordUnit, failUnit, recoverUnit, runStatus, splitUnit, runReceipt } from '../lib/intake-run.mjs';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../intake-run.mjs');
async function write(root, name, content) {
  const absolute = path.join(root, name);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return absolute;
}
async function fixture(t, files = { 'README.md': '# 개인 자료\n- 연구 준비\n' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chwi-intake-resume-'));
  // Only the exact newly allocated test directory is ever removed.
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await write(root, `raw/${name}`, content);
  const plan = await createIntakePlan({ root, sources: [path.join(root, 'raw')], summaryOnly: true });
  const runPath = path.join(root, '.work/intake/first/run.json');
  const planPath = path.join(root, '.work/intake/first/plan.json');
  await writeIntakePlan(plan, planPath);
  await startRun({ plan, runPath });
  return { root, plan, planPath, runPath };
}
async function finish(f, worker = 'main') {
  const unit = await claimUnit({ runPath: f.runPath, worker });
  await fs.writeFile(unit.outputPath, `- 사실: 연구를 준비했다.\n- 출처: ${unit.sourcePath}:${unit.scope}\n- 상태: 확인 필요\n`);
  return recordUnit({ runPath: f.runPath, id: unit.id, worker, lease: unit.lease, factsPath: unit.outputPath });
}

test('100 files: restart in a new process reuses saved work; active worker is not duplicated', async t => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`note-${i}.md`, `자료 ${i}`]));
  const f = await fixture(t, files);
  for (let i = 0; i < 3; i++) await finish(f);
  const { stdout } = await exec(process.execPath, [cli, 'claim', '--run', f.runPath, '--worker', 'agent-survives-controller']);
  const active = JSON.parse(stdout);
  const status = JSON.parse((await exec(process.execPath, [cli, 'status', '--run', f.runPath])).stdout);
  assert.equal(status.total, 100); assert.equal(status.extracted, 3); assert.equal(status.running, 1); assert.equal(status.pending, 96);
  assert.equal((await claimUnit({ runPath: f.runPath, worker: 'agent-survives-controller' })).id, active.id);
  await assert.rejects(recoverUnit({ runPath: f.runPath, id: active.id }), /종료를 확인/);
  await recoverUnit({ runPath: f.runPath, id: active.id, confirmedStopped: true });
  const replacement = await claimUnit({ runPath: f.runPath, worker: 'replacement' });
  assert.equal(replacement.id, active.id);
  await assert.rejects(failUnit({ ...f, id: active.id, worker: 'replacement', lease: active.lease, reason: 'late response' }), /lease/);
  assert.equal((await runStatus(f)).extracted, 3);
});

test('summary inventory skips project code/data hashes, including nested projects', async t => {
  const f = await fixture(t, { 'project/package.json': '{}', 'project/README.md': '# Project', 'project/data.csv': 'x\n'.repeat(100000), 'project/logs/run.md': 'details' });
  assert.equal(f.plan.files.length, 1);
  assert.equal(f.plan.inventory.length, 3);
  assert(f.plan.inventory.every(file => file.sha256 === null));
  assert.equal((await runStatus(f)).unselectedFiles, 3);
});

test('long text split is bounded and binary documents require explicit scopes', async t => {
  const f = await fixture(t, { 'long.md': `${'가'.repeat(1000)}\n`.repeat(35), 'slides.pptx': 'test placeholder, not a real presentation' });
  const run = await loadJson(f.runPath);
  assert(run.units.filter(unit => unit.startLine).every(unit => unit.chars <= 12000));
  assert.equal(run.units.filter(unit => unit.startLine).length, 4);
  assert.equal(run.units.filter(unit => unit.startLine).at(-1).endLine, 36);
  const doc = run.units.find(unit => unit.status === 'needs-scope');
  const children = await splitUnit({ ...f, id: doc.id, scopes: ['slides 1-4', 'slides 5-8'] });
  assert.equal(children.length, 2);
  assert.equal((await runStatus(f)).needsScope, 0);
});

test('failed file is isolated; bounded retries and worker ownership', async t => {
  const f = await fixture(t, { 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' });
  const a = await claimUnit({ ...f, worker: 'a' });
  const b = await claimUnit({ ...f, worker: 'b' });
  await assert.rejects(claimUnit({ ...f, worker: 'c' }), /최대 2/);
  await assert.rejects(failUnit({ ...f, id: a.id, worker: 'b', lease: b.lease, reason: 'failed' }), /worker만/);
  await failUnit({ ...f, id: a.id, worker: 'a', lease: a.lease, reason: 'parser failed' });
  await finish(f, 'c');
  assert.equal((await runStatus(f)).extracted, 1);
  await recoverUnit({ ...f, id: a.id });
  const a2 = await claimUnit({ ...f, worker: 'a2' });
  await failUnit({ ...f, id: a.id, worker: 'a2', lease: a2.lease, reason: 'again' });
  await assert.rejects(recoverUnit({ ...f, id: a.id }), /한도/);
  assert.equal((await runStatus(f)).running, 1); // b stays live, not timed out.
  assert.equal(b.status, 'running');
});

test('changed source and corrupt extraction invalidate only affected unit', async t => {
  const f = await fixture(t, { 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' });
  const a = await finish(f); const b = await finish(f); await finish(f);
  await fs.writeFile(a.sourcePath, 'changed');
  await fs.writeFile(b.artifact.path, 'corrupt');
  const status = await runStatus(f);
  assert.equal(status.extracted, 1); assert.equal(status.blocked, 2);
  const newPlan = await createIntakePlan({ root: f.root, sources: [path.join(f.root, 'raw')], summaryOnly: true });
  const nextPath = path.join(f.root, '.work/intake/next/run.json');
  await startRun({ plan: newPlan, runPath: nextPath, previous: f.runPath });
  const next = await runStatus({ runPath: nextPath });
  assert.equal(next.extracted, 1); assert.equal(next.pending, 1); assert.equal(next.blocked, 1);
});

test('partial receipt does not mark pending files processed or rewrite existing claims', async t => {
  const f = await fixture(t, { 'a.md': 'A', 'b.md': 'B' });
  const a = await finish(f);
  await write(f.root, 'profile/PROFILE.md', '# 프로필');
  const content = '# 경험\n### WORK-001\n- 사실: 원문에 없는 역할은 미확인.\n- 근거: raw/a.md\n- 상태: 확인 필요\n';
  await write(f.root, 'profile/experiences/work.md', content);
  const review = { fileIds: [a.fileId], validation: { status: 'passed' }, outputs: ['profile/PROFILE.md', 'profile/experiences/work.md'] };
  const receipt = await runReceipt({ ...f, review });
  await commitIntakePlan({ root: f.root, plan: f.plan, receipt });
  const next = await createIntakePlan({ root: f.root, sources: [path.join(f.root, 'raw')], summaryOnly: true });
  assert.equal(next.summary.files.unchanged, 1); assert.equal(next.summary.files.new, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'profile/experiences/work.md'), 'utf8'), content);
  const pendingId = f.plan.files.find(file => file.id !== a.fileId).id;
  await assert.rejects(runReceipt({ ...f, review: { ...review, fileIds: [pendingId] } }), /모두 추출/);
  await assert.rejects(commitIntakePlan({ root: f.root, plan: f.plan, receipt }), /manifest가 생겼/);
});

test('partial commit checks selected sources even with another missing source', async t => {
  const f = await fixture(t);
  const plan = await createIntakePlan({ root: f.root, sources: [path.join(f.root, 'raw'), path.join(f.root, 'missing')] });
  assert.equal(plan.canCommit, false);
  const second = path.join(f.root, '.work/intake/partial/run.json');
  await startRun({ plan, runPath: second });
  const unit = await finish({ ...f, runPath: second });
  await write(f.root, 'profile/PROFILE.md', '# 프로필');
  await write(f.root, 'profile/experiences/work.md', '### WORK-001\n- 사실: 사실\n- 근거: 원문\n- 상태: 확인 필요\n');
  const receipt = await runReceipt({ runPath: second, review: { fileIds: [unit.fileId], outputs: ['profile/PROFILE.md', 'profile/experiences/work.md'], validation: { status: 'passed' } } });
  const result = await commitIntakePlan({ root: f.root, plan, receipt });
  assert.equal(result.processed, 1);
  const retry = await createIntakePlan({ root: f.root });
  assert(retry.sourcePaths.includes(path.join(f.root, 'missing')));
  assert(retry.errors.some(error => error.type === 'missing-source'));
});

test('claim deletion/promotion blocked without explicit evidence; normal confirmed correction remains possible', async t => {
  const f = await fixture(t);
  await write(f.root, 'profile/PROFILE.md', '# 프로필');
  const experience = 'profile/experiences/work.md';
  const claim = (id, status) => `### ${id}\n- 사실: 연구 준비\n- 근거: raw/README.md\n- 상태: ${status}\n`;
  await write(f.root, experience, claim('WORK-001', '확인 필요') + claim('WORK-002', '검증됨'));
  const plan = await createIntakePlan({ root: f.root, sources: [path.join(f.root, 'raw')], summaryOnly: true });
  const runPath = path.join(f.root, '.work/intake/correction/run.json');
  await startRun({ plan, runPath });
  const unit = await finish({ ...f, runPath });
  const review = { fileIds: [unit.fileId], validation: { status: 'passed' }, outputs: ['profile/PROFILE.md', experience], legacyReviewApproved: true };
  await write(f.root, experience, claim('WORK-001', '검증됨'));
  let receipt = await runReceipt({ runPath, review });
  await assert.rejects(commitIntakePlan({ root: f.root, plan, receipt }), /상태 승격/);
  await write(f.root, experience, claim('WORK-001', '확인 필요'));
  receipt = await runReceipt({ runPath, review });
  await assert.rejects(commitIntakePlan({ root: f.root, plan, receipt }), /삭제/);
  await write(f.root, experience, claim('WORK-001', '검증됨'));
  const evidence = '.work/intake/correction/confirmation.md';
  await write(f.root, evidence, '사용자 확인 기록: WORK-001 근거 확인. WORK-002는 중복이라 삭제 요청.');
  receipt = await runReceipt({ runPath, review: { ...review, claimChanges: [
    { id: 'WORK-001', action: 'verify', reason: '원문 및 사용자 확인', evidence },
    { id: 'WORK-002', action: 'remove', reason: '사용자의 중복 삭제 요청', evidence },
  ] } });
  assert.equal((await commitIntakePlan({ root: f.root, plan, receipt })).processed, 1);
});

test('saved plans cannot be overwritten by a different run', async t => {
  const f = await fixture(t);
  const next = await createIntakePlan({ root: f.root, sources: f.plan.sourcePaths });
  await assert.rejects(writeIntakePlan(next, f.planPath), /덮어쓸 수 없/);
  assert.equal((await loadJson(f.planPath)).planId, f.plan.planId);
});
