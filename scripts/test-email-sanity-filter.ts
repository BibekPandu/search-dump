import {
  extractEmails,
  MEDIA_DPR_PATTERN,
  IMAGE_FILE_TLDS,
} from '../src/services/business-extractor.service';

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
console.log('🧪 TASK 5: MEDIA FILENAME & ASSET EMAIL SANITIZER TESTS (12 CASES)');
console.log('================================================================\n');

// T1: asset-2@4x.png -> REJECTED (DPR pattern + image extension)
const t1 = extractEmails('Our header asset is asset-2@4x.png for retina screens');
assertEq('T1: asset-2@4x.png rejected', t1.includes('asset-2@4x.png'), false);
assertBool('T1: Media DPR pattern matches asset-2@4x.png', MEDIA_DPR_PATTERN.test('asset-2@4x.png'));

// T2: hero-banner@2x.jpg -> REJECTED (Retina image)
const t2 = extractEmails('Download hero-banner@2x.jpg here');
assertEq('T2: hero-banner@2x.jpg rejected', t2.includes('hero-banner@2x.jpg'), false);
assertBool('T2: Media DPR pattern matches hero-banner@2x.jpg', MEDIA_DPR_PATTERN.test('hero-banner@2x.jpg'));

// T3: logo@3x.webp -> REJECTED (DPR image)
const t3 = extractEmails('Our logo is logo@3x.webp');
assertEq('T3: logo@3x.webp rejected', t3.includes('logo@3x.webp'), false);
assertBool('T3: Media DPR pattern matches logo@3x.webp', MEDIA_DPR_PATTERN.test('logo@3x.webp'));

// T4: icon@1.5x.svg -> REJECTED (Float DPR image)
const t4 = extractEmails('Small icon: icon@1.5x.svg in navigation');
assertEq('T4: icon@1.5x.svg rejected', t4.includes('icon@1.5x.svg'), false);

// T5: photo@gallery.png -> REJECTED (Image TLD)
const t5 = extractEmails('Check out photo@gallery.png from the event');
assertEq('T5: photo@gallery.png rejected', t5.includes('photo@gallery.png'), false);
assertBool('T5: IMAGE_FILE_TLDS contains png', IMAGE_FILE_TLDS.has('png'));

// T6: user@mockup.jpeg -> REJECTED (Image TLD)
const t6 = extractEmails('File attached: user@mockup.jpeg');
assertEq('T6: user@mockup.jpeg rejected', t6.includes('user@mockup.jpeg'), false);
assertBool('T6: IMAGE_FILE_TLDS contains jpeg', IMAGE_FILE_TLDS.has('jpeg'));

// T7: contact@example.com -> REJECTED (Existing placeholder filter)
const t7 = extractEmails('Default email: contact@example.com');
assertEq('T7: contact@example.com rejected', t7.includes('contact@example.com'), false);

// T8: info@company.com -> ACCEPTED (Valid business email)
const t8 = extractEmails('Official contact: info@company.com');
assertBool('T8: info@company.com accepted', t8.includes('info@company.com'));

// T9: mukti.gooddeal@gmail.com -> ACCEPTED by Task 5 (valid email string; role classification handled in Task 3)
const t9 = extractEmails('Reach Dr. Mukti at mukti.gooddeal@gmail.com');
assertBool('T9: mukti.gooddeal@gmail.com accepted by sanitizer', t9.includes('mukti.gooddeal@gmail.com'));

// T10: support@hospital.org.np -> ACCEPTED (Valid ccTLD email)
const t10 = extractEmails('Hospital inquiries: support@hospital.org.np');
assertBool('T10: support@hospital.org.np accepted', t10.includes('support@hospital.org.np'));

// T11: HTML snippet with image tags alongside real email -> only real email extracted
const htmlSnippet = `
  <div class="header">
    <img src="/images/logo@2x.png" alt="Company Logo" />
    <img src="/assets/hero-banner@4x.webp" alt="Hero" />
    <p>Contact us at <a href="mailto:contact@clinic.com.np">contact@clinic.com.np</a></p>
    <a href="/downloads/icon@3x.svg">Download Icon</a>
  </div>
`;
const t11 = extractEmails(htmlSnippet);
assertBool('T11: contact@clinic.com.np extracted from HTML', t11.includes('contact@clinic.com.np'));
assertEq('T11: logo@2x.png not extracted', t11.includes('logo@2x.png'), false);
assertEq('T11: hero-banner@4x.webp not extracted', t11.includes('hero-banner@4x.webp'), false);
assertEq('T11: icon@3x.svg not extracted', t11.includes('icon@3x.svg'), false);
assertEq('T11: Exactly 1 email extracted from snippet', t11.length, 1);

// T12: Markdown snippet with retina badges and valid emails -> only valid emails extracted
const markdownSnippet = `
# Welcome to Om Samaj Dental
![Banner](https://omsamaj.org.np/assets/banner@2x.jpg)
Email us for appointments: appointments@omsamaj.org.np or info@omsamaj.org.np.
Download our brochure: [Brochure Graphic](brochure-graphic@4x.png).
`;
const t12 = extractEmails(markdownSnippet);
assertBool('T12: appointments@omsamaj.org.np extracted', t12.includes('appointments@omsamaj.org.np'));
assertBool('T12: info@omsamaj.org.np extracted', t12.includes('info@omsamaj.org.np'));
assertEq('T12: banner@2x.jpg not extracted', t12.includes('banner@2x.jpg'), false);
assertEq('T12: brochure-graphic@4x.png not extracted', t12.includes('brochure-graphic@4x.png'), false);
assertEq('T12: Exactly 2 emails extracted', t12.length, 2);

console.log(`\n================================================================`);
console.log(`🎉 ALL ${passed} TASK 5 EMAIL SANITY FILTER TESTS PASSED!`);
console.log(`================================================================\n`);
