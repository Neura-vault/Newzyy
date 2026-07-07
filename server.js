// ════════════════════════════════════════════════════════════
//  NEWZYY — World News API + Currents + Guardian (MongoDB storage)
//  v2.0 — Migrated from /tmp file storage to MongoDB Atlas
// ════════════════════════════════════════════════════════════
 
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Article = require('./models/Article');
 
const app = express();
const PORT = process.env.PORT || 3001;
 
// ========== FRONTEND URL (for sitemap/rss absolute links) ==========
const SITE_URL = process.env.SITE_URL || 'https://newzyy.site';
 
// ========== API KEYS ==========
const WORLD_NEWS_API_KEY = process.env.WORLD_NEWS_API_KEY || 'e6031437382841f4921da3c6ba6ecd82';
const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY || 'kRjvwkCfg3uNzr1EYjYLSyTIatY-vq9FxxlBxt2Scb-JSfUu';
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || 'ab35f734-ceb0-4a49-bb7d-24c0c3331bd6';
 
// ========== MONGODB CONNECTION ==========
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is not set. Add it in Render → Environment.');
}
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));
 
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
 
// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy 3-API News (MongoDB)', time: new Date().toISOString() });
});
 
// ========== CATEGORIES ==========
const CATEGORIES = [
  'politics', 'technology', 'sports', 'business', 'health',
  'science', 'entertainment', 'travel', 'environment', 'culture', 'world', 'economy'
];
 
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
      breaking: Boolean(isNewestInCategory && ageMins < 60)
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
 
// ========== API 1: WORLD NEWS API (Full Article) ==========
async function fetchFromWorldNews(category) {
  if (!WORLD_NEWS_API_KEY) return [];
 
  const worldCatMap = {
    technology: 'tech', sports: 'sports', business: 'business', health: 'health',
    politics: 'politics', science: 'science', entertainment: 'entertainment'
  };
  const cat = worldCatMap[category] || category;
  const url = `https://api.worldnewsapi.com/search-news?text=${cat}&language=en&sort=publish-time&number=15&api-key=${WORLD_NEWS_API_KEY}`;
 
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.news || data.news.length === 0) return [];
 
    const fullArticles = [];
    for (const article of data.news) {
      try {
        const extractUrl = `https://api.worldnewsapi.com/extract-news?url=${encodeURIComponent(article.url)}&api-key=${WORLD_NEWS_API_KEY}`;
        const extractRes = await fetch(extractUrl);
        const extractData = await extractRes.json();
 
        fullArticles.push({
          title: article.title || extractData.title,
          description: article.text || extractData.text || '',
          body: extractData.text || article.text || '',
          url: article.url || extractData.url,
          image: article.image || extractData.image,
          author: article.author || extractData.author || 'World News',
          publishedAt: article.publish_date || new Date().toISOString(),
          source: 'World News'
        });
      } catch (e) {
        fullArticles.push({
          title: article.title,
          description: article.text || '',
          body: article.text || '',
          url: article.url,
          image: article.image,
          author: article.author || 'World News',
          publishedAt: article.publish_date || new Date().toISOString(),
          source: 'World News'
        });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return fullArticles;
  } catch (e) {
    console.error('World News API error:', e.message);
    return [];
  }
}
 
// ========== API 2: CURRENTS API ==========
async function fetchFromCurrents(category) {
  if (!CURRENTS_API_KEY) return [];
 
  const categoryMap = {
    technology: 'tech', sports: 'sports', business: 'business', health: 'health',
    politics: 'politics', science: 'science', entertainment: 'entertainment'
  };
  const cat = categoryMap[category] || category;
  const url = `https://api.currentsapi.services/v1/latest-news?category=${cat}&language=en&apiKey=${CURRENTS_API_KEY}&page_size=15`;
 
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.news) return [];
 
    return data.news.filter(a => a.title && a.description).map(a => ({
      title: a.title,
      description: a.description,
      body: a.body || a.description,
      url: a.url,
      image: a.image || a.author_image,
      author: a.author || 'Currents',
      publishedAt: a.published || new Date().toISOString(),
      source: 'Currents'
    }));
  } catch (e) {
    console.error('Currents API error:', e.message);
    return [];
  }
}
 
