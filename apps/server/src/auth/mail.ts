/**
 * Outgoing account email. Resend over HTTP (RESEND_API_KEY), SMTP via nodemailer (SMTP_URL),
 * or, with neither, the message (with its link) is written to the server log for development.
 * Each mail has a branded HTML part (mail-template.ts) and a plain-text part. No tracking.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { mailFrom, mailTransport } from "@/auth/config";
import { logger } from "@/services/logger.service";
import { renderMailHtml, type MailContent } from "@/auth/mail-template";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let smtp: Transporter | null = null;

export async function sendMail(mail: Mail): Promise<void> {
  const transport = mailTransport();
  if (transport === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: mailFrom(), to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (transport === "smtp") {
    smtp ??= nodemailer.createTransport(process.env.SMTP_URL as string);
    await smtp.sendMail({ from: mailFrom(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
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

function build(to: string, subject: string, content: MailContent): Mail {
  const text = `${content.body}\n\n${content.action}: ${content.link}\n\n${content.expiry}\n${content.footnote ?? "Didn't ask for this? Just ignore this email."}\n`;
  return { to, subject, text, html: renderMailHtml(content) };
}

export const verifyEmailMail = (to: string, link: string): Mail =>
  build(to, "Confirm your Syllabi email", {
    preheader: "One tap to finish setting up your Syllabi account.",
    title: "Confirm your email",
    body: "Welcome to Syllabi! Tap the button to confirm it's you. After that, the tutor, lecture notes and concept maps are ready to use.",
    action: "Confirm email",
    link,
    expiry: "This button works once, for the next 2 days.",
    footnote: "Didn't sign up for Syllabi? Just ignore this email.",
    hero: "verify",
    features: [
      { title: "Notebooks", body: "Write with your pen like on paper. Stuck on a step? Ask, and it explains." },
      { title: "Practice", body: "Questions and flashcards from your own notes, brought back right before you'd forget them." },
      { title: "Everything due", body: "Homework, exams and classes in one calendar, on your tablet, phone and computer." },
    ],
  });

export const magicLinkMail = (to: string, link: string): Mail =>
  build(to, "Your Syllabi sign-in link", {
    preheader: "Tap to sign in. No password needed.",
    title: "Sign in to Syllabi",
    body: "Tap the button to sign in. No password needed.",
    action: "Sign in",
    link,
    expiry: "This button works once, for the next 15 minutes.",
    hero: "magic",
  });

export const resetPasswordMail = (to: string, link: string): Mail =>
  build(to, "Reset your Syllabi password", {
    preheader: "Pick a new password for Syllabi.",
    title: "Reset your password",
    body: "Forgot your password? No problem. Tap the button and pick a new one.",
    action: "Choose a new password",
    link,
    expiry: "This button works once, for the next hour.",
    footnote: "Didn't ask for this? Just ignore this email. Your password stays the same.",
    hero: "reset",
  });
