// Invented demo data pools. No real people, companies, emails, or phone numbers (.example domains, 555 numbers).
export const LEAD_SOURCES = ['Website', 'Referral', 'LinkedIn', 'Cold Outreach', 'Event', 'Ads', 'Partner'] as const;

export const CLIENTS: { name: string; domain: string; industry: string; size: string; city: string; area: string; tz: string; tax?: number }[] = [
  { name: 'Brightline Dental', domain: 'brightlinedental.example', industry: 'dental', size: '11-50', city: 'Austin, TX', area: '512', tz: 'America/Chicago' },
  { name: 'Summit Ridge Realty', domain: 'summitridgerealty.example', industry: 'real_estate', size: '11-50', city: 'Denver, CO', area: '303', tz: 'America/Denver' },
  { name: 'Harborview Insurance Group', domain: 'harborviewins.example', industry: 'insurance', size: '51-200', city: 'Tampa, FL', area: '813', tz: 'America/New_York' },
  { name: 'Copperleaf Home Goods', domain: 'copperleafhome.example', industry: 'ecommerce', size: '11-50', city: 'Portland, OR', area: '503', tz: 'America/Los_Angeles' },
  { name: 'Whitfield & Crane Law', domain: 'whitfieldcrane.example', industry: 'law', size: '11-50', city: 'Charlotte, NC', area: '704', tz: 'America/New_York', tax: 0 },
  { name: 'Pinecrest Family Dental', domain: 'pinecrestdental.example', industry: 'dental', size: '1-10', city: 'Columbus, OH', area: '614', tz: 'America/New_York' },
  { name: 'Northstar Marketing Co.', domain: 'northstarmktg.example', industry: 'marketing', size: '11-50', city: 'Minneapolis, MN', area: '612', tz: 'America/Chicago' },
  { name: 'Bluebird Pet Supply', domain: 'bluebirdpet.example', industry: 'ecommerce', size: '11-50', city: 'Nashville, TN', area: '615', tz: 'America/Chicago' },
  { name: 'Granite Peak Properties', domain: 'granitepeakprops.example', industry: 'real_estate', size: '51-200', city: 'Salt Lake City, UT', area: '801', tz: 'America/Denver' },
  { name: 'Lakeside Legal Partners', domain: 'lakesidelegal.example', industry: 'law', size: '11-50', city: 'Chicago, IL', area: '312', tz: 'America/Chicago' },
  { name: 'Evergreen Insurance Advisors', domain: 'evergreenins.example', industry: 'insurance', size: '11-50', city: 'Seattle, WA', area: '206', tz: 'America/Los_Angeles', tax: 1025 },
  { name: 'Sunset Smiles Orthodontics', domain: 'sunsetsmiles.example', industry: 'dental', size: '11-50', city: 'San Diego, CA', area: '619', tz: 'America/Los_Angeles' },
  { name: 'Maple & Main Realty', domain: 'maplemainrealty.example', industry: 'real_estate', size: '1-10', city: 'Burlington, VT', area: '802', tz: 'America/New_York' },
  { name: 'Brightwave Digital', domain: 'brightwavedigital.example', industry: 'marketing', size: '11-50', city: 'Atlanta, GA', area: '404', tz: 'America/New_York' },
  { name: 'Coastal Cart Co.', domain: 'coastalcart.example', industry: 'ecommerce', size: '1-10', city: 'Charleston, SC', area: '843', tz: 'America/New_York' },
];

const leadNames: [string, string][] = [
  ['Oakmont Dental Studio', 'dental'], ['Riverbend Realty Group', 'real_estate'], ['Ironwood Insurance Agency', 'insurance'], ['Fernhill Apparel', 'ecommerce'],
  ['Calloway & Pierce LLP', 'law'], ['Kindred Smiles Dental', 'dental'], ['Lumen Growth Studio', 'marketing'], ['Saltbox Home Co.', 'ecommerce'],
  ['Redstone Property Management', 'real_estate'], ['Arbor Benefits Group', 'insurance'], ['Westbrook Family Law', 'law'], ['Cedar Lane Orthodontics', 'dental'],
  ['Hilltop Realty Partners', 'real_estate'], ['Pacific Shield Insurance', 'insurance'], ['Wildflower Candle Co.', 'ecommerce'], ['Brightpath Media', 'marketing'],
  ['Stonegate Legal', 'law'], ['Gentle Care Dentistry', 'dental'], ['Bayside Homes Realty', 'real_estate'], ['Cornerstone Coverage', 'insurance'],
  ['Juniper Kitchenware', 'ecommerce'], ['Signal Peak Marketing', 'marketing'], ['Hawthorne Injury Law', 'law'], ['Willow Creek Dental', 'dental'],
  ['Lighthouse Realty', 'real_estate'], ['Union Mutual Advisors', 'insurance'], ['Trailhead Gear Co.', 'ecommerce'], ['Ember & Oak Creative', 'marketing'],
  ['Ashford Estate Law', 'law'], ['Meadowbrook Dental Care', 'dental'], ['Clearwater Property Co.', 'real_estate'], ['Beacon Risk Partners', 'insurance'],
  ['Tidepool Swimwear', 'ecommerce'], ['Northwind Agency', 'marketing'], ['Garrison & Vale Law', 'law'], ['Sparrow Pediatric Dental', 'dental'],
  ['Magnolia Realty', 'real_estate'], ['Keel Insurance Brokers', 'insurance'],
];
export const LEADS = leadNames.map(([name, industry]) => ({ name, industry, domain: name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '') + '.example' }));

