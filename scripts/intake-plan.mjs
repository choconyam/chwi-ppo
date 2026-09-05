#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import {
  commitIntakePlan,
  createIntakePlan,
  defaultPlanOutput,
  loadJson,
  writeIntakePlan,
} from './lib/intake.mjs';

function usage() {
  return `사용법:
  node scripts/intake-plan.mjs plan [--root <workspace>] [--source <file-or-dir> ...] [--out <path>] [--full-inventory]
  node scripts/intake-plan.mjs commit --plan <path> --receipt <path> [--root <workspace>]

receipt 계약:
  { "schemaVersion": 1, "planId": "...", "status": "success",
    "validation": { "status": "passed" },
    "outputs": ["profile/PROFILE.md", "profile/experiences/example.md"],
    "processedFiles": [{ "id": "...", "sha256": "...", "outcome": "extracted|reviewed|deferred" }],
    "removedFiles": [{ "id": "...", "sha256": "<삭제 전 hash>" }],
    "legacyReviewApproved": true }
`;
}

function parseArguments(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help', options: { sources: [] } };
  const command = argv[0];
  if (!['plan', 'commit'].includes(command)) throw new Error(usage());
  const options = { sources: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { command: 'help', options };
    if (flag === '--full-inventory') { options.fullInventory = true; continue; }
    if (!['--root', '--source', '--out', '--plan', '--receipt'].includes(flag)) throw new Error(`알 수 없는 옵션: ${flag}\n\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
    index += 1;
    if (flag === '--source') options.sources.push(value);
    else options[flag.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'help') {
    console.log(usage());
    return;
  }
  const root = path.resolve(options.root ?? process.cwd());
  if (command === 'plan') {
    if (options.plan || options.receipt) throw new Error('plan 명령에는 --plan/--receipt를 사용할 수 없습니다.');
    const plan = await createIntakePlan({ root, sources: options.sources, summaryOnly: !options.fullInventory });
    const output = options.out ? path.resolve(root, options.out) : defaultPlanOutput(root);
    const written = await writeIntakePlan(plan, output);
    console.log(`intake 계획 생성: ${written.jsonPath}`);
    console.log(`사람용 요약: ${written.markdownPath}`);
    console.log(`파일 ${plan.summary.files.total}개, ${plan.summary.bytes.total} bytes, ${plan.modelCalls === null ? '기존 정본 대조 필요' : plan.modelCalls === 0 ? '변경 없음 — 추출 생략' : '변경 목록의 영향 확인 필요'}`);
    if (!plan.canCommit) process.exitCode = 2;
    return;
  }

  if (!options.plan || !options.receipt) throw new Error(`commit에는 --plan과 --receipt가 필요합니다.\n\n${usage()}`);
  if (options.sources.length || options.out) throw new Error('commit 명령에는 --source/--out을 사용할 수 없습니다.');
  const plan = await loadJson(path.resolve(root, options.plan), 'plan');
  const receipt = await loadJson(path.resolve(root, options.receipt), 'receipt');
  const result = await commitIntakePlan({ root, plan, receipt });
  console.log(`intake manifest 반영: ${result.manifestPath}`);
  console.log(`처리 ${result.processed}개, 삭제 검토 ${result.removed}개`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`intake-plan 실패: ${error.message}`);
    process.exitCode = 1;
  });
}

export { main, parseArguments };
