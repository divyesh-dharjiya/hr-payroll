// Integration boundary for outbound email. The browser build cannot send mail, so messages (password reset and
// welcome links) are written to the browser console. Replace the body of `sendMail` with a call to a mail API to
// deliver them for real.
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export function sendMail(message: MailMessage): void {
  console.info(`[PeopleHub mail - not delivered]\nTo: ${message.to}\nSubject: ${message.subject}\n${message.text}`);
}

/** Absolute link into this app, e.g. for a password reset email. */
export function appLink(path: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost:4200';
  return `${origin}${path}`;
}
