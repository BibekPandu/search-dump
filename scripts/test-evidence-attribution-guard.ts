/**
 * Unit tests for namesAlignForEvidence attribution guard.
 * Validates:
 * 1. Legitimate duplicate resolution (Samaj, Om Samaj, Big Smile).
 * 2. Surname empty-set fallback (Kandel Consultancy).
 * 3. Prevention of cross-candidate false binds (Rain/BMW/DAB/Englishers vs KTM Educational).
 * 4. Cross-industry single-token collision protection (Apex Law vs Apex Dental).
 */
import { namesAlignForEvidence } from '../src/services/resolution/entity-resolution.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log('--- Running Evidence Attribution Guard Tests ---');

// 1. Positive: Legitimate duplicate pairs with >= 2 shared distinctive tokens
assert(
  namesAlignForEvidence(
    'Om Samaj Dental Hospital',
    'Om Samaj Dental'
  ) === true,
  'Om Samaj Dental Hospital matches Om Samaj Dental (>= 2 shared brand tokens)'
);

assert(
  namesAlignForEvidence(
    'Big Smile Dental',
    'Big Smile Dental Clinic & Prosthodontic Center'
  ) === true,
  'Big Smile Dental matches Big Smile Dental Clinic (>= 2 shared brand tokens)'
);

// 2. Positive: Single distinctive brand token with phone or domain match
assert(
  namesAlignForEvidence(
    'Samaj Dental Hospital',
    'Samaj Dental Care Clinic',
    { phoneMatches: true }
  ) === true,
  'Samaj Dental matches Samaj Dental Care with phone corroboration'
);

assert(
  namesAlignForEvidence(
    'Samaj Dental Hospital',
    'Samaj Dental Care Clinic',
    { domainMatches: true }
  ) === true,
  'Samaj Dental matches Samaj Dental Care with domain corroboration'
);

// 3. Positive: Surname empty-set fallback (Kandel Consultancy)
assert(
  namesAlignForEvidence(
    'Kandel Consultancy',
    'Kandel Consultancy'
  ) === true,
  'Kandel Consultancy matches Kandel Consultancy (surname fallback)'
);

assert(
  namesAlignForEvidence(
    'Kandel Consultancy Education Kathmandu',
    'Kandel Consultancy',
    { phoneMatches: true }
  ) === true,
  'Kandel Consultancy Education Kathmandu matches Kandel Consultancy with phone'
);

// 4. Negative: Surnames collision prevention
assert(
  namesAlignForEvidence(
    'Kandel Consultancy',
    'Sharma Consultancy'
  ) === false,
  'Kandel Consultancy does NOT match Sharma Consultancy'
);

// 5. Negative: Cross-candidate false binding prevention (The core KTM bug)
assert(
  namesAlignForEvidence(
    'Rain Educational Consultancy',
    'KTM Educational Consultancy Pvt Ltd',
    { phoneMatches: true } // Even with phone matching!
  ) === false,
  'Rain Educational Consultancy NEVER matches KTM Educational even if phone matches'
);

assert(
  namesAlignForEvidence(
    'BMW Educational Consultancy',
    'KTM Educational Consultancy Pvt Ltd',
    { phoneMatches: true }
  ) === false,
  'BMW Educational Consultancy NEVER matches KTM Educational even if phone matches'
);

assert(
  namesAlignForEvidence(
    'Englishers Educational Consultancy',
    'KTM Educational Consultancy Pvt Ltd',
    { phoneMatches: true }
  ) === false,
  'Englishers Educational Consultancy NEVER matches KTM Educational even if phone matches'
);

assert(
  namesAlignForEvidence(
    'Best Consultancy in Kathmandu - DAB Educational Consultancy',
    'KTM Educational Consultancy Pvt Ltd',
    { phoneMatches: true }
  ) === false,
  'DAB Educational Consultancy NEVER matches KTM Educational even if phone matches'
);

// 6. Negative: Cross-industry single token collision without phone/domain corroboration
assert(
  namesAlignForEvidence(
    'Apex Law Associates',
    'Apex Dental Clinic',
    { phoneMatches: false, domainMatches: false }
  ) === false,
  'Apex Law Associates does NOT match Apex Dental Clinic without corroboration'
);

// 7. Positive: Candidate binds to its own evidence
assert(
  namesAlignForEvidence(
    'Rain Educational Consultancy',
    'Rain Educational Consultancy',
    { phoneMatches: true }
  ) === true,
  'Rain Educational Consultancy binds to Rain Educational Consultancy'
);

assert(
  namesAlignForEvidence(
    'Englishers Educational Consultancy',
    'Englishers Educational Consultancy',
    { phoneMatches: true }
  ) === true,
  'Englishers Educational Consultancy binds to Englishers Educational Consultancy'
);

console.log('All 14 Evidence Attribution Guard tests passed successfully!');
