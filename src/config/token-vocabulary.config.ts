/**
 * Pure token sets and lookup tables. No service imports.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */



export const FACEBOOK_RESERVED_PATHS = new Set([
  'sharer',
  'sharer.php',
  'share',
  'share.php',
  'dialog',
  'plugins',
  'hashtag',
  'login',
  'login.php',
  'signup',
  'tr',
  'policies',
  'help',
  'events',
  'groups',
  'pages',
  'watch',
  'photo',
  'video',
  'story.php',
  'about',
  'terms',
  'privacy',
  'people',
  'directory',
  'marketplace',
  'gaming',
  'reels',
  'saved',
  'memories',
  'fundraiser',
  'crisisresponse',
  'explore',
]);

export const TWITTER_RESERVED_PATHS = new Set([
  'share',
  'intent',
  'search',
  'hashtag',
  'home',
  'login',
  'signup',
  'explore',
  'i',
  'privacy',
  'tos',
  'notifications',
  'messages',
  'settings',
]);

export const INSTAGRAM_RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'accounts',
  'developer',
  'about',
  'legal',
  'nametag',
]);

export const INDUSTRY_GENERIC_TOKENS = new Set([
  'dental', 'dentist', 'dentistry', 'orthodontic', 'orthodontics', 'oral', 'smile',
  'clinic', 'care', 'hospital', 'health', 'healthcare', 'medical', 'med',
  'pharma', 'pharmacy', 'diagnostic', 'pathology', 'lab', 'laboratory', 'center',
  'centre', 'institute', 'poly', 'polyclinic', 'nursing', 'home',
  'realtors', 'realestate', 'properties', 'property', 'homes', 'builders', 'developers',
  'construction', 'group', 'pvt', 'ltd', 'inc', 'co', 'corp', 'company',
  'hotel', 'resort', 'lodge', 'guest', 'house', 'inn', 'stay', 'cafe', 'restaurant',
  'coffee', 'bakery', 'kitchen', 'food', 'foods', 'travel', 'travels', 'tours',
  'trekking', 'adventure', 'expedition', 'holidays', 'nepal', 'kathmandu', 'pokhara',
  'lalitpur', 'bhaktapur', 'services', 'service', 'solutions', 'tech', 'technologies',
  'auto', 'automobiles', 'motors', 'cleaning', 'clean', 'hygiene', 'express',
  'international', 'global', 'nepali', 'official', 'hub', 'point', 'mart', 'store',
  // Phase 8i additions: commercial, retail, trade, medical, education
  'shop', 'shops', 'stores', 'marts', 'market', 'bazaar',
  'drug', 'drugs', 'chemist', 'dispensary',
  'repair', 'repairs', 'mobile', 'electronics', 'supplier', 'suppliers', 'supply', 'supplies', 'hardware',
  'trade', 'trading', 'traders', 'trader', 'link', 'udhyog', 'enterprises', 'enterprise',
  'machinery', 'tools', 'sanitary', 'steel', 'metal', 'iron', 'cement', 'paint', 'paints', 'pipes', 'fittings',
  'school', 'schools', 'college', 'colleges', 'academy', 'vidya', 'mandir', 'gyanpeeth', 'secondary', 'higher',
  // Nepal administrative localities (must not count as distinctive brand tokens)
  'satungal', 'chandragiri', 'thamel', 'patan', 'kirtipur', 'baneshwor', 'thankot', 'naikap',
  'gurjudhara', 'chabahil', 'kalanki', 'koteshwor', 'dillibazar', 'lazimpat', 'maharajgunj',
  'balkhu', 'anamnagar', 'sinamangal', 'tinkune', 'kupondole', 'jawalakhel', 'sanepa',
  'kumaripati', 'satdobato', 'gongabu', 'balaju',
  // Satungal sweep Class B: cross-category generic gym/venue words
  'active', 'station',
]);

