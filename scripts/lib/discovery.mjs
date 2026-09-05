import { createHash } from 'node:crypto';

export const DISCOVERY_SCHEMA_VERSION = 1;
export const DEFAULT_BATCH_SIZE = 8;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
]);

const KNOWN_CAREER_TYPES = new Set(['new', 'experienced', 'any', 'mixed', 'intern']);
const KNOWN_SIZES = new Set(['large', 'mid', 'small', 'startup', 'public']);

const CAREER_ALIASES = new Map([
  ['new', 'new'],
  ['entry', 'new'],
  ['entry-level', 'new'],
  ['신입', 'new'],
  ['experienced', 'experienced'],
  ['experience', 'experienced'],
  ['career', 'experienced'],
  ['경력', 'experienced'],
  ['any', 'any'],
  ['irrelevant', 'any'],
  ['무관', 'any'],
  ['경력무관', 'any'],
  ['mixed', 'mixed'],
  ['신입/경력', 'mixed'],
  ['신입·경력', 'mixed'],
  ['intern', 'intern'],
  ['internship', 'intern'],
  ['인턴', 'intern'],
]);

const SIZE_ALIASES = new Map([
  ['large', 'large'],
  ['대기업', 'large'],
  ['mid', 'mid'],
  ['medium', 'mid'],
  ['중견기업', 'mid'],
  ['small', 'small'],
  ['중소기업', 'small'],
  ['startup', 'startup'],
  ['스타트업', 'startup'],
  ['public', 'public'],
  ['공기업', 'public'],
]);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value) {
  return cleanText(value).toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ');
}

function normalizeCareerType(value) {
  const normalized = normalizeText(value);
  return CAREER_ALIASES.get(normalized) ?? normalized;
}

function normalizeCareerTypes(value) {
  return [...new Set(asArray(value).map(normalizeCareerType).filter(Boolean))].sort();
}

function expandCareerTypes(types) {
  const expanded = new Set();
  for (const type of types) {
    if (type === 'mixed') {
      expanded.add('new');
      expanded.add('experienced');
    } else if (type === 'any') {
      expanded.add('new');
      expanded.add('experienced');
      expanded.add('intern');
    } else {
      expanded.add(type);
    }
  }
  return expanded;
}

