/**
 * Pure URL/title page-type heuristic. No service imports.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */



export type PageType = 'homepage' | 'contact' | 'about' | 'team' | 'services' | 'other';

/**
 * Classifies a URL into a page type based on pathname heuristics.
 */

export function classifyPageType(url?: string, pageTitle?: string): PageType {
  if (!url) return 'other';
  try {
    const raw = url.startsWith('http') ? url : `https://${url}`;
    const parsed = new URL(raw);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');

    // Homepage: root, index.html, index.php, /home
    if (path === '' || path === '/' || path === '/index.html' || path === '/index.php' || path === '/home') {
      return 'homepage';
    }

    // Contact: contact, contact-us, reach-us, get-in-touch, get-a-quote, location
    if (/\b(contact|contact-us|reach-us|get-in-touch|get-a-quote|contactus|location|branches)\b/i.test(path)) {
      return 'contact';
    }

    // Team: team, our-team, leadership, board, management, staff, members
    if (/\b(team|our-team|leadership|board|management|staff|members)\b/i.test(path)) {
      return 'team';
    }

    // About: about, about-us, who-we-are, company, profile
    if (/\b(about|about-us|who-we-are|company|profile)\b/i.test(path)) {
      return 'about';
    }

    // Services: service, services, our-services
    if (/\b(service|services|our-services)\b/i.test(path)) {
      return 'services';
    }

    return 'other';
  } catch {
    return 'other';
  }
}
