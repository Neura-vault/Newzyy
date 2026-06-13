// ════════════════════════════════════════════════════════════
//  NEWZYY — Multi-API News Backend
//  NewsAPI + GNews + Currents API
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3001;

// File path for storing articles
const ARTICLES_FILE = '/tmp/nzy_articles.json';

// API Keys
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '3d1c54f463114aa7b89add3425c96029';
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || 'YOUR_GNEWS_API_KEY_HERE';
const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY || 'YOUR_CURRENTS_API_KEY_HERE';

const resend = new Resend(RESEND_API_KEY);

// OTP Store
const otpStore = {};
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_MS = 60 * 1000;

// Cleanup OTPs
setInterval(() => {
  const now = Date.now();
  for (const email in otpStore) {
    if (otpStore[email].expiresAt < now) delete otpStore[email];
  }
}, 10 * 60 * 1000);

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy Multi-API News', time: new Date().toISOString() });
});

// Get pending news
app.get('/api/pending-news', (req, res) => {
  try {
    if (!fs.existsSync(ARTICLES_FILE)) return res.json({ success: true, news: [] });
    const data = fs.readFileSync(ARTICLES_FILE, 'utf8');
    const articles = JSON.parse(data);
    const pending = articles.filter(a => a.status === 'pending');
    res.json({ success: true, news: pending });
  } catch(e) {
    res.json({ success: true, news: [] });
  }
});