function normalizeSize(value) {
  const normalized = normalizeText(value);
  return SIZE_ALIASES.get(normalized) ?? normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function canonicalizeUrl(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLocaleLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLocaleLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return raw;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}은(는) 객체여야 합니다.`);
  }
}

function validateSnapshot(snapshot) {
  requireObject(snapshot, 'snapshot');
  if (!Array.isArray(snapshot.sources)) throw new Error('snapshot.sources는 배열이어야 합니다.');
  if (snapshot.sources.length === 0) throw new Error('snapshot.sources에는 수집 출처가 하나 이상 필요합니다.');
  if (!Array.isArray(snapshot.postings)) throw new Error('snapshot.postings는 배열이어야 합니다.');

  const sourceIds = new Set();
  for (const [index, source] of snapshot.sources.entries()) {
    requireObject(source, `snapshot.sources[${index}]`);
    const id = cleanText(source.id);
    if (!id) throw new Error(`snapshot.sources[${index}].id가 필요합니다.`);
    if (sourceIds.has(id)) throw new Error(`중복 source id: ${id}`);
    sourceIds.add(id);
    if (!cleanText(source.url)) throw new Error(`${id}: source.url이 필요합니다.`);
    if (!cleanText(source.checkedAt)) throw new Error(`${id}: source.checkedAt이 필요합니다.`);
    if (typeof source.complete !== 'boolean') throw new Error(`${id}: source.complete는 boolean이어야 합니다.`);
    if (!cleanText(source.accessStatus)) throw new Error(`${id}: source.accessStatus가 필요합니다.`);
    if (source.complete && !Number.isFinite(source.expectedPages) && !Number.isFinite(source.expectedCount)) {
      throw new Error(`${id}: complete=true이면 expectedPages 또는 expectedCount가 필요합니다.`);
    }
  }

  for (const [index, posting] of snapshot.postings.entries()) {
    requireObject(posting, `snapshot.postings[${index}]`);
    if (!sourceIds.has(cleanText(posting.sourceId))) {
      throw new Error(`snapshot.postings[${index}]: 알 수 없는 sourceId ${posting.sourceId ?? ''}`);
    }
    if (!cleanText(posting.sourceRowId) && !cleanText(posting.url)) {
      throw new Error(`snapshot.postings[${index}]: sourceRowId 또는 url이 필요합니다.`);
    }
    if (!cleanText(posting.company)) throw new Error(`snapshot.postings[${index}].company가 필요합니다.`);
    if (!cleanText(posting.title)) throw new Error(`snapshot.postings[${index}].title이 필요합니다.`);
    if (posting.roles !== undefined && !Array.isArray(posting.roles)) {
      throw new Error(`snapshot.postings[${index}].roles는 배열이어야 합니다.`);
    }
    for (const [roleIndex, role] of (posting.roles ?? []).entries()) {
      requireObject(role, `snapshot.postings[${index}].roles[${roleIndex}]`);
      if (!cleanText(role.id) && !cleanText(role.title) && !cleanText(role.url)) {
        throw new Error(`snapshot.postings[${index}].roles[${roleIndex}]: id, title, url 중 하나가 필요합니다.`);
      }
    }
  }
}

function normalizeCriteria(criteria) {
  requireObject(criteria, 'criteria');
  const careerTypes = normalizeCareerTypes(criteria.careerTypes);
  const experienceMonths = Number.isFinite(criteria.experienceMonths)
    ? Number(criteria.experienceMonths)
    : null;
  if (experienceMonths !== null && experienceMonths < 0) {
    throw new Error('criteria.experienceMonths는 0 이상이어야 합니다.');
  }
  const sizes = [...new Set(asArray(criteria.sizes).map(normalizeSize).filter(Boolean))].sort();
  const keywords = [...new Set(asArray(criteria.keywords).map(normalizeText).filter(Boolean))].sort();
  return {
    careerTypes,
    experienceMonths,
    experienceMonthsBasis: experienceMonths === null
      ? null
      : criteria.experienceMonthsBasis === 'verified-relevant'
        ? 'verified-relevant'
        : 'unspecified',
    experienceMonthsMeaning: 'verified-relevant일 때만 검증된 관련 경력의 개월 수로 hard constraint에 사용',
    sizes,
    keywords,
    regions: [...new Set(asArray(criteria.regions).map(normalizeText).filter(Boolean))].sort(),
    industries: [...new Set(asArray(criteria.industries).map(normalizeText).filter(Boolean))].sort(),
    unknownCareerPolicy: 'verify',
  };
}

function parseDateMs(value) {
  if (typeof value !== 'string') return NaN;
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!date) return NaN;
  const [year, month, day] = date.slice(1).map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() !== month - 1 || actual.getUTCDate() !== day) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59.999+09:00`
    : value;
  return Date.parse(normalized);
}

function parseDeadline(deadline) {
  if (!deadline) return { at: null, confirmed: false, raw: null };
  if (typeof deadline === 'string') {
    const timestamp = parseDateMs(deadline);
    return { at: Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString(), confirmed: true, raw: deadline };
  }
  if (typeof deadline === 'object' && !Array.isArray(deadline)) {
    const raw = deadline.at ?? deadline.date ?? deadline.value ?? null;
    const timestamp = parseDateMs(raw);
    return {
      at: Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString(),
      confirmed: deadline.confirmed !== false && !Number.isNaN(timestamp),
      raw,
    };
  }
  return { at: null, confirmed: false, raw: deadline };
}

function sourceCoverage(source, observedRows) {
  const reasons = [];
  const accessStatus = normalizeText(source.accessStatus);
  if (source.complete !== true) reasons.push('collector-marked-incomplete');
  if (accessStatus !== 'ok') reasons.push(`access-${accessStatus || 'unknown'}`);
  if (Number.isFinite(source.expectedPages)) {
    if (!Number.isFinite(source.pagesVisited)) reasons.push('pages-visited-missing');
    else if (source.pagesVisited < source.expectedPages) reasons.push('pages-not-fully-visited');
  }
  if (Number.isFinite(source.expectedCount)) {
    if (!Number.isFinite(source.listedCount)) reasons.push('listed-count-missing');
    else if (source.listedCount < source.expectedCount) reasons.push('listed-count-below-expected');
    if (observedRows < source.expectedCount) reasons.push('snapshot-rows-below-expected-count');
  }
  if (Number.isFinite(source.listedCount) && observedRows < source.listedCount) {
    reasons.push('snapshot-rows-below-listed-count');
  }
  return {
    id: cleanText(source.id),
    url: cleanText(source.url),
    checkedAt: cleanText(source.checkedAt),
    query: source.query ?? null,
    filters: source.filters ?? null,
    accessStatus: cleanText(source.accessStatus),
    complete: reasons.length === 0,
    reasons,
    pagesVisited: Number.isFinite(source.pagesVisited) ? source.pagesVisited : null,
    expectedPages: Number.isFinite(source.expectedPages) ? source.expectedPages : null,
    listedCount: Number.isFinite(source.listedCount) ? source.listedCount : null,
    expectedCount: Number.isFinite(source.expectedCount) ? source.expectedCount : null,
    observedRows,
  };
}

