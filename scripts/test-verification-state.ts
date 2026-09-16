import {
  computeConfidenceBreakdown,
  type ConfidenceInputs,
} from '../src/services/confidence.service';

// ============================================================================
// ASSERTION HELPERS (Placed at top of file)
// ============================================================================

let passed = 0;
let failed = 0;

function assertEq(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    console.error(`❌ FAIL: ${name} — expected ${expected}, got ${actual}`);
    failed++;
    process.exit(1);
  }
  console.log(`✅ PASS: ${name}`);
  passed++;
}

console.log('================================================================');
console.log('🧪 TASK 1: VERIFICATION STATE INTEGRITY TESTS (11 CASES)');
console.log('================================================================\n');

// ============================================================================
// TEST 1: emails=[] → emailVerified=false (even with extraction signal)
// The KEY bug this fixes.
// ============================================================================
const t1: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.8,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,        // extraction found email
    addressOrLocationFoundOnWebsite: false,
  },
  finalEmails: [],                    // BUT sanitizer blocked it (non-first-party)
  finalWebsites: ['https://example.com'],
};
const r1 = computeConfidenceBreakdown(t1);
assertEq('T1: empty finalEmails → emailVerified=false', r1.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 2: valid promoted email → emailVerified=true
// ============================================================================
const t2: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.8,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: false,
  },
  finalEmails: ['contact@example.com'], // promoted from first-party website
  finalWebsites: ['https://example.com'],
};
const r2 = computeConfidenceBreakdown(t2);
assertEq('T2: promoted email → emailVerified=true', r2.evidenceSummary?.emailVerified, true);

// ============================================================================
// TEST 3: rejected email → emailVerified=false
// ============================================================================
const t3: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.7,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: false,
  },
  finalEmails: [],                      // rejected/stripped
  finalWebsites: ['https://example.com'],
};
const r3 = computeConfidenceBreakdown(t3);
assertEq('T3: rejected email → emailVerified=false', r3.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 4: platform-owned email (directory) → emailVerified=false
// ============================================================================
const t4: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.5,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,          // email found on directory
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'directory',     // directory relationship
  finalEmails: [],                      // sanitizer blocks non-first-party
  finalWebsites: ['https://directory.com'],
};
const r4 = computeConfidenceBreakdown(t4);
assertEq('T4: directory email blocked → emailVerified=false', r4.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 5: website not promoted → websiteVerified=false
// ============================================================================
const t5: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.8,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  finalEmails: [],
  finalWebsites: [],                    // no website in final listing
};
const r5 = computeConfidenceBreakdown(t5);
assertEq('T5: empty finalWebsites → websiteVerified=false', r5.evidenceSummary?.websiteVerified, false);

// ============================================================================
// TEST 6: valid first-party website → websiteVerified=true
// ============================================================================
const t6: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.8,
  verificationChecks: {
    phoneMatchesMaps: true,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'first_party',
  finalEmails: [],
  finalWebsites: ['https://example.com'],
};
const r6 = computeConfidenceBreakdown(t6);
assertEq('T6: promoted first-party website → websiteVerified=true', r6.evidenceSummary?.websiteVerified, true);

// ============================================================================
// TEST 7: verified evidence but empty final field → emailVerified=false
// (Independent fixture: extraction signal present, final field empty)
// ============================================================================
const t7: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.85,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: true,
  },
  finalEmails: [],
  finalWebsites: ['https://example.com'],
};
const r7 = computeConfidenceBreakdown(t7);
assertEq('T7: extraction signal + empty final → emailVerified=false', r7.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 8: emails from non-first-party website (sanitizer blocked)
// ============================================================================
const t8: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.65,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'service_platform',
  finalEmails: [],
  finalWebsites: ['https://service.com'],
};
const r8 = computeConfidenceBreakdown(t8);
assertEq('T8: non-first-party email blocked → emailVerified=false', r8.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 9: websiteVerified with directory relationship, no final website → false
// ============================================================================
const t9: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.3,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  websiteRelationship: 'directory',
  finalEmails: [],
  finalWebsites: [],                    // directory website not promoted to final
};
const r9 = computeConfidenceBreakdown(t9);
assertEq('T9: directory website, no final → websiteVerified=false', r9.evidenceSummary?.websiteVerified, false);

// ============================================================================
// TEST 10: phoneVerified independent of emails
// phoneMatchesMaps=true should give phoneVerified regardless of email state
// ============================================================================
const t10: ConfidenceInputs = {
  isMapsCandidate: true,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.6,
  verificationChecks: {
    phoneMatchesMaps: true,             // phone verified
    emailFoundOnWebsite: false,
    addressOrLocationFoundOnWebsite: false,
  },
  finalEmails: [],                      // no email
  finalWebsites: ['https://example.com'],
  finalPhones: ['01-4412345'],
};
const r10 = computeConfidenceBreakdown(t10);
assertEq('T10: phone verified, no email → phoneVerified=true', r10.evidenceSummary?.phoneVerified, true);
assertEq('T10: phone verified, no email → emailVerified=false', r10.evidenceSummary?.emailVerified, false);

// ============================================================================
// TEST 11: Real-world benchmark fixture — Nebuti Travels Pvt Ltd
// Proves that when website is service_platform and sanitizer strips email & website,
// neither emailVerified nor websiteVerified emits false confidence.
// ============================================================================
const t11Nebuti: ConfidenceInputs = {
  isMapsCandidate: true,
  ratingCount: 661,
  hasWebsiteEvidence: true,
  verificationConfidence: 0.7,
  verificationChecks: {
    phoneMatchesMaps: false,
    emailFoundOnWebsite: true,          // raw scraping found an email on service platform
    addressOrLocationFoundOnWebsite: true,
  },
  websiteRelationship: 'service_platform',
  finalEmails: [],                      // sanitizer stripped non-first-party email
  finalWebsites: [],                    // sanitizer did not promote service platform as official website
};
const r11Nebuti = computeConfidenceBreakdown(t11Nebuti);
assertEq('T11: Nebuti fixture → emailVerified=false', r11Nebuti.evidenceSummary?.emailVerified, false);
assertEq('T11: Nebuti fixture → websiteVerified=false', r11Nebuti.evidenceSummary?.websiteVerified, false);
assertEq('T11: Nebuti fixture → mapsVerified=true', r11Nebuti.evidenceSummary?.mapsVerified, true);

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n================================================================');
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
