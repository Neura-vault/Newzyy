// ════════════════════════════════════════════════════════════
//  NEWZYY — RSS sources, per category
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
const Article = require('./models/Article');
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
// Gemini now supports up to 5 keys, round-robin rotated — set GEMINI_API_KEY,
// GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4, GEMINI_API_KEY_5 in
// Render → Environment. Unset ones are simply skipped, so this still works
// fine with just 1 key configured — nothing else needs to change either way.
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5
].filter(Boolean);
let geminiKeyRotationIndex = 0;
// Picks the next key in the pool, round-robin — spreads calls evenly across
// every configured key instead of hammering just the first one.
function nextGeminiKey() {
  const key = GEMINI_API_KEYS[geminiKeyRotationIndex % GEMINI_API_KEYS.length];
  geminiKeyRotationIndex++;
  return key;
}
const JWT_SECRET = process.env.JWT_SECRET; // set this in Render → Environment — long random string
const VERIFICATION_CODE_TTL_MIN = 15;

// This project's actual granted free-tier limit is lower than Google's documented
// defaults (its own error says "limit: 20"). Rather than guess a fixed pace, we read
// Google's own suggested wait time from each 429 response and back off exactly that
// long — self-adjusting to whatever the real limit is, never guessing wrong.
const GEMINI_DELAY_MS = 4500;              // base spacing between successful calls (tightened from 6000 for faster throughput; 429 backoff still self-corrects if this is too aggressive)
// Split so a busy rewrite cycle can never starve translation of quota (and vice
// versa) — translation gets the bigger share since one article needs 9 translation
// calls (one per language) but only 1 rewrite call.
// Per-key daily budget stays the same as before (360 / 840) — these totals just
// multiply by however many Gemini keys are actually configured (1 to 5), so
// nothing else in the file needs to know how many keys there are.
const GEMINI_REWRITE_MAX_PER_DAY = 360 * Math.max(GEMINI_API_KEYS.length, 1);
const GEMINI_TRANSLATE_MAX_PER_DAY = 840 * Math.max(GEMINI_API_KEYS.length, 1);
const GEMINI_MAX_ROUNDS_PER_CYCLE = 20;    // cap how many articles per category one cycle will attempt
// Image generation quota is NOT multiplied by key count like rewrite/translate
// above — Google's free-tier image quota is granted per Google Cloud project,
// and multiple keys often share one project, so extra keys may not add extra
// image headroom the way they do for text. Kept conservative (under the
// documented ~500/day) so this never silently starts failing mid-cycle.
const GEMINI_IMAGE_MAX_PER_DAY = 450;
let geminiRewriteCallsToday = 0;
let geminiTranslateCallsToday = 0;
let geminiImageCallsToday = 0;
let geminiDayStamp = new Date().toDateString();

// ----- Cloudinary: hosts the AI-generated article images -----
// Generated images come back from Gemini as base64 data, which we upload here
// to get a permanent, public URL — keeps MongoDB documents small (just a URL,
// like before) instead of storing image bytes directly in the database.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// ----- Groq: second AI provider (separate free account, separate quota) -----
// Used as a fallback when Gemini's quota runs out — genuinely combines both
// companies' free tiers rather than trying to bypass either one's limits.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant'; // most generous free-tier limits on Groq
const GROQ_REWRITE_MAX_PER_DAY = 3600;
const GROQ_TRANSLATE_MAX_PER_DAY = 8400;
let groqRewriteCallsToday = 0;
let groqTranslateCallsToday = 0;
let groqDayStamp = new Date().toDateString();

// ----- Mistral: third AI provider (used for translation, and now also as a rewrite fallback) -----
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = 'mistral-small-latest';
const MISTRAL_REWRITE_MAX_PER_DAY = 120;
const MISTRAL_TRANSLATE_MAX_PER_DAY = 280;
let mistralRewriteCallsToday = 0;
let mistralTranslateCallsToday = 0;
let mistralDayStamp = new Date().toDateString();

// ----- Cerebras: fourth AI provider (rewrite fallback — free tier, OpenAI-compatible, very fast) -----
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_MODEL = 'llama-3.3-70b';
const CEREBRAS_MAX_PER_DAY = 800; // conservative — Cerebras free tier is generous, raise once confirmed on your account
let cerebrasCallsToday = 0;
let cerebrasDayStamp = new Date().toDateString();

// ----- Cohere: fifth AI provider (rewrite fallback — free trial tier, Command R) -----
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const COHERE_MODEL = 'command-r-08-2024';
const COHERE_MAX_PER_DAY = 800; // Cohere trial keys are typically ~1000 calls/month — conservative daily slice
let cohereCallsToday = 0;
let cohereDayStamp = new Date().toDateString();

// ========== TRANSLATION LANGUAGES ==========
// Adding a new language later = add one line here. Nothing else needs to change.
const LANGUAGES = {
  ur: { name: 'Urdu', native: 'اردو', rtl: true },
  hi: { name: 'Hindi', native: 'हिन्दी', rtl: false },
  ar: { name: 'Arabic', native: 'العربية', rtl: true },
  es: { name: 'Spanish', native: 'Español', rtl: false },
  fr: { name: 'French', native: 'Français', rtl: false },
  bn: { name: 'Bengali', native: 'বাংলা', rtl: false },
  tr: { name: 'Turkish', native: 'Türkçe', rtl: false },
  id: { name: 'Indonesian', native: 'Bahasa Indonesia', rtl: false },
  pt: { name: 'Portuguese', native: 'Português', rtl: false }
};
const TRANSLATION_MAX_ROUNDS_PER_CYCLE = 60; // now focused on only the active language(s) below, so budget goes further

