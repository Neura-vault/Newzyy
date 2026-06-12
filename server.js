// ════════════════════════════════════════════════════════════
//  NEWZYY  —  OTP Backend + Auto News Fetcher
//  Start:  node server.js
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3001;

// ── API Keys ────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '3d1c54f463114aa7b89add3425c96029';

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

    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e8e4df">
<div style="background:#0f0f0f;padding:24px;text-align:center"><h1 style="color:#fff">Newzy<span style="color:#e8380d">y</span></h1></div>
<div style="padding:32px">
<h2>Hi ${name},</h2>
<p>Your verification code is:</p>
<div style="background:#f7f7f5;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold">${code}</div>
<p>Expires in 5 minutes.</p>
</div></div></body></html>`;

    const { data, error } = await resend.emails.send({
      from: `Newzyy <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to: [email],
      subject,
      html: htmlBody
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ success: false, message: 'Failed to send email.' });
    }

    console.log(`OTP sent to ${email} | code: ${code}`);
    res.json({ success: true, message: 'Verification code sent!' });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
//  VERIFY OTP
// ════════════════════════════════════════════════════════════
app.post('/verify-otp', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and code required.' });
    }

    const record = otpStore[email.toLowerCase()];

    if (!record) {
      return res.status(400).json({ success: false, message: 'No code found. Request a new one.' });
    }

    if (Date.now() > record.expiresAt) {
      delete otpStore[email.toLowerCase()];
      return res.status(400).json({ success: false, message: 'Code expired.', expired: true });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      delete otpStore[email.toLowerCase()];
      return res.status(429).json({ success: false, message: 'Too many attempts.' });
    }

    if (String(code).trim() !== String(record.code)) {
      record.attempts++;
      return res.status(400).json({ success: false, message: `Incorrect code. ${MAX_ATTEMPTS - record.attempts} attempts left.` });
    }

    delete otpStore[email.toLowerCase()];
    console.log(`OTP verified for ${email}`);
    res.json({ success: true, message: 'Email verified!' });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════════════
//  AUTO NEWS FETCHER
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
    const url = `https://newsapi.org/v2/top-headlines?category=${cat}&language=en&apiKey=${NEWS_API_KEY}&pageSize=10`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'ok') {
        console.log(`⚠️ ${cat}: API error`);
        continue;
      }

      const articles = data.articles.filter(a => a.title && a.title !== '[Removed]' && a.description);
      console.log(`✅ ${cat}: ${articles.length} articles`);

      let existing = [];
      try {
        existing = JSON.parse(localStorage.getItem('nzy_articles') || '[]');
      } catch(e) { existing = []; }

      let newCount = 0;

      for (const article of articles) {
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
            body: `<p>${article.description || ''}</p><p><a href="${article.url}" target="_blank">Read full article →</a></p>`,
            author: article.author || 'NewsAPI',
            time: 'Just now',
            views: Math.floor(Math.random() * 5000),
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

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`📰 TOTAL: ${totalNew} new articles`);
  console.log(`✅ News fetch completed\n`);
}

// ════════════════════════════════════════════════════════════
//  START SCHEDULE
// ════════════════════════════════════════════════════════════
console.log('📰 Initializing auto news fetcher...');
fetchAutoNews().catch(console.error);

setInterval(async () => {
  console.log('⏰ Scheduled news fetch...');
  await fetchAutoNews().catch(console.error);
}, 6 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   POST /send-otp`);
  console.log(`   POST /verify-otp`);
  console.log(`   Auto news every 6 hours\n`);
});
