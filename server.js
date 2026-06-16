// ════════════════════════════════════════════════════════════
//  NEWZYY — WORLD NEWS API + CURRENTS API (Full Article Text)
//  Free tiers: Both provide full article content
// ════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const ARTICLES_FILE = '/tmp/nzy_articles.json';

// ========== API KEYS ==========
const WORLD_NEWS_API_KEY = process.env.WORLD_NEWS_API_KEY || 'e6031437382841f4921da3c6ba6ecd82';
const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY || 'kRjvwkCfg3uNzr1EYjYLSyTIatY-vq9FxxlBxt2Scb-JSfUu';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Newzyy Full Article News API', time: new Date().toISOString() });
});

// ========== GET ALL NEWS ==========
app.get('/api/all-news', (req, res) => {
  try {
    if (!fs.existsSync(ARTICLES_FILE)) return res.json({ success: true, news: [] });
    const data = fs.readFileSync(ARTICLES_FILE, 'utf8');
    let articles = JSON.parse(data);
    articles = articles.filter(a => a.status === 'published');
    articles.sort((a, b) => new Date(b.fetched_at || b.id) - new Date(a.fetched_at || a.id));
    res.json({ success: true, news: articles });
  } catch(e) {
    res.json({ success: true, news: [] });
  }
});

// ========== CATEGORIES ==========
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

// ========== API 1: World News API (Full Article) ==========
async function fetchFromWorldNewsAPI(category) {
  if (!WORLD_NEWS_API_KEY || WORLD_NEWS_API_KEY === 'YOUR_WORLD_NEWS_API_KEY_HERE') {
    console.log('⚠️ World News API key missing');
    return [];
  }
  
  const url = `https://api.worldnewsapi.com/search-news?text=${category}&language=en&sort=publish-time&number=15&api-key=${WORLD_NEWS_API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.news || data.news.length === 0) return [];
    
    // Try to extract full article for each news item
    const fullArticles = [];
    for (const article of data.news) {
      try {
        const extractUrl = `https://api.worldnewsapi.com/extract-news?url=${encodeURIComponent(article.url)}&api-key=${WORLD_NEWS_API_KEY}`;
        const extractRes = await fetch(extractUrl);
        const extractData = await extractRes.json();
        
        fullArticles.push({
          title: article.title || extractData.title,
          description: article.text || extractData.text || '',
          body: extractData.text || article.text || '', // ✅ FULL ARTICLE TEXT
          url: article.url || extractData.url,
          image: article.image || extractData.image,
          author: article.author || extractData.author || 'World News',
          publishedAt: article.publish_date || new Date().toISOString(),
          source: article.source || 'World News'
        });
      } catch(e) {
        // If full extract fails, use available data
        fullArticles.push({
          title: article.title,
          description: article.text || '',
          body: article.text || '',
          url: article.url,
          image: article.image,
          author: article.author || 'World News',
          publishedAt: article.publish_date || new Date().toISOString(),
          source: article.source || 'World News'
        });
      }
      await new Promise(r => setTimeout(r, 200)); // Rate limit protection
    }
    
    return fullArticles;
  } catch(e) {
    console.error('World News API error:', e.message);
    return [];
  }
}

// ========== API 2: Currents API (Full Article) ==========
async function fetchFromCurrentsAPI(category) {
  if (!CURRENTS_API_KEY || CURRENTS_API_KEY === 'kRjvwkCfg3uNzr1EYjYLSyTIatY-vq9FxxlBxt2Scb-JSfUu') {
    console.log('⚠️ Currents API key missing');
    return [];
  }
  
  const categoryMap = { 
    technology: 'tech', 
    sports: 'sports', 
    business: 'business', 
    health: 'health', 
    politics: 'politics', 
    science: 'science', 
    entertainment: 'entertainment' 
  };
  const cat = categoryMap[category] || category;
  const url = `https://api.currentsapi.services/v1/latest-news?category=${cat}&language=en&apiKey=${CURRENTS_API_KEY}&page_size=30`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.news) return [];
    
    return data.news.filter(a => a.title && a.description).map(a => ({
      title: a.title,
      description: a.description,
      body: a.body || a.description, // ✅ FULL ARTICLE TEXT
      url: a.url,
      image: a.image || a.author_image,
      author: a.author || 'Currents',
      publishedAt: a.published || new Date().toISOString(),
      source: 'Currents'
    }));
  } catch(e) {
    console.error('Currents API error:', e.message);
    return [];
  }
}