// Only languages in this list actually get translated — everything else in
// LANGUAGES above is "defined but not launched yet" and gets skipped, so
// quota isn't wasted on pages that don't exist on the frontend yet.
// Add a language code here only once its /xx/ frontend folder is live.
const ACTIVE_LANGUAGES = ['ur', 'hi', 'ar', 'es', 'fr', 'bn', 'tr', 'id', 'pt'];

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
  res.json({ status: 'ok', service: 'Newzyy (RSS, MongoDB, Auth)', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════
//  BOT-VISIBLE RENDERING
//  Plain server-rendered HTML with real article text baked in — no JavaScript
//  needed to see it. Not yet wired into the live site's routing (that needs a
//  hosting-level decision — see chat notes); these endpoints work standalone
//  today at /render/home and /render/article/:id and can be pointed at once
//  that decision is made.
// ════════════════════════════════════════════════════════════

function escapeHtmlBasic(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ========== ARTICLE BODY SANITIZER ==========
// Article bodies are now AI-generated HTML, inserted directly into pages
// (innerHTML on the live site, and raw in /render/article/:id). This is the
// safety net: only a small allowlist of harmless formatting tags survives,
// every attribute is stripped from every tag (kills onclick=, javascript:
// hrefs, etc.), and script/style/iframe blocks are removed tag-and-content —
// so nothing an AI model (or a prompt-injected source article) outputs can
// ever execute in a visitor's browser.
const ARTICLE_HTML_ALLOWED_TAGS = ['p', 'strong', 'em', 'b', 'i', 'blockquote', 'br', 'ul', 'ol', 'li'];
function sanitizeArticleHtml(html) {
  if (!html) return '';
  let out = String(html);
  // Strip dangerous elements entirely, including their content
  out = out.replace(/<(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Strip any tag not in the allowlist, and strip ALL attributes from tags that stay
  out = out.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag, attrs) => {
    const lower = tag.toLowerCase();
    if (!ARTICLE_HTML_ALLOWED_TAGS.includes(lower)) return '';
    const isClosing = match.startsWith('</');
    if (lower === 'br') return '<br>';
    return isClosing ? `</${lower}>` : `<${lower}>`;
  });
  return out.trim();
}

// Articles published after this change already have body as sanitized HTML
// (<p> tags). Articles published before it are still plain text. This lets
// every article — old or new — render correctly without a one-time DB migration.
function formatArticleBodyForRender(body) {
  const b = (body || '').trim();
  if (!b) return '';
  if (/<p[\s>]/i.test(b)) return sanitizeArticleHtml(b); // already HTML — sanitize defensively, use as-is
  return b.split(/\n\s*\n/).map(p => `<p>${escapeHtmlBasic(p.trim())}</p>`).join('\n'); // legacy plain text
}

app.get('/render/home', async (req, res) => {
  try {
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    const filter = { status: 'published' };
    if (lang) filter[`translations.${lang}`] = { $exists: true };
    const articles = await Article.find(filter).sort({ fetched_at: -1 }).limit(40).lean();
    const items = applyLanguageToList(attachLiveFields(articles), lang);
    const htmlLang = lang || 'en';
    const dir = lang && LANGUAGES[lang].rtl ? 'rtl' : 'ltr';
    const siteTitle = lang ? `Newzyy — ${LANGUAGES[lang].native}` : 'Newzyy — Independent News, Politics, Technology, Business, Sports, and More';

    const html = `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${escapeHtmlBasic(siteTitle)}</title>
<meta name="description" content="Newzyy is an independent news outlet covering politics, technology, AI, business, sports, health, science, and world affairs.">
</head>
<body>
<h1>Newzyy — Top World News</h1>
<p>Newzyy is an independent news outlet covering politics, technology, AI, business, sports, health, science, culture, environment, and world affairs.</p>
<nav>
${items.length ? '' : '<p>No articles available right now — please check back shortly.</p>'}
</nav>
<main>
${items.map(a => `
  <article>
    <h2><a href="${SITE_URL}/${lang ? lang + '/article/' : 'article/'}?id=${a.id}">${escapeHtmlBasic(a.title)}</a></h2>
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
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    const a = await Article.findOne({ id: req.params.id }).lean();
    if (!a) return res.status(404).send('<html><body><h1>Article not found</h1></body></html>');
    if (lang && !(a.translations && a.translations[lang])) {
      return res.status(404).send('<html><body><h1>Not translated yet</h1></body></html>');
    }
    const article = applyLanguage(attachLiveFields([a])[0], lang);
    const htmlLang = lang || 'en';
    const dir = lang && LANGUAGES[lang].rtl ? 'rtl' : 'ltr';
    const homeUrl = lang ? `${SITE_URL}/${lang}/` : `${SITE_URL}/`;

    const html = `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${escapeHtmlBasic(article.title)} — Newzyy</title>
<meta name="description" content="${escapeHtmlBasic((article.excerpt || '').substring(0, 160))}">
</head>
<body>
<p><a href="${homeUrl}">Newzyy Home</a> &gt; ${escapeHtmlBasic(article.category)}</p>
<h1>${escapeHtmlBasic(article.title)}</h1>
<p><strong>By ${escapeHtmlBasic(article.author || 'Newzyy Staff')}</strong> — ${escapeHtmlBasic(article.time)}</p>
<img src="${escapeHtmlBasic(article.image)}" alt="${escapeHtmlBasic(article.imageAlt || article.title)}">
<div>
${formatArticleBodyForRender(article.body || article.excerpt)}
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
    url: `${SITE_URL}/article/?id=${a.id}`
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
      url: `${SITE_URL}/article/?id=${a.id}`
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
      ai: {
        gemini: {
          configured: GEMINI_API_KEYS.length > 0,
          keysConfigured: GEMINI_API_KEYS.length,
          rewrite: { callsToday: geminiRewriteCallsToday, maxPerDay: GEMINI_REWRITE_MAX_PER_DAY },
          translate: { callsToday: geminiTranslateCallsToday, maxPerDay: GEMINI_TRANSLATE_MAX_PER_DAY },
          image: { callsToday: geminiImageCallsToday, maxPerDay: GEMINI_IMAGE_MAX_PER_DAY }
        },
        groq: {
          configured: Boolean(GROQ_API_KEY),
          rewrite: { callsToday: groqRewriteCallsToday, maxPerDay: GROQ_REWRITE_MAX_PER_DAY },
          translate: { callsToday: groqTranslateCallsToday, maxPerDay: GROQ_TRANSLATE_MAX_PER_DAY }
        },
        mistral: {
          configured: Boolean(MISTRAL_API_KEY),
          rewrite: { callsToday: mistralRewriteCallsToday, maxPerDay: MISTRAL_REWRITE_MAX_PER_DAY },
          translate: { callsToday: mistralTranslateCallsToday, maxPerDay: MISTRAL_TRANSLATE_MAX_PER_DAY }
        },
        cerebras: { configured: Boolean(CEREBRAS_API_KEY), callsToday: cerebrasCallsToday, maxPerDay: CEREBRAS_MAX_PER_DAY, rewriteOnly: true },
        cohere: { configured: Boolean(COHERE_API_KEY), callsToday: cohereCallsToday, maxPerDay: COHERE_MAX_PER_DAY, rewriteOnly: true }
      },
      // Kept for any older client still reading the old flat shape.
      gemini: { callsToday: geminiRewriteCallsToday + geminiTranslateCallsToday, maxPerDay: GEMINI_REWRITE_MAX_PER_DAY + GEMINI_TRANSLATE_MAX_PER_DAY },
      groq: { configured: Boolean(GROQ_API_KEY), callsToday: groqRewriteCallsToday + groqTranslateCallsToday, maxPerDay: GROQ_REWRITE_MAX_PER_DAY + GROQ_TRANSLATE_MAX_PER_DAY }
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

// ----- Manually written articles (admin panel "Write Article" tab) -----
// Everything else (RSS fetch → AI rewrite → auto-translate → publish) keeps
// running exactly as before; this is a second, independent way for a human to
// add an article directly, using the same Article model and the same
// translation pipeline the automated system already uses, so manual articles
// look and behave identically to auto-published ones on the site.
app.post('/api/admin/article/manual', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const { title, category, excerpt, body, image, author, autoTranslate, manualBreaking } = req.body || {};

    if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
    if (!body || !body.trim()) return res.status(400).json({ success: false, message: 'Body is required.' });
    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `Category must be one of: ${CATEGORIES.join(', ')}` });
    }

    // Body typed in the admin textarea is plain text with blank lines between
    // paragraphs — wrap each paragraph in <p> so it renders exactly like every
    // other article on the site (which all store body as <p>-wrapped HTML).
    const bodyHtml = body.trim().split(/\n\s*\n/).map(p => `<p>${p.trim().replace(/\n/g, ' ')}</p>`).join('');
    const excerptText = (excerpt && excerpt.trim()) || body.trim().substring(0, 200);

    let finalImage = (image || '').trim();
    if (finalImage) {
      const goodImage = await isGoodImage(finalImage);
      if (!goodImage) {
        return res.status(400).json({ success: false, message: 'Image URL could not be verified — check the link is a direct, public image URL (ends in .jpg/.png/etc, not a webpage).' });
      }
    }

    // Auto-translate into every active language, same as the automated
    // pipeline — optional, but on by default so the article shows correctly
    // across all language pages instead of only the default one.
    let translations = {};
    if (autoTranslate !== false) {
      const englishDraft = { title: title.trim(), excerpt: excerptText, body: bodyHtml };
      const translationResults = await Promise.all(
        ACTIVE_LANGUAGES.map(async langCode => ({ langCode, result: await translateArticle(englishDraft, langCode) }))
      );
      for (const { langCode, result: tResult } of translationResults) {
        if (tResult) translations[langCode] = { ...tResult, translatedAt: new Date() };
      }
    }

    const created = await Article.create({
      id: `manual_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      category,
      title: title.trim(),
      excerpt: excerptText,
      body: bodyHtml,
      author: (author && author.trim()) || 'Newzyy Staff',
      views: 0,
      comments: 0,
      image: finalImage,
      imageAlt: title.trim(),
      status: 'published',
      source: 'Newzyy (manual)',
      rewritten: true,
      manualBreaking: Boolean(manualBreaking),
      translations,
      fetched_at: new Date()
    });

    res.json({
      success: true,
      message: `Article published. ${Object.keys(translations).length}/${ACTIVE_LANGUAGES.length} languages translated.`,
      article: created
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----- Edit an existing article (auto-published OR manual) -----
// Previously only Delete existed for articles — no way to fix a typo or swap
// a bad image without deleting and re-adding. Same fields as manual create;
// leaving image/excerpt blank keeps the existing value. Retranslation is
// opt-in (checkbox) so a small text fix doesn't burn AI quota by default.
app.patch('/api/admin/article/:id', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const article = await Article.findOne({ id: req.params.id });
    if (!article) return res.status(404).json({ success: false, message: 'Not found.' });

    const { title, category, excerpt, body, image, author, manualBreaking, retranslate } = req.body || {};

    if (category) {
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: `Category must be one of: ${CATEGORIES.join(', ')}` });
      }
      article.category = category;
    }
    if (title && title.trim()) { article.title = title.trim(); article.imageAlt = title.trim(); }
    if (typeof excerpt === 'string' && excerpt.trim()) article.excerpt = excerpt.trim();
    if (typeof body === 'string' && body.trim()) {
      article.body = body.trim().split(/\n\s*\n/).map(p => `<p>${p.trim().replace(/\n/g, ' ')}</p>`).join('');
    }
    if (typeof image === 'string' && image.trim()) {
      const goodImage = await isGoodImage(image.trim());
      if (!goodImage) {
        return res.status(400).json({ success: false, message: 'Image URL could not be verified — check the link is a direct, public image URL.' });
      }
      article.image = image.trim();
    }
    if (typeof author === 'string' && author.trim()) article.author = author.trim();
    if (typeof manualBreaking === 'boolean') article.manualBreaking = manualBreaking;

    let translateMsg = '';
    if (retranslate) {
      const englishDraft = { title: article.title, excerpt: article.excerpt, body: article.body };
      const translationResults = await Promise.all(
        ACTIVE_LANGUAGES.map(async langCode => ({ langCode, result: await translateArticle(englishDraft, langCode) }))
      );
      const translations = { ...article.translations };
      let filled = 0;
      for (const { langCode, result: tResult } of translationResults) {
        if (tResult) { translations[langCode] = { ...tResult, translatedAt: new Date() }; filled++; }
      }
      article.translations = translations;
      translateMsg = ` Re-translated ${filled}/${ACTIVE_LANGUAGES.length} languages.`;
    }

    await article.save();
    res.json({ success: true, message: `Article updated.${translateMsg}`, article });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----- Fill in only the languages an article is still missing -----
// Complements the "Translated X/9" badge already shown per article, which
// previously had no action attached to it.
app.post('/api/admin/article/:id/retranslate-missing', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const article = await Article.findOne({ id: req.params.id });
    if (!article) return res.status(404).json({ success: false, message: 'Not found.' });

    const have = new Set(Object.keys(article.translations || {}));
    const missing = ACTIVE_LANGUAGES.filter(l => !have.has(l));
    if (!missing.length) return res.json({ success: true, message: 'Already fully translated.', article });

    const englishDraft = { title: article.title, excerpt: article.excerpt, body: article.body };
    const translationResults = await Promise.all(
      missing.map(async langCode => ({ langCode, result: await translateArticle(englishDraft, langCode) }))
    );
    const translations = { ...article.translations };
    let filled = 0;
    for (const { langCode, result: tResult } of translationResults) {
      if (tResult) { translations[langCode] = { ...tResult, translatedAt: new Date() }; filled++; }
    }
    article.translations = translations;
    await article.save();
    res.json({ success: true, message: `Filled ${filled}/${missing.length} missing languages.`, article });
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

// Every category has its own dedicated RSS feed — this is now the sole source
// for every category (Guardian API removed).
const RSS_FEEDS = {
  politics: 'https://feeds.bbci.co.uk/news/politics/rss.xml',
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  ai: 'https://techcrunch.com/category/artificial-intelligence/feed/',
  business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  economy: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',
  health: 'https://feeds.bbci.co.uk/news/health/rss.xml',
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

// Only swaps in translated text when ?lang= is explicitly passed AND that
// translation actually exists yet. No lang param, or translation not ready =
// English fields returned exactly as before — this can never break existing callers.
function applyLanguage(article, langCode) {
  if (!langCode || !LANGUAGES[langCode]) return article;
  const translation = article.translations && article.translations[langCode];
  if (!translation) return article; // not translated yet — fall back to English, never show blank
  return {
    ...article,
    title: translation.title,
    excerpt: translation.excerpt,
    body: translation.body,
    lang: langCode,
    rtl: Boolean(LANGUAGES[langCode].rtl)
  };
}
function applyLanguageToList(articles, langCode) {
  if (!langCode) return articles;
  return articles.map(a => applyLanguage(a, langCode));
}

// ========== GET ALL NEWS (paginated) ==========
// ?page=1&limit=20&category=technology
app.get('/api/all-news', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter = { status: 'published' };
    if (req.query.category && CATEGORIES.includes(String(req.query.category))) filter.category = String(req.query.category);
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    // Only show articles that actually HAVE this translation — no English fallback mixed in.
    if (lang) filter[`translations.${lang}`] = { $exists: true };

    const total = await Article.countDocuments(filter);
    const articles = await Article.find(filter)
      .sort({ fetched_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      news: applyLanguageToList(attachLiveFields(articles), lang),
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
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;

    if (lang && !(article.translations && article.translations[lang])) {
      // Article exists, but not translated into this language yet — say so clearly
      // instead of silently showing English content on a language-specific page.
      return res.json({ success: true, article: null, translationPending: true });
    }

    res.json({ success: true, article: applyLanguage(attachLiveFields([article])[0], lang) });
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
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    if (lang) filter[`translations.${lang}`] = { $exists: true };

    const total = await Article.countDocuments(filter);
    const articles = await Article.find(filter)
      .sort({ fetched_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ success: true, news: applyLanguageToList(attachLiveFields(articles), lang), page, total, totalPages: Math.ceil(total / limit) || 1 });
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

    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const orClauses = [{ title: regex }, { excerpt: regex }, { category: regex }];
    if (lang) {
      orClauses.push({ [`translations.${lang}.title`]: regex });
      orClauses.push({ [`translations.${lang}.excerpt`]: regex });
    }

    const articles = await Article.find({
      status: 'published',
      $or: orClauses
    }).sort({ fetched_at: -1 }).limit(30).lean();

    res.json({ success: true, news: applyLanguageToList(attachLiveFields(articles), lang) });
  } catch (e) {
    console.error('search error:', e.message);
    res.json({ success: true, news: [] });
  }
});

// ========== MOST READ ==========
app.get('/api/most-read', async (req, res) => {
  try {
    const lang = LANGUAGES[req.query.lang] ? req.query.lang : null;
    const filter = { status: 'published' };
    if (lang) filter[`translations.${lang}`] = { $exists: true };

    const articles = await Article.find(filter)
      .sort({ views: -1 })
      .limit(10)
      .lean();
    res.json({ success: true, news: applyLanguageToList(attachLiveFields(articles), lang) });
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
    <loc>${SITE_URL}/article/?id=${a.id}</loc>
    <lastmod>${new Date(a.fetched_at).toISOString()}</lastmod>
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc></url>${urls}
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
      <link>${SITE_URL}/article/?id=${a.id}</link>
      <guid>${SITE_URL}/article/?id=${a.id}</guid>
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

// ========== SOURCE: RSS (dedicated feed per category, no key needed) ==========
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
    return []; // never throw — this category simply contributes nothing this cycle
  }
}

// ========== FETCH ARTICLES FOR ONE CATEGORY (RSS only) ==========
// Each category is fully independent — a failure in one category can never
// affect any other category.
async function fetchCategorySources(cat) {
  return await fetchRSS(cat);
}

// ========== IMAGE VALIDATION ==========
// Rejects: missing image, dead/broken links, non-image responses, and images too
// small to look sharp at our display sizes (a cheap, reliable stand-in for true
// blur detection — low-res images stretched to fill a 170-360px card are the
// ones that look "blurry" in practice).
const MIN_IMAGE_WIDTH = 300;
const MIN_IMAGE_HEIGHT = 180;
const MIN_IMAGE_BYTES = 4000; // filters out tiny placeholder/broken-icon images

// ========== SENSITIVE CONTENT FILTER ==========
// This pipeline auto-publishes with no human editorial review in the loop.
// Sexual-offence court reporting carries real legal risk without one —
// contempt of court on active trials, complainant-identification laws, and
// defamation exposure if any AI-rewritten detail drifts from the source.
// Safest approach here is to skip these stories from auto-publish entirely
// rather than risk publishing an unreviewed account of one. This is
// intentionally narrow (sexual-offence / abuse cases specifically) — it
// does not block general crime, court, or legal-affairs reporting, which
// carries much lower risk and is legitimate news coverage.
const SENSITIVE_KEYWORDS = [
  'sexual assault', 'sexually assault', 'indecent assault', 'sexual abuse',
  'sexually abused', 'child abuse', 'child sexual', 'rape', 'raped', 'rapist',
  'molest', 'pedophile', 'paedophile', 'grooming', 'sex offender',
  'sex abuse', 'incest', 'complainant', 'victim testimony'
];
function isSensitiveContent(article) {
  const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
  return SENSITIVE_KEYWORDS.some(kw => text.includes(kw));
}

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

// ========== ARTICLE IMAGES ==========
// Priority order, and nothing here ever skips an article:
//   1. The image that came with the source RSS item — fetched, lightly
//      validated (just rejects broken links / tracking pixels, not strict
//      like before), and re-hosted through Cloudinary with a standard crop so
//      it's clean and consistent regardless of the original source's sizing.
//   2. If the source had no image at all: Gemini generates a real,
//      photorealistic image specific to that article's topic — the same kind
//      of image other news sites would run, not a generic placeholder.
//   3. Only if both of the above fail (network/quota issues): a simple
//      branded category card, so publishing is never blocked.

// Cloudinary delivery transformation applied to every image on the site —
// crops to a consistent 1200x630 landscape, auto-optimizes format/quality.
// This is what "cleans" a source image that came in an odd size or format.
const IMAGE_TRANSFORM = 'c_fill,w_1200,h_630,q_auto,f_auto';
function withCloudinaryTransform(url) {
  if (!url || !url.includes('/upload/')) return url;
  return url.replace('/upload/', `/upload/${IMAGE_TRANSFORM}/`);
}

// Very lenient on purpose — this only needs to catch actually-broken links
// and 1x1 tracking pixels, not reject a real (if smallish) news thumbnail.
const SOURCE_IMAGE_MIN_BYTES = 1200;
const SOURCE_IMAGE_MIN_DIM = 80;
async function fetchSourceImageBytes(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;

    const buffer = await res.buffer();
    if (buffer.length < SOURCE_IMAGE_MIN_BYTES) return null;

    const dimensions = sizeOf(buffer);
    if (!dimensions.width || !dimensions.height) return null;
    if (dimensions.width < SOURCE_IMAGE_MIN_DIM || dimensions.height < SOURCE_IMAGE_MIN_DIM) return null;

    return { buffer, mimeType: contentType };
  } catch (e) {
    return null; // broken link, timeout, corrupt file — just means "no usable source image"
  }
}

// Spread AI image-gen attempts across the day's cycles instead of burning the
// whole day's quota in the first cycle. Reset once per fetchAllNews() run.
const GEMINI_IMAGE_MAX_PER_CYCLE = 15;
let geminiImageCallsThisCycle = 0;

async function generateImageWithGemini(title, category, contextText) {
  checkGeminiDayReset();
  if (GEMINI_API_KEYS.length === 0) return null;
  if (geminiImageCallsToday >= GEMINI_IMAGE_MAX_PER_DAY) return null;
  if (geminiImageCallsThisCycle >= GEMINI_IMAGE_MAX_PER_CYCLE) return null; // saves the rest of today's quota for later cycles
  geminiImageCallsToday++;
  geminiImageCallsThisCycle++;

  const prompt = `Create a clean, professional editorial news photograph that visually represents this news story — the kind of real photo that would run alongside this article on a major news website.

Headline: "${title}"
Category: ${category}
${contextText ? `Context: ${contextText.substring(0, 300)}` : ''}

Style requirements: realistic photojournalism style, wide/landscape composition, natural lighting, no text or captions anywhere in the image, no logos or watermarks, no borders, safe-for-work, neutral and non-graphic (do not depict violence, injury, or blood even if the story involves them — represent the topic symbolically instead).`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${nextGeminiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] }
        })
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('   ⚠️ Gemini image generation failed:', data.error?.message || res.status);
      return null;
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData || p.inline_data);
    const inline = imgPart?.inlineData || imgPart?.inline_data;
    if (!inline?.data) return null;
    return { buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || inline.mime_type || 'image/png' };
  } catch (e) {
    console.error('   ⚠️ Gemini image generation error:', e.message);
    return null;
  }
}

async function uploadImageToCloudinary(buffer, mimeType) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHash('sha1').update(`timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');
    const body = new URLSearchParams({
      file: `data:${mimeType};base64,${buffer.toString('base64')}`,
      timestamp: String(timestamp),
      api_key: CLOUDINARY_API_KEY,
      signature
    });
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body
    });
    const data = await res.json();
    if (!res.ok || !data.secure_url) {
      console.error('   ⚠️ Cloudinary upload failed:', data.error?.message || 'unknown error');
      return null;
    }
    return withCloudinaryTransform(data.secure_url);
  } catch (e) {
    console.error('   ⚠️ Cloudinary upload error:', e.message);
    return null;
  }
}

// The single entry point the fetch pipeline calls. Returns { url, source } on
// success, or null if NEITHER a real source image NOR an AI-generated one
// could be produced this attempt. On null, the caller skips the article for
// this cycle — since it never got saved, it's picked up again automatically
// next cycle (real news doesn't disappear, it just waits one cycle rather
// than ever publishing with a generic placeholder card).
async function resolveArticleImage(sourceImageUrl, title, category, contextText) {
  // 1. The source's own image, cleaned up and re-hosted
  const sourceImage = await fetchSourceImageBytes(sourceImageUrl);
  if (sourceImage) {
    const hostedUrl = await uploadImageToCloudinary(sourceImage.buffer, sourceImage.mimeType);
    if (hostedUrl) return { url: hostedUrl, source: 'fetched' };
  }

  // 2. No usable source image — AI generates one specific to this article
  const generated = await generateImageWithGemini(title, category, contextText);
  if (generated) {
    const hostedUrl = await uploadImageToCloudinary(generated.buffer, generated.mimeType);
    if (hostedUrl) return { url: hostedUrl, source: 'ai' };
  }

  return null; // neither worked this time — try again next cycle, never publish with a placeholder
}

// ========== GEMINI REWRITE ==========
// Takes the raw facts from the source APIs and asks Gemini to write an
// original Newzyy article from them. Returns null text on any failure so the
// caller can skip publishing (never breaks the pipeline).
async function rewriteWithGemini(rawArticle, category) {
  if (GEMINI_API_KEYS.length === 0) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  const prompt = `You are a staff news writer for "Newzyy", an independent news outlet.
Using ONLY the facts below, write an original news article in your own words — do not copy sentences or phrasing from the source text.
If the source facts are limited, write a shorter article rather than inventing extra details, numbers, quotes, or names that aren't in the source.
Length: 150-400 words depending on how much source material is available. Tone: clear, neutral, professional news style.
Format the output as HTML: wrap every paragraph in a <p> tag, nothing else. No headline, no preamble, no markdown, no <html>/<body>/<div> wrapper — just the <p> tags, one per paragraph, back to back.

Headline: ${rawArticle.title}
Category: ${category}
Source facts:
${sourceFacts}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${nextGeminiKey()}`,
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
    const clean = sanitizeArticleHtml(text.trim());
    return { text: clean.length > 80 ? clean : null, retryAfterMs: 0 };
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
    geminiRewriteCallsToday = 0;
    geminiTranslateCallsToday = 0;
    geminiImageCallsToday = 0;
  }
}
function checkGroqDayReset() {
  const today = new Date().toDateString();
  if (today !== groqDayStamp) {
    groqDayStamp = today;
    groqRewriteCallsToday = 0;
    groqTranslateCallsToday = 0;
  }
}

// Shared by the newer rewrite providers below (Mistral/Cerebras/Cohere) —
// identical wording to what Gemini/Groq already use, just factored out so it
// isn't repeated three more times.
function buildRewritePrompt(rawArticle, category, sourceFacts) {
  return `You are a staff news writer for "Newzyy", an independent news outlet.
Using ONLY the facts below, write an original news article in your own words — do not copy sentences or phrasing from the source text.
If the source facts are limited, write a shorter article rather than inventing extra details, numbers, quotes, or names that aren't in the source.
Length: 150-400 words depending on how much source material is available. Tone: clear, neutral, professional news style.
Format the output as HTML: wrap every paragraph in a <p> tag, nothing else. No headline, no preamble, no markdown, no <html>/<body>/<div> wrapper — just the <p> tags, one per paragraph, back to back.

Headline: ${rawArticle.title}
Category: ${category}
Source facts:
${sourceFacts}`;
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
Format the output as HTML: wrap every paragraph in a <p> tag, nothing else. No headline, no preamble, no markdown, no <html>/<body>/<div> wrapper — just the <p> tags, one per paragraph, back to back.

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
    const clean = sanitizeArticleHtml(text.trim());
    return { text: clean.length > 80 ? clean : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Groq rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// ========== MISTRAL REWRITE (fallback provider) ==========
async function rewriteWithMistral(rawArticle, category) {
  if (!MISTRAL_API_KEY) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  try {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [{ role: 'user', content: buildRewritePrompt(rawArticle, category, sourceFacts) }]
      })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      console.error(`   ⚠️ Mistral rewrite API error [${res.status}]:`, data.error?.message || JSON.stringify(data).substring(0, 300));
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter) * 1000, 70000) : 0;
      return { text: null, retryAfterMs };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { text: null, retryAfterMs: 0 };
    const clean = sanitizeArticleHtml(text.trim());
    return { text: clean.length > 80 ? clean : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Mistral rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// ========== CEREBRAS REWRITE (fallback provider) ==========
// OpenAI-compatible API, free tier, very fast inference.
async function rewriteWithCerebras(rawArticle, category) {
  if (!CEREBRAS_API_KEY) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        messages: [{ role: 'user', content: buildRewritePrompt(rawArticle, category, sourceFacts) }]
      })
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      console.error(`   ⚠️ Cerebras API error [${res.status}]:`, data.error?.message || JSON.stringify(data).substring(0, 300));
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter) * 1000, 70000) : 0;
      return { text: null, retryAfterMs };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { text: null, retryAfterMs: 0 };
    const clean = sanitizeArticleHtml(text.trim());
    return { text: clean.length > 80 ? clean : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Cerebras rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// ========== COHERE REWRITE (fallback provider) ==========
// Cohere's Chat v2 API — different request/response shape from the
// OpenAI-style providers above, handled separately.
async function rewriteWithCohere(rawArticle, category) {
  if (!COHERE_API_KEY) return { text: null, retryAfterMs: 0 };

  const sourceFacts = (rawArticle.body || rawArticle.description || '').substring(0, 3000);
  if (!sourceFacts.trim()) return { text: null, retryAfterMs: 0 };

  try {
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${COHERE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: COHERE_MODEL,
        messages: [{ role: 'user', content: buildRewritePrompt(rawArticle, category, sourceFacts) }]
      })
    });
    const data = await res.json();

    if (!res.ok || data.error || data.message?.error) {
      console.error(`   ⚠️ Cohere API error [${res.status}]:`, data.error?.message || JSON.stringify(data).substring(0, 300));
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter) * 1000, 70000) : 0;
      return { text: null, retryAfterMs };
    }

    const text = data?.message?.content?.[0]?.text;
    if (!text) return { text: null, retryAfterMs: 0 };
    const clean = sanitizeArticleHtml(text.trim());
    return { text: clean.length > 80 ? clean : null, retryAfterMs: 0 };
  } catch (e) {
    console.error('   ⚠️ Cohere rewrite error:', e.message);
    return { text: null, retryAfterMs: 0 };
  }
}

// ========== COMBINED REWRITE: 5 providers in a fallback chain ==========
// Genuinely combines five separate companies' free quotas — not multiple
// accounts on the same service, which would risk violating any of their ToS.
// Order: Gemini → Groq → Mistral → Cerebras → Cohere. Stops at the first
// provider that returns usable text; only moves to the next on quota
// exhaustion or an API error.
async function rewriteArticle(rawArticle, category) {
  checkGeminiDayReset();
  checkGroqDayReset();
  checkMistralDayReset();
  checkCerebrasDayReset();
  checkCohereDayReset();

  if (GEMINI_API_KEYS.length > 0 && geminiRewriteCallsToday < GEMINI_REWRITE_MAX_PER_DAY) {
    const result = await rewriteWithGemini(rawArticle, category);
    geminiRewriteCallsToday++;
    if (result.text) return { ...result, provider: 'gemini' };
    // Gemini failed (quota/error) — fall through to the next provider.
  }

  if (GROQ_API_KEY && groqRewriteCallsToday < GROQ_REWRITE_MAX_PER_DAY) {
    const result = await rewriteWithGroq(rawArticle, category);
    groqRewriteCallsToday++;
    if (result.text) return { ...result, provider: 'groq' };
  }

  if (MISTRAL_API_KEY && mistralRewriteCallsToday < MISTRAL_REWRITE_MAX_PER_DAY) {
    const result = await rewriteWithMistral(rawArticle, category);
    mistralRewriteCallsToday++;
    if (result.text) return { ...result, provider: 'mistral' };
  }

  if (CEREBRAS_API_KEY && cerebrasCallsToday < CEREBRAS_MAX_PER_DAY) {
    const result = await rewriteWithCerebras(rawArticle, category);
    cerebrasCallsToday++;
    if (result.text) return { ...result, provider: 'cerebras' };
  }

  if (COHERE_API_KEY && cohereCallsToday < COHERE_MAX_PER_DAY) {
    const result = await rewriteWithCohere(rawArticle, category);
    cohereCallsToday++;
    if (result.text) return { ...result, provider: 'cohere' };
  }

  return { text: null, retryAfterMs: 0, provider: 'none' };
}

// ════════════════════════════════════════════════════════════
//  TRANSLATION SYSTEM (separate from the English writing pipeline above —
//  translates the ALREADY-WRITTEN English article, so every language shows
//  the exact same set of articles, just in a different language)
// ════════════════════════════════════════════════════════════

function checkMistralDayReset() {
  const today = new Date().toDateString();
  if (today !== mistralDayStamp) {
    mistralDayStamp = today;
    mistralRewriteCallsToday = 0;
    mistralTranslateCallsToday = 0;
  }
}

function checkCerebrasDayReset() {
  const today = new Date().toDateString();
  if (today !== cerebrasDayStamp) {
    cerebrasDayStamp = today;
    cerebrasCallsToday = 0;
  }
}

function checkCohereDayReset() {
  const today = new Date().toDateString();
  if (today !== cohereDayStamp) {
    cohereDayStamp = today;
    cohereCallsToday = 0;
  }
}

function parseTranslationJSON(rawText) {
  if (!rawText) return null;
  try {
    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.body) return null;
    return { title: parsed.title, excerpt: parsed.excerpt || '', body: sanitizeArticleHtml(parsed.body) };
  } catch (e) {
    return null;
  }
}

function buildTranslationPrompt(article, langCode) {
  const lang = LANGUAGES[langCode];
  return `Translate the following English news article into ${lang.name} (${lang.native}).
Write it the way a native ${lang.name}-speaking news writer would — natural and fluent, not a literal word-for-word translation.
Keep names, places, and numbers accurate. Do not add or remove facts.
The Body field contains HTML <p> tags wrapping each paragraph — keep that exact same <p> tag structure in your translated output (same number of <p> tags, one per paragraph), translating only the text inside them. Do not translate or alter the tags themselves.
Return ONLY valid JSON, no markdown, no extra commentary, in exactly this format:
{"title": "...", "excerpt": "...", "body": "..."}

Title: ${article.title}
Excerpt: ${article.excerpt || ''}
Body: ${(article.body || '').substring(0, 3000)}`;
}

async function translateWithGemini(article, langCode) {
  if (GEMINI_API_KEYS.length === 0) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${nextGeminiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: buildTranslationPrompt(article, langCode) }] }] })
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) return null;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return parseTranslationJSON(text);
  } catch (e) {
    console.error('   ⚠️ Gemini translate error:', e.message);
    return null;
  }
}

async function translateWithGroq(article, langCode) {
  if (!GROQ_API_KEY) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: buildTranslationPrompt(article, langCode) }]
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) return null;
    return parseTranslationJSON(data?.choices?.[0]?.message?.content);
  } catch (e) {
    console.error('   ⚠️ Groq translate error:', e.message);
    return null;
  }
}

async function translateWithMistral(article, langCode) {
  if (!MISTRAL_API_KEY) return null;
  try {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [{ role: 'user', content: buildTranslationPrompt(article, langCode) }]
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) return null;
    return parseTranslationJSON(data?.choices?.[0]?.message?.content);
  } catch (e) {
    console.error('   ⚠️ Mistral translate error:', e.message);
    return null;
  }
}

async function translateArticle(article, langCode) {
  checkGeminiDayReset();
  checkGroqDayReset();
  checkMistralDayReset();

  if (GEMINI_API_KEYS.length > 0 && geminiTranslateCallsToday < GEMINI_TRANSLATE_MAX_PER_DAY) {
    geminiTranslateCallsToday++;
    const result = await translateWithGemini(article, langCode);
    if (result) return result;
  }
  if (GROQ_API_KEY && groqTranslateCallsToday < GROQ_TRANSLATE_MAX_PER_DAY) {
    groqTranslateCallsToday++;
    const result = await translateWithGroq(article, langCode);
    if (result) return result;
  }
  if (MISTRAL_API_KEY && mistralTranslateCallsToday < MISTRAL_TRANSLATE_MAX_PER_DAY) {
    mistralTranslateCallsToday++;
    const result = await translateWithMistral(article, langCode);
    if (result) return result;
  }
  return null;
}

async function runTranslationCycle() {
  console.log(`\n🌐 [${new Date().toLocaleTimeString()}] Starting translation cycle...`);
  let attempted = 0;
  let succeeded = 0;

  try {
    const articles = await Article.find({ status: 'published' }).sort({ fetched_at: -1 }).limit(150).lean();

    outer:
    for (const article of articles) {
      const existing = article.translations || {};
      for (const langCode of ACTIVE_LANGUAGES) {
        if (existing[langCode]) continue;

        if (attempted >= TRANSLATION_MAX_ROUNDS_PER_CYCLE) break outer;
        attempted++;

        const result = await translateArticle(article, langCode);
        if (result) {
          await Article.updateOne(
            { id: article.id },
            { $set: { [`translations.${langCode}`]: { ...result, translatedAt: new Date() } } }
          );
          succeeded++;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (e) {
    console.error('Translation cycle error:', e.message);
  }

  console.log(`   ✅ Translation cycle done: ${succeeded}/${attempted} succeeded this run\n`);
}

// ========== MAIN FETCH FUNCTION (MongoDB, fair round-robin across all categories) ==========
async function fetchAllNews() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting news fetch (RSS, per category)...`);
  checkGeminiDayReset();
  geminiImageCallsThisCycle = 0; // fresh budget for this cycle's image generation

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
  CATEGORIES.forEach(c => (stats[c] = { added: 0, fetchedImage: 0, aiImage: 0, skippedImage: 0, skippedGemini: 0, skippedSensitive: 0 }));

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

      // ----- Sensitive content check (cheapest check, do it first) -----
      if (isSensitiveContent(article)) {
        stats[cat].skippedSensitive++;
        continue;
      }

      // ----- AI rewrite: Gemini → Groq → Mistral → Cerebras → Cohere -----
      const noProviderLeft =
        (GEMINI_API_KEYS.length === 0 || geminiRewriteCallsToday >= GEMINI_REWRITE_MAX_PER_DAY) &&
        (!GROQ_API_KEY || groqRewriteCallsToday >= GROQ_REWRITE_MAX_PER_DAY) &&
        (!MISTRAL_API_KEY || mistralRewriteCallsToday >= MISTRAL_REWRITE_MAX_PER_DAY) &&
        (!CEREBRAS_API_KEY || cerebrasCallsToday >= CEREBRAS_MAX_PER_DAY) &&
        (!COHERE_API_KEY || cohereCallsToday >= COHERE_MAX_PER_DAY);
      if (noProviderLeft) {
        stats[cat].skippedGemini++;
        continue;
      }

      const result = await rewriteArticle(article, cat);

      if (!result.text) {
        stats[cat].skippedGemini++;
        await new Promise(r => setTimeout(r, result.retryAfterMs || GEMINI_DELAY_MS));
        continue;
      }

      await new Promise(r => setTimeout(r, result.provider === 'groq' ? 2000 : GEMINI_DELAY_MS));

      // ----- Translate into every active language IN PARALLEL before publishing -----
      // Nothing goes live (not even English) until every language succeeds. If any
      // language fails, the whole article is skipped this cycle and retried next time —
      // never published half-done.
      const englishDraft = { title: article.title, excerpt: (article.description || '').substring(0, 200), body: result.text };
      const translationResults = await Promise.all(
        ACTIVE_LANGUAGES.map(async langCode => ({ langCode, result: await translateArticle(englishDraft, langCode) }))
      );

      const translations = {};
      let allTranslationsOk = true;
      for (const { langCode, result: tResult } of translationResults) {
        if (tResult) {
          translations[langCode] = { ...tResult, translatedAt: new Date() };
        } else {
          allTranslationsOk = false;
        }
      }

      if (!allTranslationsOk) {
        stats[cat].skippedGemini++; // counted as a skip — will retry as a "new" article next cycle
        continue;
      }

      // ----- Get the article's image: real source image first, AI-generated
      // second. If neither works this attempt, skip and retry next cycle —
      // never publish with a generic placeholder card. -----
      const imageResult = await resolveArticleImage(article.image, article.title, cat, englishDraft.excerpt);
      if (!imageResult) {
        stats[cat].skippedImage++; // will retry as a "new" article next cycle
        continue;
      }
      const { url: imageUrl, source: imageSource } = imageResult;
      stats[cat][imageSource === 'fetched' ? 'fetchedImage' : 'aiImage']++;

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
          image: imageUrl,
          imageAlt: article.title,
          status: 'published',
          // Kept internally for editorial record-keeping only — not shown on the site.
          source_url: article.url,
          source: article.source || 'News',
          rewritten: true,
          translations,
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
    console.log(`   ✅ ${cat}: ${s.added} added (${s.fetchedImage} fetched image, ${s.aiImage} AI image), ${s.skippedImage} skipped (no real image available), ${s.skippedGemini} skipped (rewrite/quota), ${s.skippedSensitive} skipped (sensitive content)`);
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
  console.log(`   Gemini keys configured: ${GEMINI_API_KEYS.length > 0 ? GEMINI_API_KEYS.length : 'NONE — set GEMINI_API_KEY in Render, nothing will publish without it'}`);
  console.log(`   Gemini — rewrite: ${geminiRewriteCallsToday}/${GEMINI_REWRITE_MAX_PER_DAY}, translate: ${geminiTranslateCallsToday}/${GEMINI_TRANSLATE_MAX_PER_DAY}`);
  console.log(`   Groq key configured: ${GROQ_API_KEY ? 'YES' : 'NO'} — rewrite: ${groqRewriteCallsToday}/${GROQ_REWRITE_MAX_PER_DAY}, translate: ${groqTranslateCallsToday}/${GROQ_TRANSLATE_MAX_PER_DAY}`);
  console.log(`   Mistral key configured: ${MISTRAL_API_KEY ? 'YES' : 'NO'} — rewrite: ${mistralRewriteCallsToday}/${MISTRAL_REWRITE_MAX_PER_DAY}, translate: ${mistralTranslateCallsToday}/${MISTRAL_TRANSLATE_MAX_PER_DAY}`);
  console.log(`   Cerebras key configured: ${CEREBRAS_API_KEY ? 'YES' : 'NO'} — Cerebras calls used today: ${cerebrasCallsToday}/${CEREBRAS_MAX_PER_DAY}`);
  console.log(`   Cohere key configured: ${COHERE_API_KEY ? 'YES' : 'NO'} — Cohere calls used today: ${cohereCallsToday}/${COHERE_MAX_PER_DAY}`);
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

app.get('/admin/run-translation-now', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  runTranslationCycle();
  res.json({ success: true, message: 'Translation cycle started — check logs for progress.' });
});

