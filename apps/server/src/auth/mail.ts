/**
 * Outgoing account email. Resend over HTTP (RESEND_API_KEY), SMTP via nodemailer (SMTP_URL),
 * or, with neither, the message (with its link) is written to the server log for development.
 * Plain text only: a subject, one short paragraph and the link. No tracking.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { mailFrom, mailTransport } from "@/auth/config";
import { logger } from "@/services/logger.service";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

let smtp: Transporter | null = null;

export async function sendMail(mail: Mail): Promise<void> {
  const transport = mailTransport();
  if (transport === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: mailFrom(), to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (transport === "smtp") {
    smtp ??= nodemailer.createTransport(process.env.SMTP_URL as string);
    await smtp.sendMail({ from: mailFrom(), to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }
  console.log(`[mail] (no RESEND_API_KEY or SMTP_URL; not sent)\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
}

/** Send without making the caller wait (no timing signal on the no-enumeration endpoints). */
export function sendMailInBackground(mail: Mail): void {
  sendMail(mail).catch((error) => {
    logger.error("Account email failed", error instanceof Error ? error : new Error(String(error))).catch(() => {});
  });
}

export const verifyEmailMail = (to: string, link: string): Mail => ({
  to,
  subject: "Confirm your Syllabi email",
  text: `Open this link to confirm your email address for Syllabi. It works once and expires in 48 hours.\n\n${link}\n`,
});

export const magicLinkMail = (to: string, link: string): Mail => ({
  to,
  subject: "Your Syllabi sign-in link",
  text: `Open this link to sign in to Syllabi. It works once and expires in 15 minutes. If you did not ask for it, ignore this email.\n\n${link}\n`,
});

export const resetPasswordMail = (to: string, link: string): Mail => ({
  to,
  subject: "Reset your Syllabi password",
  text: `Open this link to choose a new Syllabi password. It works once and expires in 1 hour. If you did not ask for it, ignore this email.\n\n${link}\n`,
});
