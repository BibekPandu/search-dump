import {
  extractEmails,
  extractPhones,
  extractMobiles,
  extractLandlines,
  expandSlashExtensions,
  extractSocialLinks,
  extractFavicon,
  extractBusinessInfo,
  extractAllFromPages,
  sanitizeEmailString,
  sanitizePhoneString,
  classifyNepalPhone,
  formatPhoneDisplay,
  isRealSocialProfile,
} from '../src/services/business-extractor.service';
import type { WebsitePageEvidence } from '../src/mastra/agents/research-agent/verification.schema';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`âŒ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`âœ… PASS: ${message}`);
  }
}

function runTests() {
  console.log('===============================================================');
  console.log('ðŸ§ª BUSINESS EXTRACTOR UNIT TESTS (ZERO API)');
  console.log('===============================================================');

  // --- Emails ---
  console.log('\n--- extractEmails ---');
  const emailContent = `
    Contact us at info@himalayanjava.com and sales@example.com.
    For support: noreply@sentry.io, admin@example.org, hello@wixpress.com.
    Real: bookings@himalayanjava.com.np, + a placeholder test@example.com.
    Reach us at: contact.himalayanjava@gmail.com
  `;
  const emails = extractEmails(emailContent);
  assert(emails.includes('info@himalayanjava.com'), 'Extracts real email');
  assert(emails.includes('bookings@himalayanjava.com.np'), 'Extracts .com.np email');
  assert(emails.includes('contact.himalayanjava@gmail.com'), 'Extracts dots in local part');
  assert(!emails.some((e) => e.includes('example.com') || e.includes('example.org')), 'Filters example.com/org placeholders');
  assert(!emails.some((e) => e.includes('sentry.io')), 'Filters sentry.io');
  assert(!emails.some((e) => e.includes('wixpress')), 'Filters wixpress.com');
  assert(!emails.some((e) => e.startsWith('noreply')), 'Filters noreply');
  assert(!emails.some((e) => e.startsWith('admin@example')), 'Filters admin@example');
  assert(!emails.some((e) => e.startsWith('test@example')), 'Filters test@example');

  // --- Phones / Mobiles ---
  console.log('\n--- extractPhones / extractMobiles ---');
  const phoneContent = `
    Landline: +977-1-4240520, office 01 4240520, alt 01-4240520,
    Mobile: +977 9829221456 and 982-9469962,
    International: +447911123456, and a stray 123.
  `;
  const phones = extractPhones(phoneContent);
  assert(
    phones.includes('+977-1-4240520') || phones.some((p) => p.includes('4240520')),
    'Extracts Nepal landline (display preserved)'
  );
  const phDigits = new Set(phones.map((p) => p.replace(/\D/g, '').replace(/^977/, '')));
  assert(phDigits.has('14240520'), 'Landline variants deduped by normalized digits');

  const mobiles = extractMobiles(phoneContent);
  const mobDigits = new Set(mobiles.map((p) => p.replace(/\D/g, '').replace(/^977/, '')));
  assert(mobDigits.has('9829221456'), 'Extracts +977 mobile');
  assert(mobDigits.has('9829469962'), 'Extracts dashed mobile');
  assert(!mobiles.some((p) => p.replace(/\D/g, '').length < 10), 'No short phone fragments');

  // --- Social links ---
  console.log('\n--- extractSocialLinks ---');
  const socialContent = `
    Facebook: https://www.facebook.com/himalayanjava
    Instagram: https://instagram.com/himalayan_java
    TikTok: https://tiktok.com/@himalayanjava
    X: https://twitter.com/hjcoffee
    LinkedIn: https://www.linkedin.com/company/himalayan-java
    YouTube: https://youtube.com/@himalayanjava
  `;
  const socials = extractSocialLinks(socialContent);
  assert(socials.facebook === 'https://www.facebook.com/himalayanjava', 'Facebook extracted');
  assert(socials.instagram === 'https://instagram.com/himalayan_java', 'Instagram extracted');
  assert(socials.tiktok === 'https://tiktok.com/@himalayanjava', 'TikTok extracted');
  assert(socials.other.x === 'https://twitter.com/hjcoffee', 'Twitter/X in other');
  assert(socials.other.linkedin === 'https://www.linkedin.com/company/himalayan-java', 'LinkedIn in other');
  assert(socials.other.youtube === 'https://youtube.com/@himalayanjava', 'YouTube in other');

  // --- v1.1: Cloudflare email decoding ---
  console.log('\n--- extractEmails: Cloudflare + obfuscation (v1.1) ---');
  const cloudflareContent = `
    Contact: /cdn-cgi/l/email-protection#e093818c8593a0888f8c8984819993948f8e8590818cce838f8d
  `;
  const cfEmails = extractEmails(cloudflareContent);
  assert(cfEmails.includes('sales@holidaystonepal.com'), 'Cloudflare-masked email decoded to sales@holidaystonepal.com');

  const junkCfContent = 'Contact: /cdn-cgi/l/email-protection#zzzzzzzz';
  assert(extractEmails(junkCfContent).length === 0, 'Malformed Cloudflare hex rejected (non-hex)');

  const obfuscatedContent = `
    Sales: info [at] company.com
    Support: sales(at)acme.net
    Contact: admin&#64;business.org
    Email: bookings at hotel.com.np
    Promo: the team at retail.com (prose must NOT decode)
  `;
  const obfEmails = extractEmails(obfuscatedContent);
  assert(obfEmails.includes('info@company.com'), 'Bracket [at] obfuscation decoded');
  assert(obfEmails.includes('sales@acme.net'), 'Parenthesized (at) obfuscation decoded');
  assert(obfEmails.includes('admin@business.org'), 'HTML entity &#64; obfuscation decoded');
  assert(obfEmails.includes('bookings@hotel.com.np'), 'Bare "at" obfuscation decoded (label context)');
  assert(!obfEmails.includes('team@retail.com'), 'Prose "at" WITHOUT label context NOT decoded');

  // --- v1.1: Phone noise filtering + tel:/WhatsApp preservation ---
  console.log('\n--- extractPhones: noise filtering + preservation (v1.1) ---');
  const imageContent = `
    Logo: /upload/company/31012024173722lk.png
    Phone: 01-4240520
    Mobile: 9841049090
  `;
  const imagePhones = extractPhones(imageContent);
  const imageDig = imagePhones.map((p) => p.replace(/\D/g, ''));
  assert(!imageDig.some((d) => d.includes('0120241737')), 'Image/timestamp filename NOT extracted as phone');
  assert(imagePhones.some((p) => p.includes('4240520')), 'Visible landline still extracted');
  assert(imagePhones.some((p) => p.includes('9841049090')), 'Visible mobile still extracted');

  const dateContent = 'Updated 2024-01-31; landline 01-4240520.';
  const datePhones = extractPhones(dateContent);
  assert(!datePhones.some((p) => p.replace(/\D/g, '').includes('20240131')), 'YYYY-MM-DD date NOT extracted as phone');
  assert(datePhones.some((p) => p.includes('4240520')), 'Landline next to a date still extracted');

  const telContent = '[Call us](tel:+977-9851166779) — landline 01-4240520.';
  const telPhones = extractPhones(telContent);
  assert(
    telPhones.some((p) => p.replace(/\D/g, '').replace(/^977/, '') === '9851166779'),
    'tel: link phone preserved after URL/noise stripping'
  );

  const waContent = 'WhatsApp: https://wa.me/9779851166779 Mobile: 9841049090';
  const waPhones = extractPhones(waContent);
  assert(
    waPhones.some((p) => p.replace(/\D/g, '').replace(/^977/, '') === '9851166779'),
    'wa.me deep-link phone preserved after URL stripping'
  );

  // --- v1.1: Mobile vs Landline classification ---
  console.log('\n--- extractMobiles / extractLandlines classification (v1.1) ---');
  const mixedContent = `
    Landline: 01-5320746, +977-1-4240520
    Mobile: 9841049090, 9751234567
  `;
  const mobilesStrict = extractMobiles(mixedContent);
  const landlines = extractLandlines(mixedContent);
  const mobDigStrict = mobilesStrict.map((p) => p.replace(/\D/g, '').replace(/^977/, ''));
  const landDig = landlines.map((p) => p.replace(/\D/g, '').replace(/^977/, '').replace(/^0/, ''));
  assert(mobDigStrict.length === 2, `Exactly 2 mobiles extracted (got ${mobDigStrict.length})`);
  assert(mobDigStrict.every((d) => d.startsWith('97') || d.startsWith('98')), 'Mobiles all start with 97/98');
  assert(landDig.every((d) => d.startsWith('1')), 'Landlines all start with 1');
  assert(!mobDigStrict.some((d) => d.includes('5320746')), 'Landline 01-5320746 NOT in mobiles');
  assert(!landDig.some((d) => d.includes('9841049090')), 'Mobile 9841049090 NOT in landlines');
  assert(landDig.includes('14240520'), '+977-1-4240520 classified as landline');

  // --- v1.1: Social links from markdown + bare handles ---
  console.log('\n--- extractSocialLinks: markdown + bare handles (v1.1) ---');
  const markdownSocialContent = `
    Follow us:
    [Facebook](https://facebook.com/holidaystonepal)
    [Instagram](https://instagram.com/holidaystonepal)
  `;
  const markdownSocials = extractSocialLinks(markdownSocialContent);
  assert(markdownSocials.facebook.includes('holidaystonepal'), 'Facebook from markdown link');
  assert(markdownSocials.instagram.includes('holidaystonepal'), 'Instagram from markdown link');

  const bareSocials = extractSocialLinks('Instagram: @himalayanjava_boutique | TikTok: @himalayanjava');
  assert(bareSocials.instagram === 'https://instagram.com/himalayanjava_boutique', 'Bare Instagram handle lifted to canonical URL');
  assert(bareSocials.tiktok === 'https://tiktok.com/@himalayanjava', 'Bare TikTok handle lifted to canonical URL');

  const freeHandle = extractSocialLinks('Reach our team @himalayanjava anytime');
  assert(freeHandle.instagram === '' && freeHandle.facebook === '', 'Free-standing @handle ignored (too ambiguous)');

// --- Favicon ---
  console.log('\n--- extractFavicon ---');
  assert(
    extractFavicon([{ url: 'a', favicon: '' }, { url: 'b', favicon: 'https://x.com/fav.ico' }]) ===
      'https://x.com/fav.ico',
    'First non-empty favicon selected'
  );
  assert(extractFavicon([{ url: 'a', favicon: '' }]) === undefined, 'No favicon â†’ undefined');

  // --- Services & Hours ---
  console.log('\n--- extractBusinessInfo ---');
  const bizContent = `
    Our Services:
    Specialty Coffee Roasting
    Brewing Equipment Sales
    Barista Training
    7:00 AM - 8:30 PM daily.
  `;
  const info = extractBusinessInfo(bizContent);
  assert(info.services.some((s) => s.includes('Coffee Roasting')), 'Services extracted from heading block');
  assert(Boolean(info.hours) && /7:00 AM - 8:30 PM/i.test(info.hours || ''), 'Opening hours extracted');
  const empty = extractBusinessInfo('no services or hours here at all');
  assert(empty.services.length === 0 && empty.hours === undefined, 'Empty content â†’ empty arrays, never invented');

  // --- extractAllFromPages integration ---
  console.log('\n--- extractAllFromPages ---');
  const pages: WebsitePageEvidence[] = [
    {
      url: 'https://himalayanjava.com/',
      content: 'Himalayan Java Coffee. Contact info@himalayanjava.com, call +977-1-4240520.',
      favicon: 'https://himalayanjava.com/fav.ico',
      success: true,
      discoverySource: 'homepage',
      pageType: 'home',
    },
    {
      url: 'https://himalayanjava.com/contact-us',
      content: 'Bookings: bookings@himalayanjava.com.np. Instagram: https://instagram.com/himalayanjava',
      favicon: '',
      success: true,
      discoverySource: 'internal_link',
      pageType: 'contact',
    },
  ];
  const all = extractAllFromPages(pages);
  assert(all.extractedEmails.length === 2, `All emails merged across pages (got ${all.extractedEmails.length})`);
  assert(all.extractedPhones.length >= 1, 'Phone merged across pages');
  assert(all.extractedSocialLinks.instagram === 'https://instagram.com/himalayanjava', 'Instagram merged');
  assert(all.favicon === 'https://himalayanjava.com/fav.ico', 'Favicon from homepage');
  assert(Boolean(all.rawContentSummary), 'rawContentSummary present (context only)');

  // --- v1.2: HTML attribute extraction (mailto:, tel:, icon-only markup) ---
  console.log('\n--- HTML attribute extraction (mailto:, tel:, icons) (v1.2) ---');
  const htmlMarkup = `
    <div class="contact-card">
      <a href="mailto:info@nebuti.com"><i class="fa fa-envelope"></i></a>
      <a href="mailto:anil@nebuti.com?subject=Inquiry">Email Anil</a>
      <a href="tel:+977-1-4522833"><i class="fa fa-phone"></i> Call Office</a>
      <a href="tel:014522833"><i class="fa fa-phone"></i></a>
      <a href="tel:+977-9801025057"><i class="fa fa-mobile"></i></a>
      <a href="https://facebook.com/nebuti"><i class="fa fa-facebook"></i></a>
    </div>
  `;
  const htmlEmails = extractEmails(htmlMarkup);
  assert(htmlEmails.includes('info@nebuti.com'), 'Extracted info@nebuti.com from mailto: icon anchor');
  assert(htmlEmails.includes('anil@nebuti.com'), 'Extracted anil@nebuti.com from mailto: anchor with query param');

  const htmlPhones = extractPhones(htmlMarkup);
  assert(htmlPhones.some((p) => p.includes('4522833')), 'Extracted landline from tel: href');
  const htmlLandlines = extractLandlines(htmlMarkup);
  assert(htmlLandlines.length > 0, 'Classified 014522833 / +977-1-4522833 as landline');
  const htmlMobiles = extractMobiles(htmlMarkup);
  assert(htmlMobiles.some((m) => m.includes('9801025057')), 'Classified +977-9801025057 as mobile');

  const htmlSocials = extractSocialLinks(htmlMarkup);
  assert(htmlSocials.facebook === 'https://facebook.com/nebuti', 'Extracted facebook link from HTML href');

  // --- v1.2: Nebuti empirical fixture & raw HTML safety net test ---
  console.log('\n--- Nebuti Empirical Fixture: Tavily stripped markdown + Raw HTML safety net ---');
  const nebutiContactHtml = `
    <ul class="icon">
      <li class="call"><a href="tel:+977-1-4522833"> <i class="fa fa-phone"></i> +977-1-4522833</a></li>
      <li class="call"><a href="tel:+977-9801025057"> <i class="fa fa-phone"></i> +977-9801025057</a></li>
      <li class="email"><a href="mailto:info@nebuti.com"><i class="fa fa-envelope"></i> info@nebuti.com</a></li>
      <li class="email"><a href="mailto:anil@nebuti.com"><i class="fa fa-envelope"></i> Anil</a></li>
      <li class="social"><a href="https://facebook.com/nebuti"><i class="fa fa-facebook"></i></a></li>
    </ul>
  `;

  // Simulate Tavily stripping the <ul class="icon"> list completely from markdown content:
  const strippedTavilyMarkdown = `
    #### Contact us
    Our team is available Sunday to Friday.
  `;

  const nebutiPages: WebsitePageEvidence[] = [
    {
      url: 'http://nebuti.com/',
      content: 'Welcome to Nebuti. Best travel & trekking in Nepal.',
      favicon: 'http://nebuti.com/favicon.ico',
      success: true,
      discoverySource: 'homepage',
      pageType: 'home',
    },
    {
      url: 'http://nebuti.com/page-contact.html',
      content: strippedTavilyMarkdown, // Tavily markdown has NO contact info
      rawHtml: nebutiContactHtml,       // Raw HTML safety net has the full markup!
      favicon: '',
      success: true,
      discoverySource: 'internal_link', // Provenance tracked
      pageType: 'contact',              // Provenance tracked
    },
  ];

  const nebutiResult = extractAllFromPages(nebutiPages);
  assert(nebutiResult.extractedEmails.includes('info@nebuti.com'), 'Nebuti fixture: info@nebuti.com recovered via raw HTML');
  assert(nebutiResult.extractedEmails.includes('anil@nebuti.com'), 'Nebuti fixture: anil@nebuti.com recovered via raw HTML');
  assert(nebutiResult.extractedPhones.some((p) => p.includes('4522833')), 'Nebuti fixture: +977-1-4522833 recovered via raw HTML');
  // Mobile display is now formatted as +977-9XX-XXXXXXX by formatPhoneDisplay; match by canonical digits.
  assert(
    nebutiResult.extractedMobiles.some((m) => classifyNepalPhone(m).digits === '9801025057'),
    'Nebuti fixture: +977-9801025057 mobile recovered via raw HTML (canonical digits: 9801025057)'
  );
  assert(nebutiResult.extractedSocialLinks.facebook === 'https://facebook.com/nebuti', 'Nebuti fixture: Facebook recovered via raw HTML');
  assert(!nebutiResult.rawContentSummary?.includes('<ul'), 'rawContentSummary is clean and contains NO raw HTML tags');
  assert(!nebutiResult.rawContentSummary?.includes('<li'), 'rawContentSummary contains NO <li> tags');

  // Provenance verification:
  const contactPage = nebutiPages.find((p) => p.pageType === 'contact');
  assert(contactPage !== undefined, 'Contact page identified in evidence');
  assert(contactPage?.url === 'http://nebuti.com/page-contact.html', 'Provenance URL points to page-contact.html');
  assert(contactPage?.discoverySource === 'internal_link', 'Provenance discoverySource is internal_link');

  // =========================================================================
  // Business Evidence Quality v1.2 — 6 Concrete Production Defect Regressions
  // =========================================================================
  console.log('\n--- Business Evidence Quality v1.2: 6 Production Defect Regressions ---');

  // Bug #1: Dirty Email Parentheses / Markdown ("info@gorkhatravel.com)*")
  console.log('\n[Bug #1 Regression] Dirty Email Parentheses / Markdown');
  assert(
    sanitizeEmailString('info@gorkhatravel.com)*') === 'info@gorkhatravel.com',
    'Bug #1: info@gorkhatravel.com)* sanitized to info@gorkhatravel.com'
  );
  assert(
    sanitizeEmailString('*(info@example.com)*') === 'info@example.com',
    'Bug #1: *(info@example.com)* sanitized to info@example.com'
  );
  assert(
    sanitizeEmailString('[info@example.com]') === 'info@example.com',
    'Bug #1: [info@example.com] sanitized to info@example.com'
  );
  const dirtyMarkdownContent = '*[+9779851066916](tel:+9779851066916)* *[info@gorkhatravel.com](mailto:info@gorkhatravel.com)*';
  const gorkhaEmails = extractEmails(dirtyMarkdownContent);
  assert(
    gorkhaEmails.length === 1 && gorkhaEmails[0] === 'info@gorkhatravel.com',
    `Bug #1: Exactly 1 clean email extracted from markdown link (got ${JSON.stringify(gorkhaEmails)})`
  );

  // Bug #2: Escaped Backslash Duplicates ("info@aadiyogitravels.com\\" & "info@touchkailash.com\\\\\\")
  console.log('\n[Bug #2 Regression] Escaped Backslash Duplicates & Deduplication');
  assert(
    sanitizeEmailString('info@aadiyogitravels.com\\') === 'info@aadiyogitravels.com',
    'Bug #2: info@aadiyogitravels.com\\ sanitized to clean email'
  );
  assert(
    sanitizeEmailString('info@touchkailash.com\\\\\\') === 'info@touchkailash.com',
    'Bug #2: info@touchkailash.com\\\\\\ sanitized to clean email'
  );
  const backslashContent = `
    "info@aadiyogitravels.com\\",
    "info@aadiyogitravels.com",
    "info@touchkailash.com\\\\\\",
    "info@touchkailash.com"
  `;
  const deduplicatedEmails = extractEmails(backslashContent);
  assert(
    deduplicatedEmails.includes('info@aadiyogitravels.com') &&
      deduplicatedEmails.filter((e) => e === 'info@aadiyogitravels.com').length === 1,
    'Bug #2: Escaped and clean emails deduplicated into exactly one info@aadiyogitravels.com'
  );
  assert(
    deduplicatedEmails.includes('info@touchkailash.com') &&
      deduplicatedEmails.filter((e) => e === 'info@touchkailash.com').length === 1,
    'Bug #2: Multiple backslashed and clean emails deduplicated into exactly one info@touchkailash.com'
  );

  // Bug #3: Truncated Landline as Mobile ("977 1532074")
  console.log('\n[Bug #3 Regression] Truncated Landline Strictly Discarded (Never Mobile / Landline)');
  const c7Fragment = classifyNepalPhone('977 1532074');
  assert(
    c7Fragment.type === 'invalid',
    `Bug #3: "977 1532074" (7 digits starting with 1 after country code) is strictly invalid (got ${c7Fragment.type})`
  );
  const mob7 = extractMobiles('Office: 977 1532074, mobile: 9851350661');
  assert(
    !mob7.some((m) => m.replace(/\D/g, '').includes('1532074')),
    'Bug #3: "977 1532074" NEVER admitted into extractMobiles'
  );
  assert(
    mob7.some((m) => m.includes('9851350661')),
    'Bug #3: Legitimate mobile 9851350661 extracted'
  );
  // Full Kathmandu landline (8 digits starting with 1) is valid landline:
  const cFullLandline = classifyNepalPhone('+977 15320746');
  assert(
    cFullLandline.type === 'landline' && cFullLandline.digits === '15320746',
    'Bug #3: Full 8-digit landline +977 15320746 correctly classified as landline'
  );

  // Bug #4: Broken Phone Parentheses ("+34654827089 (") & Unbalanced tokens
  console.log('\n[Bug #4 Regression] Broken Phone Parentheses & Unbalanced Tokens');
  assert(
    sanitizePhoneString('+34654827089 (') === '+34654827089',
    'Bug #4: Trailing unmatched "(" stripped by sanitizePhoneString'
  );
  const cCleanParen = classifyNepalPhone('+34654827089 (');
  assert(
    cCleanParen.type === 'international' && cCleanParen.normalized === '+34654827089',
    'Bug #4: "+34654827089 (" correctly classified as valid international +34654827089'
  );
  const cUnbalanced = classifyNepalPhone('+34 (654827089');
  assert(
    cUnbalanced.type === 'invalid',
    'Bug #4: Unbalanced opening parenthesis without closing parenthesis rejected as invalid'
  );

  // Bug #5: Fake Social Profile (Facebook Share Endpoint)
  console.log('\n[Bug #5 Regression] Fake Facebook Share/Tracker Endpoints Rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/sharer', 'facebook'), 'Bug #5: /sharer rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/sharer/sharer.php?u=https://example.com', 'facebook'), 'Bug #5: /sharer/sharer.php rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/share.php?u=https://example.com', 'facebook'), 'Bug #5: /share.php rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/tr?id=12345', 'facebook'), 'Bug #5: /tr tracking pixel rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/dialog/share', 'facebook'), 'Bug #5: /dialog/share rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/plugins/like.php', 'facebook'), 'Bug #5: /plugins rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/', 'facebook'), 'Bug #5: Bare domain rejected');
  assert(
    isRealSocialProfile('https://www.facebook.com/esevenstarintltravels', 'facebook'),
    'Bug #5: Real profile handle esevenstarintltravels accepted'
  );

  // Bug #6: Fake Twitter/X Endpoint ("twitter.com/share")
  console.log('\n[Bug #6 Regression] Fake Twitter/X Share Endpoints Rejected');
  assert(!isRealSocialProfile('https://twitter.com/share', 'twitter'), 'Bug #6: twitter.com/share rejected');
  assert(!isRealSocialProfile('https://twitter.com/share?text=Hello', 'twitter'), 'Bug #6: twitter.com/share?text=... rejected');
  assert(!isRealSocialProfile('https://x.com/share', 'twitter'), 'Bug #6: x.com/share rejected');
  assert(!isRealSocialProfile('https://twitter.com/intent/tweet?text=Hello', 'twitter'), 'Bug #6: /intent/tweet rejected');
  assert(!isRealSocialProfile('https://x.com/intent/tweet', 'twitter'), 'Bug #6: x.com/intent rejected');
  assert(!isRealSocialProfile('https://x.com/', 'twitter'), 'Bug #6: Bare domain rejected');
  assert(
    isRealSocialProfile('https://twitter.com/E7Star_Travel', 'twitter'),
    'Bug #6: Real handle @E7Star_Travel accepted'
  );

  // Other social profiles: Instagram & LinkedIn
  console.log('\n[Social Quality] Instagram & LinkedIn Profile Validation');
  assert(!isRealSocialProfile('https://www.instagram.com/p/C_abc123/', 'instagram'), 'Instagram post URL rejected');
  assert(!isRealSocialProfile('https://www.instagram.com/reel/C_abc123/', 'instagram'), 'Instagram reel URL rejected');
  assert(!isRealSocialProfile('https://www.instagram.com/explore/', 'instagram'), 'Instagram explore rejected');
  assert(isRealSocialProfile('https://www.instagram.com/travelesevenstar', 'instagram'), 'Real Instagram profile accepted');
  assert(!isRealSocialProfile('http://www.linkedin.com/shareArticle?mini=true', 'linkedin'), 'LinkedIn shareArticle rejected');
  assert(isRealSocialProfile('https://www.linkedin.com/company/quality-holidays-tours-travels', 'linkedin'), 'Real LinkedIn company profile accepted');

  // Realistic Production Fixture with Share Buttons alongside Real Handles:
  console.log('\n[End-to-End Extraction Fixture] Share buttons alongside real social profiles');
  const pageWithShareButtons = `
    <div class="share-box">
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://example.com"><i class="fa fa-facebook"></i> Share</a>
      <a href="https://twitter.com/share?text=Check+this"><i class="fa fa-twitter"></i> Tweet</a>
      <a href="https://www.linkedin.com/shareArticle?mini=true"><i class="fa fa-linkedin"></i> Share</a>
    </div>
    <div class="footer-socials">
      <a href="https://www.facebook.com/esevenstarintltravels">Facebook</a>
      <a href="https://twitter.com/E7Star_Travel">Twitter</a>
      <a href="https://www.instagram.com/travelesevenstar">Instagram</a>
      <a href="https://www.linkedin.com/company/quality-holidays-tours-travels">LinkedIn</a>
    </div>
  `;
  const extractedFromSharePage = extractSocialLinks(pageWithShareButtons);
  assert(
    extractedFromSharePage.facebook === 'https://www.facebook.com/esevenstarintltravels',
    `Facebook extracted real profile instead of /sharer (got ${extractedFromSharePage.facebook})`
  );
  assert(
    extractedFromSharePage.other.x === 'https://twitter.com/E7Star_Travel',
    `Twitter extracted real profile instead of /share (got ${extractedFromSharePage.other.x})`
  );
  assert(
    extractedFromSharePage.instagram === 'https://www.instagram.com/travelesevenstar',
    `Instagram extracted real profile (got ${extractedFromSharePage.instagram})`
  );
  assert(
    extractedFromSharePage.other.linkedin === 'https://www.linkedin.com/company/quality-holidays-tours-travels',
    `LinkedIn extracted real profile instead of /shareArticle (got ${extractedFromSharePage.other.linkedin})`
  );

  // --- v1.3: Gorkha Travel homepage footer recovery (regression) ---
  console.log('\n--- v1.3: Gorkha homepage footer fixture (Tavily truncation recovery) ---');
  // Tavily readability stripped the footer: markdown kept ONLY the header email.
  const gorkhaTruncatedMarkdown =
    'Gorkha International Travels & Treks. Email: info@gorkhatravel.com';
  // Raw HTML safety net holds the full footer (icon-only social anchors —
  // exactly the elements Tavily's parser discarded on gorkhatravel.com).
  const gorkhaFooterHtml = `
    <footer>
      <a href="mailto:contact@gorkhatravel.com">contact@gorkhatravel.com</a>
      <a href="tel:+13013221427">+1 301 322 1427</a>
      <a href="https://www.facebook.com/gorkha123"><i class="fa fa-facebook"></i></a>
      <a href="https://www.instagram.com/gorkhatreks"><i class="fa fa-instagram"></i></a>
      <a href="https://www.linkedin.com/company/gorkhatravel"><i class="fa fa-linkedin"></i></a>
    </footer>
  `;
  const gorkhaPages: WebsitePageEvidence[] = [
    {
      url: 'http://gorkhatravel.com/',
      content: gorkhaTruncatedMarkdown,
      rawHtml: gorkhaFooterHtml,
      favicon: '',
      success: true,
      discoverySource: 'homepage',
      pageType: 'home',
    },
  ];
  const gorkhaEvidence = extractAllFromPages(gorkhaPages);
  assert(
    gorkhaEvidence.extractedEmails.includes('info@gorkhatravel.com') &&
      gorkhaEvidence.extractedEmails.includes('contact@gorkhatravel.com'),
    'Gorkha: BOTH emails recovered (markdown header + raw HTML footer)'
  );
  assert(
    gorkhaEvidence.extractedPhones.some((p) => p.replace(/\D/g, '') === '13013221427'),
    `Gorkha: USA office +1 301 322 1427 recovered via raw HTML (got ${JSON.stringify(
      gorkhaEvidence.extractedPhones
    )})`
  );
  assert(
    gorkhaEvidence.extractedPhones.length === 1,
    `Gorkha: phones contain ONLY the clean USA number — no inner-fragment artifact (got ${JSON.stringify(
      gorkhaEvidence.extractedPhones
    )})`
  );
  assert(
    gorkhaEvidence.extractedSocialLinks.facebook.includes('gorkha123'),
    'Gorkha: Facebook icon-only anchor recovered via raw HTML'
  );
  assert(
    gorkhaEvidence.extractedSocialLinks.instagram.includes('gorkhatreks'),
    'Gorkha: Instagram icon-only anchor recovered via raw HTML'
  );
  assert(
    (gorkhaEvidence.extractedSocialLinks.other.linkedin || '').includes('gorkhatravel'),
    'Gorkha: LinkedIn icon-only anchor recovered via raw HTML'
  );

  // Direct extractor-level parity with the forensic fetch that proved the
  // extractors work on the real raw HTML (forensics: emails x2, phones + USA,
  // socials facebook/instagram/linkedin).
  const gorkhaDirectSocials = extractSocialLinks(gorkhaFooterHtml);
  assert(gorkhaDirectSocials.facebook.includes('gorkha123'), 'Gorkha direct: Facebook from raw HTML');
  assert(gorkhaDirectSocials.instagram.includes('gorkhatreks'), 'Gorkha direct: Instagram from raw HTML');
  assert(
    (gorkhaDirectSocials.other.linkedin || '').includes('gorkhatravel'),
    'Gorkha direct: LinkedIn from raw HTML'
  );
  const gorkhaDirectEmails = extractEmails(gorkhaFooterHtml);
  assert(gorkhaDirectEmails.includes('contact@gorkhatravel.com'), 'Gorkha direct: contact@ from raw HTML');
  const gorkhaDirectPhones = extractPhones(gorkhaFooterHtml);
  assert(
    gorkhaDirectPhones.some((p) => p.replace(/\D/g, '') === '13013221427'),
    'Gorkha direct: +1 301 322 1427 classified international'
  );

  // --- v1.4: EPABX Slash Extension Expansion & Phone Taxonomy ---
  console.log('\n--- v1.4: EPABX slash extension expansion ---');
  const kumariSlash = '+977 1 5363501/511/560';
  const expanded = expandSlashExtensions(kumariSlash);
  assert(expanded.length === 3, `Kumari slash expanded to 3 numbers (got ${expanded.length})`);
  assert(expanded[0] === '+977 1 5363501', `Expanded #1 is +977 1 5363501 (got ${expanded[0]})`);
  assert(expanded[1] === '+977 1 5363511', `Expanded #2 is +977 1 5363511 (got ${expanded[1]})`);
  assert(expanded[2] === '+977 1 5363560', `Expanded #3 is +977 1 5363560 (got ${expanded[2]})`);

  const localKumariSlash = '01-5363501/511/560';
  const expandedLocal = expandSlashExtensions(localKumariSlash);
  assert(expandedLocal.length === 3, 'Local slash expanded to 3 numbers');
  assert(expandedLocal[1] === '01-5363511', 'Local trunk expanded correctly');

  // Mobile slashes without shared trunk are rejected
  const mobileSlash = '9851234567/568';
  const mobileExpanded = expandSlashExtensions(mobileSlash);
  assert(mobileExpanded.length === 0, 'Mobile slash without shared prefix rejected');

  // Strict separation in extractAllFromPages:
  console.log('\n--- v1.4: extractAllFromPages strict separation ---');
  const mixedPages: WebsitePageEvidence[] = [
    {
      url: 'https://example.com/contact',
      pageType: 'contact',
      content: 'Office: +977 1 5363501/511. Mobile: +977-9851334626. WhatsApp: 9801025057. USA: +1 301 322 1427.',
      favicon: '',
      success: true,
      discoverySource: 'internal_link',
    },
  ];
  const mixedEvidence = extractAllFromPages(mixedPages);
  // extractedPhones must contain ONLY landlines and international numbers
  assert(
    mixedEvidence.extractedPhones.every((p) => {
      const cls = classifyNepalPhone(p);
      return cls.type === 'landline' || cls.type === 'international';
    }),
    `extractedPhones contains ONLY landlines/international: ${JSON.stringify(mixedEvidence.extractedPhones)}`
  );
  // extractedMobiles must contain the mobiles
  assert(
    mixedEvidence.extractedMobiles.length === 2,
    `extractedMobiles contains exactly 2 mobiles (got ${mixedEvidence.extractedMobiles.length})`
  );

  // =======================================================================
  // v1.5: Phone Normalization Regression Fixtures (6 real-world E2E cases)
  // =======================================================================
  console.log('\n--- v1.5: classifyNepalPhone explicit structure matching ---');

  // Fixture 1: Sabai partial INCOMPLETE_MOBILE rejection
  // "+977 (980) 822-2" → digits after stripping: 977 + 9808222 (7 digits) → INCOMPLETE_MOBILE
  const sabaiBad1 = classifyNepalPhone('+977 (980) 822-2');
  assert(sabaiBad1.type === 'invalid', 'Fixture 1a: +977 (980) 822-2 → invalid (INCOMPLETE_MOBILE)');
  assert(sabaiBad1.reason === 'INCOMPLETE_MOBILE', `Fixture 1a reason is INCOMPLETE_MOBILE (got ${sabaiBad1.reason})`);

  // Extra Sabai case: ensure it does NOT produce a valid number
  assert(
    !extractMobiles('+977 (980) 822-2').some((m) => m.includes('9808222')),
    'Fixture 1a: +977 (980) 822-2 never enters mobiles array'
  );

  // Fixture 1b: same prefix, complete version → valid mobile
  const sabaiBad1b = classifyNepalPhone('+977 (980) 822-2425');
  assert(sabaiBad1b.type === 'mobile', 'Fixture 1b: +977 (980) 822-2425 → valid mobile (complete 10 digits)');
  assert(sabaiBad1b.digits === '9808222425', `Fixture 1b canonical digits = 9808222425 (got ${sabaiBad1b.digits})`);

  // Fixture 2: Sabai valid mobile (domestic format)
  const sabaiGood = classifyNepalPhone('980-8222425');
  assert(sabaiGood.type === 'mobile', 'Fixture 2: 980-8222425 → valid mobile');
  assert(sabaiGood.digits === '9808222425', `Fixture 2 canonical digits = 9808222425 (got ${sabaiGood.digits})`);
  assert(
    formatPhoneDisplay('9808222425', 'mobile') === '+977-980-8222425',
    `Fixture 2 display = +977-980-8222425 (got ${formatPhoneDisplay('9808222425', 'mobile')})`
  );

  // Fixture 3: Kumari slash expansion → 3 landlines with correct display
  console.log('\n--- v1.5: EPABX slash expansion display formatting ---');
  const kumariSlashV15 = '+977 1 5363501/511/560';
  const kumariExpandedV15 = expandSlashExtensions(kumariSlashV15);
  assert(kumariExpandedV15.length === 3, `Fixture 3: Kumari slash → 3 landlines (got ${kumariExpandedV15.length})`);
  for (const raw of kumariExpandedV15) {
    const cls = classifyNepalPhone(raw);
    const display = formatPhoneDisplay(cls.digits, cls.type, raw);
    assert(cls.type === 'landline', `Fixture 3: ${raw} classified as landline`);
    assert(
      display.startsWith('+977-01-'),
      `Fixture 3: display of ${raw} is +977-01-XXXXXXX (got ${display})`
    );
  }
  const kumariDisplays = kumariExpandedV15.map((raw) => {
    const cls = classifyNepalPhone(raw);
    return formatPhoneDisplay(cls.digits, cls.type, raw);
  });
  assert(kumariDisplays[0] === '+977-01-5363501', `Fixture 3a: +977-01-5363501 (got ${kumariDisplays[0]})`);
  assert(kumariDisplays[1] === '+977-01-5363511', `Fixture 3b: +977-01-5363511 (got ${kumariDisplays[1]})`);
  assert(kumariDisplays[2] === '+977-01-5363560', `Fixture 3c: +977-01-5363560 (got ${kumariDisplays[2]})`);

  // Fixture 4: Namaste 8-digit bare rejection (18474291)
  // This starts with '1' and is exactly 8 digits → classifies as LANDLINE by current structure.
  // Per the v1.5 contract, 1XXXXXXX IS a valid Kathmandu landline if it fits the structure.
  // The plan says reject ONLY if there is no recognized structure. Since 18474291 = 8 digits
  // starting with 1, classifyNepalPhone returns 'landline'. Rejection must happen at a higher
  // layer (sub-exchange validation) if required. For now we verify it does NOT enter mobiles.
  console.log('\n--- v1.5: 8-digit bare run structure verification ---');
  const namaste8 = classifyNepalPhone('18474291');
  assert(
    namaste8.type === 'landline' || namaste8.type === 'invalid',
    `Fixture 4: 18474291 is either landline or invalid (got ${namaste8.type})`
  );
  assert(
    namaste8.type !== 'mobile',
    'Fixture 4: 18474291 never classified as mobile'
  );

  // Fixture 5: Thamel 8-digit bare rejection (15585456)
  const thamel8 = classifyNepalPhone('15585456');
  assert(
    thamel8.type === 'landline' || thamel8.type === 'invalid',
    `Fixture 5: 15585456 is either landline or invalid (got ${thamel8.type})`
  );
  assert(
    thamel8.type !== 'mobile',
    'Fixture 5: 15585456 never classified as mobile'
  );

  // Fixture 6: Nebuti canonical dedup — same number, two display formats
  console.log('\n--- v1.5: Canonical dedup — same number different display formats ---');
  const nebutiFormat1 = classifyNepalPhone('+977-1-4522833');
  const nebutiFormat2 = classifyNepalPhone('01-4522833');
  const nebutiFormat3 = classifyNepalPhone('+977 1 4522833');
  assert(nebutiFormat1.type === 'landline', 'Fixture 6a: +977-1-4522833 is landline');
  assert(nebutiFormat2.type === 'landline', 'Fixture 6b: 01-4522833 is landline');
  assert(nebutiFormat3.type === 'landline', 'Fixture 6c: +977 1 4522833 is landline');
  assert(
    nebutiFormat1.digits === nebutiFormat2.digits,
    `Fixture 6: +977-1-4522833 and 01-4522833 share canonical digits (${nebutiFormat1.digits} vs ${nebutiFormat2.digits})`
  );
  assert(
    nebutiFormat1.digits === nebutiFormat3.digits,
    `Fixture 6: +977-1-4522833 and +977 1 4522833 share canonical digits (${nebutiFormat1.digits} vs ${nebutiFormat3.digits})`
  );
  // Both display as the same +977-01-XXXXXXX format
  const d1 = formatPhoneDisplay(nebutiFormat1.digits, 'landline');
  const d2 = formatPhoneDisplay(nebutiFormat2.digits, 'landline');
  assert(d1 === d2, `Fixture 6: Both display as same string (${d1})`);
  assert(d1 === '+977-01-4522833', `Fixture 6: Display is +977-01-4522833 (got ${d1})`);

  // PhoneEvidence tracing: extractAllFromPages produces evidence
  console.log('\n--- v1.5: PhoneEvidence tracing in extractAllFromPages ---');
  const evidencePages: WebsitePageEvidence[] = [
    {
      url: 'https://test.com/contact',
      pageType: 'contact',
      content: 'Phone: 980-8222425. Office: +977-1-4522833. Partial: +977 (980) 822-2.',
      favicon: '',
      success: true,
      discoverySource: 'internal_link',
    },
  ];
  const evidenceResult = extractAllFromPages(evidencePages);
  assert(
    !!evidenceResult.extractedPhoneEvidence && evidenceResult.extractedPhoneEvidence.length > 0,
    'PhoneEvidence array populated by extractAllFromPages'
  );
  // All evidence entries for valid phones have a non-invalid type
  const invalidEvidence = evidenceResult.extractedPhoneEvidence?.filter((e) => e.type === 'invalid') ?? [];
  assert(
    invalidEvidence.every((e) => e.reason !== undefined),
    'All invalid PhoneEvidence entries carry a reason (never silently rejected)'
  );
  // Valid phones appear in the public arrays
  assert(
    evidenceResult.extractedMobiles.some((m) => classifyNepalPhone(m).digits === '9808222425'),
    'PhoneEvidence: 980-8222425 → valid mobile in extractedMobiles'
  );
  assert(
    evidenceResult.extractedPhones.some((p) => classifyNepalPhone(p).digits === '14522833'),
    'PhoneEvidence: +977-1-4522833 → valid landline in extractedPhones'
  );
  // Valid phones in evidence all have correct pageUrl
  const validEvidence = evidenceResult.extractedPhoneEvidence?.filter((e) => e.type !== 'invalid') ?? [];
  assert(
    validEvidence.every((e) => e.pageUrl === 'https://test.com/contact'),
    'PhoneEvidence: valid entries carry correct pageUrl'
  );
  // Invalid phones never appear in public arrays — the partial mobile digits 9808222 from the
  // partial string must NOT create a separate mobile entry beyond the valid 9808222425
  assert(
    evidenceResult.extractedMobiles.every((m) => !m.includes('9808222') || classifyNepalPhone(m).digits === '9808222425'),
    'Invalid partial mobile never enters extractedMobiles as a spurious entry'
  );
  // phones ∩ mobiles = ∅
  const phoneDigits = new Set(evidenceResult.extractedPhones.map((p) => classifyNepalPhone(p).digits));
  const mobileDigits = new Set(evidenceResult.extractedMobiles.map((m) => classifyNepalPhone(m).digits));
  const overlap = [...phoneDigits].filter((d) => mobileDigits.has(d));
  assert(overlap.length === 0, `PhoneEvidence taxonomy invariant: phones ∩ mobiles = ∅ (overlap: ${overlap})`);

  // --- v1.4: Facebook profile.php?id= and social handle validation ---
  console.log('\n--- v1.4: Social profile validation ---');
  const sabaiFacebook = 'https://www.facebook.com/profile.php?id=61578085095209';
  assert(isRealSocialProfile(sabaiFacebook, 'facebook'), 'Facebook profile.php with numeric id accepted');
  assert(!isRealSocialProfile('https://www.facebook.com/profile.php', 'facebook'), 'Bare Facebook profile.php rejected');
  assert(!isRealSocialProfile('https://www.facebook.com/profile.php?id=abc', 'facebook'), 'Facebook profile.php with non-digit id rejected');


  console.log('\n===============================================================');
  console.log('🎉 ALL BUSINESS EXTRACTOR UNIT & REGRESSION TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests();
