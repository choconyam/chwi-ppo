import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { commitIntakePlan, createIntakePlan, DEFAULT_MANIFEST } from '../lib/intake.mjs';

const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
const execFile = promisify(execFileCallback);
const cliPath = path.resolve(import.meta.dirname, '..', 'intake-plan.mjs');

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function addProfileOutputs(root) {
  await write(root, 'profile/PROFILE.md', '# 프로필\n');
  await write(root, 'profile/experiences/work.md', '# 경험\n### WORK-001\n- 사실: 원자료를 검토했다.\n- 근거: raw의 문서\n- 상태: 확인 필요\n');
}

function receiptFor(plan, overrides = {}) {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    status: 'success',
    validation: { status: 'passed' },
    outputs: ['profile/PROFILE.md', 'profile/experiences/work.md'],
    processedFiles: plan.execution.receiptFileIds.map((id) => {
      const file = plan.files.find((item) => item.id === id);
      return { id, sha256: file.sha256, outcome: file.extraction === 'summary' ? 'extracted' : 'deferred' };
    }),
    removedFiles: plan.execution.removedFileIds.map((id) => {
      const file = plan.files.find((item) => item.id === id);
      return { id, sha256: file.previousSha256 };
    }),
    ...overrides,
  };
}

async function createWorkspace(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const source = path.join(root, 'raw');
  await fs.mkdir(source, { recursive: true });
  return { root, source };
}

async function baseline(root, source) {
  const plan = await createIntakePlan({ root, sources: [source] });
  assert.equal(plan.mode, 'initial');
  assert.equal(await fs.stat(path.join(root, 'state')).catch(() => null), null, 'plan만으로 state를 만들면 안 됨');
  await addProfileOutputs(root);
  await commitIntakePlan({ root, plan, receipt: receiptFor(plan) });
  return plan;
}

