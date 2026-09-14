import http from 'node:http';
import {
  classifyPageType,
  isIgnoredWebsitePath,
  normalizeInternalUrl,
  prioritizeInternalLinks,
  discoverWebsitePages,
  extractContactLinksFromMarkdown,
} from '../src/services/website-discovery.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`âŒ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`âœ… PASS: ${message}`);
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('ðŸ§ª WEBSITE DISCOVERY UNIT TESTS (ZERO API)');
  console.log('===============================================================');

  // --- classifyPageType ---
  console.log('\n--- classifyPageType ---');
  assert(classifyPageType('https://x.com/') === 'home', 'Root URL â†’ home');
  assert(classifyPageType('https://x.com/contact-us') === 'contact', '/contact-us â†’ contact');
  assert(classifyPageType('https://x.com/reach-us/') === 'contact', '/reach-us â†’ contact');
  assert(classifyPageType('https://x.com/about-us') === 'about', '/about-us â†’ about');
  assert(classifyPageType('https://x.com/our-services') === 'services', '/our-services â†’ services');
  assert(classifyPageType('https://x.com/locations') === 'location', '/locations â†’ location');
  assert(classifyPageType('https://x.com/team') === 'team', '/team â†’ team');
  assert(classifyPageType('https://x.com/menu') === 'menu', '/menu â†’ menu');
  assert(classifyPageType('https://x.com/gallery') === 'other', '/gallery â†’ other');

  assert(classifyPageType('https://x.com/contact.php') === 'contact', '/contact.php -> contact');
  assert(classifyPageType('https://x.com/aboutus.php') === 'about', '/aboutus.php -> about');
  // v1.1: custom contact path (Nebuti-style) now classified as contact.
  assert(classifyPageType('https://x.com/page-contact.html') === 'contact', '/page-contact.html -> contact');
  assert(classifyPageType('https://x.com/write-to-us') === 'contact', '/write-to-us -> contact');
  assert(classifyPageType('https://x.com/get-in-touch') === 'contact', '/get-in-touch -> contact (explicit path)');

  // --- isIgnoredWebsitePath ---
  console.log('\n--- isIgnoredWebsitePath ---');
  assert(isIgnoredWebsitePath('https://x.com/blog/post-1'), '/blog -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/news/2026'), '/news -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/careers'), '/careers -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/privacy'), '/privacy -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/terms'), '/terms -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/login'), '/login -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/wp-json'), '/wp-json -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/download.pdf'), '.pdf -> ignored');
  assert(isIgnoredWebsitePath('https://x.com/img/header.jpg'), '/img/ -> ignored (asset dir)');
  assert(isIgnoredWebsitePath('https://x.com/images/logo.png'), '/images/ -> ignored (asset dir)');
  assert(isIgnoredWebsitePath('https://x.com/assets/main.css'), '/assets/ -> ignored (asset dir)');
  assert(isIgnoredWebsitePath('https://x.com/uploads/2026/doc.pdf'), '/uploads/ -> ignored (asset dir)');
  assert(isIgnoredWebsitePath('https://x.com/static/bundle.js'), '/static/ -> ignored (asset dir)');
  assert(!isIgnoredWebsitePath('https://x.com/contact'), '/contact -> NOT ignored');
  assert(!isIgnoredWebsitePath('https://x.com/contact.php'), '/contact.php -> NOT ignored');

  // --- normalizeInternalUrl ---
  console.log('\n--- normalizeInternalUrl ---');
  const base = 'https://himalayanjava.com/';
  assert(
    normalizeInternalUrl(base, 'contact.php') === 'https://himalayanjava.com/contact.php',
    'contact.php resolved as relative internal path'
  );
  assert(
    normalizeInternalUrl(base, 'aboutus.php') === 'https://himalayanjava.com/aboutus.php',
    'aboutus.php resolved as relative internal path'
  );
  assert(
    normalizeInternalUrl(base, '/contact-us/') === 'https://himalayanjava.com/contact-us',
    'Relative path resolved + trailing slash stripped'
  );
  assert(
    normalizeInternalUrl(base, 'www.himalayanjava.com/about/') === 'https://himalayanjava.com/about',
    'Bare-host href resolved to absolute'
  );
  assert(
    normalizeInternalUrl(base, 'https://www.himalayanjava.com/contact?utm=x#sec') ===
      'https://himalayanjava.com/contact',
    'Fragment + query stripped, www normalized'
  );
  assert(
    normalizeInternalUrl(base, '/index.html') === 'https://himalayanjava.com',
    '/index.html canonicalized to root /'
  );
  assert(
    normalizeInternalUrl(base, '/index.php') === 'https://himalayanjava.com',
    '/index.php canonicalized to root /'
  );
  assert(
    normalizeInternalUrl(base, '/home') === 'https://himalayanjava.com',
    '/home canonicalized to root /'
  );
  assert(normalizeInternalUrl(base, 'mailto:info@x.com') === null, 'mailto rejected');
  assert(normalizeInternalUrl(base, 'tel:+977123') === null, 'tel rejected');
  assert(normalizeInternalUrl(base, 'javascript:void(0)') === null, 'javascript rejected');
  assert(normalizeInternalUrl(base, '#section') === null, 'fragment-only rejected');
  assert(
    normalizeInternalUrl(base, 'https://facebook.com/himalayanjava') === null,
    'Cross-domain (facebook) rejected'
  );
  assert(normalizeInternalUrl(base, '/blog/hello') === null, 'Ignored path rejected');

  // --- prioritizeInternalLinks ---
  console.log('\n--- prioritizeInternalLinks ---');
  const links = [
    'https://himalayanjava.com/menu',
    '/gallery',
    'https://www.himalayanjava.com/about-us/',
    '/blog/x',
    'https://himalayanjava.com/contact',
    'https://himalayanjava.com/contact-us',
  ];

  const sorted = prioritizeInternalLinks(base, links, 5);
  assert(sorted.length === 5, `Dedup + ignore reduced to 5 (got ${sorted.length})`);
  assert(sorted[0].pageType === 'contact', 'Contact prioritized first');
  assert(sorted[1].pageType === 'contact', 'Second contact entry next (stable order)');
  assert(sorted[2].pageType === 'about', 'About prioritized after contacts');
  assert(sorted[0].discoverySource === 'internal_link', 'Discovery source marked internal_link');
  const capped = prioritizeInternalLinks(base, links, 2);
  assert(capped.length === 2, `maxPages cap honored (got ${capped.length})`);

  // --- extractContactLinksFromMarkdown (v1.1) ---
  console.log('\n--- extractContactLinksFromMarkdown ---');
  const contactContent = `
    [Contact Us](/page-contact.html)
    [Get in Touch](/get-in-touch)
    [Support](/support)
    [Write to Us](/write-to-us)
    [About](/about)
    [Our Menu](/menu)
  `;
  const contactLinks = extractContactLinksFromMarkdown(contactContent);
  assert(contactLinks.some((l) => l.includes('page-contact')), 'page-contact.html detected via anchor text');
  assert(contactLinks.some((l) => l.includes('get-in-touch')), 'get-in-touch detected via anchor text');
  assert(contactLinks.some((l) => l.includes('support')), 'support detected via anchor text');
  assert(contactLinks.some((l) => l.includes('write-to-us')), 'write-to-us detected via anchor text');
  assert(!contactLinks.some((l) => l.includes('about')), 'About NOT detected as contact');
  assert(!contactLinks.some((l) => l.includes('menu')), 'Menu NOT detected as contact');

