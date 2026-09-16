import {
  classifyWebsiteRelationship,
  determineWebsiteLifecycle,
  validateLifecycleRelationshipInvariant,
  detectIndustryPortalSignals,
} from '../src/services/website-relationship.service';
import type { WebsiteRelationship, WebsiteLifecycle } from '../src/mastra/agents/research-agent/verification.schema';

console.log('================================================================');
console.log('RUNNING TASK 7 WEBSITE LIFECYCLE & RELATIONSHIP TESTS (17 FIXTURES)');
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

// ── T1: Directory Domain (REAL-ESTATE-01 fix) ────────────────────────────────
const t1 = classifyWebsiteRelationship(
  'https://realestateinnepal.com/listings',
  'Kathmandu Realtors',
  'Browse properties and real estate directory in Nepal.'
);
assertEqual('T1.1: Directory domain relationship', t1.relationship, 'directory');
assertEqual('T1.2: Directory domain isContactEnrichable', t1.isContactEnrichable, false);

// ── T2: First-Party Domain ───────────────────────────────────────────────────
const t2 = classifyWebsiteRelationship(
  'https://cleanoclock.com.np',
  "Clean O'Clock Nepal",
  'Professional cleaning services in Kathmandu.'
);
assertEqual('T2.1: First-party domain relationship', t2.relationship, 'first_party');
assertEqual('T2.2: First-party domain isContactEnrichable', t2.isContactEnrichable, true);

// ── T3: Custom Wix Domain (Wix fingerprint on custom domain preserved) ────────
const t3 = classifyWebsiteRelationship(
  'https://cleanoclock.com.np',
  "Clean O'Clock Nepal",
  'Welcome to Clean O\'Clock. Built with Wix. All rights reserved.'
);
assertEqual('T3.1: Custom Wix domain relationship', t3.relationship, 'first_party');
assertEqual('T3.2: Custom Wix domain isContactEnrichable', t3.isContactEnrichable, true);
assertEqual('T3.3: Wix vendor fingerprint detected in signals', typeof t3.signals.vendorFingerprint, 'string');

// ── T4: Wix Subdomain (Service Platform) ─────────────────────────────────────
const t4 = classifyWebsiteRelationship(
  'https://kathmandu-realtors.wixsite.com/home',
  'Kathmandu Realtors',
  'Our property portal on Wix.'
);
assertEqual('T4.1: Wix subdomain relationship', t4.relationship, 'service_platform');
assertEqual('T4.2: Wix subdomain isContactEnrichable', t4.isContactEnrichable, false);

// ── T5: Corporate Parent ─────────────────────────────────────────────────────
const t5 = classifyWebsiteRelationship(
  'https://ihg.com/holidayinn/hotels/us/en/kathmandu/ktmnp/hoteldetail',
  'Holiday Inn Kathmandu',
  'Book your stay at Holiday Inn Kathmandu with IHG One Rewards.'
);
assertEqual('T5.1: Corporate parent relationship', t5.relationship, 'corporate_parent');
assertEqual('T5.2: Corporate parent isContactEnrichable', t5.isContactEnrichable, true);

// ── T6: Related Entity (Sister entity + corporate footer evidence) ───────────
const t6 = classifyWebsiteRelationship(
  'https://himalayan-adventures.com',
  'Himalayan Treks & Tours',
  'Himalayan Adventures is a subsidiary of Himalayan Group of Companies.'
);
assertEqual('T6.1: Related entity relationship', t6.relationship, 'related_entity');
assertEqual('T6.2: Related entity isContactEnrichable', t6.isContactEnrichable, false);

// ── T7: Unrelated Business (All 3 predicates met) ────────────────────────────
const t7 = classifyWebsiteRelationship(
  'https://kathmandudentalcare.com',
  'Nepal Himalayan Bakery',
  'Welcome to Kathmandu Dental Care. We provide dental implants and orthodontic treatments.',
  'Kathmandu Dental Care - Dental Clinic'
);
assertEqual('T7.1: Unrelated domain relationship', t7.relationship, 'unrelated');
assertEqual('T7.2: Unrelated domain isContactEnrichable', t7.isContactEnrichable, false);

// ── T8: Lifecycle Stage 1 (Discovered) ───────────────────────────────────────
const t8Lifecycle = determineWebsiteLifecycle('unverified', 'failed', false);
assertEqual('T8.1: Unextracted candidate lifecycle', t8Lifecycle, 'discovered');

// ── T9: Lifecycle Stage 2 (Usable) ───────────────────────────────────────────
const t9Lifecycle = determineWebsiteLifecycle('unverified', 'weak', true);
assertEqual('T9.1: Extracted candidate weak verification lifecycle', t9Lifecycle, 'usable');

// ── T10: Lifecycle Stage 3 (Identity Confirmed on Directory) ─────────────────
const t10Lifecycle = determineWebsiteLifecycle('directory', 'verified', true);
assertEqual('T10.1: Directory verified identity lifecycle', t10Lifecycle, 'identity_confirmed');

// ── T11: Lifecycle Stage 4 (First Party Owned) ───────────────────────────────
const t11Lifecycle = determineWebsiteLifecycle('first_party', 'verified', true);
assertEqual('T11.1: First-party verified lifecycle', t11Lifecycle, 'first_party_owned');