export const UNIVERSAL_STOPWORDS = new Set<string>([
  'and', 'the', 'of', 'in', 'for', 'at', 'by', 'to',
  '&', 'pvt', 'ltd', 'p', 'l', 'inc', 'co',
  'international', 'global',
  // Glue words that must never count as distinctive brand tokens (Satungal sweep).
  'with', 'without', 'via', 'near', 'upon', 'into', 'from',
]);

export const NEPAL_LOCALITY_TOKENS = new Set<string>([
  'satungal', 'chandragiri', 'thamel', 'patan', 'kirtipur', 'baneshwor', 'thankot', 'naikap',
  'gurjudhara', 'chabahil', 'kalanki', 'koteshwor', 'dillibazar', 'lazimpat', 'maharajgunj',
  'balkhu', 'anamnagar', 'sinamangal', 'tinkune', 'kupondole', 'jawalakhel', 'sanepa',
  'kumaripati', 'satdobato', 'gongabu', 'balaju', 'kathmandu', 'pokhara', 'lalitpur', 'bhaktapur',
]);

export const CATEGORY_GENERIC_TOKENS: Record<string, string[]> = {
  dental: ['dental', 'dentist', 'dentistry', 'orthodontic', 'orthodontics', 'oral', 'smile',
    'clinic', 'care', 'hospital', 'center', 'centre', 'health', 'healthcare'],
  medical: ['clinic', 'hospital', 'health', 'healthcare', 'polyclinic', 'pharmacy', 'medical',
    'care', 'center', 'centre', 'nursing', 'diagnostic', 'lab', 'laboratory'],
  education: ['school', 'secondary', 'primary', 'academy', 'college', 'vidyalaya', 'shiksha',
    'institute', 'campus', 'vidya', 'mandir', 'gyanpeeth', 'higher'],
  hospitality: ['hotel', 'resort', 'lodge', 'inn', 'stay', 'guest', 'house', 'restaurant', 'cafe',
    'coffee', 'bakery', 'kitchen'],
  legal: ['law', 'lawyer', 'advocate', 'legal', 'associates', 'chambers', 'attorney', 'solicitors'],
  fitness: ['gym', 'fitness', 'club', 'center', 'centre', 'workout', 'training', 'health',
    // Satungal sweep Class B (D-2.3 Active Fitness Gym)
    'active', 'station', 'zone', 'body', 'physique', 'exercise'],
  retail: ['store', 'shop', 'mart', 'kirana', 'pasal', 'center', 'centre', 'enterprise',
    'market', 'bazaar', 'mart'],
  beauty: [
    'beauty', 'salon', 'parlour', 'parlor', 'hair', 'makeup', 'cosmetic', 'cosmetics',
    'spa', 'nail', 'wellness', 'skin', 'skincare', 'grooming', 'threading', 'waxing',
    'facial', 'pedicure', 'manicure', 'bridal', 'studio', 'care', 'center', 'centre',
    'style', 'styling', 'look', 'glam', 'glamour', 'fashion',
    // additional generic terms surfaced by Checkpoint 1 analysis (D16-D22)
    'unisex', 'ladies', 'gents', 'royal', 'hub', 'collection', 'classic', 'elegant',
    // Satungal sweep Class B (D-3.1 Santosh Hair cutting)
    'cutting', 'cut', 'saloon', 'barber', 'barbershop', 'haircut', 'haircuts',
    'shave', 'shaving', 'clipper', 'clippers',
  ],
  venue: [
    'banquet', 'banquets', 'hall', 'halls', 'party', 'palace', 'venue', 'venues',
    'reception', 'community', 'function', 'functions', 'programme', 'program',
    'auditorium', 'marriage', 'wedding', 'event', 'events', 'celebration',
    'ceremony', 'party palace', 'garden', 'banquet hall',
  ],
  hardware: [
    'hardware', 'machinery', 'machine', 'supplier', 'suppliers', 'supply', 'supplies',
    'tools', 'steel', 'metal', 'iron', 'heavy', 'sanitary', 'sanitation', 'tiles',
    'pipe', 'pipes', 'fittings', 'electric', 'electrical', 'paints', 'paint', 'cement',
    'construction', 'materials', 'plywood', 'glass', 'aluminum', 'distributor', 'distributors',
    'dealers', 'dealer', 'wholesale', 'retail', 'udhyog', 'enterprises', 'enterprise',
    'trade', 'trading', 'link', 'traders', 'trader', 'ware', 'multitrade',
  ],
  driving: [
    'driving', 'driver', 'drivers', 'motor', 'motors', 'training', 'school',
    'institute', 'academy', 'center', 'centre', 'vehicle', 'vehicles', 'car',
    'bike', 'scooter', 'scooty', 'license', 'licence', 'trial', 'transport',
    'auto', 'learners', 'instructor', 'riding', 'heavy', 'trail',
  ],
  furniture: [
    'furniture', 'furnishing', 'furnishings', 'interior', 'interiors', 'sofa',
    'bed', 'table', 'chair', 'wood', 'wooden', 'decor', 'home', 'living',
    'store', 'shop', 'house', 'handicraft', 'kitchen', 'mattress', 'design',
    'udhyog', 'plywood', 'almirah', 'wardrobe', 'cabinet', 'fixture', 'fixtures',
  ],
  services: ['service', 'services', 'repair', 'cleaning', 'plumbing', 'solutions', 'works'],
};

