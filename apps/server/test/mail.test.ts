import assert from "node:assert/strict";
import { test } from "node:test";
import { magicLinkMail, resetPasswordMail, verifyEmailMail } from "../src/auth/mail";

const link = "https://app.syllabi.studio/auth/magic/?token=a<b&c";

test("account mails carry branded html and a plain-text part with the link", () => {
  for (const mail of [verifyEmailMail("a@b.co", link), magicLinkMail("a@b.co", link), resetPasswordMail("a@b.co", link)]) {
    assert.ok(mail.html?.startsWith("<!doctype html>"));
    assert.ok(mail.text.includes(link));
    assert.ok(mail.html.includes("https://app.syllabi.studio/auth/magic/?token=a&lt;b&amp;c"));
    assert.ok(!mail.html.includes("a<b&c"), "link is escaped in html");
    assert.ok(!/#000(000)?\b/i.test(mail.html), "no pure black");
  }
});