// --- discoverWebsitePages (no network) ---
  console.log('\n--- discoverWebsitePages (pure/fallback paths) ---');
  // Passing no content + a bogus domain should degrade to fallback guesses, never throw.
  const pages = await discoverWebsitePages('https://not-a-real-site-xyz123.com', { timeoutMs: 800 });
  assert(pages.length > 0, `Never throws; produced ${pages.length} pages (fallback)`);
  assert(pages[0].discoverySource === 'homepage' && pages[0].pageType === 'home', 'Homepage always first');
  assert(pages.every((p) => p.url.startsWith('https://not-a-real-site-xyz123.com')), 'All same-domain');
  const fallbackSources = pages.filter((p) => p.discoverySource === 'fallback_guess');
  assert(fallbackSources.length > 0, 'Fallback guesses used when discovery fails (marked fallback_guess)');

  // discoverySource honors existing content links when provided.
  const withContent = await discoverWebsitePages('https://caffeophilia.com', {
    tavilyHomepageContent:
      '[Contact](/contact-us) [Contact Us](/page-contact.html) [About](/about) [Instagram](https://instagram.com/caffeophilia)',
  });
  const internalLinks = withContent.filter((p) => p.discoverySource === 'internal_link');
  assert(
    internalLinks.length >= 2,
    `Markdown links parsed from Tavily content (got ${internalLinks.length} internal)`
  );
  assert(
    withContent.some((p) => p.url === 'https://caffeophilia.com/contact-us'),
    '/contact-us discovered from content link'
  );
  assert(
    withContent.some((p) => p.url === 'https://caffeophilia.com/page-contact.html'),
    'Custom /page-contact.html discovered + classified as contact (Nebuti fix)'
  );

  // --- v1.3: contact page strict priority under markdown clutter (Gorkha fix) ---
  console.log('\n--- discoverWebsitePages: contact priority under package-link clutter (v1.3) ---');
  {
    // Local loopback server: deterministic, zero external API. Simulates a
    // homepage whose raw HTML nav/footer links to /contact and /about while
    // Tavily markdown only surfaced 10 package links (the Gorkha starvation).
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body>' +
          '<nav>' +
          '<a href="/contact">Contact</a>' +
          '<a href="/about">About</a>' +
          '<a href="/package/everest-base-camp">Everest Base Camp</a>' +
          '</nav>' +
          '</body></html>'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 10 non-contact package links in Tavily markdown — NO contact link.
      const packageMarkdown = Array.from(
        { length: 10 },
        (_, i) => `[Package ${i + 1}](/package/tour-${i + 1})`
      ).join(' ');

      const discovered = await discoverWebsitePages(`${base}/`, {
        maxPages: 5,
        timeoutMs: 2000,
        tavilyHomepageContent: packageMarkdown,
      });

      assert(discovered.length === 5, `Page quota honored (got ${discovered.length})`);
      assert(
        discovered[0].pageType === 'home' && discovered[0].discoverySource === 'homepage',
        'Homepage always first'
      );
      assert(
        discovered.some((p) => p.url === `${base}/contact`),
        'Contact page discovered from raw HTML despite full markdown quota (Gorkha fix)'
      );
      assert(
        discovered[1].pageType === 'contact' && discovered[1].url === `${base}/contact`,
        'Contact takes the FIRST non-home slot (strict priority over packages)'
      );
      assert(
        discovered.some((p) => p.url === `${base}/about`),
        'About page also recovered from raw HTML hrefs'
      );
      const packageKept = discovered.filter((p) => p.url.includes('/package/tour-')).length;
      assert(
        packageKept <= 3,
        `Package clutter displaced by contact/about (kept ${packageKept}/10 package links)`
      );
      assert(
        discovered.every((p) => p.url.startsWith(base)),
        'All discovered URLs stay same-origin'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log('\n===============================================================');
  console.log('ðŸŽ‰ WEBSITE DISCOVERY UNIT TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('Website discovery tests failed:', err);
  process.exit(1);
});
