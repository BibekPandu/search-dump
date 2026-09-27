import assert from 'node:assert';
import {
  cleanBranchAddress,
  extractStructuredBranchBlocks,
  extractAllFromPages,
} from '@/services/business-extractor.service';
import { attributeMultiBranchContacts } from '@/services/resolution/entity-resolution.service';
import { sanitizeListingWithEvidence } from '@/mastra/workflows/research-workflow.js';

console.log('=== Running M2C Structured Branch Attribution Tests ===\n');

// 1. Test cleanBranchAddress
const dirtyContext1 = 's://csc.edu.np/wp-content/uploads/2024/03/CSC-Global-Final-03.png)](https://csc.edu.np/) CSC New Baneshwor, Kathmandu +977-1-4585349 [get direction](https://maps.app.goo.gl/F3qraf4VBnJnFSA76)';
const clean1 = cleanBranchAddress(dirtyContext1, 'CSC Global');
assert(clean1, 'cleanBranchAddress should return cleaned address');
assert(!clean1.includes('png'), 'cleanBranchAddress must strip image filenames');
assert(!clean1.includes('http'), 'cleanBranchAddress must strip URLs');
assert(!clean1.includes('4585349'), 'cleanBranchAddress must strip phone numbers');
assert(!clean1.includes('get direction'), 'cleanBranchAddress must strip CTA phrases');
assert(clean1.includes('New Baneshwor, Kathmandu'), 'cleanBranchAddress should preserve readable address');

const dirtyContext2 = 'ore About Us]( Our Offices CSC Kumaripati, Lalitpur , get direction CSC Putalisadak, Kathmandu +977-98418';
const clean2 = cleanBranchAddress(dirtyContext2, 'CSC Global');
assert(clean2, 'cleanBranchAddress should return cleaned address for dirtyContext2');
assert(!clean2.includes('98418'), 'cleanBranchAddress must strip phone numbers');
assert(!clean2.includes('get direction'), 'cleanBranchAddress must strip get direction');
assert(!clean2.includes('About Us'), 'cleanBranchAddress must strip About Us navigation');

// 2. Test CSC Global-style structured HTML page
const cscGlobalHtml = `
<div class="offices">
  <h2>Our Offices</h2>
  <div class="office-block">
    <h3>CSC Kamaladi, Kathmandu</h3>
    <p>Heritage Plaza, Kamaladi, Kathmandu</p>
    <a href="tel:+977-1-5912962">+977-1-5912962</a>
    <a href="tel:+977-1-5912963">+977-1-5912963</a>
    <a href="https://maps.app.goo.gl/JZbhcLuJi88xzfpd8">get direction</a>
  </div>
  <div class="office-block">
    <h3>CSC New Baneshwor, Kathmandu</h3>
    <p>Opposite Birendra International Convention Centre, New Baneshwor, Kathmandu</p>
    <a href="tel:+977-1-4585349">+977-1-4585349</a>
    <a href="tel:+977-9851043857">+977-9851043857</a>
    <a href="https://maps.app.goo.gl/QGDe4F2z4y8U81V29">get direction</a>
  </div>
  <div class="office-block">
    <h3>CSC Chitwan</h3>
    <p>Lions Chowk, Narayangarh, Bharatpur, Chitwan</p>
    <a href="tel:+977-056-596261">+977-056-596261</a>
    <a href="tel:+977-9866348919">+977-9866348919</a>
    <a href="https://maps.app.goo.gl/BWdnY4VtP2tqYUm78">get direction</a>
  </div>
  <div class="office-block">
    <h3>CSC Butwal</h3>
    <p>Traffic Chowk, Butwal, Rupandehi</p>
    <a href="tel:+977-71-590118">+977-71-590118</a>
    <a href="https://maps.app.goo.gl/Xyz123">get direction</a>
  </div>
  <div class="office-block">
    <h3>CSC Kumaripati, Lalitpur</h3>
    <p>Kumaripati, Lalitpur</p>
    <a href="tel:+977-1-5532074">+977-1-5532074</a>
  </div>
</div>
`;

const blocks = extractStructuredBranchBlocks(cscGlobalHtml, 'CSC Global', 'https://csc.edu.np/');
assert.strictEqual(blocks.length, 5, 'Should extract 5 distinct branch blocks');

const baneshworBlock = blocks.find((b) => b.branchLabel.includes('Baneshwor') || b.heading.includes('Baneshwor'));
assert(baneshworBlock, 'Must find Baneshwor branch block');
assert(baneshworBlock.phones.includes('+977-1-4585349') || baneshworBlock.phones.some((p) => p.includes('4585349')), 'Baneshwor must contain its landline');
assert(baneshworBlock.mobiles.includes('+977-9851043857') || baneshworBlock.mobiles.some((m) => m.includes('9851043857')), 'Baneshwor must contain its mobile');
assert(!baneshworBlock.phones.some((p) => p.includes('596261')), 'Baneshwor must NOT contain Chitwan phone');