// ========== MAIN FETCH FUNCTION ==========
async function fetchAllNews() {
  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting news fetch...`);
  
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
    
    const [worldNews, currents] = await Promise.all([
      fetchFromWorldNewsAPI(cat),
      fetchFromCurrentsAPI(cat)
    ]);
    
    const allArticles = [...worldNews, ...currents];
    console.log(`   World News: ${worldNews.length}, Currents: ${currents.length}, Total: ${allArticles.length}`);
    
    let newCount = 0;
    
    for (const article of allArticles) {
      if (!article.title) continue;
      const titleLower = article.title.toLowerCase();
      
      if (existingTitles.has(titleLower)) continue;
      
      const newArticle = {
        id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        category: cat,
        featured: cat === 'politics' && newCount === 0,
        trending: false,
        editor: false,
        title: article.title,
        excerpt: (article.description || '').substring(0, 200),
        body: article.body || article.description || '', // ✅ FULL ARTICLE
        author: article.author || article.source,
        time: formatTimeAgo(article.publishedAt),
        views: Math.floor(Math.random() * 5000) + 100,
        comments: Math.floor(Math.random() * 200),
        image: article.image || getCategoryImage(cat),
        status: 'published',
        source_url: article.url,
        source: article.source || 'News',
        fetched_at: new Date().toISOString()
      };
      
      existing.unshift(newArticle);
      existingTitles.add(titleLower);
      newCount++;
      totalNew++;
    }
    
    if (newCount > 0) {
      console.log(`   ✅ ${cat}: ${newCount} new articles added`);
    }
    
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Auto delete old news (older than 3 days)
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const beforeDelete = existing.length;
  existing = existing.filter(a => new Date(a.fetched_at || a.id) > threeDaysAgo);
  const deletedCount = beforeDelete - existing.length;
  if (deletedCount > 0) console.log(`🗑️ Auto-deleted ${deletedCount} old news (older than 3 days)`);
  
  // Sort by date (latest first)
  existing.sort((a, b) => new Date(b.fetched_at || b.id) - new Date(a.fetched_at || a.id));
  
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(existing));
  
  console.log(`\n📊 SUMMARY: +${totalNew} new | Total: ${existing.length} articles`);
  console.log(`✅ Fetch completed at ${new Date().toLocaleTimeString()}\n`);
}

// ========== MANUAL FETCH ==========
app.get('/manual-fetch', async (req, res) => {
  console.log('📡 Manual fetch triggered');
  try {
    await fetchAllNews();
    res.json({ success: true, message: 'Manual fetch completed', time: new Date().toISOString() });
  } catch(e) {
    console.error('Manual fetch error:', e);
    res.json({ success: false, message: e.message });
  }
});

// ========== START SCHEDULE ==========
console.log('📰 Initializing World News + Currents API fetcher...');
fetchAllNews().catch(console.error);

setInterval(async () => {
  console.log('⏰ Scheduled news fetch...');
  await fetchAllNews().catch(console.error);
}, 6 * 60 * 60 * 1000);

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   🔥 World News API + Currents API (Full Article Text!)`);
  console.log(`   GET /api/all-news - Get all news`);
  console.log(`   GET /manual-fetch - Force manual fetch`);
  console.log(`   Auto fetch every 6 hours`);
  console.log(`   Auto delete news older than 3 days\n`);
});
