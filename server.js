// ════════════════════════════════════════════════════════════
//  NEWZYY — Guardian + diverse RSS sources, per category
//  v2.1 — MongoDB storage, Gemini rewrite, fair round-robin
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const sizeOf = require('image-size');
const RSSParser = require('rss-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const Article = require('./models/article.js');
const User = require('./models/User');
const ContactMessage = require('./models/ContactMessage');
const Subscriber = require('./models/Subscriber');
const { sendVerificationEmail, sendContactNotification, sendNewsletterDigest } = require('./utils/mailer'); // FIX: was './models/article.js' (lowercase) — Render
                                              // is case-sensitive (Linux); the real file is Article.js.
                                              // This exact mismatch crashes the whole server on deploy.

const rssParser = new RSSParser({
  timeout: 8000,
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent']
    ]
  }
});

const app = express();
const PORT = process.env.PORT || 3001;

// ========== FRONTEND URL (for sitemap/rss absolute links) ==========
const SITE_URL = process.env.SITE_URL || 'https://newzyy.site';

// ========== API KEYS ==========
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || 'ab35f734-ceb0-4a49-bb7d-24c0c3331bd6';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // set this in Render → Environment
const JWT_SECRET = process.env.JWT_SECRET; // set this in Render → Environment — long random string
const VERIFICATION_CODE_TTL_MIN = 15;

// This project's actual granted free-tier limit is lower than Google's documented
// defaults (its own error says "limit: 20"). Rather than guess a fixed pace, we read
// Google's own suggested wait time from each 429 response and back off exactly that
// long — self-adjusting to whatever the real limit is, never guessing wrong.
const GEMINI_DELAY_MS = 6000;              // base spacing between successful calls
const GEMINI_MAX_PER_DAY = 1200;           // safety ceiling only — raise once real quota is confirmed higher
const GEMINI_MAX_ROUNDS_PER_CYCLE = 20;    // cap how many articles per category one cycle will attempt
let geminiCallsToday = 0;
let geminiDayStamp = new Date().toDateString();

// ----- Groq: second AI provider (separate free account, separate quota) -----
// Used as a fallback when Gemini's quota runs out — genuinely combines both
// companies' free tiers rather than trying to bypass either one's limits.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant'; // most generous free-tier limits on Groq
const GROQ_MAX_PER_DAY = 12000;            // safety margin under Groq's ~14,400/day
let groqCallsToday = 0;
let groqDayStamp = new Date().toDateString();

// ========== MONGODB CONNECTION ==========
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is not set. Add it in Render → Environment.');
}
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set — login/signup will fail. Add it in Render → Environment.');
}
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.error('⚠️ EMAIL_USER / EMAIL_PASS not set — verification and contact emails will not send.');
}
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// ========== RATE LIMITING (protects auth + contact from abuse) ==========
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' }
});
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many messages sent. Please try again later.' }
});

// ========== AUTH MIDDLEWARE (protects routes that require login) ==========
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy (Guardian + diverse RSS, MongoDB, Auth)', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════
//  BOT-VISIBLE RENDERING
//  Plain server-rendered HTML with real article text baked in — no JavaScript
//  needed to see it. Used only for bots/crawlers/AI tools (routed here by a
//  Cloudflare Worker sitting in front of the site) — real visitors keep using
//  the normal fast SPA on GitHub Pages, unaffected.
// ════════════════════════════════════════════════════════════

function escapeHtmlBasic(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.get('/render/home', async (req, res) => {
  try {
    const articles = await Article.find({ status: 'published' }).sort({ fetched_at: -1 }).limit(40).lean();
    const items = attachLiveFields(articles);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Newzyy — Independent News, Politics, Technology, Business, Sports, and More</title>
<meta name="description" content="Newzyy is an independent news outlet covering politics, technology, AI, business, sports, health, science, and world affairs.">
</head>
<body>
<h1>Newzyy — Top World News</h1>
<p>Newzyy is an independent news outlet covering politics, technology, AI, business, sports, health, science, culture, travel, environment, and world affairs.</p>
<nav>
${items.length ? '' : '<p>No articles available right now — please check back shortly.</p>'}
</nav>
<main>
${items.map(a => `
  <article>
    <h2><a href="${SITE_URL}/single-post.html?id=${a.id}">${escapeHtmlBasic(a.title)}</a></h2>
    <p><strong>${escapeHtmlBasic(a.category)}</strong> — by ${escapeHtmlBasic(a.author || 'Newzyy Staff')}, ${escapeHtmlBasic(a.time)}</p>
    <p>${escapeHtmlBasic(a.excerpt)}</p>
  </article>
`).join('\n')}
</main>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('<html><body><h1>Newzyy</h1><p>Temporarily unavailable.</p></body></html>');
  }
});

app.get('/render/article/:id', async (req, res) => {
  try {
    const a = await Article.findOne({ id: req.params.id }).lean();
    if (!a) return res.status(404).send('<html><body><h1>Article not found</h1></body></html>');
    const article = attachLiveFields([a])[0];

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtmlBasic(article.title)} — Newzyy</title>
<meta name="description" content="${escapeHtmlBasic((article.excerpt || '').substring(0, 160))}">
</head>
<body>
<p><a href="${SITE_URL}/">Newzyy Home</a> &gt; ${escapeHtmlBasic(article.category)}</p>
<h1>${escapeHtmlBasic(article.title)}</h1>
<p><strong>By ${escapeHtmlBasic(article.author || 'Newzyy Staff')}</strong> — ${escapeHtmlBasic(article.time)}</p>
<img src="${escapeHtmlBasic(article.image)}" alt="${escapeHtmlBasic(article.title)}">
<div>
${(article.body || article.excerpt || '').split(/\n\s*\n/).map(p => `<p>${escapeHtmlBasic(p.trim())}</p>`).join('\n')}
</div>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('<html><body><h1>Newzyy</h1><p>Temporarily unavailable.</p></body></html>');
  }
});

