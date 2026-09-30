// Public contact details: Unyly (as published on unyly.org/contact) and the project owner's direct lines.
export const CONTACT = {
  email: 'info@unyly.org',
  site: 'https://unyly.org',
  telegramGlobal: 'https://t.me/unyly_global',
  telegramCis: 'https://t.me/unyly_cis',
  company: 'CSA PROJECT - FZCO',
  address: 'IFZA Business Park, DDP, Premises Number 31174 - 001, Dubai, UAE',
  /** Direct lines of the project owner (Alex Vasilev). Empty values are not shown. */
  owner: {
    name: 'Alex Vasilev',
    email: 'alxvasilevv@gmail.com',
    /** International numbers, digits only. */
    whatsapp: '971585479661',
    line: '66618267415',
    instagram: 'Alvasilev',
    linkedin: process.env.CONTACT_LINKEDIN ?? '',
  },
};

export const whatsappUrl = (digits: string) => `https://wa.me/${digits}`;
export const whatsappLabel = (digits: string) => phoneLabel(digits);
export const phoneLabel = (digits: string) =>
  digits.startsWith('66') ? `+66 ${digits.slice(2, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`
  : digits.startsWith('971') ? `+971 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  : `+${digits}`;
export const instagramUrl = (handle: string) => `https://instagram.com/${handle}`;