export const CONFLICTING_VERTICAL_TOKENS: Record<string, string[]> = {
  furniture: ['food', 'cafe', 'restaurant', 'kitchen', 'bakery'],
  dental: ['furniture', 'sofa', 'food', 'cafe'],
  beauty: ['furniture', 'sofa', 'food', 'cafe'],
  hardware: ['food', 'cafe', 'restaurant'],
  driving: ['furniture', 'sofa', 'food', 'cafe'],
};

export const FACEBOOK_NON_CANONICAL_SUBPATHS = new Set([
  'mentions',
  'videos',
  'posts',
  'photos',
  'reviews',
  'about',
  'community',
  'events',
  'reels',
  'services',
  'shop',
  'offers',
]);

export const PLATFORM_OFFICIAL_HANDLES = new Map<string, string[]>([
  ['facebook',  ['facebook', 'fb', 'meta', 'help', 'support', 'business', 'developers']],
  ['instagram', ['instagram', 'meta', 'help', 'support', 'creators', 'business']],
  ['twitter',   ['twitter', 'x', 'support', 'help', 'api', 'verified']],
  ['linkedin',  ['linkedin', 'help', 'support', 'learning']],
  ['youtube',   ['youtube', 'google', 'creators']],
  ['tiktok',    ['tiktok', 'bytedance', 'creators', 'ads']],
]);

export const KNOWN_VENDOR_SOCIAL_HANDLES = new Map<string, string[]>([
  ['facebook',  ['sitepad', 'softaculous', 'wix', 'wixcom', 'shopify', 'squarespace',
                 'weebly', 'godaddy', 'longtail', 'longtailemed', 'webflow', 'carrd']],
  ['twitter',   ['sitepad_editor', 'softaculous', 'wix', 'shopify', 'squarespace',
                 'weebly', 'godaddy', 'longtail', 'webflow']],
  ['linkedin',  ['softaculous-ltd-', 'wix', 'shopify-inc', 'squarespace', 'godaddy',
                 'longtail-e-media', 'webflow']],
  ['instagram', ['sitepadorcom', 'wix', 'shopify', 'squarespace', 'weebly']],
]);

export const PLATFORM_DOMAINS = new Set([
  'noshnepal.com', 'foodmandu.com', 'pathao.com', 'indrive.com',
  'daraz.com', 'daraz.com.np', 'tripadvisor.com', 'booking.com',
  'airbnb.com', 'wixpress.com', 'wordpress.com', 'blogspot.com',
]);

export const BUSINESS_EMAIL_PREFIXES = new Set([
  'info', 'contact', 'office', 'admin', 'support', 'sales', 'hello',
  'enquiry', 'inquiry', 'reception', 'booking', 'legal', 'hr', 'accounts',
  'billing', 'marketing', 'admission', 'frontdesk', 'reservation', 'help',
  'service', 'careers', 'jobs', 'press', 'pr', 'partners', 'media',
  'investors', 'security', 'lawyer', 'advocate', 'desk', 'query',
  'general', 'principal', 'headmaster', 'receptionist', 'services',
  'appointment', 'inquiries', 'mail',
]);

