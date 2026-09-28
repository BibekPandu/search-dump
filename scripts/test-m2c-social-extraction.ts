import assert from 'node:assert';
import { extractSocialLinks } from '@/services/business-extractor.service';

const content = `
[![TikTok icon](https://example.com/tiktok.svg)](https://www.tiktok.com/@globaleyeeducation)
<meta property="og:see_also" content="https://www.facebook.com/globaleyeeducation">
<meta property="og:see_also" content="https://www.instagram.com/globaleye.consultancy">
<a rel="me" href="https://www.linkedin.com/company/global-eye-education"></a>
<img src="https://www.facebook.com/tr?id=1395564971716732&ev=PageView">
`;

const socials = extractSocialLinks(content, {
  businessName: 'Global Eye Education Consultancy',
  websiteDomain: 'globaleye.edu.np',
});

assert.strictEqual(socials.tiktok, 'https://tiktok.com/@globaleyeeducation');
assert.strictEqual(socials.facebook, 'https://facebook.com/globaleyeeducation');
assert.strictEqual(socials.instagram, 'https://instagram.com/globaleye.consultancy');
assert.strictEqual(socials.other.linkedin, 'https://linkedin.com/company/global-eye-education');

console.log('M2C social extraction tests passed.');
