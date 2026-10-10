export const SEED_CUSTOMER_COUNT = 1000;

const FIRST_NAMES: readonly (readonly [string, string])[] = [
  ['Noa', 'נועה'],
  ['Yael', 'יעל'],
  ['Maya', 'מאיה'],
  ['Ariel', 'אריאל'],
  ['Daniel', 'דניאל'],
  ['Lior', 'ליאור'],
  ['Tamar', 'תמר'],
  ['Yonatan', 'יונתן'],
  ['Shira', 'שירה'],
  ['Eitan', 'איתן'],
  ['Michal', 'מיכל'],
  ['Omar', 'עומר'],
  ['Roni', 'רוני'],
  ['Gal', 'גל'],
  ['Hila', 'הילה'],
  ['Itay', 'איתי'],
  ['Noam', 'נועם'],
  ['Yaara', 'יערה'],
  ['Amit', 'עמית'],
  ['Talia', 'טליה'],
];

const LAST_NAMES: readonly (readonly [string, string])[] = [
  ['Cohen', 'כהן'],
  ['Levi', 'לוי'],
  ['Mizrahi', 'מזרחי'],
  ['Peretz', 'פרץ'],
  ['Biton', 'ביטון'],
  ['Friedman', 'פרידמן'],
  ['Azoulay', 'אזולאי'],
  ['Dahan', 'דהן'],
  ['Avraham', 'אברהם'],
  ['Malka', 'מלכה'],
];

const CITIES = [
  'Tel Aviv',
  'Jerusalem',
  'Haifa',
  'Beersheba',
  'Rishon LeZion',
  'Petah Tikva',
  'Ashdod',
  'Netanya',
  'Holon',
  'Bnei Brak',
  'Ramat Gan',
  'Ashkelon',
  'Rehovot',
  'Bat Yam',
  'Herzliya',
  'Kfar Saba',
  'Hadera',
  'Modiin',
  'Nazareth',
  'Lod',
  'Raanana',
  'Ramla',
  'Givatayim',
  'Hod Hasharon',
  'Kiryat Ata',
  'Acre',
  'Eilat',
  'Tiberias',
  'Karmiel',
  'Afula',
] as const;

export interface SeedCustomer {
  id: string;
  nameEn: string;
  nameHe: string;
  city: string;
  phone: string;
}

/** Deterministic customer. Phones use separators so the value is not a 12-digit run. */
export function customerAt(index: number): SeedCustomer {
  if (!Number.isInteger(index) || index < 0 || index >= SEED_CUSTOMER_COUNT) {
    throw new Error(`customer index must be 0..${SEED_CUSTOMER_COUNT - 1}`);
  }
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  if (!first || !last) {
    throw new Error('customer name tables are empty');
  }
  const city = CITIES[index % CITIES.length];
  if (!city) {
    throw new Error('city table is empty');
  }
  return {
    id: `cust-${String(index).padStart(4, '0')}`,
    nameEn: `${first[0]} ${last[0]}`,
    nameHe: `${first[1]} ${last[1]}`,
    city,
    phone: phoneFor(index),
  };
}

export function allCustomers(): SeedCustomer[] {
  return Array.from({ length: SEED_CUSTOMER_COUNT }, (_, index) => customerAt(index));
}

function phoneFor(index: number): string {
  const prefix = 50 + (index % 8);
  const subscriber = String(index).padStart(7, '0');
  return `+972-${prefix}-${subscriber.slice(0, 3)}-${subscriber.slice(3)}`;
}
