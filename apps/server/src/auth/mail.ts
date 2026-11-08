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
  const text = `${content.body}\n\n${content.action}: ${content.link}\n\n${content.expiry}\n${content.footnote ?? "If you didn't ask for this, you can ignore this email."}\n`;
  return { to, subject, text, html: renderMailHtml(content) };
}

export const verifyEmailMail = (to: string, link: string): Mail =>
  build(to, "Confirm your Syllabi email", {
    preheader: "One tap to confirm your email and turn on the AI tutor.",
    title: "Confirm your email",
    body: "Welcome to Syllabi! Confirm this address to finish setting up your account and turn on the AI features: the tutor, lecture notes and concept maps.",
    action: "Confirm email",
    link,
    expiry: "This link works once and expires in 48 hours.",
    footnote: "If you didn't create a Syllabi account, you can ignore this email.",
    hero: "verify",
    features: [
      { title: "Notebooks", body: "Write by hand with your stylus; the AI can read your work and explain a step." },
      { title: "Spaced repetition", body: "Questions and flashcards from your material, scheduled so you review at the right time." },
      { title: "Everything due", body: "Classes, deadlines and reviews in one calendar, synced to every device." },
    ],
  });

export const magicLinkMail = (to: string, link: string): Mail =>
  build(to, "Your Syllabi sign-in link", {
    preheader: "Your sign-in link is ready. It expires in 15 minutes.",
    title: "Sign in to Syllabi",
    body: "Tap the button to sign in. No password needed.",
    action: "Sign in",
    link,
    expiry: "This link works once and expires in 15 minutes.",
    hero: "magic",
  });

export const resetPasswordMail = (to: string, link: string): Mail =>
  build(to, "Reset your Syllabi password", {
    preheader: "Choose a new password for your Syllabi account.",
    title: "Reset your password",
    body: "Someone asked to reset the password for this Syllabi account. Tap the button to choose a new one.",
    action: "Choose a new password",
    link,
    expiry: "This link works once and expires in 1 hour.",
    footnote: "If you didn't ask for this, ignore this email. Your password stays the same.",
    hero: "reset",
  });
