import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readClaims, readExperiences } from './lib/profile.mjs';
import { checkedMap, mapMarker } from './lib/jd-map.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
function localPath(root, relative) {
  assert(typeof relative === 'string' && relative, '파일 경로가 필요합니다.');
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  assert(rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel), '파일은 작업공간 내부여야 합니다.');
  return file;
}

export function buildPacket(root, request) {
  assert(request.version === 1, '요청 version은 1이어야 합니다.');
  assert(request.official?.status === 'verified' && /^https:\/\//.test(request.official.url ?? ''), '공식 JD 확인이 필요합니다.');
  assert(Number.isFinite(Date.parse(request.official.checkedAt)), '공식 확인 시각이 필요합니다.');
  assert(request.eligibility?.status === 'eligible', '지원 자격 확인 또는 충족이 필요합니다.');
  assert(['proceed', 'caution'].includes(request.fit?.decision), '직무 선택 또는 적합성 재검토가 필요합니다.');
  const documents = ['jd', 'analysis', 'fit'].map(key => {
    const relative = request.documents?.[key];
    const content = fs.readFileSync(localPath(root, relative), 'utf8');
    assert(content.trim(), `${key} 문서가 비어 있습니다.`);
    return { key, file: relative, content, hash: digest(content) };
  });
  const claims = readClaims(root);
  assert(!request.matchingState || documents.find(d => d.key === 'analysis').content.includes(mapMarker), 'matchingState가 있으면 JD 매칭 형식 표시를 유지해야 합니다.');
  const matching = documents.find(d => d.key === 'analysis').content.includes(mapMarker)
    ? checkedMap(root, request.documents, request.matchingState, claims) : null;
  assert(Array.isArray(request.questions) && request.questions.length, '공식 문항이 필요합니다.');
  const ids = new Set();
  const questions = [];
  const blockedQuestions = [];
  for (const question of request.questions) {
    assert(/^[a-zA-Z0-9_-]+$/.test(question.id ?? '') && !ids.has(question.id), '문항 ID가 없거나 중복됩니다.');
    ids.add(question.id);
    try {
    assert(question.prompt?.trim() && question.source?.trim(), `${question.id}: 문항 원문·확인 위치가 필요합니다.`);
    assert(Number.isInteger(question.limit) && question.limit > 0, `${question.id}: 글자수 제한 확인 필요`);
    assert(Array.isArray(question.claimIds) && question.claimIds.length, `${question.id}: 소재 갭 — 필요한 경험만 intake 갱신`);
    const selected = [...new Set(question.claimIds)].map(id => {
      const claim = claims.get(id);
      assert(claim?.status === '검증됨', `${question.id}: ${id}는 검증된 claim이 아닙니다.`);
      return claim;
    });
    // Full source hashes and line numbers remain in the packet for provenance, not reuse decisions.
    const relevantClaims = selected.map(({ sourceHash, line, ...claim }) => claim);
    let relevantDocuments = documents.map(d => d.hash);
    if (matching) {
      assert(Array.isArray(question.requirementIds), `${question.id}: requirementIds가 필요합니다.`);
      assert(new Set(question.requirementIds).size === question.requirementIds.length, `${question.id}: 중복 요구 ID`);
      assert(question.requirementIds.length || question.requirementNote?.trim(), `${question.id}: 직무 요구를 배정하지 않는 이유가 필요합니다.`);
      const requirements = question.requirementIds.map(id => {
        const entry = matching.entries.find(e => e.id === id);
        assert(entry, `${question.id}: 알 수 없는 요구 ID ${id}`);
        assert(entry.claimIds.some(claimId => question.claimIds.includes(claimId)), `${question.id}: ${id}에 연결된 근거 claim을 배정하세요.`);
        return entry.hash;
      });
      relevantDocuments = [matching.jdHash, matching.contextHash, ...requirements];
    }
    const inputHash = digest(JSON.stringify({ question, claims: relevantClaims, documents: relevantDocuments,
      official: { status: request.official.status, url: request.official.url }, eligibility: request.eligibility, fit: request.fit, format: request.format ?? '' }));
      questions.push({ ...question, claims: selected, inputHash });
    } catch (error) {
      blockedQuestions.push({ id: question.id, action: 'blocked', reason: error.message });
    }
  }
  assert(questions.length, blockedQuestions.map(q => q.reason).join('\n'));
  return { version: 1, documents, questions, blockedQuestions, ...(matching ? { matching } : {}) };
}

export function validateDraft(content, question) {
  const blocks = [...content.matchAll(/```text\r?\n([\s\S]*?)```/g)];
  assert(blocks.length === 1, '제출 본문 text 블록은 하나여야 합니다.');
  const body = blocks[0][1].replaceAll('\r\n', '\n').trimEnd();
  assert(body.length && body.length <= question.limit, `글자수 오류: ${body.length}/${question.limit}`);
  assert(!/\[확인 필요|TODO|TBD|<회사명>|<직무명>/.test(body), '본문에 미완성 항목이 있습니다.');
  const tracking = content.replace(blocks[0][0], '');
  const allReferences = [...new Set(tracking.match(/\b[A-Z][A-Z0-9-]*-\d{3,}\b/g) ?? [])];
  const references = allReferences.filter(id => !question.requirementIds || !/^JD-\d+$/.test(id));
  if (question.requirementIds) assert(allReferences.filter(id => /^JD-\d+$/.test(id)).every(id => question.requirementIds.includes(id)), '배정되지 않은 요구 ID가 인용되었습니다.');
  assert(references.length, '본문 아래에 claim 추적표가 필요합니다.');
  assert(references.every(id => question.claimIds.includes(id)), '배정되지 않은 claim이 인용되었습니다.');
  return { characters: body.length, references };
}

function checkedDraft(root, question, checkpoint) {
  if (checkpoint?.status !== 'checked' || checkpoint.inputHash !== question.inputHash) return null;
  try {
    const draft = fs.readFileSync(localPath(root, checkpoint.file), 'utf8');
    validateDraft(draft, question);
    return digest(draft) === checkpoint.draftHash ? checkpoint : null;
  } catch { return null; }
}

function refreshedDraft(root, question, checkpoint) {
  if (checkpoint?.status !== 'checked' || checkpoint.inputHash !== question.inputHash) return null;
  try {
    const draft = fs.readFileSync(localPath(root, checkpoint.file), 'utf8');
    const result = validateDraft(draft, question);
    return { status: 'checked', inputHash: question.inputHash, file: checkpoint.file, draftHash: digest(draft),
      characters: result.characters, references: result.references };
  } catch { return null; }
}

function previousDraftPath(root, cached) {
  const relative = cached?.draftCheckpoint?.file ?? cached?.finalReview?.draft ?? cached?.factReview?.draft ?? cached?.review?.draft;
  if (!relative) return null;
  try { return fs.existsSync(localPath(root, relative)) ? relative : null; } catch { return null; }
}

function checkedReview(root, question, review, stage) {
  if (review?.status !== 'PASS' || review.stage !== stage || review.inputHash !== question.inputHash) return null;
  try {
    const draft = fs.readFileSync(localPath(root, review.draft), 'utf8');
    const report = fs.readFileSync(localPath(root, review.report), 'utf8');
    validateDraft(draft, question);
    return digest(draft) === review.draftHash && digest(report) === review.reportHash ? review : null;
  } catch { return null; }
}

function checkedReviewForDraft(root, question, review, stage, draftHash) {
  if (review?.status !== 'PASS' || review.stage !== stage || review.inputHash !== question.inputHash
    || review.draftHash !== draftHash) return null;
  try {
    const report = fs.readFileSync(localPath(root, review.report), 'utf8');
    return digest(report) === review.reportHash ? review : null;
  } catch { return null; }
}

function legacyFactReview(root, question, cached) {
  const review = cached?.review;
  if (cached?.inputHash !== question.inputHash || review?.status !== 'PASS') return null;
  return checkedReview(root, question, {
    ...review,
    stage: 'fact',
    inputHash: question.inputHash,
  }, 'fact');
}

function currentPacketQuestion(root, packet, questionId) {
  const question = packet.questions.find(q => q.id === questionId);
  assert(question, '해당 문항이 없습니다.');
  const current = buildPacket(root, json(localPath(root, packet.requestFile))).questions.find(q => q.id === questionId);
  assert(current?.inputHash === question.inputHash, '입력 근거가 변경되었습니다. prepare를 다시 실행하세요.');
  return question;
}

export function prepare(root, requestFile, outputFile, previousFile) {
  const request = json(requestFile);
  const packet = buildPacket(root, request);
  const previous = previousFile && fs.existsSync(previousFile) ? json(previousFile) : null;
  packet.requestFile = path.relative(root, requestFile).replaceAll('\\', '/');
  for (const question of packet.questions) {
    const cached = previous?.questions?.find(q => q.id === question.id);
    const finalReview = cached?.inputHash === question.inputHash && checkedReview(root, question, cached.finalReview, 'final');
    const factReview = cached?.inputHash === question.inputHash
      && (checkedReview(root, question, cached.factReview, 'fact') ?? legacyFactReview(root, question, cached));
    const checkpointSource = cached?.draftCheckpoint ?? (cached?.finalReview && { status: 'checked', inputHash: cached.inputHash,
      file: cached.finalReview.draft, draftHash: cached.finalReview.draftHash }) ?? (cached?.factReview && { status: 'checked', inputHash: cached.inputHash,
      file: cached.factReview.draft, draftHash: cached.factReview.draftHash }) ?? (cached?.review && { status: 'checked', inputHash: cached.inputHash,
      file: cached.review.draft, draftHash: cached.review.draftHash });
    const checkpoint = cached?.inputHash === question.inputHash && (refreshedDraft(root, question, checkpointSource)
      ?? (finalReview && checkedDraft(root, question, { status: 'checked', inputHash: question.inputHash, file: finalReview.draft, draftHash: finalReview.draftHash }))
      ?? (factReview && checkedDraft(root, question, { status: 'checked', inputHash: question.inputHash, file: factReview.draft, draftHash: factReview.draftHash })));
    if (finalReview && checkpoint) {
      question.action = 'reuse-final';
      question.state = 'final-reviewed';
      question.draftCheckpoint = checkpoint;
      question.finalReview = finalReview;
      if (factReview) question.factReview = factReview;
    } else if (checkpoint) {
      question.action = 'reuse-draft';
      question.state = factReview ? 'fact-reviewed-draft' : 'draft';
      question.draftCheckpoint = checkpoint;
      if (factReview) question.factReview = factReview;
    } else {
      question.action = 'draft';
      question.state = 'needs-draft';
      const previousDraft = previousDraftPath(root, cached);
      if (previousDraft) question.previousDraft = previousDraft;
    }
  }
  write(outputFile, `${JSON.stringify(packet, null, 2)}\n`);
  const selectedClaims = new Map();
  for (const question of packet.questions) for (const claim of question.claims) selectedClaims.set(claim.id, claim);
  const cautionsByFile = new Map();
  for (const claim of selectedClaims.values()) {
    if (claim.cautions?.trim()) cautionsByFile.set(claim.file, claim.cautions.trim());
  }
  const analysis = packet.documents.find(doc => doc.key === 'analysis');
  const usedRequirements = new Set(packet.questions.flatMap(q => q.requirementIds ?? []));
  const analysisText = packet.matching
    ? [packet.matching.analysisContext, packet.matching.fitContext, ...packet.matching.entries.filter(e => usedRequirements.has(e.id))
      .map(e => `### ${e.id}\n${e.requirement}\n\n${e.mapping}`)].join('\n\n') : analysis?.content;
  const documentLabels = { jd: '공식 JD', analysis: '직무 분석', fit: '적합도 판단' };
  const markdown = ['# 지원서 작성 입력', '', '배정된 검증 사실의 공통 사전과 문항별 claim-id 매핑입니다. 전체 원문은 필요할 때 아래 경로에서 직접 엽니다.', '',
    '## 입력 문서', '', ...packet.documents.map(doc => `- ${documentLabels[doc.key] ?? doc.key}: ${doc.file}`), '',
    ...(analysisText ? ['## 작성에 필요한 직무 분석·경험 연결', '', analysisText.trim(), ''] : []),
    ...(packet.blockedQuestions.length ? ['## 보류 문항', '', ...packet.blockedQuestions.map(q => `- ${q.id}: ${q.reason}`), ''] : []),
    '## 공통 verified claim 사전', '',
    ...[...selectedClaims.values()].flatMap(c => [`### ${c.id}`, `- 사실: ${c.fact}`,
      ...(c.contribution ? [`- 본인 기여: ${c.contribution}`] : []),
      ...(c.method ? [`- 방법·도구: ${c.method}`] : []),
      ...(c.outcome ? [`- 결과·상태: ${c.outcome}`] : []),
      `- 근거: ${c.evidence}`, `- 정본: ${c.file}:${c.line}`, '']),
    ...(cautionsByFile.size ? ['## 경험별 표현 제한', '', ...[...cautionsByFile].flatMap(([file, cautions]) => [`### ${file}`, cautions, ''])] : []),
    ...packet.questions.flatMap(q => [`## ${q.id}: ${{ 'reuse-final': '최종 검수 PASS 본문 재사용', 'reuse-draft': '검수 전 초안 재사용', draft: '초안 작성·수정 필요' }[q.action]}`, '',
      `- 문항: ${q.prompt}`, `- 원문 위치: ${q.source}`, `- 제한: ${q.limit}자`, `- 입력 해시: ${q.inputHash}`,
      `- 배정 claim-id: ${q.claims.map(c => c.id).join(', ')}`, '',
      ...(q.requirementIds ? [`- 배정 요구 ID: ${q.requirementIds.join(', ') || '없음'}`, ...(q.requirementNote ? [`- 요구 배정 메모: ${q.requirementNote}`] : []), ''] : []),
      ...(q.draftCheckpoint?.file ? [`- 현재 초안: ${q.draftCheckpoint.file}`, ''] : []),
      ...(q.previousDraft ? [`- 기존 초안 참고: ${q.previousDraft} (현재 입력 기준 재검토 필요)`, ''] : []),
      ...(q.instructions ? [`- 작성 요청: ${q.instructions}`, ''] : [])])].join('\n');
  write(outputFile.replace(/\.json$/, '') + '.md', markdown);
  return packet;
}

export function checkpointDraft(root, packetFile, questionId, draftRelative) {
  const packet = json(packetFile);
  const question = currentPacketQuestion(root, packet, questionId);
  const draft = fs.readFileSync(localPath(root, draftRelative), 'utf8');
  const result = validateDraft(draft, question);
  const draftHash = digest(draft);
  const finalReview = checkedReviewForDraft(root, question, question.finalReview, 'final', draftHash);
  const legacyFact = question.review?.status === 'PASS' ? {
    ...question.review,
    stage: 'fact',
    inputHash: question.inputHash,
  } : null;
  const factReview = checkedReviewForDraft(root, question, question.factReview ?? legacyFact, 'fact', draftHash);
  question.draftCheckpoint = { status: 'checked', inputHash: question.inputHash, file: draftRelative, draftHash,
    characters: result.characters, references: result.references };
  delete question.factReview;
  delete question.finalReview;
  delete question.review;
  if (factReview) question.factReview = { ...factReview, draft: draftRelative };
  if (finalReview) {
    question.finalReview = { ...finalReview, draft: draftRelative };
    question.state = 'final-reviewed';
    question.action = 'reuse-final';
  } else {
    question.state = factReview ? 'fact-reviewed-draft' : 'draft';
    question.action = 'reuse-draft';
  }
  write(packetFile, `${JSON.stringify(packet, null, 2)}\n`);
  return question;
}

export function recordReview(root, packetFile, questionId, draftRelative, reportRelative, stage = 'fact') {
  assert(['fact', 'final'].includes(stage), '검수 단계는 fact 또는 final이어야 합니다.');
  const packet = json(packetFile);
  const question = currentPacketQuestion(root, packet, questionId);
  const draft = fs.readFileSync(localPath(root, draftRelative), 'utf8');
  const report = fs.readFileSync(localPath(root, reportRelative), 'utf8');
  const result = validateDraft(draft, question);
  const draftHash = digest(draft);
  const field = name => report.match(new RegExp(`^- ${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  assert(field('판정') === 'PASS', '검수가 PASS가 아닙니다.');
  assert(stage === 'fact' ? !field('검수 단계') || field('검수 단계') === 'fact' : field('검수 단계') === 'final',
    `검수 보고서의 단계가 ${stage}과 일치하지 않습니다.`);
  assert(field('입력 해시') === question.inputHash && field('본문 해시') === draftHash, '검수가 현재 입력·본문과 일치하지 않습니다.');
  question.draftCheckpoint = { status: 'checked', inputHash: question.inputHash, file: draftRelative, draftHash,
    characters: result.characters, references: result.references };
  const review = { stage, status: 'PASS', inputHash: question.inputHash, draft: draftRelative, report: reportRelative,
    draftHash, reportHash: digest(report) };
  delete question.review;
  if (stage === 'final') {
    question.finalReview = review;
    question.state = 'final-reviewed';
    question.action = 'reuse-final';
  } else {
    question.factReview = review;
    delete question.finalReview;
    question.state = 'fact-reviewed-draft';
    question.action = 'reuse-draft';
  }
  write(packetFile, `${JSON.stringify(packet, null, 2)}\n`);
  return question;
}

const summarize = (value, max = 60) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export function catalog(root, options = {}) {
  const all = [...readClaims(root).values()].filter(c => c.status === '검증됨');
  const experiences = readExperiences(root);
  assert(!options.mode || ['index', 'claims'].includes(options.mode), 'catalog mode는 index 또는 claims입니다.');
  const files = options.files?.split(',').map(s => s.trim());
  // 띄어 쓴 단어는 모두 포함돼야 일치로 본다. 한 단어 질의의 결과는 이전과 같다.
  const terms = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = text => terms.every(term => text.includes(term));
  const own = claim => [claim.id, claim.fact, claim.file, claim.type, claim.contribution, claim.method, claim.outcome]
    .filter(Boolean).join(' ').toLowerCase();
  // 사실 문장에 없는 도구·방법·산출물도 경험 문맥에서 찾되, claim 자체의 일치와 구분해 보여 준다.
  const context = claim => [experiences.get(claim.file)?.title, experiences.get(claim.file)?.type,
    experiences.get(claim.file)?.searchText].filter(Boolean).join(' ').toLowerCase();
  const inScope = all.filter(c => !files || files.includes(c.file));
  const direct = inScope.filter(c => matches(own(c)));
  const contextual = inScope.filter(c => !direct.includes(c) && matches(`${own(c)} ${context(c)}`));
  const selected = [...direct, ...contextual];
  const rows = options.mode === 'index'
    ? [...new Set(selected.map(c => c.file))].map(file => {
      const meta = experiences.get(file);
      const detail = [meta?.type && `유형 ${meta.type}`, meta?.role && `역할 ${summarize(meta.role)}`,
        `검증 claim ${selected.filter(c => c.file === file).length}개`].filter(Boolean);
      return `- ${file}: ${meta?.title || file} (${detail.join(' / ')})`;
    }) : selected.map(c => [`- ${c.id}`, c.type ? ` [${c.type}]` : '', `: ${c.fact}`,
      c.method ? ` / 방법·도구: ${c.method}` : '', c.outcome ? ` / 결과·상태: ${c.outcome}` : '',
      ` (${c.file}:${c.line})`, contextual.includes(c) ? ' [경험 문맥 일치: claim 자체에는 검색어 없음]' : ''].join(''));
  // 검증 claim이 없는 경험은 목록에 나오지 않는다. 없는 경험으로 오해하지 않게 따로 알린다.
  const verifiedFiles = new Set(all.map(c => c.file));
  const hidden = [...experiences.keys()].filter(file => file !== 'profile/PROFILE.md' && !verifiedFiles.has(file)
    && (!files || files.includes(file)));
  const offset = Number(options.offset ?? 0);
  const limit = Number(options.limit ?? rows.length);
  assert(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 0, 'offset/limit은 0 이상의 정수입니다.');
  const shown = rows.slice(offset, offset + limit);
  return ['# 검증된 경험 요약', '', `- 전체 검증 claim: ${all.length}개 / 조건에 맞는 claim: ${selected.length}개`,
    `- 표시: ${shown.length}/${rows.length}행 / offset: ${offset} / 다음 offset: ${offset + shown.length < rows.length ? offset + shown.length : '없음'}`,
    '- 범위 주의: 필터·페이지 밖의 경험은 미검토입니다. 검색 결과 없음은 경험 부재의 증명이 아닙니다.',
    ...(terms.length ? [`- 일치 구분: claim 직접 일치 ${direct.length}개 / 경험 문맥 일치 ${contextual.length}개 (문맥 일치는 해당 claim이 검색어를 뒷받침한다는 뜻이 아닙니다)`] : []),
    ...(hidden.length ? [`- 검증 claim이 없어 목록에 없는 경험: ${hidden.join(', ')} (확인 필요·사용 금지 claim만 있음)`] : []),
    '', ...shown].join('\n') + '\n';
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i]?.startsWith('--') && args[i + 1], '옵션에는 값이 필요합니다.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const root = path.resolve(options.root ?? path.join(import.meta.dirname, '..'));
  if (command === 'catalog') {
    write(localPath(root, options.out), catalog(root, options));
    console.log('검증된 경험 목록을 저장했습니다. 표시 범위·미검토 범위를 출력 파일에서 확인하세요.');
  } else if (command === 'prepare') {
    const packet = prepare(root, localPath(root, options.request), localPath(root, options.out), options.previous && localPath(root, options.previous));
    console.log(`진행 문항 ${packet.questions.length}개: 최종 PASS 재사용 ${packet.questions.filter(q => q.action === 'reuse-final').length}, 검수 전 초안 재사용 ${packet.questions.filter(q => q.action === 'reuse-draft').length}, 초안 작성 ${packet.questions.filter(q => q.action === 'draft').length}, 보류 ${packet.blockedQuestions.length}`);
  } else if (command === 'checkpoint') {
    const question = checkpointDraft(root, localPath(root, options.packet), options.question, options.draft);
    const status = question.action === 'reuse-final' ? '최종 검수 PASS 유지'
      : question.factReview ? '중간 사실 검수 PASS 유지 (최종 검수 전)' : '검수 전 초안';
    console.log(`초안 체크포인트: ${question.draftCheckpoint.characters}/${question.limit}자, 상태: ${status}`);
  } else if (command === 'record') {
    const stage = options.stage ?? 'fact';
    recordReview(root, localPath(root, options.packet), options.question, options.draft, options.review, stage);
    console.log(stage === 'final' ? '현재 입력·실제 본문에 대한 최종 검수 PASS를 기록했습니다.' : '선택한 중간 사실 검수 PASS를 기록했습니다. 최종 검수는 별도입니다.');
  } else if (command === 'hash') {
    console.log(digest(fs.readFileSync(localPath(root, options.file), 'utf8')));
  } else throw new Error('사용법: apply-packet.mjs catalog | prepare | checkpoint | record | hash (docs/WORKFLOW_RUNTIME.md 참조)');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
