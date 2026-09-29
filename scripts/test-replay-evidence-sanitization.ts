/**
 * Replay fixture test for evidence attribution & sanitization.
 * Replays the 5 consultancies from run 2026-09-29T08-16-07-683Z-consultancy-in-kathmandu
 * through matchListingToEvidence and sanitizeListingWithEvidence.
 * Asserts each entity binds to its own evidence and retains its authentic website & phone.
 */
import fs from 'fs';
import path from 'path';
import { matchListingToEvidence, sanitizeListingWithEvidence } from '../src/services/resolution/listing-sanitizer.service';
import type { BusinessListing } from '../src/types/business-listing';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`PASS: ${message}`);
  }
}

const runDir = path.resolve('output/history/2026-09-29T08-16-07-683Z-consultancy-in-kathmandu');
const evFile = JSON.parse(fs.readFileSync(path.join(runDir, '2b-verified-evidence.json'), 'utf-8'));
const evidenceList = Array.isArray(evFile) ? evFile : evFile.verifiedEvidence || [];

console.log(`Loaded ${evidenceList.length} verified evidence records from run.`);

// Test Case 1: Corrupted Rain listing (contaminated with KTM's phone & website by LLM hallucination)
const contaminatedRainListing: BusinessListing = {
  name: 'Rain Educational Consultancy',
  location: 'Kathmandu 44600',
  emails: [],
  phones: ['+977-01-4526263'], // Contaminated phone from KTM
  mobiles: [],
  websites: ['http://ktmeducational.edu.np/'], // Contaminated website from KTM
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: {
    address: 'Kathmandu 44600',
    businessDescription: 'Educational consultant in Kathmandu 44600. Phone: 01-4010551.',
    placeId: '6222809028413550552',
  },
  metadata: {
    source: 'google_maps',
    extractedAt: new Date().toISOString(),
    confidence: 0.8,
  },
  process: 'Verified via Google Maps Places (Direct)',
  links: ['https://raineducation.edu.np/'],
  placeId: '6222809028413550552',
};

const rainEvidence = matchListingToEvidence(contaminatedRainListing, evidenceList);
assert(Boolean(rainEvidence), 'Rain listing matched an evidence record');
assert(
  rainEvidence?.candidate?.name === 'Rain Educational Consultancy',
  `Rain listing bound to "${rainEvidence?.candidate?.name}" (MUST BE Rain Educational Consultancy, NOT KTM)`
);
assert(
  rainEvidence?.candidate?.phone === '01-4010551',
  `Rain matched evidence phone is "${rainEvidence?.candidate?.phone}" (expected 01-4010551)`
);

const sanitizedRain = sanitizeListingWithEvidence(contaminatedRainListing, rainEvidence!);
assert(
  sanitizedRain.websites.includes('https://raineducation.edu.np/'),
  `Sanitized Rain listing restored authentic website: ${JSON.stringify(sanitizedRain.websites)}`
);
assert(
  !sanitizedRain.websites.some(w => w.includes('ktmeducational.edu.np')),
  'Sanitized Rain listing purged KTM educational website'
);

// Test Case 2: Englishers contaminated listing
const contaminatedEnglishersListing: BusinessListing = {
  name: 'Englishers Educational Consultancy',
  location: 'Bag Bazar Sadak, Kathmandu 44600',
  emails: [],
  phones: ['+977-01-4526263'], // Contaminated phone from KTM
  mobiles: [],
  websites: ['http://ktmeducational.edu.np/'], // Contaminated website from KTM
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: {
    address: 'Bag Bazar Sadak, Kathmandu 44600',
    businessDescription: 'Educational consultant in Bag Bazar Sadak, Kathmandu 44600. Phone: 01-5312816.',
    placeId: '1667166570963258160',
  },
  metadata: {
    source: 'google_maps',
    extractedAt: new Date().toISOString(),
    confidence: 0.8,
  },
  process: 'Verified via Google Maps Places (Direct)',
  links: ['http://englishers.net/'],
  placeId: '1667166570963258160',
};

const englishersEvidence = matchListingToEvidence(contaminatedEnglishersListing, evidenceList);
assert(
  englishersEvidence?.candidate?.name === 'Englishers Educational Consultancy',
  `Englishers bound to "${englishersEvidence?.candidate?.name}" (MUST BE Englishers, NOT KTM)`
);