app.get('/api/admin/translation-coverage', async (req, res) => {
  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not set on server' });
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ success: false, message: 'Wrong secret' });
  try {
    const total = await Article.countDocuments({ status: 'published' });
    const coverage = {};
    for (const langCode of Object.keys(LANGUAGES)) {
      coverage[langCode] = await Article.countDocuments({ [`translations.${langCode}`]: { $exists: true } });
    }
    res.json({ success: true, total, coverage, languages: LANGUAGES });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ========== START SCHEDULE ==========
mongoose.connection.once('open', () => {
  console.log('📰 Initializing news fetcher (RSS, dedicated per category, Gemini rewrite)...');
  fetchAllNews().catch(console.error);

  setInterval(async () => {
    console.log('⏰ Scheduled news fetch...');
    await fetchAllNews().catch(console.error);
  }, 30 * 60 * 1000); // tightened from every 6h to every 30min for fresher news

  // Newsletter digest — once every 24 hours.
  setInterval(async () => {
    await sendDailyDigest().catch(console.error);
  }, 24 * 60 * 60 * 1000);

  // Translation cycle — every 30 minutes (tightened from every 2h), starting 5
  // minutes after boot so it doesn't compete with the initial news fetch for
  // AI quota at the same instant.
  setTimeout(() => {
    runTranslationCycle().catch(console.error);
    setInterval(async () => {
      await runTranslationCycle().catch(console.error);
    }, 30 * 60 * 1000);
  }, 5 * 60 * 1000);
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   🔥 RSS per category, Gemini-rewritten, MongoDB storage`);
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