const chitwanBlock = blocks.find((b) => b.branchLabel.includes('Chitwan') || b.heading.includes('Chitwan'));
assert(chitwanBlock, 'Must find Chitwan branch block');
assert(chitwanBlock.phones.some((p) => p.includes('596261')), 'Chitwan must contain its landline');
assert(!chitwanBlock.phones.some((p) => p.includes('4585349')), 'Chitwan must NOT contain Baneshwor phone');

const butwalBlock = blocks.find((b) => b.branchLabel.includes('Butwal') || b.heading.includes('Butwal'));
assert(butwalBlock, 'Must find Butwal branch block');
assert(butwalBlock.phones.some((p) => p.includes('590118')), 'Butwal must contain its landline');

// 3. Test extractAllFromPages with structured branch blocks
const pageEvidence = [
  {
    url: 'https://csc.edu.np/',
    content: '',
    rawHtml: cscGlobalHtml,
    success: true,
    favicon: '',
    discoverySource: 'homepage' as const,
    pageType: 'home' as const,
  },
];

const extracted = extractAllFromPages(pageEvidence, 'CSC Global', 'https://csc.edu.np/');
const classifiedContacts = extracted.extractedClassifiedContacts || [];

assert(classifiedContacts.length >= 5, 'Must extract classified contacts for each branch');

// Check attribution targeting Putalisadak, Kathmandu
const attributions = attributeMultiBranchContacts(
  classifiedContacts,
  'Putalisadak, Kathmandu',
  undefined,
  undefined,
  null,
  'CSC Global'
);

for (const attr of attributions) {
  const digits = attr.contact.canonicalDigits || '';
  if (digits.includes('596261')) {
    assert.strictEqual(attr.attribution, 'branch_contact', 'Chitwan phone must be attributed as branch_contact');
    assert(attr.branchLabel?.includes('Chitwan'), 'Chitwan attribution label must identify Chitwan');
  }
  if (digits.includes('590118')) {
    assert.strictEqual(attr.attribution, 'branch_contact', 'Butwal phone must be attributed as branch_contact');
    assert(attr.branchLabel?.includes('Butwal'), 'Butwal attribution label must identify Butwal');
  }
}

// 4. End-to-end branch test
const cscCandidate = {
  title: 'CSC Global',
  name: 'CSC Global',
  url: 'https://csc.edu.np',
  domain: 'csc.edu.np',
  phone: '+977-1-5912962',  // Kamaladi branch (Maps-confirmed main phone)
  source: 'google_maps' as const,
};
const cscListing = {
  name: 'CSC Global',
  location: 'Putalisadak, Kathmandu',
  phones: [], mobiles: [], emails: [], websites: ['https://csc.edu.np'],
};
const cscEvidence = {
  candidate: cscCandidate,
  sourceHealth: 'verified',
  websiteRelationship: 'first_party',
  verification: { overallConfidence: 0.8 },
  websiteEvidence: {
    extractedSocialLinks: {},
    extractedClassifiedContacts: classifiedContacts, // populated from extractAllFromPages
    rawHtmlPages: [{ url: 'https://csc.edu.np/', rawHtml: cscGlobalHtml, success: true }],
  }
};

const finalListing = sanitizeListingWithEvidence(cscListing as any, cscEvidence as any);

// Assert branch count
assert(finalListing.otherDetails?.branches && finalListing.otherDetails.branches.length >= 4, `Expected >=4 branches`);

// Find Baneshwor branch
const baneshwor = finalListing.otherDetails.branches.find((b: any) => b.name?.includes('Baneshwor'));
assert(baneshwor, 'Must find Baneshwor branch in final listing');
assert(baneshwor.phones?.some((p: string) => p.includes('4585349')), 'Baneshwor must have its own phone');
assert(!baneshwor.phones?.some((p: string) => p.includes('596261')), 'Baneshwor must NOT have Chitwan phone');
assert(!baneshwor.phones?.some((p: string) => p.includes('590118')), 'Baneshwor must NOT have Butwal phone');

// Find Chitwan branch
const chitwan = finalListing.otherDetails.branches.find((b: any) => b.name?.includes('Chitwan'));
assert(chitwan, 'Must find Chitwan branch');
assert(chitwan.phones?.some((p: string) => p.includes('596261')), 'Chitwan must have its own phone');
assert(!chitwan.phones?.some((p: string) => p.includes('4585349')), 'Chitwan must NOT have Baneshwor phone');

// Assert no HTML fragments in any branch address
for (const branch of finalListing.otherDetails.branches) {
  assert(
    !/<\/?[a-z]/i.test(branch.address || ''),
    `HTML tag in branch address: "${branch.address}"`
  );
  assert(
    !/\.(png|jpg|webp|svg)/i.test(branch.address || ''),
    `Image filename in branch address: "${branch.address}"`
  );
}

console.log('M2C structured branch attribution tests passed.\n');
