import { isProduction } from '../config/env';

// Integration boundary for outbound email. Swap the body of `sendMail` for an SMTP/API provider in production.
// Development fallback: messages are written to the server console and never leave the machine.
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (isProduction) {
    // No provider configured in this build. Fail loudly instead of silently dropping reset links.
    throw new Error('Email delivery is not configured. Set a mail provider in lib/mailer.ts.');
  }
  console.log(
    `\n[DEV MAIL FALLBACK - not delivered]\nTo: ${message.to}\nSubject: ${message.subject}\n${message.text}\n`,
  );
}
