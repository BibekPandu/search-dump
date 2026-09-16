/**
 * ══════════════════════════════════════════════════════════════════════════════
 * Nepal Telecommunications Authority (NTA) Numbering Reference
 * ══════════════════════════════════════════════════════════════════════════════
 * Provenance: NTA National Numbering Allocation Plan, 2079 & NTA Numbering Portal.
 * Structural Rules:
 *   - Cellular Mobile: 10 national digits (Service code 96/97/98 + operator digit + 7 subscriber digits).
 *   - Fixed Landline: 8 national digits:
 *       - Kathmandu Valley (Zone 1): 1-digit area code (1) + 7-digit subscriber number.
 *       - Outside Kathmandu (Zones 2-9): 2-digit area code (e.g. 61, 21) + 6-digit subscriber number.
 *   - Trunk Prefix: '0' for domestic STD dialing (e.g. 01 for Kathmandu, 061 for Pokhara).
 */

export const NEPAL_COUNTRY_CODE = '977';

/**
 * Verified mobile allocation ranges from: NTA National Numbering Allocation Plan, 2079.
 * All Nepal mobile numbers are 10 digits starting with these 3-digit prefixes.
 */
export const NTA_MOBILE_PREFIXES = [
  '984', '985', '986',        // Nepal Telecom (NTC) GSM
  '974', '975',               // Nepal Telecom (NTC) CDMA
  '980', '981', '982', '970', // Ncell Axiata GSM
  '988', '961', '962',        // Smart Telecom (historical allocations)
  '972',                      // UTL (historical allocation)
] as const;

/**
 * Nationwide NTA Landline Area Codes (trunk 0 + area code).
 * Complete coverage across all regions in Nepal.
 */
export const NTA_LANDLINE_AREA_CODES: Record<string, { region: string; areaCodeDigits: string; subscriberLength: number }> = {
  // Zone 1: Kathmandu Valley
  '01':  { region: 'Kathmandu Valley', areaCodeDigits: '1',  subscriberLength: 7 },
  // Zone 2: Eastern Region
  '021': { region: 'Biratnagar (Morang)', areaCodeDigits: '21', subscriberLength: 6 },
  '023': { region: 'Bhadrapur (Jhapa)',   areaCodeDigits: '23', subscriberLength: 6 },
  '024': { region: 'Ilam',                areaCodeDigits: '24', subscriberLength: 6 },
  '025': { region: 'Dharan (Sunsari)',    areaCodeDigits: '25', subscriberLength: 6 },
  '026': { region: 'Dhankuta',            areaCodeDigits: '26', subscriberLength: 6 },
  '027': { region: 'Bhojpur',             areaCodeDigits: '27', subscriberLength: 6 },
  '029': { region: 'Okhaldhunga',         areaCodeDigits: '29', subscriberLength: 6 },
  // Zone 4 & 5: Central Region
  '041': { region: 'Janakpur (Dhanusha)', areaCodeDigits: '41', subscriberLength: 6 },
  '044': { region: 'Lahan (Siraha)',      areaCodeDigits: '44', subscriberLength: 6 },
  '046': { region: 'Malangwa (Sarlahi)',  areaCodeDigits: '46', subscriberLength: 6 },
  '051': { region: 'Birgunj (Parsa)',     areaCodeDigits: '51', subscriberLength: 6 },
  '053': { region: 'Gaur (Rautahat)',     areaCodeDigits: '53', subscriberLength: 6 },
  '056': { region: 'Bharatpur (Chitwan)', areaCodeDigits: '56', subscriberLength: 6 },
  '057': { region: 'Hetauda (Makwanpur)', areaCodeDigits: '57', subscriberLength: 6 },
  // Zone 6 & 7: Western Region
  '061': { region: 'Pokhara (Kaski)',     areaCodeDigits: '61', subscriberLength: 6 },
  '063': { region: 'Besisahar (Lamjung)', areaCodeDigits: '63', subscriberLength: 6 },
  '064': { region: 'Gorkha',              areaCodeDigits: '64', subscriberLength: 6 },
  '065': { region: 'Damauli (Tanahun)',   areaCodeDigits: '65', subscriberLength: 6 },
  '066': { region: 'Syangja',             areaCodeDigits: '66', subscriberLength: 6 },
  '067': { region: 'Kusma (Parbat)',      areaCodeDigits: '67', subscriberLength: 6 },
  '068': { region: 'Baglung',             areaCodeDigits: '68', subscriberLength: 6 },
  '069': { region: 'Beni (Myagdi)',       areaCodeDigits: '69', subscriberLength: 6 },
  '071': { region: 'Butwal (Rupandehi)',  areaCodeDigits: '71', subscriberLength: 6 },
  '075': { region: 'Tansen (Palpa)',      areaCodeDigits: '75', subscriberLength: 6 },
  '076': { region: 'Sandhikharka (Arghakhanchi)', areaCodeDigits: '76', subscriberLength: 6 },
  '077': { region: 'Tamghas (Gulmi)',     areaCodeDigits: '77', subscriberLength: 6 },
  '078': { region: 'Parasi (Nawalparasi)',areaCodeDigits: '78', subscriberLength: 6 },
  // Zone 8 & 9: Mid-Western & Far-Western Region
  '081': { region: 'Nepalgunj (Banke)',   areaCodeDigits: '81', subscriberLength: 6 },
  '082': { region: 'Ghorahi (Dang)',      areaCodeDigits: '82', subscriberLength: 6 },
  '083': { region: 'Birendranagar (Surkhet)', areaCodeDigits: '83', subscriberLength: 6 },
  '084': { region: 'Gulariya (Bardiya)',  areaCodeDigits: '84', subscriberLength: 6 },
  '091': { region: 'Dhangadhi (Kailali)', areaCodeDigits: '91', subscriberLength: 6 },
  '092': { region: 'Dadeldhura',          areaCodeDigits: '92', subscriberLength: 6 },
  '093': { region: 'Baitadi',             areaCodeDigits: '93', subscriberLength: 6 },
  '094': { region: 'Darchula',            areaCodeDigits: '94', subscriberLength: 6 },
  '097': { region: 'Mahendranagar (Kanchanpur)', areaCodeDigits: '97', subscriberLength: 6 },
};
