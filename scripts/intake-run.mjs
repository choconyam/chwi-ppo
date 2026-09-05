#!/usr/bin/env node
import path from 'node:path';
import { loadJson, writeJsonAtomic } from './lib/intake.mjs';
import { startRun, runStatus, claimUnit, splitUnit, recordUnit, failUnit, recoverUnit, runReceipt } from './lib/intake-run.mjs';

const HELP = `사용법 (메인 에이전트용):
  node scripts/intake-run.mjs start --plan <plan.json> --run <.work/intake/run/run.json> [--previous <run.json>]
  node scripts/intake-run.mjs status --run <run.json>
  node scripts/intake-run.mjs claim --run <run.json> --worker <worker-id>
  node scripts/intake-run.mjs split --run <run.json> --unit <id> --scopes <범위문자열배열.json>
  node scripts/intake-run.mjs record --run <run.json> --unit <id> --worker <worker-id> --lease <claim의 lease> --facts <staging.md>
  node scripts/intake-run.mjs fail --run <run.json> --unit <id> --worker <worker-id> --lease <claim의 lease> --reason <실패사유>
  node scripts/intake-run.mjs recover --run <run.json> --unit <id> [--confirmed-stopped]
  node scripts/intake-run.mjs receipt --run <run.json> --review <통합검수기록.json> --out <receipt.json>

추출과 사실 검증은 별개입니다. run/사실 결과는 로컬에 보관합니다.
진행 상황은 status, 실제 worker가 종료된 경우에만 recover를 사용하세요.`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ['--help', '-h'].includes(command)) { console.log(HELP); return; }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--confirmed-stopped') { options.confirmedStopped = true; continue; }
    if (!['--run', '--plan', '--previous', '--worker', '--lease', '--unit', '--scopes', '--facts', '--reason', '--review', '--out'].includes(flag)) throw new Error(`알 수 없는 옵션: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
    options[flag.slice(2)] = value;
  }
  if (!options.run) throw new Error('--run이 필요합니다.');
  const required = { start: ['plan'], status: [], claim: ['worker'], split: ['unit', 'scopes'], record: ['unit', 'worker', 'lease', 'facts'], fail: ['unit', 'worker', 'lease', 'reason'], recover: ['unit'], receipt: ['review', 'out'] };
  if (!required[command]) throw new Error(HELP);
  for (const key of required[command]) if (!options[key]) throw new Error(`--${key}가 필요합니다.`);
  const input = { ...options, runPath: path.resolve(options.run), id: options.unit, factsPath: options.facts };
  let result;
  if (command === 'start') result = await startRun({ ...input, plan: await loadJson(options.plan) });
  if (command === 'status') result = await runStatus(input);
  if (command === 'claim') result = await claimUnit(input);
  if (command === 'split') result = await splitUnit({ ...input, scopes: await loadJson(options.scopes) });
  if (command === 'record') result = await recordUnit(input);
  if (command === 'fail') result = await failUnit(input);
  if (command === 'recover') result = await recoverUnit(input);
  if (command === 'receipt') {
    result = await runReceipt({ ...input, review: await loadJson(options.review) });
    if (path.resolve(options.out) === input.runPath) throw new Error('receipt로 run을 덮어쓸 수 없습니다.');
    await writeJsonAtomic(path.resolve(options.out), result);
  }
  if (command === 'start') result = await runStatus(input);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(error => { console.error(`intake-run 실패: ${error.message}`); process.exitCode = 1; });
}