// ========== API 3: GUARDIAN API ==========
async function fetchFromGuardian(category) {
  if (!GUARDIAN_API_KEY) return [];
 
  const guardianCategories = {
    technology: 'technology', sports: 'sport', business: 'business', health: 'health',
    politics: 'politics', science: 'science', entertainment: 'culture'
  };
  const cat = guardianCategories[category] || category;
  const url = `https://content.guardianapis.com/search?section=${cat}&api-key=${GUARDIAN_API_KEY}&show-fields=body,thumbnail,trailText&page-size=15&order-by=newest`;
 
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.response || !data.response.results) return [];
 
    return data.response.results.map(a => ({
      title: a.webTitle || a.fields?.headline || 'Untitled',
      description: a.fields?.trailText || '',
      body: a.fields?.body || '',
      url: a.webUrl || a.url,
      image: a.fields?.thumbnail || '',
      author: a.fields?.byline || a.sectionName || 'The Guardian',
      publishedAt: a.webPublicationDate || new Date().toISOString(),
      source: 'The Guardian'
    }));
  } catch (e) {
    console.error('Guardian API error:', e.message);
    return [];
  }
}
 
// ========== MAIN FETCH FUNCTION (now writes to MongoDB) ==========
async function fetchAllNews() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting 3-API news fetch...`);
 
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
 
  let totalNew = 0;
 
  for (const cat of CATEGORIES) {
    console.log(`\n📰 Fetching ${cat}...`);
 
    const [world, currents, guardian] = await Promise.all([
      fetchFromWorldNews(cat),
      fetchFromCurrents(cat),
      fetchFromGuardian(cat)
    ]);
 
    const allArticles = [...world, ...currents, ...guardian];
    console.log(`   World: ${world.length}, Currents: ${currents.length}, Guardian: ${guardian.length}, Total: ${allArticles.length}`);
 
    let newCount = 0;
 
    for (const article of allArticles) {
      if (!article.title) continue;
      const titleLower = article.title.toLowerCase();
      if (existingTitles.has(titleLower)) continue;
 
      try {
        await Article.create({
          id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
          category: cat,
          title: article.title,
          excerpt: (article.description || '').substring(0, 200),
          body: article.body || article.description || '',
          author: article.author || article.source,
          views: Math.floor(Math.random() * 5000) + 100,
          comments: Math.floor(Math.random() * 200),
          image: article.image || getCategoryImage(cat),
          status: 'published',
          source_url: article.url,
          source: article.source || 'News',
          fetched_at: new Date()
        });
        existingTitles.add(titleLower);
        newCount++;
        totalNew++;
      } catch (e) {
        // Duplicate key or validation error — skip quietly, not fatal.
        if (e.code !== 11000) console.error('   ⚠️ Save error:', e.message);
      }
    }
 
    if (newCount > 0) console.log(`   ✅ ${cat}: ${newCount} new articles added`);
    await new Promise(r => setTimeout(r, 300));
  }
 
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
  console.log(`✅ Fetch completed at ${new Date().toLocaleTimeString()}\n`);
}
 
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
  console.log('📰 Initializing 3-API news fetcher (World + Currents + Guardian)...');
  fetchAllNews().catch(console.error);
 
  setInterval(async () => {
    console.log('⏰ Scheduled news fetch...');
    await fetchAllNews().catch(console.error);
  }, 6 * 60 * 60 * 1000);
});
 
// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   🔥 World News API + Currents + Guardian (MongoDB storage)`);
  console.log(`   GET  /api/all-news?page=1&limit=20&category=technology`);
  console.log(`   GET  /api/article/:id`);
  console.log(`   GET  /api/category/:slug`);
  console.log(`   GET  /api/search?q=...`);
  console.log(`   GET  /api/most-read`);
  console.log(`   POST /api/article/:id/view`);
  console.log(`   GET  /sitemap.xml`);
  console.log(`   GET  /rss.xml`);
  console.log(`   GET  /manual-fetch`);
  console.log(`   Auto fetch every 6 hours | Auto-delete articles older than 90 days\n`);
});