const temporaryRoots = [];
try {
  {
    const { root, source } = await createWorkspace('intake-unchanged-');
    temporaryRoots.push(root);
    await write(root, 'raw/resume.md', 'same content');
    await baseline(root, source);
    const unchanged = await createIntakePlan({ root });
    assert.equal(unchanged.summary.files.unchanged, 1);
    assert.equal(unchanged.modelCalls, 0);
    assert.deepEqual(unchanged.sourcePaths, [source], 'manifest의 외부 source path를 재사용해야 함');
  }

  {
    const { root, source } = await createWorkspace('intake-changed-');
    temporaryRoots.push(root);
    const target = await write(root, 'raw/note.txt', 'AAAA');
    await baseline(root, source);
    await fs.writeFile(target, 'BBBB'); // 같은 크기 변경도 content hash로 잡아야 한다.
    const changed = await createIntakePlan({ root, sources: [source] });
    assert.equal(changed.summary.files.changed, 1);
    assert.notEqual(changed.files[0].sha256, changed.files[0].previousSha256);
  }

  {
    const { root, source } = await createWorkspace('intake-removed-');
    temporaryRoots.push(root);
    const target = await write(root, 'raw/old.md', 'remove me');
    await baseline(root, source);
    await fs.unlink(target);
    const removed = await createIntakePlan({ root, sources: [source] });
    assert.equal(removed.summary.files.removed, 1);
    assert.equal(removed.files.find((item) => item.status === 'removed').previousSha256, digest('remove me'));
    assert.match(await fs.readFile(path.join(root, 'profile/experiences/work.md'), 'utf8'), /WORK-001/, '기존 사실을 자동 삭제하면 안 됨');
  }

  {
    const { root, source } = await createWorkspace('intake-missing-');
    temporaryRoots.push(root);
    await write(root, 'raw/source.md', 'external');
    await baseline(root, source);
    await fs.rm(source, { recursive: true });
    const missing = await createIntakePlan({ root });
    assert.equal(missing.summary.files.removed, 0, 'source 자체 소실은 파일 삭제로 오인하면 안 됨');
    assert.equal(missing.canCommit, false);
    assert(missing.errors.some((error) => error.type === 'missing-source'));
  }

  {
    const { root, source } = await createWorkspace('intake-stale-');
    temporaryRoots.push(root);
    const target = await write(root, 'raw/resume.md', 'before');
    const plan = await createIntakePlan({ root, sources: [source] });
    await addProfileOutputs(root);
    const receipt = receiptFor(plan);
    await fs.writeFile(target, 'after');
    await assert.rejects(() => commitIntakePlan({ root, plan, receipt }), /source가 변경/);
    await assert.rejects(() => fs.stat(path.join(root, DEFAULT_MANIFEST)), /ENOENT/);
  }

  {
    const { root, source } = await createWorkspace('intake-safe-');
    temporaryRoots.push(root);
    await write(root, 'raw/README.md', '# project');
    await write(root, 'raw/package.json', '{}');
    await write(root, 'raw/src/app.js', 'console.log(1);');
    await write(root, 'raw/reports/run-001.md', 'long experimental report');
    await write(root, 'raw/operation_log.md', 'long historical log');
    await write(root, 'raw/.claude/agents/example.md', 'agent instructions, not personal evidence');
    await write(root, 'raw/node_modules/pkg/index.js', 'do not scan');
    await write(root, 'raw/build/output.txt', 'do not scan');
    await write(root, 'profile/PROFILE.md', '# existing');
    await write(root, 'profile/experiences/old.md', '# old');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-outside-'));
    temporaryRoots.push(outside);
    await write(outside, 'secret.md', 'outside');
    let symlinkCreated = false;
    try {
      await fs.symlink(outside, path.join(source, 'outside-link'), 'junction');
      symlinkCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
    }
    const plan = await createIntakePlan({ root, sources: [source] });
    assert.equal(plan.mode, 'legacy-review');
    assert.equal(plan.execution.automaticExtractionAllowed, false);
    assert(plan.files.some((file) => file.displayPath.endsWith('README.md') && file.extraction === 'summary'));
    assert(plan.files.some((file) => file.displayPath.endsWith('src/app.js') && file.extraction === 'drill-down'));
    assert(plan.files.some((file) => file.displayPath.endsWith('run-001.md') && file.extraction === 'drill-down'));
    assert(plan.files.some((file) => file.displayPath.endsWith('operation_log.md') && file.extraction === 'drill-down'));
    assert(!plan.files.some(file => file.path.includes(`${path.sep}.claude${path.sep}`)));
    assert(!plan.files.some((file) => /node_modules|build|secret\.md/.test(file.path)));
    if (symlinkCreated) {
      const rejectedLinkSource = await createIntakePlan({ root, sources: [path.join(source, 'outside-link')] });
      assert.equal(rejectedLinkSource.canCommit, false);
      assert(rejectedLinkSource.errors.some((error) => error.type === 'symlink-source-rejected'));
    }
    await assert.rejects(
      () => commitIntakePlan({ root, plan, receipt: receiptFor(plan) }),
      /legacyReviewApproved/,
    );
    const excluded = await createIntakePlan({ root, sources: [path.join(root, 'profile', 'PROFILE.md')] });
    assert.equal(excluded.canCommit, false);
    assert(excluded.errors.some((error) => error.type === 'excluded-source'));
  }

  {
    const { root, source } = await createWorkspace('intake-output-missing-');
    temporaryRoots.push(root);
    await write(root, 'raw/resume.md', 'data');
    const plan = await createIntakePlan({ root, sources: [source] });
    const receipt = receiptFor(plan);
    await assert.rejects(() => commitIntakePlan({ root, plan, receipt }), /산출물이 없습니다/);
  }

  {
    const { root, source } = await createWorkspace('intake-cli-');
    temporaryRoots.push(root);
    await write(root, 'raw/career.md', '경력 원문');
    const planPath = path.join(root, '.work', 'first.json');
    const first = await execFile(process.execPath, [cliPath, 'plan', '--root', root, '--source', source, '--out', planPath]);
    assert.match(first.stdout, /intake 계획 생성/);
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(await fs.readFile(planPath.replace(/\.json$/, '.md'), 'utf8').then((value) => value.includes('파일·용량 요약')), true);
    await addProfileOutputs(root);
    const receiptPath = path.join(root, '.work', 'receipt.json');
    await fs.writeFile(receiptPath, `${JSON.stringify(receiptFor(plan), null, 2)}\n`);
    const committed = await execFile(process.execPath, [cliPath, 'commit', '--root', root, '--plan', planPath, '--receipt', receiptPath]);
    assert.match(committed.stdout, /manifest 반영/);
    const secondPath = path.join(root, '.work', 'second.json');
    await execFile(process.execPath, [cliPath, 'plan', '--root', root, '--out', secondPath]);
    const second = JSON.parse(await fs.readFile(secondPath, 'utf8'));
    assert.equal(second.modelCalls, 0);
    assert.equal(second.summary.files.unchanged, 1);
  }

  console.log('intake 증분 계획 검증 통과');
} finally {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
