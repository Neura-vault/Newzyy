// ════════════════════════════════════════════════════════════
//  MAILER — sends verification codes + contact form notifications
//  Uses Resend (https://resend.com), a plain HTTPS API — not SMTP.
//  Render (and most free cloud hosts) block outbound SMTP ports, which is
//  why Gmail SMTP failed with "Connection timeout". An HTTPS API call is
//  a normal web request, so it isn't affected by that restriction.
//
//  Needs RESEND_API_KEY, and RESEND_FROM (e.g. "Newzyy <noreply@newzyy.site>")
//  — see setup steps for verifying newzyy.site with Resend.
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Newzyy <onboarding@resend.dev>';
const ADMIN_INBOX = process.env.EMAIL_USER || null; // where contact-form notifications land

if (!RESEND_API_KEY) {
  console.error('⚠️ RESEND_API_KEY not set — emails will not be sent. Add it in Render → Environment.');
}

const wrapEmail = (title, bodyHtml) => `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:30px 24px;border:1px solid #e3ded3;">
    <div style="font-size:1.4rem;font-weight:900;margin-bottom:20px;">Newzy<span style="color:#b80000;">y</span></div>
    <h2 style="font-size:1.1rem;margin-bottom:14px;">${title}</h2>
    ${bodyHtml}
    <p style="font-size:0.75rem;color:#888;margin-top:30px;">Newzyy — Independent Journalism</p>
  </div>
`;

// Core sender. Times out after 10s so a Resend outage can never hang a request.
// Returns true/false — never throws.
async function sendEmail(to, subject, html, replyTo) {
  if (!RESEND_API_KEY) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {})
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      console.error(`   ⚠️ Resend API error [${res.status}]:`, errText.substring(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('   ⚠️ Email send error:', e.message);
    return false;
  }
}

async function sendVerificationEmail(toEmail, name, code) {
  return sendEmail(
    toEmail,
    `Your Newzyy verification code: ${code}`,
    wrapEmail('Verify your email', `
      <p>Hi ${name},</p>
      <p>Use this code to verify your Newzyy account:</p>
      <div style="font-size:2rem;font-weight:800;letter-spacing:6px;text-align:center;padding:16px;background:#f7f6f2;margin:16px 0;">${code}</div>
      <p style="font-size:0.85rem;color:#666;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
    `)
  );
}

async function sendContactNotification(name, fromEmail, message) {
  if (!ADMIN_INBOX) {
    console.error('   ⚠️ EMAIL_USER not set — no inbox configured to receive contact messages.');
    return false;
  }
  return sendEmail(
    ADMIN_INBOX,
    `New contact form message from ${name}`,
    wrapEmail('New contact message', `
      <p><strong>From:</strong> ${name} (${fromEmail})</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;background:#f7f6f2;padding:14px;">${message}</p>
    `),
    fromEmail
  );
}

async function sendNewsletterDigest(toEmail, articles) {
  const itemsHtml = articles.map(a => `
    <div style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid #e3ded3;">
      <div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;color:#b80000;">${a.category}</div>
      <div style="font-size:1rem;font-weight:700;margin:4px 0;">${a.title}</div>
      <div style="font-size:0.85rem;color:#666;">${(a.excerpt || '').substring(0, 120)}...</div>
      <a href="${a.url}" style="font-size:0.8rem;color:#b80000;font-weight:600;">Read more →</a>
    </div>
  `).join('');

  return sendEmail(
    toEmail,
    `Today's top stories from Newzyy`,
    wrapEmail("Today's Top Stories", itemsHtml + `
      <p style="font-size:0.75rem;color:#999;margin-top:10px;">
        You're receiving this because you subscribed at newzyy.site.
      </p>
    `)
  );
}

module.exports = { sendVerificationEmail, sendContactNotification, sendNewsletterDigest };
