import { classifyNepalPhone } from '../src/services/business-extractor.service';
import { normalizePhoneDigits } from '../src/services/entity-resolution.service';
import { NTA_MOBILE_PREFIXES } from '../src/config/nepal-telecom.config';

// ============================================================================
// ASSERTION HELPERS
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

function assertBool(name: string, value: boolean) {
  if (!value) {
    console.error(`❌ FAIL: ${name}`);
    failed++;
    process.exit(1);
  }
  console.log(`✅ PASS: ${name}`);
  passed++;
}

console.log('================================================================');
console.log('🧪 TASK 4: NEPAL PHONE PARSING & CANONICALIZATION TESTS (19 CASES)');
console.log('================================================================\n');

// T1: +01-4444356 -> landline, digits='14444356' (TRAVEL-01 fix: misformatted landline without CC)
const t1 = classifyNepalPhone('+01-4444356');
assertEq('T1: +01-4444356 is landline', t1.type, 'landline');
assertEq('T1: +01-4444356 canonical digits', t1.digits, '14444356');

// T2: +977 977 9851234567 -> duplicate CC stripped -> mobile, digits='9851234567' (DENTAL-02 fix)
const t2 = classifyNepalPhone('+977 977 9851234567');
assertEq('T2: +977 977 9851234567 is mobile', t2.type, 'mobile');
assertEq('T2: +977 977 9851234567 canonical digits', t2.digits, '9851234567');

// T3: +977-1-4444356 -> standard country-coded landline, digits='14444356'
const t3 = classifyNepalPhone('+977-1-4444356');
assertEq('T3: +977-1-4444356 is landline', t3.type, 'landline');
assertEq('T3: +977-1-4444356 canonical digits', t3.digits, '14444356');

// T4: +01-4444356 and +977-1-4444356 -> identical canonical digits (REAL-ESTATE-03 fix)
const normA = normalizePhoneDigits('+01-4444356');
const normB = normalizePhoneDigits('+977-1-4444356');
const normC = normalizePhoneDigits('+977-01-4444356');
assertEq('T4: normalizePhoneDigits(+01-4444356)', normA, '14444356');
assertEq('T4: normalizePhoneDigits(+977-1-4444356)', normB, '14444356');
assertEq('T4: normalizePhoneDigits(+977-01-4444356)', normC, '14444356');
assertEq('T4: Dual canonicalization equality', normA === normB && normB === normC, true);

// T5: 9808222425 -> mobile (Ncell prefix 980)
const t5 = classifyNepalPhone('9808222425');
assertEq('T5: 9808222425 is mobile', t5.type, 'mobile');
assertEq('T5: 9808222425 digits', t5.digits, '9808222425');

// T6: 9841234567 -> mobile (NTC GSM prefix 984)
const t6 = classifyNepalPhone('9841234567');
assertEq('T6: 9841234567 is mobile', t6.type, 'mobile');
assertEq('T6: 9841234567 digits', t6.digits, '9841234567');

// T7: 9701234567 -> mobile (Ncell prefix 970)
const t7 = classifyNepalPhone('9701234567');
assertEq('T7: 9701234567 is mobile', t7.type, 'mobile');
assertEq('T7: 9701234567 digits', t7.digits, '9701234567');

// T8: 01-5363501 -> landline, digits='15363501'
const t8 = classifyNepalPhone('01-5363501');
assertEq('T8: 01-5363501 is landline', t8.type, 'landline');
assertEq('T8: 01-5363501 digits', t8.digits, '15363501');

// T9: +1-402-650-3670 -> international
const t9 = classifyNepalPhone('+1-402-650-3670');
assertEq('T9: +1-402-650-3670 is international', t9.type, 'international');

// T10: 9808222 -> invalid (INCOMPLETE_MOBILE, 7 digits)
const t10 = classifyNepalPhone('9808222');
assertEq('T10: 9808222 is invalid', t10.type, 'invalid');
assertEq('T10: 9808222 reason is INCOMPLETE_MOBILE', t10.reason, 'INCOMPLETE_MOBILE');

// T11: 97798512345 -> invalid (11 digits, invalid mobile length)
const t11 = classifyNepalPhone('97798512345');
assertEq('T11: 97798512345 is invalid', t11.type, 'invalid');
assertEq('T11: 97798512345 reason is INCOMPLETE_MOBILE', t11.reason, 'INCOMPLETE_MOBILE');

// T12: Unassigned prefix 9991234567 -> invalid mobile
const t12 = classifyNepalPhone('9991234567');
assertEq('T12: 9991234567 is invalid', t12.type, 'invalid');

// T13: Malformed phone +977- -> invalid
const t13 = classifyNepalPhone('+977-');
assertEq('T13: +977- is invalid', t13.type, 'invalid');

// T14: Malformed phone +977-123-456 -> invalid
const t14 = classifyNepalPhone('+977-123-456');
assertEq('T14: +977-123-456 is invalid', t14.type, 'invalid');

// T15: Malformed phone +977-abcdef -> invalid
const t15 = classifyNepalPhone('+977-abcdef');
assertEq('T15: +977-abcdef is invalid', t15.type, 'invalid');

// T16: NTC CDMA prefix 9741234567 -> mobile
const t16 = classifyNepalPhone('9741234567');
assertEq('T16: 9741234567 is mobile', t16.type, 'mobile');
assertBool('T16: 974 is in NTA_MOBILE_PREFIXES', NTA_MOBILE_PREFIXES.includes('974'));

// T17: NTC CDMA prefix 9751234567 -> mobile
const t17 = classifyNepalPhone('9751234567');
assertEq('T17: 9751234567 is mobile', t17.type, 'mobile');
assertBool('T17: 975 is in NTA_MOBILE_PREFIXES', NTA_MOBILE_PREFIXES.includes('975'));

// T18: Regional landline 061-520123 (Pokhara) -> landline, digits='61520123'
const t18 = classifyNepalPhone('061-520123');
assertEq('T18: 061-520123 is landline', t18.type, 'landline');
assertEq('T18: 061-520123 canonical digits', t18.digits, '61520123');

// T19: phones intersect mobiles = empty set invariant verified
const mobilePhones = ['9808222425', '9841234567', '9701234567', '9741234567', '9751234567'];
const landlinePhones = ['01-4444356', '+977-1-4444356', '01-5363501', '061-520123'];
const mobileDigits = new Set(mobilePhones.map((p) => classifyNepalPhone(p).digits));
const landlineDigits = new Set(landlinePhones.map((p) => classifyNepalPhone(p).digits));
const intersection = [...mobileDigits].filter((d) => landlineDigits.has(d));
assertEq('T19: phones ∩ mobiles is empty', intersection.length, 0);

console.log(`\n================================================================`);
console.log(`🎉 ALL ${passed} TASK 4 NEPAL PHONE PARSING TESTS PASSED!`);
console.log(`================================================================\n`);
