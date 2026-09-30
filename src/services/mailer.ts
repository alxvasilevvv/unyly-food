import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  /** Last messages (console mode only), used by tests and local dev. */
  outbox: { to: string; subject: string; text: string }[];
}

export function createMailer(cfg: Config): Mailer {
  const outbox: Mailer['outbox'] = [];
  if (cfg.mail.mode === 'disabled') {
    return { outbox, async send() { throw new Error('mail disabled'); } };
  }
  if (cfg.mail.mode === 'smtp') {
    if (!cfg.mail.smtpUrl) throw new Error('SMTP_URL is required when MAIL_MODE=smtp');
    const t = nodemailer.createTransport(cfg.mail.smtpUrl);
    return {
      outbox,
      async send(to, subject, text) {
        await t.sendMail({ from: cfg.mail.from, to, subject, text });
      },
    };
  }
  return {
    outbox,
    async send(to, subject, text) {
      outbox.push({ to, subject, text });
      if (outbox.length > 50) outbox.shift();
      if (cfg.env !== 'test') console.log(`[mail:console] to=${to.replace(/(.).+@/, '$1***@')} subject="${subject}"`);
    },
  };
}
