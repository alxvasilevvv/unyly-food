import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  /** Last messages (console mode only), used by tests and local dev. */
  outbox: { to: string; subject: string; text: string }[];
}

export function createMailer(cfg: Config): Mailer {
  const outbox: Mailer['outbox'] = [];
  // loadConfig validates MAIL_MODE; this guards configs built by hand (a typo must never fall through to console).
  if (!['smtp', 'disabled', 'console'].includes(cfg.mail.mode)) throw new Error(`Unknown MAIL_MODE "${cfg.mail.mode}" (expected smtp, disabled or console)`);
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
      // Never log message content: subjects and bodies can carry sign-in codes. Only local development
      // gets the subject (the code itself is never in the subject; see loginMail).
      if (cfg.env === 'development') console.log(`[mail:console] to=${to.replace(/(.).+@/, '$1***@')} subject="${subject}"`);
      else if (cfg.env !== 'test') console.log(`[mail:console] to=${to.replace(/(.).+@/, '$1***@')} (content not logged)`);
    },
  };
}