function postingCareerTypes(posting, role) {
  const roleTypes = normalizeCareerTypes(role?.careerTypes);
  return roleTypes.length ? roleTypes : normalizeCareerTypes(posting.careerTypes);
}

function hardConstraintDecision(posting, role, criteria, nowMs) {
  const reasons = [];
  const unknowns = [];
  const postingTypes = postingCareerTypes(posting, role);
  const criteriaTypesKnown = criteria.careerTypes.length > 0
    && criteria.careerTypes.every((type) => KNOWN_CAREER_TYPES.has(type));
  const postingTypesKnown = postingTypes.length > 0
    && postingTypes.every((type) => KNOWN_CAREER_TYPES.has(type));
  const wanted = criteriaTypesKnown ? expandCareerTypes(criteria.careerTypes) : new Set();
  const offered = postingTypesKnown ? expandCareerTypes(postingTypes) : new Set();
  if (criteria.careerTypes.length && !criteriaTypesKnown) {
    unknowns.push('candidate-career-target-unknown');
  } else if (criteriaTypesKnown && !criteria.careerTypes.includes('any')) {
    if (!postingTypesKnown) {
      unknowns.push('career-types-unknown');
    } else {
      if (![...wanted].some((type) => offered.has(type))) reasons.push('career-type-mismatch');
    }
  }

  const requiredExperienceMonths = Number.isFinite(role?.requiredExperienceMonths)
    ? Number(role.requiredExperienceMonths)
    : Number.isFinite(posting.requiredExperienceMonths)
      ? Number(posting.requiredExperienceMonths)
      : null;
  if (requiredExperienceMonths !== null) {
    const newPathAvailable = !postingTypesKnown
      || (offered.has('new') && (!criteriaTypesKnown || wanted.has('new')));
    if (newPathAvailable) {
      // 혼합 채용의 숫자 최소경력은 경력 분기에만 적용하고 신입 경로를 막지 않는다.
    } else if (criteria.experienceMonths === null || criteria.experienceMonthsBasis !== 'verified-relevant') {
      unknowns.push('candidate-verified-relevant-experience-unknown');
    } else if (criteria.experienceMonths < requiredExperienceMonths) {
      reasons.push('confirmed-experience-shortage');
    }
  }

  const postingSize = normalizeSize(posting.size);
  if (criteria.sizes.length) {
    const criteriaSizesKnown = criteria.sizes.every((size) => KNOWN_SIZES.has(size));
    if (!criteriaSizesKnown) unknowns.push('candidate-company-size-target-unknown');
    else if (!postingSize || !KNOWN_SIZES.has(postingSize)) unknowns.push('company-size-unknown');
    else if (!criteria.sizes.includes(postingSize)) reasons.push('company-size-mismatch');
  }

  const deadline = parseDeadline(role?.deadline ?? posting.deadline);
  if (deadline.at && deadline.confirmed && Date.parse(deadline.at) <= nowMs) reasons.push('deadline-ended');
  else if (!deadline.at) unknowns.push('deadline-unknown');

  return { excluded: reasons.length > 0, reasons, unknowns, requiredExperienceMonths, deadline };
}

function keywordScore(posting, role, keywords) {
  if (!keywords.length) return { score: 0, matches: [] };
  const haystack = normalizeText([
    posting.company,
    posting.title,
    ...(asArray(posting.keywords)),
    role?.title,
    ...(asArray(role?.keywords)),
  ].filter(Boolean).join(' '));
  const matches = keywords.filter((keyword) => haystack.includes(keyword));
  return { score: matches.length, matches };
}

function roleIdentity(role) {
  if (cleanText(role?.id)) return `id:${normalizeText(role.id)}`;
  if (cleanText(role?.url)) return `url:${canonicalizeUrl(role.url)}`;
  if (cleanText(role?.title)) return `title:${normalizeText(role.title)}`;
  return 'roles-unresolved';
}