// Approve news
app.post('/api/approve-news', (req, res) => {
  try {
    const { id } = req.body;
    const data = fs.readFileSync(ARTICLES_FILE, 'utf8');
    let articles = JSON.parse(data);
    const index = articles.findIndex(a => a.id === id);
    if (index !== -1) {
      articles[index].status = 'published';
      fs.writeFileSync(ARTICLES_FILE, JSON.stringify(articles));
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Not found' });
    }
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// Approve all
app.post('/api/approve-all', (req, res) => {
  try {
    const data = fs.readFileSync(ARTICLES_FILE, 'utf8');
    let articles = JSON.parse(data);
    let count = 0;
    articles.forEach(a => { if (a.status === 'pending') { a.status = 'published'; count++; } });
    fs.writeFileSync(ARTICLES_FILE, JSON.stringify(articles));
    res.json({ success: true, count: count });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// ========== SEND OTP ==========
app.post('/send-otp', async (req, res) => {
  try {
    const { email, type = 'signup', name = 'User' } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }
    const existing = otpStore[email.toLowerCase()];
    if (existing && existing.sentAt && (Date.now() - existing.sentAt) < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (Date.now() - existing.sentAt)) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${wait} seconds.` });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore[email.toLowerCase()] = { code, expiresAt: Date.now() + OTP_EXPIRY_MS, sentAt: Date.now(), attempts: 0, type };
    const isSignup = type === 'signup';
    const subject = isSignup ? `${code} — Your Newzyy Verification Code` : `${code} — Confirm Your Newzyy Sign In`;
    const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial;padding:20px"><div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px"><div style="background:#0f0f0f;padding:24px;text-align:center"><h1 style="color:#fff">Newzy<span style="color:#e8380d">y</span></h1></div><div style="padding:32px"><h2>Hi ${name},</h2><p>Your verification code is:</p><div style="background:#f7f7f5;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold">${code}</div><p>Expires in 5 minutes.</p></div></div></body></html>`;
    const { data, error } = await resend.emails.send({
      from: `Newzyy <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to: [email], subject, html: htmlBody
    });
    if (error) return res.status(500).json({ success: false, message: 'Failed to send email.' });
    res.json({ success: true, message: 'Verification code sent!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ========== VERIFY OTP ==========
app.post('/verify-otp', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Email and code required.' });
    const record = otpStore[email.toLowerCase()];
    if (!record) return res.status(400).json({ success: false, message: 'No code found.' });
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
    res.json({ success: true, message: 'Email verified!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ========== MULTI-API NEWS FETCHER ==========

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

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMins = Math.floor((now - date) / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Fetch from NewsAPI
async function fetchFromNewsAPI(category) {
  const url = `https://newsapi.org/v2/top-headlines?category=${category}&language=en&apiKey=${NEWS_API_KEY}&pageSize=8`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'ok') return [];
    return data.articles.filter(a => a.title && a.title !== '[Removed]' && a.description).map(a => ({
      title: a.title,
      description: a.description,
      url: a.url,
      image: a.urlToImage,
      author: a.author || 'NewsAPI',
      publishedAt: a.publishedAt,
      source: 'NewsAPI'
    }));
  } catch(e) { return []; }
}

// Fetch from GNews API
async function fetchFromGNews(category) {
  if (!GNEWS_API_KEY || GNEWS_API_KEY === 'YOUR_GNEWS_API_KEY_HERE') return [];
  const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&apikey=${GNEWS_API_KEY}&max=8`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.articles) return [];
    return data.articles.map(a => ({
      title: a.title,
      description: a.description,
      url: a.url,
      image: a.image,
      author: a.source?.name || 'GNews',
      publishedAt: a.publishedAt,
      source: 'GNews'
    }));
  } catch(e) { return []; }
}

// Fetch from Currents API
async function fetchFromCurrents(category) {
  if (!CURRENTS_API_KEY || CURRENTS_API_KEY === 'YOUR_CURRENTS_API_KEY_HERE') return [];
  const categoryMap = { technology: 'tech', sports: 'sports', business: 'business', health: 'health', politics: 'politics', science: 'science', entertainment: 'entertainment' };
  const cat = categoryMap[category] || category;
  const url = `https://api.currentsapi.services/v1/latest-news?category=${cat}&language=en&apiKey=${CURRENTS_API_KEY}&page_size=8`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.news) return [];
    return data.news.map(a => ({
      title: a.title,
      description: a.description,
      url: a.url,
      image: a.image || a.author_image,
      author: a.author || 'Currents',
      publishedAt: a.published,
      source: 'Currents'
    }));
  } catch(e) { return []; }
}

// Fetch all news from all APIs
async function fetchAllNewsMultiAPI() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting multi-API news fetch...`);
  
  let existing = [];
  try {
    if (fs.existsSync(ARTICLES_FILE)) {
      const data = fs.readFileSync(ARTICLES_FILE, 'utf8');
      existing = JSON.parse(data);
      console.log(`📚 Loaded ${existing.length} existing articles`);
    }
  } catch(e) { existing = []; }

  let totalNew = 0;
  const existingTitles = new Set(existing.map(a => a.title?.toLowerCase()));

  for (const cat of CATEGORIES) {
    console.log(`\n📰 Fetching ${cat}...`);
    
    // Fetch from all 3 APIs
    const [newsapi, gnews, currents] = await Promise.all([
      fetchFromNewsAPI(cat),
      fetchFromGNews(cat),
      fetchFromCurrents(cat)
    ]);
    
    const allArticles = [...newsapi, ...gnews, ...currents];
    console.log(`   NewsAPI: ${newsapi.length}, GNews: ${gnews.length}, Currents: ${currents.length}, Total: ${allArticles.length}`);
    
    let newCount = 0;
    
    for (const article of allArticles) {
      if (!article.title) continue;
      const titleLower = article.title.toLowerCase();
      
      if (!existingTitles.has(titleLower)) {
        const newArticle = {
          id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
          category: cat,
          featured: false,
          trending: Math.random() > 0.7,
          editor: false,
          title: article.title,
          excerpt: (article.description || '').substring(0, 180),
          body: `<p>${article.description || ''}</p><p><a href="${article.url}" target="_blank" style="color:#e8380d;">📖 Read full article on ${article.source} →</a></p>`,
          author: article.author || article.source,
          time: formatTimeAgo(article.publishedAt),
          views: Math.floor(Math.random() * 5000) + 100,
          comments: Math.floor(Math.random() * 200),
          image: article.image || getCategoryImage(cat),
          status: 'pending',
          source_url: article.url,
          source: article.source,
          fetched_at: new Date().toISOString()
        };
        existing.unshift(newArticle);
        existingTitles.add(titleLower);
        newCount++;
        totalNew++;
      }
    }
    
    if (newCount > 0) {
      fs.writeFileSync(ARTICLES_FILE, JSON.stringify(existing));
      console.log(`   ✅ ${cat}: ${newCount} new articles added`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\n📰 TOTAL: ${totalNew} new articles fetched from all APIs`);
  console.log(`✅ Multi-API fetch completed at ${new Date().toLocaleTimeString()}\n`);
}

// ========== START SCHEDULE ==========
console.log('📰 Initializing multi-API news fetcher...');
fetchAllNewsMultiAPI().catch(console.error);

setInterval(async () => {
  console.log('⏰ Scheduled news fetch...');
  await fetchAllNewsMultiAPI().catch(console.error);
}, 6 * 60 * 60 * 1000);

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   POST /send-otp`);
  console.log(`   POST /verify-otp`);
  console.log(`   GET  /api/pending-news`);
  console.log(`   POST /api/approve-news`);
  console.log(`   POST /api/approve-all`);
  console.log(`   Multi-API news every 6 hours\n`);
});