const sanitizedEnglishers = sanitizeListingWithEvidence(contaminatedEnglishersListing, englishersEvidence!);
assert(
  sanitizedEnglishers.websites.includes('http://englishers.net/'),
  `Sanitized Englishers restored authentic website: ${JSON.stringify(sanitizedEnglishers.websites)}`
);
assert(
  !sanitizedEnglishers.websites.some(w => w.includes('ktmeducational.edu.np')),
  'Sanitized Englishers purged KTM educational website'
);

// Test Case 3: BMW Educational Consultancy contaminated listing
const contaminatedBmwListing: BusinessListing = {
  name: 'BMW Educational Consultancy',
  location: 'to, Kathmandu 44600',
  emails: [],
  phones: ['+977-01-4526263'],
  mobiles: [],
  websites: ['http://ktmeducational.edu.np/'],
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: {
    address: 'to, Kathmandu 44600',
    placeId: '3664421114139038732',
  },
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.8 },
  process: 'Verified via Google Maps Places (Direct)',
  links: [],
  placeId: '3664421114139038732',
};

const bmwEvidence = matchListingToEvidence(contaminatedBmwListing, evidenceList);
assert(
  bmwEvidence?.candidate?.name === 'BMW Educational Consultancy',
  `BMW bound to "${bmwEvidence?.candidate?.name}" (MUST BE BMW Educational, NOT KTM)`
);
const sanitizedBmw = sanitizeListingWithEvidence(contaminatedBmwListing, bmwEvidence!);
assert(
  sanitizedBmw.websites.includes('http://bmwconsultancy.com/'),
  `Sanitized BMW restored authentic website: ${JSON.stringify(sanitizedBmw.websites)}`
);

// Test Case 4: DAB Educational Consultancy contaminated listing
const contaminatedDabListing: BusinessListing = {
  name: 'Best Consultancy in Kathmandu - DAB Educational Consultancy',
  location: 'Dilli Bazar Height Marg, Kathmandu 44600',
  emails: [],
  phones: ['+977-01-4526263'],
  mobiles: [],
  websites: ['http://ktmeducational.edu.np/'],
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: {
    address: 'Dilli Bazar Height Marg, Kathmandu 44600',
    placeId: '10150107791122081699',
  },
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.8 },
  process: 'Verified via Google Maps Places (Direct)',
  links: [],
  placeId: '10150107791122081699',
};

const dabEvidence = matchListingToEvidence(contaminatedDabListing, evidenceList);
assert(
  dabEvidence?.candidate?.name === 'Best Consultancy in Kathmandu - DAB Educational Consultancy',
  `DAB bound to "${dabEvidence?.candidate?.name}" (MUST BE DAB, NOT KTM)`
);
const sanitizedDab = sanitizeListingWithEvidence(contaminatedDabListing, dabEvidence!);
assert(
  sanitizedDab.websites.includes('https://dab.bnbgroup.com.np/'),
  `Sanitized DAB restored authentic website: ${JSON.stringify(sanitizedDab.websites)}`
);

// Test Case 5: Authentic KTM Educational Consultancy listing
const authenticKtmListing: BusinessListing = {
  name: 'KTM Educational Consultancy Pvt Ltd',
  location: 'Kathmandu, Bagmati Province 44600',
  emails: [],
  phones: ['+977-01-4526263'],
  mobiles: [],
  websites: ['http://ktmeducational.edu.np/'],
  icon: '',
  socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
  otherDetails: {
    address: 'Kathmandu, Bagmati Province 44600',
    placeId: 'ChIJ1aK0_gcZ6zkRjKEJ__0TZVI',
  },
  metadata: { source: 'google_maps', extractedAt: new Date().toISOString(), confidence: 0.8 },
  process: 'Verified via Google Maps Places (Direct)',
  links: [],
  placeId: 'ChIJ1aK0_gcZ6zkRjKEJ__0TZVI',
};

const ktmEvidence = matchListingToEvidence(authenticKtmListing, evidenceList);
assert(
  ktmEvidence?.candidate?.name === 'KTM Educational Consultancy Pvt Ltd',
  `KTM listing bound to "${ktmEvidence?.candidate?.name}"`
);
const sanitizedKtm = sanitizeListingWithEvidence(authenticKtmListing, ktmEvidence!);
assert(
  sanitizedKtm.websites.includes('http://ktmeducational.edu.np/'),
  'KTM retains http://ktmeducational.edu.np/'
);

console.log('--- ALL REPLAY SANITIZATION TESTS PASSED! ---');