function candidateKey(posting, role) {
  const postingUrl = canonicalizeUrl(posting.url) ?? `source-row:${cleanText(posting.sourceId)}:${cleanText(posting.sourceRowId)}`;
  return `${postingUrl}::${roleIdentity(role)}`;
}

function candidateId(key) {
  return `candidate-${fingerprint(key).slice(0, 16)}`;
}

function previousByFingerprint(previous) {
  const map = new Map();
  for (const candidate of asArray(previous?.candidates)) {
    if (cleanText(candidate?.fingerprint)) map.set(candidate.fingerprint, candidate);
  }
  return map;
}

function verificationCloseAt(previousCandidate) {
  return previousCandidate?.verification?.closesAt
    ?? previousCandidate?.verification?.deadlineAt
    ?? previousCandidate?.deadline?.at
    ?? null;
}

function cachedVerification(previousCandidate, nowMs) {
  const verification = previousCandidate?.verification;
  if (!verification || verification.source !== 'official') return { hit: false, reason: 'no-official-cache' };
  if (verification.state !== 'verified') return { hit: false, reason: 'official-cache-not-complete' };
  if (!['open', 'upcoming', 'rolling'].includes(normalizeText(verification.officialStatus))) {
    return { hit: false, reason: 'official-cache-status-not-verified' };
  }
  if (!/^https:\/\//i.test(cleanText(verification.officialUrl))) return { hit: false, reason: 'official-cache-url-missing' };
  if (verification.evidence === undefined || verification.evidence === null
    || (typeof verification.evidence === 'string' && !cleanText(verification.evidence))
    || (Array.isArray(verification.evidence) && verification.evidence.length === 0)
    || (typeof verification.evidence === 'object' && !Array.isArray(verification.evidence)
      && Object.keys(verification.evidence).length === 0)) {
    return { hit: false, reason: 'official-cache-evidence-missing' };
  }
  const checkedAtMs = Date.parse(verification.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return { hit: false, reason: 'cache-checked-at-invalid' };
  if (checkedAtMs > nowMs || nowMs - checkedAtMs >= CACHE_TTL_MS) return { hit: false, reason: 'cache-expired' };
  const closesAt = verificationCloseAt(previousCandidate);
  const closeMs = parseDateMs(closesAt);
  if (closesAt && Number.isFinite(closeMs) && closeMs <= nowMs) {
    return { hit: false, reason: 'past-close-recheck' };
  }
  return { hit: true, verification: { ...verification, cache: 'hit' } };
}

function ranking(candidate) {
  let score = candidate.keywordMatches.length * 10;
  if (!candidate.unknowns.includes('career-types-unknown')) score += 4;
  if (candidate.action === 'verify-official') score += 2;
  const deadlineMs = candidate.deadline.at ? Date.parse(candidate.deadline.at) : null;
  return { score, deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : Number.POSITIVE_INFINITY };
}

function compareCandidates(left, right) {
  const a = ranking(left);
  const b = ranking(right);
  return b.score - a.score
    || a.deadlineMs - b.deadlineMs
    || left.company.localeCompare(right.company, 'ko')
    || left.title.localeCompare(right.title, 'ko')
    || left.id.localeCompare(right.id);
}

function cacheFingerprint(posting, role, normalizedCriteria) {
  return fingerprint({
    criteria: normalizedCriteria,
    posting: {
      url: canonicalizeUrl(posting.url),
      company: cleanText(posting.company),
      title: cleanText(posting.title),
      size: normalizeSize(posting.size) || null,
      careerTypes: normalizeCareerTypes(posting.careerTypes),
      requiredExperienceMonths: Number.isFinite(posting.requiredExperienceMonths)
        ? Number(posting.requiredExperienceMonths)
        : null,
      deadline: parseDeadline(posting.deadline),
      keywords: asArray(posting.keywords).map(normalizeText).filter(Boolean).sort(),
      rawEvidence: posting.rawEvidence ?? null,
    },
    role: role ? {
      id: cleanText(role.id) || null,
      title: cleanText(role.title) || null,
      url: canonicalizeUrl(role.url),
      careerTypes: normalizeCareerTypes(role.careerTypes),
      requiredExperienceMonths: Number.isFinite(role.requiredExperienceMonths)
        ? Number(role.requiredExperienceMonths)
        : null,
      deadline: parseDeadline(role.deadline),
      keywords: asArray(role.keywords).map(normalizeText).filter(Boolean).sort(),
    } : null,
  });
}

export function buildDiscoveryQueue(snapshot, criteria, options = {}) {
  validateSnapshot(snapshot);
  const normalizedCriteria = normalizeCriteria(criteria);
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`유효하지 않은 기준 시각: ${now}`);
  const generatedAt = new Date(nowMs).toISOString();
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize
    : DEFAULT_BATCH_SIZE;
  const prior = previousByFingerprint(options.previous);
  const observedRowsBySource = snapshot.postings.reduce((counts, posting) => {
    const sourceId = cleanText(posting.sourceId);
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    return counts;
  }, new Map());
  const coverageSources = snapshot.sources.map((source) => (
    sourceCoverage(source, observedRowsBySource.get(cleanText(source.id)) ?? 0)
  ));
  const sourceById = new Map(snapshot.sources.map((source) => [cleanText(source.id), source]));
  const candidateByKey = new Map();
  const ledger = [];

  for (const [rowIndex, posting] of snapshot.postings.entries()) {
    const roles = Array.isArray(posting.roles) ? posting.roles : [];
    const roleEntries = roles.length ? roles : [null];
    const rowCandidateIds = [];
    const rowDecisions = [];

    for (const role of roleEntries) {
      const decision = hardConstraintDecision(posting, role, normalizedCriteria, nowMs);
      if (decision.excluded) {
        rowDecisions.push({ role: roleIdentity(role), disposition: 'excluded', reasons: decision.reasons });
        continue;
      }

      const key = candidateKey(posting, role);
      const existing = candidateByKey.get(key);
      if (existing) {
        const provenance = {
          sourceId: cleanText(posting.sourceId),
          sourceRowId: cleanText(posting.sourceRowId) || null,
          url: canonicalizeUrl(posting.url),
        };
        if (!existing.provenance.some((item) => JSON.stringify(item) === JSON.stringify(provenance))) {
          existing.provenance.push(provenance);
        }
        existing.portalEvidence.push({ ...provenance, rawEvidence: posting.rawEvidence ?? null });
        existing._contentFingerprints.push(cacheFingerprint(posting, role, normalizedCriteria));
        rowCandidateIds.push(existing.id);
        rowDecisions.push({ role: roleIdentity(role), disposition: 'retained', reasons: ['duplicate-merged'] });
        continue;
      }

      const roleUnknown = role === null;
      const keyword = keywordScore(posting, role, normalizedCriteria.keywords);
      const id = candidateId(key);
      const candidate = {
        id,
        fingerprint: null,
        disposition: roleUnknown ? 'deferred' : 'retained',
        action: roleUnknown ? 'inspect-roles' : 'verify-official',
        company: cleanText(posting.company),
        title: role ? cleanText(role.title) || cleanText(posting.title) : cleanText(posting.title),
        postingTitle: cleanText(posting.title),
        roleId: role ? cleanText(role.id) || null : null,
        portalUrl: canonicalizeUrl(role?.url ?? posting.url),
        postingUrl: canonicalizeUrl(posting.url),
        careerTypes: postingCareerTypes(posting, role),
        requiredExperienceMonths: decision.requiredExperienceMonths,
        companySize: normalizeSize(posting.size) || null,
        deadline: decision.deadline,
        unknowns: roleUnknown
          ? [...new Set(['roles-unresolved', ...decision.unknowns])]
          : decision.unknowns,
        keywordMatches: keyword.matches,
        keywordMismatchIsExclusion: false,
        portalEvidence: [{
          sourceId: cleanText(posting.sourceId),
          sourceRowId: cleanText(posting.sourceRowId) || null,
          url: canonicalizeUrl(posting.url),
          rawEvidence: posting.rawEvidence ?? null,
        }],
        _contentFingerprints: [cacheFingerprint(posting, role, normalizedCriteria)],
        provenance: [{
          sourceId: cleanText(posting.sourceId),
          sourceRowId: cleanText(posting.sourceRowId) || null,
          url: canonicalizeUrl(posting.url),
        }],
        verification: null,
      };
      candidateByKey.set(key, candidate);
      rowCandidateIds.push(id);
      rowDecisions.push({
        role: roleIdentity(role),
        disposition: candidate.disposition,
        reasons: roleUnknown ? ['roles-unresolved'] : ['candidate-retained'],
      });
    }

    const dispositions = new Set(rowDecisions.map((decision) => decision.disposition));
    const disposition = dispositions.has('retained')
      ? 'retained'
      : dispositions.has('deferred')
        ? 'deferred'
        : 'excluded';
    ledger.push({
      rowId: `${cleanText(posting.sourceId)}:${cleanText(posting.sourceRowId) || canonicalizeUrl(posting.url) || rowIndex}`,
      sourceId: cleanText(posting.sourceId),
      sourceRowId: cleanText(posting.sourceRowId) || null,
      company: cleanText(posting.company),
      title: cleanText(posting.title),
      disposition,
      candidateIds: [...new Set(rowCandidateIds)],
      roleDecisions: rowDecisions,
      decisionScope: 'portal-candidate-filter',
      officialEligibility: 'unverified',
      sourceCheckedAt: cleanText(sourceById.get(cleanText(posting.sourceId))?.checkedAt),
    });
  }

  const candidates = [...candidateByKey.values()];
  const companies = new Map();
  for (const [index, row] of ledger.entries()) {
    // A posting may be unsuitable while the company has another suitable opening.
    if (row.roleDecisions.every(d => d.reasons.includes('company-size-mismatch') || d.reasons.includes('deadline-ended'))) continue;
    const posting = snapshot.postings[index];
    if (!companies.has(row.company)) companies.set(row.company, {
      id: `company-${fingerprint(row.company).slice(0, 16)}`, company: row.company,
      action: 'inspect-official-openings', candidateIds: [], postings: [],
    });
    const company = companies.get(row.company);
    company.candidateIds.push(...row.candidateIds);
    company.postings.push({ url: canonicalizeUrl(posting.url), title: posting.title,
      roleTitles: (posting.roles ?? []).map(role => role.title).filter(Boolean),
      employmentPageUrl: posting.rawEvidence?.employmentPageUrl ?? null,
      currentPostingDisposition: row.disposition });
  }
  const companyChecks = [...companies.values()].map(company => ({ ...company, candidateIds: [...new Set(company.candidateIds)],
    reason: company.candidateIds.length ? '후보 직무와 해당 기업의 관련 공식 공고 비교' : '현재 포털 공고는 조건 불일치. 기업의 다른 신입/경력 공고는 미확인' }));
  for (const candidate of candidates) {
    candidate.fingerprint = fingerprint({
      criteria: normalizedCriteria,
      contents: [...new Set(candidate._contentFingerprints)].sort(),
    });
    delete candidate._contentFingerprints;
    const cache = cachedVerification(prior.get(candidate.fingerprint), nowMs);
    candidate.verification = cache.hit
      ? cache.verification
      : {
          state: 'pending',
          source: null,
          officialStatus: 'unverified',
          checkedAt: null,
          cache: 'miss',
          cacheReason: cache.reason,
        };
  }
  candidates.sort(compareCandidates);
  const pendingIds = candidates
    .filter((candidate) => candidate.verification.cache !== 'hit')
    .map((candidate) => candidate.id);
  const firstBatch = pendingIds.slice(0, batchSize);
  const remaining = pendingIds.slice(batchSize);
  const partial = coverageSources.some((source) => !source.complete);
  const counts = ledger.reduce((totals, row) => {
    totals[row.disposition] += 1;
    return totals;
  }, { retained: 0, excluded: 0, deferred: 0 });

  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    generatedAt,
    asOf: generatedAt,
    notice: '이 큐는 채용 포털 스냅샷을 기반으로 한 공식 검증 순서 추천입니다. ledger의 excluded도 포털 후보 필터일 뿐 최종 지원 자격이나 공식 채용 상태의 확정이 아닙니다.',
    criteria: normalizedCriteria,
    coverage: {
      partial,
      sources: coverageSources,
      observedPostingRows: snapshot.postings.length,
      zeroObservedIsNoHiring: false,
      interpretation: partial
        ? '수집이 불완전하거나 접근에 실패한 출처가 있어 결과 없음은 채용 없음으로 해석할 수 없습니다.'
        : '완전 수집으로 표시된 출처에서 관측된 결과이며, 회사 전체 채용 부재를 뜻하지 않습니다.',
    },
    stats: {
      postingRows: snapshot.postings.length,
      ledgerRows: ledger.length,
      candidates: candidates.length,
      companiesToInspect: companyChecks.length,
      ...counts,
      queuedForVerification: pendingIds.length,
      cacheHits: candidates.filter((candidate) => candidate.verification.cache === 'hit').length,
    },
    queue: {
      batchSize,
      firstBatch,
      remaining,
      all: pendingIds,
      truncated: false,
    },
    candidates,
    companyChecks,
    ledger,
  };
}
