// ════════════════════════════════════════════════════════════
//  MAILER — sends verification codes + contact form notifications
//  Uses Gmail SMTP (free) via Nodemailer. Needs EMAIL_USER + EMAIL_PASS
//  (a Gmail "App Password", not your normal Gmail password — see setup steps).
// ════════════════════════════════════════════════════════════

const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    connectionTimeout: 10000, // fail fast instead of hanging if the port is blocked
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
} else {
  console.error('⚠️ EMAIL_USER / EMAIL_PASS not set — emails will not be sent. Add them in Render → Environment.');
}

const wrapEmail = (title, bodyHtml) => `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:30px 24px;border:1px solid #e3ded3;">
    <div style="font-size:1.4rem;font-weight:900;margin-bottom:20px;">Newzy<span style="color:#b80000;">y</span></div>
    <h2 style="font-size:1.1rem;margin-bottom:14px;">${title}</h2>
    ${bodyHtml}
    <p style="font-size:0.75rem;color:#888;margin-top:30px;">Newzyy — Independent Journalism</p>
  </div>
`;

// Returns true/false — never throws, so callers can continue safely either way.
async function sendVerificationEmail(toEmail, name, code) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({
      from: `"Newzyy" <${EMAIL_USER}>`,
      to: toEmail,
      subject: `Your Newzyy verification code: ${code}`,
      html: wrapEmail('Verify your email', `
        <p>Hi ${name},</p>
        <p>Use this code to verify your Newzyy account:</p>
        <div style="font-size:2rem;font-weight:800;letter-spacing:6px;text-align:center;padding:16px;background:#f7f6f2;margin:16px 0;">${code}</div>
        <p style="font-size:0.85rem;color:#666;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
      `)
    });
    return true;
  } catch (e) {
    console.error('   ⚠️ sendVerificationEmail failed:', e.message);
    return false;
  }
}

async function sendContactNotification(name, fromEmail, message) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({
      from: `"Newzyy Contact Form" <${EMAIL_USER}>`,
      to: EMAIL_USER, // sends to your own inbox
      replyTo: fromEmail,
      subject: `New contact form message from ${name}`,
      html: wrapEmail('New contact message', `
        <p><strong>From:</strong> ${name} (${fromEmail})</p>
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;background:#f7f6f2;padding:14px;">${message}</p>
      `)
    });
    return true;
  } catch (e) {
    console.error('   ⚠️ sendContactNotification failed:', e.message);
    return false;
  }
}

module.exports = { sendVerificationEmail, sendContactNotification };