export const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'protonmail.com', 'aol.com',
]);

export const OWNER_LEADERSHIP_TITLES = [
  'owner',
  'founder',
  'co-founder',
  'proprietor',
  'managing director',
  'ceo',
  'chairman',
  'chairperson',
  'president',
  'principal',
  'managing partner',
  'senior partner',
  'partner',
  'head of legal',
  'medical director',
];

export const STAFF_TITLES = [
  'supervisor',
  'housekeeping supervisor',
  'manager',
  'executive',
  'field marketing executive',
  'officer',
  'coordinator',
  'accountant',
  'front desk',
  'receptionist',
  'maid',
  'cleaner',
  'designer',
  'graphic designer',
  'graphic design',
  'web design',
  'design',
  'developer',
  'technician',
  'operator',
  'sales head',
  'head',
  // Legal, Medical & Academic roles (Phase 8i)
  'advocate',
  'senior advocate',
  'attorney',
  'lawyer',
  'associate',
  'counsel',
  'legal advisor',
  'physician',
  'doctor',
  'specialist',
  'teacher',
  'faculty',
  'professor',
  'lecturer',
];

export const EXCLUDED_LEGAL_AND_GOV_ENTITIES = new Set([
  'office of the company registrar',
  'department of industry',
  'department of immigration',
  'nepal rastra bank',
  'investment board',
  'inland revenue department',
  'tribhuvan university',
  'kathmandu university',
  'government of nepal',
  'supreme court',
  'high court',
  'district court',
  'private limited company',
  'public limited company',
  'sole proprietorship',
  'partnership firm',
  'notary nepal',
  'company darta nepal',
]);

export const QUESTION_STARTER_WORDS = /^(how|what|why|when|where|who|which|can|is|are|do|does|should|will|could|would|step|faq|question|reason|practice|service)\b/i;

/**
 * Phase 8h (W2-04) & Phase 8i (CONTACT-02 / Group D): Enhanced multi-business listing / directory / aggregator / blog post detector.
 * Identifies pages presenting multiple distinct companies, contacts, or listicles while disambiguating
 * FAQ question headings, attorney/doctor rosters, and legal/regulatory authority mentions.
 */

export const NEPAL_BRANCH_LOCALITIES = [
  'baneshwor', 'new baneshwor', 'old baneshwor',
  'chitwan', 'bharatpur', 'narayangarh',
  'kumaripati', 'lalitpur', 'patan', 'jawalakhel', 'kupondole', 'lagankhel',
  'butwal', 'rupandehi',
  'kamaladi', 'putalisadak', 'bagbazar', 'dillibazar', 'maharajgunj', 'lazimpat', 'thamel', 'chabahil',
  'koteshwor', 'tinkune', 'sinamangal', 'anamnagar', 'tripureshwor', 'kalanki', 'balkhu', 'kirtipur',
  'satungal', 'thankot', 'balambu', 'naikap', 'chhauni', 'swayambhu', 'banasthali', 'balaju',
  'gongabu', 'samakhusi', 'tokha', 'budhanilkantha', 'basundhara', 'hattigauda',
  'bhaktapur', 'suryabinayak', 'thimi', 'sallaghari',
  'pokhara', 'kaski', 'biratnagar', 'morang', 'birgunj', 'parsa', 'dharan', 'sunsari',
  'hetauda', 'makwanpur', 'nepalgunj', 'banke', 'itahari', 'damak', 'jhapa', 'bhairahawa',
  'dang', 'ghorahi', 'tulsipur', 'dhangadhi', 'kailali', 'janakpur', 'dhanusha', 'banepa', 'kavre',
  'australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
  'canada', 'toronto', 'vancouver', 'uk', 'london', 'usa', 'dallas', 'new york',
];
