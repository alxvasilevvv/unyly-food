// Public contact details: Unyly (as published on unyly.org/contact) and the project owner's direct lines.
export const CONTACT = {
  email: 'info@unyly.org',
  site: 'https://unyly.org',
  telegramGlobal: 'https://t.me/unyly_global',
  telegramCis: 'https://t.me/unyly_cis',
  company: 'CSA PROJECT - FZCO',
  address: 'IFZA Business Park, DDP, Premises Number 31174 - 001, Dubai, UAE',
  /** Direct lines of the project owner. Empty values are not shown. */
  owner: {
    linkedin: process.env.CONTACT_LINKEDIN ?? '',
    /** International number, digits only (e.g. 66812345678); rendered as a wa.me link. */
    whatsapp: (process.env.CONTACT_WHATSAPP ?? '').replace(/\D/g, ''),
  },
};

export const whatsappUrl = (digits: string) => `https://wa.me/${digits}`;
export const whatsappLabel = (digits: string) => `+${digits}`;
