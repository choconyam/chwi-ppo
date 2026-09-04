export type VerificationStatus = 'verified' | 'needs-review' | 'sample';
export type EligibilityStatus = 'eligible' | 'ineligible' | 'needs-review';
export type FitLevel = 'high' | 'medium' | 'low' | 'unrated';
export type FitDecision = 'proceed' | 'caution' | 'reconsider' | 'unrated';
export type ApplicationStatus =
  | 'discovered'
  | 'analyzing'
  | 'writing'
  | 'review'
  | 'ready'
  | 'submitted'
  | 'closed';

export interface Opportunity {
  id: string;
  company: string;
  role: string;
  location?: string;
  officialUrl: string;
  deadline: {
    date: string | null;
    time: string | null;
    timeConfirmed: boolean;
    raw?: string;
  };
  verification: {
    status: VerificationStatus;
    checkedAt: string;
    evidence: string;
  };
  eligibility: {
    status: EligibilityStatus;
    reason: string;
  };
  fit: {
    level: FitLevel;
    decision: FitDecision;
    rationale: string;
  };
  application: {
    status: ApplicationStatus;
    submissionConfirmedAt?: string;
  };
  notes?: string;
}

export interface OpportunityRegistry {
  version: 1;
  updatedAt: string;
  opportunities: Opportunity[];
}

export type FilterKey = 'all' | 'eligible' | 'high' | 'needs-review';