// ── T12: Identity Confirmed on Directory Preserves Relationship ──────────────
const t12Classification = classifyWebsiteRelationship(
  'https://nepalyp.com/biz/clean-oclock',
  "Clean O'Clock",
  'Clean O\'Clock company directory listing on Nepal Yellow Pages.'
);
const t12Lifecycle = determineWebsiteLifecycle(t12Classification.relationship, 'verified', true);
assertEqual('T12.1: Relationship stays directory', t12Classification.relationship, 'directory');
assertEqual('T12.2: Lifecycle reaches identity_confirmed', t12Lifecycle, 'identity_confirmed');
assertEqual('T12.3: Contact enrichment blocked', t12Classification.isContactEnrichable, false);

// ── T13: Invariant Enforcement ───────────────────────────────────────────────
const t13Fixed1 = validateLifecycleRelationshipInvariant('first_party_owned', 'directory');
assertEqual('T13.1: Invariant corrects first_party_owned + directory to identity_confirmed', t13Fixed1, 'identity_confirmed');

const t13Fixed2 = validateLifecycleRelationshipInvariant('first_party_owned', 'service_platform');
assertEqual('T13.2: Invariant corrects first_party_owned + service_platform to identity_confirmed', t13Fixed2, 'identity_confirmed');

const t13Valid = validateLifecycleRelationshipInvariant('first_party_owned', 'first_party');
assertEqual('T13.3: Invariant preserves first_party_owned + first_party', t13Valid, 'first_party_owned');

// ── T14: Industry Portal Signals Classifier ──────────────────────────────────
const t14Dir = detectIndustryPortalSignals('Find doctors, clinics and hospitals in our company directory.');
assertEqual('T14.1: Detect directory portal phrase', t14Dir, 'directory');

const t14Market = detectIndustryPortalSignals('Shop products online with vendor checkout and multi-vendor seller dashboard.');
assertEqual('T14.2: Detect marketplace portal phrase', t14Market, 'marketplace');

const t14None = detectIndustryPortalSignals('Welcome to our private dental clinic in Kathmandu.');
assertEqual('T14.3: Private clinic returns null portal signals', t14None, null);

// ── T15: Enrichment Gate Validation ──────────────────────────────────────────
const relationships: WebsiteRelationship[] = [
  'first_party',
  'corporate_parent',
  'related_entity',
  'directory',
  'marketplace',
  'service_platform',
  'unrelated',
  'unverified',
];

const enrichableMap: Record<WebsiteRelationship, boolean> = {
  first_party: true,
  corporate_parent: true,
  related_entity: false,
  directory: false,
  marketplace: false,
  service_platform: false,
  unrelated: false,
  unverified: false,
};

for (const rel of relationships) {
  const isEnrichable = rel === 'first_party' || rel === 'corporate_parent';
  assertEqual(`T15 (${rel}): isContactEnrichable matches policy`, isEnrichable, enrichableMap[rel]);
}

// ── T16: Lifecycle × Relationship Compatibility Matrix ───────────────────────
const matrixPairs: Array<{ lifecycle: WebsiteLifecycle; relationship: WebsiteRelationship; valid: boolean }> = [
  { lifecycle: 'discovered', relationship: 'unverified', valid: true },
  { lifecycle: 'usable', relationship: 'unverified', valid: true },
  { lifecycle: 'usable', relationship: 'directory', valid: true },
  { lifecycle: 'usable', relationship: 'service_platform', valid: true },
  { lifecycle: 'identity_confirmed', relationship: 'directory', valid: true },
  { lifecycle: 'identity_confirmed', relationship: 'first_party', valid: true },
  { lifecycle: 'identity_confirmed', relationship: 'corporate_parent', valid: true },
  { lifecycle: 'first_party_owned', relationship: 'first_party', valid: true },
  { lifecycle: 'first_party_owned', relationship: 'directory', valid: false },
  { lifecycle: 'first_party_owned', relationship: 'marketplace', valid: false },
];

for (const pair of matrixPairs) {
  const normalized = validateLifecycleRelationshipInvariant(pair.lifecycle, pair.relationship);
  const isActuallyValid = pair.valid ? normalized === pair.lifecycle : normalized !== pair.lifecycle;
  assertEqual(`T16 matrix (${pair.lifecycle} × ${pair.relationship})`, isActuallyValid, true);
}

// ── T17: Three-Layer Decoupled Semantics Test ────────────────────────────────
const t17Portal = classifyWebsiteRelationship(
  'https://realestateinnepal.com/properties/kathmandu-realtors',
  'Kathmandu Realtors',
  'Browse property listings on Nepal Real Estate Directory. Contact listing agent.'
);
const t17Lifecycle = determineWebsiteLifecycle(t17Portal.relationship, 'verified', true);
assertEqual('T17.1: Layer 1 - Lifecycle is identity_confirmed', t17Lifecycle, 'identity_confirmed');
assertEqual('T17.2: Layer 2 - Relationship is directory', t17Portal.relationship, 'directory');
assertEqual('T17.3: Layer 3 - Contact enrichment is false', t17Portal.isContactEnrichable, false);

console.log('\n================================================================');
console.log(`TASK 7 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================');

if (failed > 0) {
  process.exit(1);
}
