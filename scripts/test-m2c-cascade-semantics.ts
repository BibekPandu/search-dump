import assert from 'node:assert';
import { sourceHealthEnum } from '@/mastra/agents/research-agent/verification.schema.js';
import { classifySocialProfile } from '@/services/business-extractor.service';
import { sanitizeListingWithEvidence } from '@/mastra/workflows/research-workflow.js';

console.log('=== Running M2C Cascade Semantics & Source Health Tests ===\n');

// 1. Source health enum validity
const healthStates = ['verified', 'transient_failure', 'wrong_source', 'unverified'];
for (const h of healthStates) {
  const parsed = sourceHealthEnum.safeParse(h);
  assert(parsed.success, `Source health state '${h}' must be valid in sourceHealthEnum`);
}

// 2. Refinement 1 test: Distinctive first-party social profile from an unverified/transient source
const businessName = 'Global Eye Education Consultancy';
const domain = 'globaleye.edu.np';

const fbUrl = 'https://www.facebook.com/globaleyeeducation';
const fbClassified = classifySocialProfile(
  fbUrl,
  'facebook',
  businessName,
  domain,
  ['consultancy', 'education'],
  'website_evidence'
);

assert.strictEqual(fbClassified.status, 'accepted', 'Matching first-party social profile must be accepted');
assert.strictEqual(fbClassified.owner, 'business', 'Matching first-party social profile owner must be business');

// 3. Strict rejection of wrong source (directory / vendor / platform)
const directoryUrl = 'https://www.facebook.com/yellowpagesnepal';
const dirClassified = classifySocialProfile(
  directoryUrl,
  'facebook',
  businessName,
  domain,
  ['consultancy', 'education'],
  'website_evidence'
);

assert.strictEqual(dirClassified.status, 'rejected', 'Directory social profile must be strictly rejected');

// 4. Mismatch handle on first-party site must still be rejected by distinctive matcher
const mismatchUrl = 'https://www.facebook.com/nepalairlinesofficial';
const mismatchClassified = classifySocialProfile(
  mismatchUrl,
  'facebook',
  businessName,
  domain,
  ['consultancy', 'education'],
  'website_evidence'
);

assert.strictEqual(mismatchClassified.status, 'rejected', 'Mismatched brand handle must be rejected');

// --- End-to-end cascade tests ---
const baseCandidate = {
  title: 'Global Eye Education Consultancy',
  name: 'Global Eye Education Consultancy',
  url: 'https://globaleye.edu.np',
  domain: 'globaleye.edu.np',
  phone: '+977-1-4102345',
  source: 'google_maps' as const,
};

const baseListing = {
  name: 'Global Eye Education Consultancy',
  location: 'Putalisadak, Kathmandu',
  phones: [], mobiles: [], emails: [], websites: ['https://globaleye.edu.np'],
};

// Case 1: transient + corroborated social (matching name token) -> KEEP
const transientEvidence1 = {
  candidate: baseCandidate,
  sourceHealth: 'transient_failure',
  websiteRelationship: 'unverified',
  verification: { overallConfidence: 0.8 },
  websiteEvidence: {
    extractedSocialLinks: { facebook: 'https://www.facebook.com/globaleyeeducation' },
    extractedClassifiedContacts: [],
  }
};
const result1 = sanitizeListingWithEvidence(baseListing as any, transientEvidence1 as any);
assert(result1.socialLinks?.facebook, 'transient + corroborated social must survive');

// Case 2: wrong-source + social -> REJECT
const wrongSourceEvidence = {
  candidate: baseCandidate,
  sourceHealth: 'wrong_source',
  websiteRelationship: 'directory',
  verification: { overallConfidence: 0.8 },
  websiteEvidence: {
    extractedSocialLinks: { facebook: 'https://www.facebook.com/globaleyeeducation' },
    extractedClassifiedContacts: [],
  }
};
const result2 = sanitizeListingWithEvidence(baseListing as any, wrongSourceEvidence as any);
assert(!result2.socialLinks?.facebook, 'wrong-source social must be rejected');

// Case 3: transient + Maps phone match -> KEEP contact
const transientEvidence3 = {
  candidate: baseCandidate,
  sourceHealth: 'transient_failure',
  websiteRelationship: 'unverified',
  verification: { overallConfidence: 0.8 },
  websiteEvidence: {
    extractedSocialLinks: {},
    extractedClassifiedContacts: [
      { value: '+977-1-4102345', canonicalDigits: '9774102345', type: 'phone', phoneType: 'landline', role: 'main', owner: 'business', channels: [] }
    ],
  }
};
const result3 = sanitizeListingWithEvidence(baseListing as any, transientEvidence3 as any);
assert(
  result3.phones?.some((p: string) => p.includes('4102345')),
  'transient + Maps-phone-match contact must survive'
);

// Case 4: wrong-source + contact -> REJECT
const wrongSourceEvidence4 = {
  candidate: baseCandidate,
  sourceHealth: 'wrong_source',
  websiteRelationship: 'directory',
  verification: { overallConfidence: 0.8 },
  websiteEvidence: {
    extractedSocialLinks: {},
    extractedClassifiedContacts: [
      { value: '+977-1-4999999', canonicalDigits: '9774999999', type: 'phone', phoneType: 'landline', role: 'main', owner: 'business', channels: [] }
    ],
  }
};
const result4 = sanitizeListingWithEvidence(baseListing as any, wrongSourceEvidence4 as any);
assert(
  !result4.phones?.some((p: string) => p.includes('4999999')),
  'wrong-source contact must be rejected'
);

console.log('M2C cascade semantics tests passed.\n');