// ════════════════════════════════════════════════════════════
//  AUTHENTICATION
// ════════════════════════════════════════════════════════════

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}
function generateCode() {
  return String(crypto.randomInt(100000, 999999)); // 6-digit code
}

// ----- SIGNUP: creates an unverified account and emails a 6-digit code -----
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const code = generateCode();

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      verified: false,
      verificationCode: code,
      verificationExpires: new Date(Date.now() + VERIFICATION_CODE_TTL_MIN * 60000)
    });

    // Fire-and-forget: never let a slow/blocked mailer hold up this response.
    sendVerificationEmail(user.email, user.name, code)
      .then(sent => { if (!sent) console.error(`   ⚠️ Verification email did not send for ${user.email}`); })
      .catch(err => console.error('   ⚠️ Verification email error:', err.message));

    res.json({
      success: true,
      message: 'Account created. Check your email for a verification code — it may take a minute to arrive.',
      email: user.email
    });
  } catch (e) {
    console.error('signup error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ----- VERIFY: confirms the 6-digit code, marks account verified, returns a login token -----
app.post('/api/auth/verify', authLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Email and code are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'No account found for this email.' });
    if (user.verified) return res.status(400).json({ success: false, message: 'This account is already verified.' });

    if (!user.verificationCode || user.verificationCode !== String(code)) {
      return res.status(400).json({ success: false, message: 'Incorrect code.' });
    }
    if (!user.verificationExpires || user.verificationExpires < new Date()) {
      return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }

    user.verified = true;
    user.verificationCode = null;
    user.verificationExpires = null;
    await user.save();

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, message: 'Email verified.', token, user: { name: user.name, email: user.email } });
  } catch (e) {
    console.error('verify error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ----- RESEND CODE -----
app.post('/api/auth/resend-code', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'No account found for this email.' });
    if (user.verified) return res.status(400).json({ success: false, message: 'This account is already verified.' });

    const code = generateCode();
    user.verificationCode = code;
    user.verificationExpires = new Date(Date.now() + VERIFICATION_CODE_TTL_MIN * 60000);
    await user.save();

    sendVerificationEmail(user.email, user.name, code)
      .then(sent => { if (!sent) console.error(`   ⚠️ Resend verification email did not send for ${user.email}`); })
      .catch(err => console.error('   ⚠️ Resend verification email error:', err.message));

    res.json({ success: true, message: 'A new code is on its way — it may take a minute to arrive.' });
  } catch (e) {
    console.error('resend-code error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ----- LOGIN -----
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    if (!user.verified) {
      return res.status(403).json({ success: false, message: 'Please verify your email before logging in.', needsVerification: true, email: user.email });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { name: user.name, email: user.email } });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ----- CURRENT USER (requires a valid token) -----
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('name email verified createdAt');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

// ════════════════════════════════════════════════════════════
//  CONTACT FORM
// ════════════════════════════════════════════════════════════
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message are all required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    await ContactMessage.create({ name: name.trim(), email: email.trim(), message: message.trim() });
    sendContactNotification(name.trim(), email.trim(), message.trim()).catch(() => {}); // fire-and-forget, DB save already succeeded

    res.json({ success: true, message: 'Thanks — your message has been sent.' });
  } catch (e) {
    console.error('contact error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ════════════════════════════════════════════════════════════
//  BOOKMARKS (requires login)
// ════════════════════════════════════════════════════════════

app.get('/api/bookmarks', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('bookmarks');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const articles = await Article.find({ id: { $in: user.bookmarks }, status: 'published' }).lean();
    res.json({ success: true, news: attachLiveFields(articles) });
  } catch (e) {
    console.error('bookmarks list error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

app.post('/api/bookmarks/:articleId', requireAuth, async (req, res) => {
  try {
    const article = await Article.findOne({ id: req.params.articleId });
    if (!article) return res.status(404).json({ success: false, message: 'Article not found.' });

    await User.updateOne({ _id: req.userId }, { $addToSet: { bookmarks: req.params.articleId } });
    res.json({ success: true, message: 'Saved.' });
  } catch (e) {
    console.error('bookmark add error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

app.delete('/api/bookmarks/:articleId', requireAuth, async (req, res) => {
  try {
    await User.updateOne({ _id: req.userId }, { $pull: { bookmarks: req.params.articleId } });
    res.json({ success: true, message: 'Removed.' });
  } catch (e) {
    console.error('bookmark remove error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

// ════════════════════════════════════════════════════════════
//  NEWSLETTER
// ════════════════════════════════════════════════════════════

app.post('/api/newsletter/subscribe', contactLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    const existing = await Subscriber.findOne({ email: email.toLowerCase() });
    if (existing) {
      if (existing.active) return res.json({ success: true, message: "You're already subscribed." });
      existing.active = true;
      await existing.save();
      return res.json({ success: true, message: 'Welcome back — you\'re re-subscribed.' });
    }
    const sub = await Subscriber.create({ email: email.toLowerCase().trim() });

    // Send an immediate welcome digest so new subscribers see something right away,
    // instead of waiting for the next scheduled 24-hour cycle.
    sendWelcomeDigest(sub.email).catch(err => console.error('   ⚠️ Welcome digest error:', err.message));

    res.json({ success: true, message: 'Subscribed! Check your inbox for today\'s top stories.' });
  } catch (e) {
    console.error('newsletter subscribe error:', e.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

async function sendWelcomeDigest(email) {
  const topArticles = await Article.find({ status: 'published' }).sort({ views: -1 }).limit(5).lean();
  if (!topArticles.length) return;
  const articlesForEmail = topArticles.map(a => ({
    title: a.title,
    category: CATEGORY_NAMES_BACKEND[a.category] || a.category,
    excerpt: a.excerpt,
    url: `${SITE_URL}/single-post.html?id=${a.id}`
  }));
  const ok = await sendNewsletterDigest(email, articlesForEmail);
  if (ok) await Subscriber.updateOne({ email }, { lastSentAt: new Date() });
}

app.post('/api/newsletter/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    await Subscriber.updateOne({ email: email.toLowerCase() }, { active: false });
    res.json({ success: true, message: 'You have been unsubscribed.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
});

// Sends today's top 5 articles (by views) to every active subscriber.
// Runs automatically once a day (see schedule below) — can also be triggered
// manually via /admin/send-newsletter-now for testing.
async function sendDailyDigest() {
  console.log('\n📧 Sending newsletter digest...');
  try {
    const topArticles = await Article.find({ status: 'published' }).sort({ views: -1 }).limit(5).lean();
    if (!topArticles.length) { console.log('   No articles to send.'); return; }

    const articlesForEmail = topArticles.map(a => ({
      title: a.title,
      category: CATEGORY_NAMES_BACKEND[a.category] || a.category,
      excerpt: a.excerpt,
      url: `${SITE_URL}/single-post.html?id=${a.id}`
    }));

    const subscribers = await Subscriber.find({ active: true }).lean();
    let sent = 0;
    for (const sub of subscribers) {
      const ok = await sendNewsletterDigest(sub.email, articlesForEmail);
      if (ok) {
        sent++;
        await Subscriber.updateOne({ _id: sub._id }, { lastSentAt: new Date() });
      }
      await new Promise(r => setTimeout(r, 300)); // gentle pacing, stay well under Resend's free-tier rate
    }
    console.log(`   ✅ Digest sent to ${sent}/${subscribers.length} subscribers`);
  } catch (e) {
    console.error('   ⚠️ Digest error:', e.message);
  }
}
const CATEGORY_NAMES_BACKEND = {
  politics: 'Politics', technology: 'Technology', ai: 'AI', sports: 'Sports', business: 'Business',
  health: 'Health', science: 'Science', entertainment: 'Entertainment', travel: 'Travel',
  environment: 'Earth', culture: 'Culture', world: 'World', economy: 'Economy'
};

app.get('/admin/send-newsletter-now', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  sendDailyDigest();
  res.json({ success: true, message: 'Digest send started — check logs for progress.' });
});

// ════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD DATA (read-only, secret-protected)
// ════════════════════════════════════════════════════════════

app.get('/api/admin/contacts', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const messages = await ContactMessage.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, messages });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const users = await User.find().select('name email verified createdAt bookmarks').sort({ createdAt: -1 }).limit(300).lean();
    res.json({ success: true, users });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/admin/subscribers', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 }).limit(500).lean();
    res.json({ success: true, subscribers });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const [articleCount, userCount, subscriberCount, contactCount] = await Promise.all([
      Article.countDocuments({ status: 'published' }),
      User.countDocuments(),
      Subscriber.countDocuments({ active: true }),
      ContactMessage.countDocuments()
    ]);
    const perCategory = await Article.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);
    res.json({
      success: true,
      stats: { articleCount, userCount, subscriberCount, contactCount },
      perCategory,
      gemini: { callsToday: geminiCallsToday, maxPerDay: GEMINI_MAX_PER_DAY },
      groq: { configured: Boolean(GROQ_API_KEY), callsToday: groqCallsToday, maxPerDay: GROQ_MAX_PER_DAY }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----- Articles: list + delete -----
app.get('/api/admin/articles', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const articles = await Article.find().sort({ fetched_at: -1 }).limit(100).lean();
    res.json({ success: true, articles: attachLiveFields(articles) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete('/api/admin/article/:id', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    await Article.deleteOne({ id: req.params.id });
    res.json({ success: true, message: 'Article deleted.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.patch('/api/admin/article/:id/toggle-breaking', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const article = await Article.findOne({ id: req.params.id });
    if (!article) return res.status(404).json({ success: false, message: 'Not found.' });
    article.manualBreaking = !article.manualBreaking;
    await article.save();
    res.json({ success: true, manualBreaking: article.manualBreaking });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----- Contact messages: mark read + delete -----
app.patch('/api/admin/contact/:id/read', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    await ContactMessage.updateOne({ _id: req.params.id }, { read: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete('/api/admin/contact/:id', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    await ContactMessage.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----- Users: delete -----
app.delete('/api/admin/user/:id', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    await User.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ========== CATEGORIES ==========
const CATEGORIES = [
  'politics', 'technology', 'ai', 'sports', 'business', 'health',
  'science', 'entertainment', 'travel', 'environment', 'culture', 'world', 'economy'
];

// Every category has its OWN dedicated Guardian query (never shares another
// category's results) — either a specific section, or a free-text search when
// no matching section exists. This is the primary source for every category.
// FIX: ai / economy / entertainment must be `search`, not `section` — Guardian
// "sections" are fixed single-word slugs (politics, sport, world...), not phrases
// or boolean OR queries. Using `section` for those silently returns zero results.
const GUARDIAN_CATEGORY_QUERY = {
  politics: { section: 'politics' },
  world: { section: 'world' },
  technology: { section: 'technology' },
  ai: { search: 'artificial intelligence' },
  business: { section: 'business' },
  economy: { search: 'economy OR economic OR inflation OR "interest rates"' },
  health: { section: 'health' },
  science: { section: 'science' },
  environment: { section: 'environment' },
  sports: { section: 'sport' },
  entertainment: { search: 'entertainment OR celebrity OR film OR music OR television' },
  culture: { section: 'culture' },
  travel: { section: 'travel' }
};

// Secondary source for extra volume — official RSS feeds, one per category,
// no API key needed. Only categories with a real matching feed are listed;
// the rest rely on Guardian alone, which is enough on its own.
const RSS_FEEDS = {
  politics: 'https://feeds.bbci.co.uk/news/politics/rss.xml',
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  ai: 'https://artificialintelligence-news.com/feed/',
  business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  economy: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',
  health: 'https://medlineplus.gov/groupfeeds/new.xml',
  science: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  environment: 'https://www.theguardian.com/environment/rss',
  sports: 'https://feeds.bbci.co.uk/sport/rss.xml',
  entertainment: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
  culture: 'https://www.theguardian.com/culture/rss',
  travel: 'https://www.theguardian.com/uk/travel/rss',
};

// Time string is now computed live at READ time, never stored — so it never goes stale.
function formatTimeAgo(dateValue) {
  const date = new Date(dateValue);
  const now = new Date();
  const diffMins = Math.floor((now - date) / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Adds "time" (live string) and "breaking" (live flag) to a batch of articles.
// breaking = true only for the single newest article in its category, and only
// while it's under 60 minutes old. Nothing is stored — computed fresh every request.
function attachLiveFields(articles) {
  const newestPerCategory = {};
  articles.forEach(a => {
    const cur = newestPerCategory[a.category];
    if (!cur || new Date(a.fetched_at) > new Date(cur.fetched_at)) newestPerCategory[a.category] = a;
  });
  return articles.map(a => {
    const ageMins = (Date.now() - new Date(a.fetched_at)) / 60000;
    const isNewestInCategory = newestPerCategory[a.category] && newestPerCategory[a.category].id === a.id;
    return {
      ...a,
      time: formatTimeAgo(a.fetched_at),
      breaking: Boolean(a.manualBreaking || (isNewestInCategory && ageMins < 60))
    };
  });
}

// ========== GET ALL NEWS (paginated) ==========
// ?page=1&limit=20&category=technology
app.get('/api/all-news', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter = { status: 'published' };
    if (req.query.category) filter.category = req.query.category;

    const total = await Article.countDocuments(filter);
    const articles = await Article.find(filter)
      .sort({ fetched_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      news: attachLiveFields(articles),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (e) {
    console.error('all-news error:', e.message);
    res.json({ success: true, news: [], page: 1, totalPages: 1, total: 0 });
  }
});

// ========== GET SINGLE ARTICLE ==========
app.get('/api/article/:id', async (req, res) => {
  try {
    const article = await Article.findOne({ id: req.params.id }).lean();
    if (!article) return res.status(404).json({ success: false, message: 'Article not found' });
    res.json({ success: true, article: attachLiveFields([article])[0] });
  } catch (e) {
    console.error('article error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ========== GET BY CATEGORY ==========
app.get('/api/category/:slug', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter = { status: 'published', category: req.params.slug };

    const total = await Article.countDocuments(filter);
    const articles = await Article.find(filter)
      .sort({ fetched_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ success: true, news: attachLiveFields(articles), page, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (e) {
    console.error('category error:', e.message);
    res.json({ success: true, news: [] });
  }
});

// ========== SEARCH ==========
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, news: [] });

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const articles = await Article.find({
      status: 'published',
      $or: [{ title: regex }, { excerpt: regex }, { category: regex }]
    }).sort({ fetched_at: -1 }).limit(30).lean();

    res.json({ success: true, news: attachLiveFields(articles) });
  } catch (e) {
    console.error('search error:', e.message);
    res.json({ success: true, news: [] });
  }
});

// ========== MOST READ ==========
app.get('/api/most-read', async (req, res) => {
  try {
    const articles = await Article.find({ status: 'published' })
      .sort({ views: -1 })
      .limit(10)
      .lean();
    res.json({ success: true, news: attachLiveFields(articles) });
  } catch (e) {
    console.error('most-read error:', e.message);
    res.json({ success: true, news: [] });
  }
});

// ========== INCREMENT VIEW COUNT (server-side, real count) ==========
app.post('/api/article/:id/view', async (req, res) => {
  try {
    await Article.updateOne({ id: req.params.id }, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ========== SITEMAP.XML ==========
app.get('/sitemap.xml', async (req, res) => {
  try {
    const articles = await Article.find({ status: 'published' }, 'id fetched_at').sort({ fetched_at: -1 }).limit(5000).lean();
    const urls = articles.map(a => `
  <url>
    <loc>${SITE_URL}/single-post.html?id=${a.id}</loc>
    <lastmod>${new Date(a.fetched_at).toISOString()}</lastmod>
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/index.html</loc></url>${urls}
</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (e) {
    res.status(500).send('Error generating sitemap');
  }
});

// ========== RSS.XML ==========
app.get('/rss.xml', async (req, res) => {
  try {
    const articles = await Article.find({ status: 'published' }).sort({ fetched_at: -1 }).limit(50).lean();
    const items = articles.map(a => `
    <item>
      <title><![CDATA[${a.title}]]></title>
      <link>${SITE_URL}/single-post.html?id=${a.id}</link>
      <guid>${SITE_URL}/single-post.html?id=${a.id}</guid>
      <pubDate>${new Date(a.fetched_at).toUTCString()}</pubDate>
      <description><![CDATA[${a.excerpt || ''}]]></description>
    </item>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Newzyy</title>
    <link>${SITE_URL}</link>
    <description>Newzyy — Independent News</description>${items}
  </channel>
</rss>`;

    res.header('Content-Type', 'application/rss+xml');
    res.send(xml);
  } catch (e) {
    res.status(500).send('Error generating RSS feed');
  }
});

// Strips HTML tags/entities from raw API text. Guardian's `fields.body` is real
// HTML (<p>, <h2>, <a>, <figure>, <gu-atom>, <iframe> ...) — without this, those
// tags leak into the article as visible text if they ever reach the page unrewritten.
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')   // drop embedded media blocks entirely
    .replace(/<[^>]+>/g, ' ')                       // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========== SOURCE 1: GUARDIAN (dedicated query per category) ==========
async function fetchGuardianForCategory(cat) {
  if (!GUARDIAN_API_KEY) return [];
  const q = GUARDIAN_CATEGORY_QUERY[cat];
  if (!q) return [];

  const base = q.section
    ? `section=${encodeURIComponent(q.section)}`
    : `q=${encodeURIComponent(q.search)}`;
  const url = `https://content.guardianapis.com/search?${base}&api-key=${GUARDIAN_API_KEY}&show-fields=body,thumbnail,trailText&show-elements=image&page-size=15&order-by=newest`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.response || !data.response.results) return [];

    return data.response.results.map(a => {
      // Guardian's fields.thumbnail is a tiny ~140x84 crop — too small to display well.
      // The `elements` array (from show-elements=image) carries the real, full-size
      // picture with multiple asset sizes. Pick the largest available one instead.
      let image = a.fields?.thumbnail || '';
      try {
        const imageElement = (a.elements || []).find(el => el.type === 'image');
        const assets = imageElement?.assets || [];
        if (assets.length) {
          const largest = assets.reduce((best, cur) => {
            const w = parseInt(cur.typeData?.width) || 0;
            const bw = parseInt(best?.typeData?.width) || 0;
            return w > bw ? cur : best;
          }, assets[0]);
          if (largest?.file) image = largest.file;
        }
      } catch (e) { /* fall back to thumbnail — never fatal */ }

      return {
        title: a.webTitle || a.fields?.headline || 'Untitled',
        description: stripHtml(a.fields?.trailText || ''),
        body: stripHtml(a.fields?.body || ''),
        url: a.webUrl || a.url,
        image,
        author: a.fields?.byline || a.sectionName || 'The Guardian',
        publishedAt: a.webPublicationDate || new Date().toISOString(),
        source: 'The Guardian'
      };
    });
  } catch (e) {
    console.error(`   ⚠️ Guardian fetch failed for ${cat}:`, e.message);
    return []; // never throw — an empty array just means this source contributed nothing this cycle
  }
}

// ========== SOURCE 2: RSS (dedicated feed per category, no key needed) ==========
async function fetchRSS(cat) {
  const feedUrl = RSS_FEEDS[cat];
  if (!feedUrl) return [];

  try {
    const feed = await rssParser.parseURL(feedUrl);
    if (!feed || !feed.items) return [];

    return feed.items.slice(0, 15).map(item => {
      let image = '';
      try {
        if (item.mediaThumbnail?.$?.url) image = item.mediaThumbnail.$.url;
        else if (item.mediaContent?.$?.url) image = item.mediaContent.$.url;
        else if (item.enclosure?.url) image = item.enclosure.url;
      } catch (e) { /* image is optional — safe to leave blank, isGoodImage() handles it */ }

      const text = stripHtml(item.contentSnippet || item.content || '');
      return {
        title: item.title || '',
        description: text,
        body: text,
        url: item.link || '',
        image,
        author: 'News',
        publishedAt: item.pubDate || new Date().toISOString(),
        source: 'RSS-FEED'
      };
    });
  } catch (e) {
    console.error(`   ⚠️ RSS fetch failed for ${cat}:`, e.message);
    return []; // never throw — this category just falls back to Guardian-only this cycle
  }
}

// ========== COMBINE BOTH SOURCES FOR ONE CATEGORY ==========
// Each category is fully independent — a failure in one source, or one category,
// can never affect any other category.
async function fetchCategorySources(cat) {
  const [guardianArticles, Articles] = await Promise.all([
    fetchGuardianForCategory(cat),
    fetchRSS(cat)
  ]);
  return [...guardianArticles, ...Articles];
}

// ========== IMAGE VALIDATION ==========
// Rejects: missing image, dead/broken links, non-image responses, and images too
// small to look sharp at our display sizes (a cheap, reliable stand-in for true
// blur detection — low-res images stretched to fill a 170-360px card are the
// ones that look "blurry" in practice).
const MIN_IMAGE_WIDTH = 300;
const MIN_IMAGE_HEIGHT = 180;
const MIN_IMAGE_BYTES = 4000; // filters out tiny placeholder/broken-icon images

async function isGoodImage(url) {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return false;

    const buffer = await res.buffer();
    if (buffer.length < MIN_IMAGE_BYTES) return false;

    const dimensions = sizeOf(buffer);
    if (!dimensions.width || !dimensions.height) return false;
    if (dimensions.width < MIN_IMAGE_WIDTH || dimensions.height < MIN_IMAGE_HEIGHT) return false;

    return true;
  } catch (e) {
    return false; // any uncertainty (timeout, bad data, network error) = reject, never crash
  }
}

// ========== GEMINI REWRITE ==========
// Takes the raw facts from the source APIs and asks Gemini to write an
// original Newzyy article from them. Returns null text on any failure so the
// caller can skip publishing (never breaks the pipeline).
async function rewriteWithGemini(rawArticle, category) {
  if (!GEMINI_API_KEY) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  const prompt = `You are a staff news writer for "Newzyy", an independent news outlet.
Using ONLY the facts below, write an original news article in your own words — do not copy sentences or phrasing from the source text.
If the source facts are limited, write a shorter article rather than inventing extra details, numbers, quotes, or names that aren't in the source.
Length: 150-400 words depending on how much source material is available. Tone: clear, neutral, professional news style.
Output ONLY the article body text. No headline, no preamble, no markdown.

Headline: ${rawArticle.title}
Category: ${category}
Source facts:
${sourceFacts}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await res.json();

    if (!res.ok || data.error) {
      let retryAfterMs = 0;
      const details = data.error?.details || [];
      const retryInfo = details.find(d => (d['@type'] || '').includes('RetryInfo'));
      if (retryInfo?.retryDelay) {
        const seconds = parseFloat(String(retryInfo.retryDelay).replace('s', ''));
        if (!isNaN(seconds)) retryAfterMs = Math.min(Math.ceil(seconds * 1000), 70000); // cap at 70s, sanity limit
      }
      console.error(`   ⚠️ Gemini API error [${res.status}]:`, data.error?.message || JSON.stringify(data).substring(0, 300));
      return { text: null, retryAfterMs };
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('   ⚠️ Gemini returned no text. Full response:', JSON.stringify(data).substring(0, 500));
      return { text: null, retryAfterMs: 0 };
    }
    return { text: text.trim().length > 80 ? text.trim() : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Gemini rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// Resets the daily Gemini call counter when the date rolls over
// (RPD resets at midnight Pacific time — this local-date check is an
// approximation that's safe to be conservative about).
function checkGeminiDayReset() {
  const today = new Date().toDateString();
  if (today !== geminiDayStamp) {
    geminiDayStamp = today;
    geminiCallsToday = 0;
  }
}
function checkGroqDayReset() {
  const today = new Date().toDateString();
  if (today !== groqDayStamp) {
    groqDayStamp = today;
    groqCallsToday = 0;
  }
}

// ========== GROQ REWRITE (fallback provider) ==========
async function rewriteWithGroq(rawArticle, category) {
  if (!GROQ_API_KEY) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  const prompt = `You are a staff news writer for "Newzyy", an independent news outlet.
Using ONLY the facts below, write an original news article in your own words — do not copy sentences or phrasing from the source text.
If the source facts are limited, write a shorter article rather than inventing extra details, numbers, quotes, or names that aren't in the source.
Length: 150-400 words depending on how much source material is available. Tone: clear, neutral, professional news style.
Output ONLY the article body text. No headline, no preamble, no markdown.

Headline: ${rawArticle.title}
Category: ${category}
Source facts:
${sourceFacts}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      console.error(`   ⚠️ Groq API error [${res.status}]:`, data.error?.message || JSON.stringify(data).substring(0, 300));
      // Groq sends a Retry-After header on 429s — honor it if present.
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter) * 1000, 70000) : 0;
      return { text: null, retryAfterMs };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { text: null, retryAfterMs: 0 };
    return { text: text.trim().length > 80 ? text.trim() : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Groq rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// ========== COMBINED REWRITE: Gemini first, Groq as fallback ==========
// Genuinely combines two separate companies' free quotas — not multiple
// accounts on the same service, which would risk violating either ToS.
async function rewriteArticle(rawArticle, category) {
  checkGeminiDayReset();
  checkGroqDayReset();

  if (GEMINI_API_KEY && geminiCallsToday < GEMINI_MAX_PER_DAY) {
    const result = await rewriteWithGemini(rawArticle, category);
    geminiCallsToday++;
    if (result.text) return { ...result, provider: 'gemini' };
    // Gemini failed (quota/error) — fall through to Groq below.
  }

  if (GROQ_API_KEY && groqCallsToday < GROQ_MAX_PER_DAY) {
    const result = await rewriteWithGroq(rawArticle, category);
    groqCallsToday++;
    if (result.text) return { ...result, provider: 'groq' };
    return { ...result, provider: 'groq' };
  }

  return { text: null, retryAfterMs: 0, provider: 'none' };
}

// ========== MAIN FETCH FUNCTION (MongoDB, fair round-robin across all categories) ==========
async function fetchAllNews() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting news fetch (Guardian + diverse RSS, per category)...`);
  checkGeminiDayReset();

  // Load existing titles once, so we don't hit the DB per-article inside the loop.
  let existingTitles;
  try {
    const existingDocs = await Article.find({}, 'title').lean();
    existingTitles = new Set(existingDocs.map(a => (a.title || '').toLowerCase()));
    console.log(`📚 ${existingDocs.length} existing articles in DB`);
  } catch (e) {
    console.error('Could not load existing titles:', e.message);
    existingTitles = new Set();
  }

  // ----- Step 1: fetch raw candidates for every category first, each fully independent -----
  const candidatesByCategory = {};
  for (const cat of CATEGORIES) {
    const raw = await fetchCategorySources(cat);
    const fresh = raw.filter(a => a.title && !existingTitles.has(a.title.toLowerCase()));
    candidatesByCategory[cat] = fresh;
    console.log(`📰 ${cat}: ${raw.length} fetched, ${fresh.length} new`);
    await new Promise(r => setTimeout(r, 250)); // small courtesy delay between source calls
  }

  // ----- Step 2: round-robin through categories one article at a time -----
  // Every category gets a turn before any category gets a second turn, so if
  // the Gemini budget runs out mid-cycle, every category already had a fair share.
  const stats = {};
  CATEGORIES.forEach(c => (stats[c] = { added: 0, skippedImage: 0, skippedGemini: 0 }));

  let totalNew = 0;
  let round = 0;

  while (round < GEMINI_MAX_ROUNDS_PER_CYCLE) {
    let anyCategoryHadCandidate = false;

    for (const cat of CATEGORIES) {
      const list = candidatesByCategory[cat];
      if (round >= list.length) continue; // this category's candidates are exhausted
      anyCategoryHadCandidate = true;

      const article = list[round];
      const titleLower = article.title.toLowerCase();
      if (existingTitles.has(titleLower)) continue; // could have been added by an earlier round this same cycle

      // ----- Image check first (cheap, saves wasting a Gemini call on articles we'd reject anyway) -----
      const hasGoodImage = await isGoodImage(article.image);
      if (!hasGoodImage) {
        stats[cat].skippedImage++;
        continue;
      }

      // ----- AI rewrite: Gemini first, Groq as fallback -----
      if ((!GEMINI_API_KEY || geminiCallsToday >= GEMINI_MAX_PER_DAY) && (!GROQ_API_KEY || groqCallsToday >= GROQ_MAX_PER_DAY)) {
        stats[cat].skippedGemini++;
        continue;
      }

      const result = await rewriteArticle(article, cat);

      if (!result.text) {
        stats[cat].skippedGemini++;
        await new Promise(r => setTimeout(r, result.retryAfterMs || GEMINI_DELAY_MS));
        continue;
      }

      await new Promise(r => setTimeout(r, result.provider === 'groq' ? 2500 : GEMINI_DELAY_MS));

      try {
        await Article.create({
          id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
          category: cat,
          title: article.title,
          excerpt: (article.description || '').substring(0, 200),
          body: result.text,
          author: 'Newzyy Staff',
          views: Math.floor(Math.random() * 5000) + 100,
          comments: Math.floor(Math.random() * 200),
          image: article.image,
          status: 'published',
          // Kept internally for editorial record-keeping only — not shown on the site.
          source_url: article.url,
          source: article.source || 'News',
          rewritten: true,
          fetched_at: new Date()
        });
        existingTitles.add(titleLower);
        stats[cat].added++;
        totalNew++;
      } catch (e) {
        if (e.code !== 11000) console.error(`   ⚠️ Save error [${cat}]:`, e.message);
      }
    }

    if (!anyCategoryHadCandidate) break; // every category's candidate list is exhausted
    round++;
  }

  CATEGORIES.forEach(cat => {
    const s = stats[cat];
    console.log(`   ✅ ${cat}: ${s.added} added, ${s.skippedImage} skipped (bad/missing image), ${s.skippedGemini} skipped (rewrite/quota)`);
  });

  // Retention: 90 days, not 3 — permanent-ish URLs matter for SEO and social shares.
  // MongoDB free tier is 512MB, which comfortably holds well over 100,000 articles
  // of this size, so 90 days is conservative, not a storage-pressure decision.
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const result = await Article.deleteMany({ fetched_at: { $lt: ninetyDaysAgo } });
    if (result.deletedCount > 0) console.log(`🗑️ Deleted ${result.deletedCount} articles older than 90 days`);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }

  console.log(`\n📊 SUMMARY: +${totalNew} new articles this cycle`);
  console.log(`   Gemini key configured: ${GEMINI_API_KEY ? 'YES' : 'NO — set GEMINI_API_KEY in Render, nothing will publish without it'}`);
  console.log(`   Gemini calls used today: ${geminiCallsToday}/${GEMINI_MAX_PER_DAY}`);
  console.log(`   Groq key configured: ${GROQ_API_KEY ? 'YES' : 'NO'} — Groq calls used today: ${groqCallsToday}/${GROQ_MAX_PER_DAY}`);
  console.log(`✅ Fetch completed at ${new Date().toLocaleTimeString()}\n`);
}

// ========== ADMIN: PURGE OLD (NON-REWRITTEN) ARTICLES ==========
// Visit in browser: /admin/purge-non-rewritten?secret=YOUR_SECRET
// Deletes only articles that were never rewritten by Gemini (old/original excerpt articles).
// Rewritten articles are left untouched.
const ADMIN_SECRET = process.env.ADMIN_SECRET; // set this in Render → Environment

app.get('/admin/purge-non-rewritten', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });

  try {
    const result = await Article.deleteMany({ rewritten: { $ne: true } });
    res.json({ success: true, deleted: result.deletedCount, message: 'Old non-rewritten articles removed.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Visit in browser: /admin/purge-all?secret=YOUR_SECRET&confirm=YES
// Deletes EVERYTHING, including already-rewritten Gemini articles. Rarely what you want —
// prefer /admin/purge-non-rewritten unless you're starting completely fresh.
app.get('/admin/purge-all', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  if (req.query.confirm !== 'YES') return res.status(400).json({ success: false, message: 'Add &confirm=YES to actually wipe everything' });

  try {
    const result = await Article.deleteMany({});
    res.json({ success: true, deleted: result.deletedCount, message: 'ALL articles removed.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Visit in browser: /admin/check-verification?email=user@example.com&secret=YOUR_SECRET
// Temporary safety net while confirming email deliverability — lets you see a user's
// current pending code without needing the email to arrive. Remove/ignore once email
// sending is confirmed reliable.
app.get('/admin/check-verification', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });

  try {
    const user = await User.findOne({ email: (req.query.email || '').toLowerCase() })
      .select('name email verified verificationCode verificationExpires');
    if (!user) return res.status(404).json({ success: false, message: 'No account found for this email.' });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ========== MANUAL FETCH ==========
app.get('/manual-fetch', async (req, res) => {
  console.log('📡 Manual fetch triggered');
  try {
    await fetchAllNews();
    res.json({ success: true, message: 'Manual fetch completed', time: new Date().toISOString() });
  } catch (e) {
    console.error('Manual fetch error:', e);
    res.json({ success: false, message: e.message });
  }
});

// ========== START SCHEDULE ==========
mongoose.connection.once('open', () => {
  console.log('📰 Initializing news fetcher (Guardian + diverse RSS, dedicated per category, Gemini rewrite)...');
  fetchAllNews().catch(console.error);

  setInterval(async () => {
    console.log('⏰ Scheduled news fetch...');
    await fetchAllNews().catch(console.error);
  }, 6 * 60 * 60 * 1000);

  // Newsletter digest — once every 24 hours.
  setInterval(async () => {
    await sendDailyDigest().catch(console.error);
  }, 24 * 60 * 60 * 1000);
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   🔥 Guardian + diverse RSS per category, Gemini-rewritten, MongoDB storage`);
  console.log(`   GET  /api/all-news?page=1&limit=20&category=technology`);
  console.log(`   GET  /api/article/:id`);
  console.log(`   GET  /api/category/:slug`);
  console.log(`   GET  /api/search?q=...`);
  console.log(`   GET  /api/most-read`);
  console.log(`   POST /api/article/:id/view`);
  console.log(`   GET  /sitemap.xml`);
  console.log(`   GET  /rss.xml`);
  console.log(`   GET  /manual-fetch`);
  console.log(`   POST /api/auth/signup | /api/auth/verify | /api/auth/resend-code | /api/auth/login`);
  console.log(`   GET  /api/auth/me  (requires Authorization: Bearer <token>)`);
  console.log(`   POST /api/contact`);
  console.log(`   GET/POST/DELETE /api/bookmarks (requires login)`);
  console.log(`   POST /api/newsletter/subscribe | /unsubscribe`);
  console.log(`   GET  /api/admin/contacts | /users | /subscribers | /stats (secret-protected)`);
  console.log(`   Auto fetch every 6 hours | Auto-delete articles older than 90 days\n`);
});
