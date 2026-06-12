// ════════════════════════════════════════════════════════════
//  NEWZYY  —  OTP Backend  (Node.js + Express + Resend API)
//  Start:  node server.js
//  Port:   3001  (change PORT env var to override)
// ════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const { Resend } = require('resend');

const app  = express();
const PORT = process.env.PORT || 3001;
// ════════════════════════════════════════════════════════════
//  NEWZYY  —  OTP Backend + Auto News Fetcher
//  Start:  node server.js
//  Port:   3001 (or Render port)
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3001;

// ── API Keys ────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '3d1c54f463114aa7b89add3425c96029';  // ← Apni NewsAPI key yahan daalo

const resend = new Resend(RESEND_API_KEY);

// ── In-memory OTP store ────────────────────────────────────
const otpStore = {};
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_MS = 60 * 1000;

// ── Cleanup expired OTPs every 10 min ──────────────────────
setInterval(() => {
  const now = Date.now();
  for (const email in otpStore) {
    if (otpStore[email].expiresAt < now) delete otpStore[email];
  }
}, 10 * 60 * 1000);

// ── Middleware ─────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy OTP + News API', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════
//  SEND OTP
// ════════════════════════════════════════════════════════════
app.post('/send-otp', async (req, res) => {
  try {
    const { email, type = 'signup', name = 'User' } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    const existing = otpStore[email.toLowerCase()];
    if (existing && existing.sentAt && (Date.now() - existing.sentAt) < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (Date.now() - existing.sentAt)) / 1000);
      return res.status(429).json({
        success: false,
        message: `Please wait ${wait} seconds before requesting another code.`
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));

    otpStore[email.toLowerCase()] = {
      code,
      expiresAt: Date.now() + OTP_EXPIRY_MS,
      sentAt: Date.now(),
      attempts: 0,
      type
    };

    const isSignup = type === 'signup';
    const subject = isSignup
      ? `${code} — Your Newzyy Verification Code`
      : `${code} — Confirm Your Newzyy Sign In`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin:0; padding:0; background:#f7f7f5; font-family:'Helvetica Neue',Arial,sans-serif; }
    .wrap { max-width:520px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
    .header { background:#0f0f0f; padding:32px; text-align:center; }
    .logo { font-size:2rem; font-weight:900; color:#fff; letter-spacing:-1px; }
    .logo span { color:#e8380d; }
    .body { padding:40px 36px; }
    .greeting { font-size:1rem; color:#4a4a4a; margin-bottom:8px; }
    .headline { font-size:1.35rem; font-weight:700; color:#0f0f0f; margin-bottom:24px; line-height:1.3; }
    .code-box { background:#f7f7f5; border:2px dashed #e8380d; border-radius:12px; padding:28px; text-align:center; margin:24px 0; }
    .code { font-size:3rem; font-weight:900; letter-spacing:12px; color:#e8380d; font-family:'Courier New',monospace; }
    .expiry { font-size:.82rem; color:#8a8a8a; margin-top:10px; }
    .note { background:#fff1ee; border-radius:8px; padding:14px 16px; font-size:.83rem; color:#4a4a4a; margin:20px 0; border-left:3px solid #e8380d; }
    .footer { background:#f7f7f5; padding:24px 36px; text-align:center; font-size:.75rem; color:#aaa; border-top:1px solid #e8e4df; }
    .footer a { color:#e8380d; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo">Newzy<span>y</span></div>
    </div>
    <div class="body">
      <div class="greeting">Hi ${name},</div>
      <div class="headline">${isSignup ? 'Verify your new account' : 'Confirm your sign in'}</div>
      <p style="font-size:.9rem;color:#4a4a4a;line-height:1.6">
        ${isSignup
          ? 'Welcome to Newzyy! Enter the code below to confirm your email and activate your account.'
          : 'Someone (hopefully you!) is signing in to Newzyy. Enter this code to confirm.'}
      </p>
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="expiry">⏱ Expires in 5 minutes</div>
      </div>
      <div class="note">
        🔒 <strong>Security tip:</strong> Never share this code with anyone. Newzyy will never ask for your code.
      </div>
      <p style="font-size:.83rem;color:#8a8a8a;line-height:1.6">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      © 2026 Newzyy — Independent journalism, always.
    </div>
  </div>
</body>
</html>`;

    const { data, error } = await resend.emails.send({
      from: `Newzyy <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to: [email],
      subject,
      html: htmlBody
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ success: false, message: 'Failed to send email. Please try again.' });
    }

    console.log(`OTP sent to ${email} | code: ${code}`);
    res.json({ success: true, message: 'Verification code sent to your email.' });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════
//  VERIFY OTP
// ════════════════════════════════════════════════════════════
app.post('/verify-otp', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and code are required.' });
    }

    const record = otpStore[email.toLowerCase()];

    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'No verification code found. Please request a new one.'
      });
    }

    if (Date.now() > record.expiresAt) {
      delete otpStore[email.toLowerCase()];
      return res.status(400).json({
        success: false,
        message: 'Code expired. Please request a new one.',
        expired: true
      });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      delete otpStore[email.toLowerCase()];
      return res.status(429).json({
        success: false,
        message: 'Too many attempts. Please request a new code.',
        locked: true
      });
    }

    if (String(code).trim() !== String(record.code)) {
      record.attempts++;
      const remaining = MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({
        success: false,
        message: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
          : 'Too many attempts. Please request a new code.'
      });
    }

    delete otpStore[email.toLowerCase()];
    console.log(`OTP verified for ${email}`);
    res.json({ success: true, message: 'Email verified successfully.' });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
//  AUTO NEWS FETCHER (Every 6 Hours)
// ════════════════════════════════════════════════════════════

const CATEGORIES = ['technology', 'sports', 'business', 'health', 'politics', 'science', 'entertainment'];

function getCategoryImage(cat) {
  const images = {
    technology: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80',
    sports: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&q=80',
    business: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
    health: 'https://images.unsplash.com/photo-1505751172876-fa1923c5c528?w=800&q=80',
    politics: 'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=800&q=80',
    science: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=800&q=80',
    entertainment: 'https://images.unsplash.com/photo-1598899134739-24c46f58b8c0?w=800&q=80'
  };
  return images[cat] || images.technology;
}

async function fetchAutoNews() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting news fetch...`);
  let totalNew = 0;

  for (const cat of CATEGORIES) {
    const url = `https://newsapi.org/v2/top-headlines?category=${cat}&language=en&apiKey=${NEWS_API_KEY}&pageSize=15`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'ok') {
        console.log(`⚠️ ${cat}: API error`);
        continue;
      }

      const articles = data.articles.filter(a => a.title && a.title !== '[Removed]' && a.description);
      console.log(`✅ ${cat}: ${articles.length} articles`);

      // Get existing articles
      let existing = [];
      try {
        existing = JSON.parse(localStorage.getItem('nzy_articles') || '[]');
      } catch (e) {
        existing = [];
      }

      let newCount = 0;

      for (const article of articles) {
        // Check for duplicate (by title)
        const isDuplicate = existing.some(a => a.title === article.title);

        if (!isDuplicate) {
          const newArticle = {
            id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
            category: cat,
            featured: false,
            trending: false,
            editor: false,
            title: article.title,
            excerpt: (article.description || '').substring(0, 180),
            body: `<p>${article.description || ''}</p><p><a href="${article.url}" target="_blank" style="color:#e8380d;">📖 Read full article on source →</a></p>`,
            author: article.author || 'NewsAPI',
            time: 'Just now',
            views: Math.floor(Math.random() * 5000) + 100,
            comments: Math.floor(Math.random() * 200),
            image: article.urlToImage || getCategoryImage(cat),
            status: 'pending',
            source_url: article.url,
            fetched_at: new Date().toISOString()
          };
          existing.unshift(newArticle);
          newCount++;
          totalNew++;
        }
      }

      if (newCount > 0) {
        localStorage.setItem('nzy_articles', JSON.stringify(existing));
        console.log(`📰 ${cat}: ${newCount} new articles added`);
      }

    } catch (err) {
      console.log(`❌ ${cat}: Error - ${err.message}`);
    }

    // Delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`📰 TOTAL: ${totalNew} new articles fetched`);
  console.log(`✅ News fetch completed at ${new Date().toLocaleTimeString()}\n`);
}

// ════════════════════════════════════════════════════════════
//  START AUTO NEWS SCHEDULE
// ════════════════════════════════════════════════════════════
console.log('📰 Initializing auto news fetcher...');
fetchAutoNews().catch(console.error);

setInterval(async () => {
  console.log('⏰ Scheduled news fetch starting...');
  await fetchAutoNews().catch(console.error);
}, 6 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 Newzyy OTP server running at http://localhost:${PORT}`);
  console.log(`   POST /send-otp    — Send OTP to email`);
  console.log(`   POST /verify-otp  — Verify OTP code`);
  console.log(`   Auto news fetcher — Every 6 hours\n`);
});
// ── Resend client ──────────────────────────────────────────
// Replace with your actual API key or set env var RESEND_API_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S';
const resend = new Resend(RESEND_API_KEY);

// ── In-memory OTP store ───────────────────────────────────
// { email: { code, expiresAt, attempts } }
const otpStore = {};
const OTP_EXPIRY_MS   = 5 * 60 * 1000;   // 5 minutes
const MAX_ATTEMPTS    = 5;                 // wrong tries before lock
const RATE_LIMIT_MS   = 60 * 1000;        // 1 resend per minute

// ── Cleanup expired OTPs every 10 min ────────────────────
setInterval(() => {
  const now = Date.now();
  for (const email in otpStore) {
    if (otpStore[email].expiresAt < now) delete otpStore[email];
  }
}, 10 * 60 * 1000);

// ── Middleware ─────────────────────────────────────────────
app.use(cors({
  origin: '*',          // In production, restrict to your domain
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ── Health check ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy OTP API', time: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
//  POST /send-otp
//  Body: { email: string, type: 'signup' | 'login', name?: string }
// ══════════════════════════════════════════════════════════
app.post('/send-otp', async (req, res) => {
  try {
    const { email, type = 'signup', name = 'User' } = req.body;

    // ── Validate email ──
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    // ── Rate-limit: block rapid resend ──
    const existing = otpStore[email.toLowerCase()];
    if (existing && existing.sentAt && (Date.now() - existing.sentAt) < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (Date.now() - existing.sentAt)) / 1000);
      return res.status(429).json({
        success: false,
        message: `Please wait ${wait} seconds before requesting another code.`
      });
    }

    // ── Generate 6-digit code ──
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // ── Store OTP ──
    otpStore[email.toLowerCase()] = {
      code,
      expiresAt: Date.now() + OTP_EXPIRY_MS,
      sentAt: Date.now(),
      attempts: 0,
      type
    };

    // ── Build beautiful HTML email ──
    const isSignup = type === 'signup';
    const subject  = isSignup
      ? `${code} — Your Newzyy Verification Code`
      : `${code} — Confirm Your Newzyy Sign In`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin:0; padding:0; background:#f7f7f5; font-family:'Helvetica Neue',Arial,sans-serif; }
    .wrap { max-width:520px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
    .header { background:#0f0f0f; padding:32px; text-align:center; }
    .logo { font-size:2rem; font-weight:900; color:#fff; letter-spacing:-1px; }
    .logo span { color:#e8380d; }
    .body { padding:40px 36px; }
    .greeting { font-size:1rem; color:#4a4a4a; margin-bottom:8px; }
    .headline { font-size:1.35rem; font-weight:700; color:#0f0f0f; margin-bottom:24px; line-height:1.3; }
    .code-box { background:#f7f7f5; border:2px dashed #e8380d; border-radius:12px; padding:28px; text-align:center; margin:24px 0; }
    .code { font-size:3rem; font-weight:900; letter-spacing:12px; color:#e8380d; font-family:'Courier New',monospace; }
    .expiry { font-size:.82rem; color:#8a8a8a; margin-top:10px; }
    .note { background:#fff1ee; border-radius:8px; padding:14px 16px; font-size:.83rem; color:#4a4a4a; margin:20px 0; border-left:3px solid #e8380d; }
    .footer { background:#f7f7f5; padding:24px 36px; text-align:center; font-size:.75rem; color:#aaa; border-top:1px solid #e8e4df; }
    .footer a { color:#e8380d; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo">Newzy<span>y</span></div>
    </div>
    <div class="body">
      <div class="greeting">Hi ${name},</div>
      <div class="headline">${isSignup ? 'Verify your new account' : 'Confirm your sign in'}</div>
      <p style="font-size:.9rem;color:#4a4a4a;line-height:1.6">
        ${isSignup
          ? 'Welcome to Newzyy! Enter the code below to confirm your email and activate your account.'
          : 'Someone (hopefully you!) is signing in to Newzyy. Enter this code to confirm.'}
      </p>
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="expiry">⏱ Expires in 5 minutes</div>
      </div>
      <div class="note">
        🔒 <strong>Security tip:</strong> Never share this code with anyone. Newzyy will never ask for your code via phone or chat.
      </div>
      <p style="font-size:.83rem;color:#8a8a8a;line-height:1.6">
        If you didn't request this, you can safely ignore this email. Your account remains secure.
      </p>
    </div>
    <div class="footer">
      © 2026 Newzyy — Independent journalism, always.<br>
      <a href="#">Unsubscribe</a> · <a href="#">Privacy Policy</a>
    </div>
  </div>
</body>
</html>`;

    // ── Send via Resend ──
    const { data, error } = await resend.emails.send({
      from: `Newzyy <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,   // Use your verified domain in production
      to:   [email],
      subject,
      html: htmlBody
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ success: false, message: 'Failed to send email. Please try again.' });
    }

    console.log(`OTP sent to ${email} | code: ${code} | id: ${data?.id}`);
    res.json({ success: true, message: 'Verification code sent to your email.' });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /verify-otp
//  Body: { email: string, code: string }
// ══════════════════════════════════════════════════════════
app.post('/verify-otp', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and code are required.' });
    }

    const record = otpStore[email.toLowerCase()];

    // ── OTP not found ──
    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'No verification code found for this email. Please request a new one.'
      });
    }

    // ── Expired ──
    if (Date.now() > record.expiresAt) {
      delete otpStore[email.toLowerCase()];
      return res.status(400).json({
        success: false,
        message: 'Your code has expired. Please request a new one.',
        expired: true
      });
    }

    // ── Too many attempts ──
    if (record.attempts >= MAX_ATTEMPTS) {
      delete otpStore[email.toLowerCase()];
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new code.',
        locked: true
      });
    }

    // ── Wrong code ──
    if (String(code).trim() !== String(record.code)) {
      record.attempts++;
      const remaining = MAX_ATTEMPTS - record.attempts;
      return res.status(400).json({
        success: false,
        message: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
          : 'Too many incorrect attempts. Please request a new code.',
        attemptsLeft: remaining
      });
    }

    // ── ✅ CORRECT ──
    delete otpStore[email.toLowerCase()];
    console.log(`OTP verified for ${email}`);
    res.json({ success: true, message: 'Email verified successfully.' });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Newzyy OTP server running at http://localhost:${PORT}`);
  console.log(`   POST /send-otp    — Send OTP to email`);
  console.log(`   POST /verify-otp  — Verify OTP code\n`);
});