export const POSITION_TITLES: Record<string, string[]> = {
  dental: ['Dental Front Desk VA', 'Dental Insurance Verification Specialist', 'Dental Billing Specialist'],
  real_estate: ['Real Estate Transaction Coordinator', 'Real Estate Lead Gen VA', 'Listing Coordinator'],
  insurance: ['Insurance Account Manager VA', 'Insurance Quoting Specialist', 'Claims Support VA'],
  ecommerce: ['E-commerce Customer Support', 'Shopify Store Assistant', 'Order Processing VA'],
  law: ['Legal Assistant VA', 'Remote Paralegal', 'Legal Intake Specialist'],
  marketing: ['Social Media Manager', 'Content Writer', 'Email Marketing Specialist'],
};

export const FAMILIES: Record<string, { role: string; duty: string; skills: string[]; software: string[] }> = {
  dental: { role: 'Dental Virtual Assistant', duty: 'manage patient scheduling, verify insurance eligibility and handle patient calls and messages', skills: ['Patient Scheduling', 'Insurance Verification', 'Patient Intake', 'Customer Service', 'Medical Billing', 'HIPAA Compliance'], software: ['Dentrix', 'Eaglesoft', 'Open Dental', 'Google Workspace', 'Weave'] },
  real_estate: { role: 'Real Estate Virtual Assistant', duty: 'coordinate transactions from contract to close, manage CRM pipelines and follow up with leads', skills: ['Transaction Coordination', 'Lead Generation', 'CRM Management', 'Cold Calling', 'Listing Management', 'Calendar Management'], software: ['Follow Up Boss', 'kvCORE', 'DocuSign', 'Zillow Premier Agent', 'Dotloop'] },
  insurance: { role: 'Insurance Virtual Assistant', duty: 'service policies, prepare quotes and renewals and support claims follow-up', skills: ['Policy Servicing', 'Quoting', 'Claims Processing', 'Renewals', 'Customer Service', 'Data Entry'], software: ['Applied Epic', 'HawkSoft', 'EZLynx', 'Excel', 'QuickBooks'] },
  ecommerce: { role: 'E-commerce Support Specialist', duty: 'answer customer tickets, process orders and returns and keep product listings accurate', skills: ['Customer Support', 'Order Processing', 'Product Listing', 'Inventory Management', 'Live Chat', 'Returns Handling'], software: ['Shopify', 'Zendesk', 'Gorgias', 'Amazon Seller Central', 'Klaviyo'] },
  law: { role: 'Legal Virtual Assistant', duty: 'prepare legal documents, manage case files and handle client intake calls', skills: ['Legal Research', 'Document Preparation', 'Case Management', 'Client Intake', 'Calendar Management', 'Bookkeeping'], software: ['Clio', 'MyCase', 'Microsoft Word', 'QuickBooks', 'Dropbox'] },
  marketing: { role: 'Digital Marketing Assistant', duty: 'plan social content, write copy and run email campaigns', skills: ['Social Media Management', 'Content Writing', 'SEO', 'Email Marketing', 'Graphic Design', 'Copywriting'], software: ['Canva', 'HubSpot', 'Mailchimp', 'Hootsuite', 'Google Analytics'] },
};

