import {
  classifySocialProfile,
  isBusinessOwnedSocialProfile,
  classifyAllSocialProfiles,
  extractSocialLinks,
} from '../src/services/business-extractor.service';
import { isIdentifyingSocialProfile } from '../src/services/entity-resolution.service';

console.log('================================================================');
console.log('RUNNING TASK 6 SOCIAL OWNERSHIP & PROFILE TESTS (18 FIXTURES)');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function assertEqual(testName: string, actual: any, expected: any) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`✅ PASSED: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAILED: ${testName}`);
    console.error(`   Actual:   ${JSON.stringify(actual)}`);
    console.error(`   Expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}

// ── T1: LinkedIn Company Page ────────────────────────────────────────────────
const t1 = classifySocialProfile('https://linkedin.com/company/acme-corp', 'linkedin', 'Acme Corp', 'acme.com');
assertEqual('T1.1: LinkedIn company profileType', t1.profileType, 'business_page');
assertEqual('T1.2: LinkedIn company owner', t1.owner, 'business');
assertEqual('T1.3: LinkedIn company status', t1.status, 'accepted');
assertEqual('T1.4: LinkedIn company rejectionReason', t1.rejectionReason, 'NONE');

// ── T2: LinkedIn Personal Profile ────────────────────────────────────────────
const t2 = classifySocialProfile('https://linkedin.com/in/john-smith', 'linkedin', 'Acme Corp', 'acme.com');
assertEqual('T2.1: LinkedIn /in/ profileType', t2.profileType, 'personal_profile');
assertEqual('T2.2: LinkedIn /in/ owner', t2.owner, 'person');
assertEqual('T2.3: LinkedIn /in/ status', t2.status, 'rejected');
assertEqual('T2.4: LinkedIn /in/ rejectionReason', t2.rejectionReason, 'PERSONAL_PROFILE');

// ── T3: Aligned Social Profile ───────────────────────────────────────────────
const t3 = classifySocialProfile('https://facebook.com/cleanoclocknepal', 'facebook', "Clean O'Clock Nepal", 'cleanoclock.com.np');
assertEqual('T3.1: Aligned FB owner', t3.owner, 'business');
assertEqual('T3.2: Aligned FB status', t3.status, 'accepted');
assertEqual('T3.3: Aligned FB rejectionReason', t3.rejectionReason, 'NONE');

// ── T4: Foreign Brand Mismatch (Nova Dental / Tarakeshwor defect fix) ─────────
const t4 = classifySocialProfile('https://facebook.com/novadentalcarepvt.ltd', 'facebook', 'Tarakeshwor Dental Clinic', 'tarakeshwordental.com');
assertEqual('T4.1: Nova Dental mismatch owner', t4.owner, 'unknown');
assertEqual('T4.2: Nova Dental mismatch status', t4.status, 'rejected');
assertEqual('T4.3: Nova Dental mismatch rejectionReason', t4.rejectionReason, 'BUSINESS_NAME_MISMATCH');

// ── T5: Acronym Match (>= 3 chars) ───────────────────────────────────────────
const t5 = classifySocialProfile('https://facebook.com/kvhdental', 'facebook', 'Kathmandu Valley Hospital', 'kvh.com.np');
assertEqual('T5.1: 3-char acronym owner', t5.owner, 'business');
assertEqual('T5.2: 3-char acronym status', t5.status, 'accepted');
assertEqual('T5.3: 3-char acronym rejectionReason', t5.rejectionReason, 'NONE');

// ── T6: Known Vendor Handle ──────────────────────────────────────────────────
const t6 = classifySocialProfile('https://facebook.com/sitepad', 'facebook', "Clean O'Clock", 'cleanoclock.com.np');
assertEqual('T6.1: SitePad vendor owner', t6.owner, 'vendor');
assertEqual('T6.2: SitePad vendor status', t6.status, 'rejected');
assertEqual('T6.3: SitePad vendor rejectionReason', t6.rejectionReason, 'VENDOR_PROFILE');

// ── T7: Platform Official Handle ─────────────────────────────────────────────
const t7 = classifySocialProfile('https://facebook.com/facebook', 'facebook', 'My Company', 'mycompany.com');
assertEqual('T7.1: Facebook official owner', t7.owner, 'platform');
assertEqual('T7.2: Facebook official status', t7.status, 'rejected');
assertEqual('T7.3: Facebook official rejectionReason', t7.rejectionReason, 'PLATFORM_PROFILE');

// ── T8: Share Dialog URL ─────────────────────────────────────────────────────
const t8 = classifySocialProfile('https://facebook.com/sharer.php?u=https://example.com', 'facebook', "Clean O'Clock", 'cleanoclock.com');
assertEqual('T8.1: FB sharer.php profileType', t8.profileType, 'unknown');
assertEqual('T8.2: FB sharer.php owner', t8.owner, 'unknown');
assertEqual('T8.3: FB sharer.php status', t8.status, 'rejected');
assertEqual('T8.4: FB sharer.php rejectionReason', t8.rejectionReason, 'NOT_A_REAL_PROFILE');

// ── T9: Ambiguous Handle Without Business Context ────────────────────────────
const t9 = classifySocialProfile('https://facebook.com/randomhandle123', 'facebook');
assertEqual('T9.1: Contextless handle owner', t9.owner, 'unknown');
assertEqual('T9.2: Contextless handle status', t9.status, 'unknown');
assertEqual('T9.3: Contextless handle rejectionReason', t9.rejectionReason, 'INSUFFICIENT_EVIDENCE');

// ── T10: Numeric ID Profile (profile.php) ────────────────────────────────────
const t10 = classifySocialProfile('https://facebook.com/profile.php?id=100012345678', 'facebook', 'Acme Dental', 'acmedental.com');
assertEqual('T10.1: Numeric FB profileType', t10.profileType, 'unknown');
assertEqual('T10.2: Numeric FB owner', t10.owner, 'unknown');
assertEqual('T10.3: Numeric FB status', t10.status, 'unknown');
assertEqual('T10.4: Numeric FB rejectionReason', t10.rejectionReason, 'INSUFFICIENT_EVIDENCE');

// ── T11: Aligned Handle Without Website ──────────────────────────────────────
const t11 = classifySocialProfile('https://facebook.com/cleanoclock', 'facebook', "Clean O'Clock");
assertEqual('T11.1: Name-only aligned status', t11.status, 'accepted');
assertEqual('T11.2: Name-only aligned rejectionReason', t11.rejectionReason, 'NONE');

// ── T12: Short Acronym Guard (< 3 chars) ─────────────────────────────────────
const t12 = classifySocialProfile('https://facebook.com/akdental', 'facebook', 'Akash Khanal Dental', 'akashdental.com');
assertEqual('T12.1: 2-char acronym status', t12.status, 'unknown');
assertEqual('T12.2: 2-char acronym owner', t12.owner, 'unknown');
assertEqual('T12.3: 2-char acronym rejectionReason', t12.rejectionReason, 'INSUFFICIENT_EVIDENCE');

// ── T13: Entity Resolution Identifying Socials ───────────────────────────────
assertEqual('T13.1: LinkedIn /in/ personal profile is identifying', isIdentifyingSocialProfile('https://linkedin.com/in/john-smith'), true);
assertEqual('T13.2: LinkedIn company page is not uniquely identifying personal asset', isIdentifyingSocialProfile('https://linkedin.com/company/acme-corp'), false);
assertEqual('T13.3: FB sharer is not identifying', isIdentifyingSocialProfile('https://facebook.com/sharer.php?u=foo'), false);
assertEqual('T13.4: Vendor handle is not identifying', isIdentifyingSocialProfile('https://facebook.com/sitepad'), false);

// ── T14: Projection Filtering in extractSocialLinks ──────────────────────────
const htmlContent = `
  <div>
    <a href="https://facebook.com/novadentalcarepvt.ltd">Wrong FB</a>
    <a href="https://facebook.com/tarakeshwordental">Correct FB</a>
    <a href="https://instagram.com/tarakeshwordental">Instagram</a>
    <a href="https://linkedin.com/in/john-smith">Personal LinkedIn</a>
  </div>
`;
const extracted = extractSocialLinks(htmlContent, {
  businessName: 'Tarakeshwor Dental Clinic',
  websiteDomain: 'tarakeshwordental.com',
});
assertEqual('T14.1: Rejected FB filtered out of projection', extracted.facebook, 'https://facebook.com/tarakeshwordental');
assertEqual('T14.2: Accepted IG projected', extracted.instagram, 'https://instagram.com/tarakeshwordental');
assertEqual('T14.3: Rejected personal LinkedIn omitted', extracted.other.linkedin, undefined);

// ── T15: Audit Trail Extraction in classifyAllSocialProfiles ─────────────────
const auditContent = `
  FB 1: https://facebook.com/novadentalcarepvt.ltd
  LI: https://linkedin.com/in/john-smith
  Share: https://facebook.com/sharer.php?u=foo
  Valid: https://facebook.com/tarakeshwordental
`;
const auditProfiles = classifyAllSocialProfiles(auditContent, {
  businessName: 'Tarakeshwor Dental Clinic',
  websiteDomain: 'tarakeshwordental.com',
});
assertEqual('T15.1: Audit profiles extracted count', auditProfiles.length, 4);
assertEqual('T15.2: Audit mismatch reason', auditProfiles[0].rejectionReason, 'BUSINESS_NAME_MISMATCH');
assertEqual('T15.3: Audit personal reason', auditProfiles[1].rejectionReason, 'PERSONAL_PROFILE');
assertEqual('T15.4: Audit share reason', auditProfiles[2].rejectionReason, 'NOT_A_REAL_PROFILE');
assertEqual('T15.5: Audit valid status', auditProfiles[3].status, 'accepted');

// ── T16: Regression Safety for isBusinessOwnedSocialProfile ──────────────────
assertEqual(
  'T16.1: Reject vendor handle',
  isBusinessOwnedSocialProfile('https://facebook.com/sitepad', 'facebook', 'Clean', 'clean.com'),
  false
);
assertEqual(
  'T16.2: Accept aligned profile',
  isBusinessOwnedSocialProfile('https://facebook.com/cleanoclocknepal', 'facebook', "Clean O'Clock Nepal", 'cleanoclock.com'),
  true
);

// ── T17: Generic-Only Token Overlap ──────────────────────────────────────────
const t17 = classifySocialProfile('https://facebook.com/nepaldental', 'facebook', 'Tarakeshwor Dental Clinic', 'tarakeshwordental.com');
assertEqual('T17.1: Generic-only handle status', t17.status, 'unknown');
assertEqual('T17.2: Generic-only handle owner', t17.owner, 'unknown');
assertEqual('T17.3: Generic-only handle rejectionReason', t17.rejectionReason, 'INSUFFICIENT_EVIDENCE');

// ── T18: Reserved Path Endpoints ─────────────────────────────────────────────
const t18 = classifySocialProfile('https://facebook.com/explore', 'facebook');
assertEqual('T18.1: Reserved path profileType', t18.profileType, 'unknown');
assertEqual('T18.2: Reserved path owner', t18.owner, 'unknown');
assertEqual('T18.3: Reserved path status', t18.status, 'rejected');
assertEqual('T18.4: Reserved path rejectionReason', t18.rejectionReason, 'RESERVED_PATH');

console.log('\n================================================================');
console.log(`TASK 6 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
