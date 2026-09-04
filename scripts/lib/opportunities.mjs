import fs from 'node:fs';
import path from 'node:path';

const verificationStates = new Set(['verified', 'needs-review', 'sample']);
const eligibilityStates = new Set(['eligible', 'ineligible', 'needs-review']);
const fitLevels = new Set(['high', 'medium', 'low', 'unrated']);
const fitDecisions = new Set(['proceed', 'caution', 'reconsider', 'unrated']);
const applicationStates = new Set(['discovered', 'analyzing', 'writing', 'review', 'ready', 'submitted', 'closed']);

const isDate = (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value) => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const isDateTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

export function readRegistry(filePath) {
  const absolute = path.resolve(filePath);
  return { absolute, value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
}

export function validateRegistry(registry) {
  const errors = [];
  if (registry?.version !== 1) errors.push('version은 1이어야 합니다.');
  if (!isDateTime(registry?.updatedAt)) errors.push('updatedAt은 ISO 날짜·시간이어야 합니다.');
  if (!Array.isArray(registry?.opportunities)) return [...errors, 'opportunities는 배열이어야 합니다.'];

  const ids = new Set();
  registry.opportunities.forEach((item, index) => {
    const label = `opportunities[${index}]`;
    if (!item || typeof item !== 'object') {
      errors.push(`${label}: 객체가 아닙니다.`);
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]+$/.test(item.id ?? '')) errors.push(`${label}: id 형식 오류`);
    if (ids.has(item.id)) errors.push(`${label}: 중복 id ${item.id}`);
    ids.add(item.id);
    if (!item.company?.trim()) errors.push(`${label}: company 누락`);
    if (!item.role?.trim()) errors.push(`${label}: role 누락`);
    try {
      const url = new URL(item.officialUrl);
      if (url.protocol !== 'https:') errors.push(`${label}: officialUrl은 https여야 합니다.`);
    } catch {
      errors.push(`${label}: officialUrl 형식 오류`);
    }

    if (!isDate(item.deadline?.date)) errors.push(`${label}: deadline.date 형식 오류`);
    if (!isTime(item.deadline?.time)) errors.push(`${label}: deadline.time 형식 오류`);
    if (typeof item.deadline?.timeConfirmed !== 'boolean') errors.push(`${label}: timeConfirmed 누락`);
    if (item.deadline?.timeConfirmed && !item.deadline?.time) errors.push(`${label}: 확인된 시간 값 누락`);

    if (!verificationStates.has(item.verification?.status)) errors.push(`${label}: verification.status 오류`);
    if (!isDateTime(item.verification?.checkedAt)) errors.push(`${label}: verification.checkedAt 오류`);
    if (!item.verification?.evidence?.trim()) errors.push(`${label}: verification.evidence 누락`);
    if (item.verification?.status === 'verified' && /example\.com/i.test(item.officialUrl ?? '')) {
      errors.push(`${label}: 예시 URL을 verified로 표시할 수 없습니다.`);
    }

    if (!eligibilityStates.has(item.eligibility?.status)) errors.push(`${label}: eligibility.status 오류`);
    if (!item.eligibility?.reason?.trim()) errors.push(`${label}: eligibility.reason 누락`);
    if (!fitLevels.has(item.fit?.level)) errors.push(`${label}: fit.level 오류`);
    if (!fitDecisions.has(item.fit?.decision)) errors.push(`${label}: fit.decision 오류`);
    if (!item.fit?.rationale?.trim()) errors.push(`${label}: fit.rationale 누락`);
    if (!applicationStates.has(item.application?.status)) errors.push(`${label}: application.status 오류`);
    if (item.application?.status === 'submitted' && !isDateTime(item.application?.submissionConfirmedAt)) {
      errors.push(`${label}: submitted 상태에는 사용자 확인 시각 submissionConfirmedAt이 필요합니다.`);
    }
  });

  return errors;
}