export const COUNTRIES: Record<string, { code: string; name: string; city: string; tz: string; dial: string; lang: string | null; rate: [number, number]; first: string[]; last: string[] }> = {
  PH: { code: 'PH', name: 'Philippines', city: pickCity(['Manila', 'Cebu City', 'Davao City', 'Quezon City', 'Iloilo City']), tz: 'Asia/Manila', dial: '+63 917', lang: 'Tagalog', rate: [9, 16], first: ['Angelica', 'Mark', 'Kristine', 'John Paul', 'Rhea', 'Carlo', 'Jasmine', 'Paolo', 'Bea', 'Miguel', 'Patricia', 'Ramon', 'Joanna', 'Christian', 'Liza', 'Arvin'], last: ['Reyes', 'Cruz', 'Bautista', 'Garcia', 'Mendoza', 'Villanueva', 'Ramos', 'Aquino', 'Castillo', 'Dela Cruz', 'Navarro', 'Torres', 'Flores', 'Gonzales'] },
  MX: { code: 'MX', name: 'Mexico', city: 'Guadalajara', tz: 'America/Mexico_City', dial: '+52 33', lang: 'Spanish', rate: [14, 22], first: ['Sofia', 'Mateo', 'Valentina', 'Diego', 'Ximena', 'Emiliano', 'Regina', 'Rodrigo'], last: ['Hernandez', 'Lopez', 'Martinez', 'Gomez', 'Ruiz', 'Morales', 'Ortega', 'Navarro'] },
  CO: { code: 'CO', name: 'Colombia', city: 'Medellín', tz: 'America/Bogota', dial: '+57 300', lang: 'Spanish', rate: [14, 22], first: ['Camila', 'Andres', 'Lucia', 'Santiago', 'Isabella', 'Juan Pablo', 'Daniela', 'Felipe'], last: ['Rodriguez', 'Perez', 'Sanchez', 'Romero', 'Alvarez', 'Vargas', 'Castro', 'Rojas'] },
  AR: { code: 'AR', name: 'Argentina', city: 'Córdoba', tz: 'America/Argentina/Buenos_Aires', dial: '+54 351', lang: 'Spanish', rate: [16, 24], first: ['Martina', 'Tomas', 'Agustina', 'Nicolas', 'Florencia', 'Joaquin'], last: ['Fernandez', 'Gimenez', 'Acosta', 'Benitez', 'Sosa', 'Medina'] },
  PE: { code: 'PE', name: 'Peru', city: 'Lima', tz: 'America/Lima', dial: '+51 987', lang: 'Spanish', rate: [12, 20], first: ['Lucia', 'Renzo', 'Ariana', 'Bruno', 'Fiorella', 'Gonzalo'], last: ['Quispe', 'Flores', 'Huaman', 'Chavez', 'Ramirez', 'Mendoza'] },
  ZA: { code: 'ZA', name: 'South Africa', city: 'Cape Town', tz: 'Africa/Johannesburg', dial: '+27 82', lang: 'Afrikaans', rate: [16, 24], first: ['Thabo', 'Naledi', 'Sipho', 'Lerato', 'Johan', 'Ayanda', 'Pieter', 'Zanele', 'Kagiso', 'Annika'], last: ['Nkosi', 'Dlamini', 'van der Merwe', 'Botha', 'Mokoena', 'Naidoo', 'Pillay', 'Khumalo'] },
  KE: { code: 'KE', name: 'Kenya', city: 'Nairobi', tz: 'Africa/Nairobi', dial: '+254 712', lang: 'Swahili', rate: [10, 18], first: ['Wanjiru', 'Brian', 'Achieng', 'Kevin', 'Njeri', 'Dennis', 'Akinyi', 'Collins'], last: ['Otieno', 'Kamau', 'Mwangi', 'Odhiambo', 'Wambui', 'Kiprop', 'Njoroge', 'Ochieng'] },
};
function pickCity(cities: string[]) { return cities[0]; }

export const UNIVERSITIES: Record<string, string[]> = {
  PH: ['Polytechnic University of the Philippines', 'University of Santo Tomas', 'Cebu Institute of Technology', 'University of Mindanao'],
  MX: ['Universidad de Guadalajara', 'Tecnológico de Monterrey'],
  CO: ['Universidad de Antioquia', 'Universidad EAFIT'],
  AR: ['Universidad Nacional de Córdoba'],
  PE: ['Pontificia Universidad Católica del Perú', 'Universidad de Lima'],
  ZA: ['University of Cape Town', 'Stellenbosch University', 'University of Johannesburg'],
  KE: ['University of Nairobi', 'Kenyatta University', 'Strathmore University'],
};

export const EMPLOYERS = ['Acme Outsourcing Inc.', 'Pacific Support Solutions', 'BrightDesk BPO', 'Northgate Virtual Staffing', 'Summit Contact Center', 'Bluewave Remote Services', 'Orbit Business Process', 'Clearline Admin Partners', 'Self-employed (freelance)'];
