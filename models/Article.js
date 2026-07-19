// ════════════════════════════════════════════════════════════
//  ARTICLE MODEL — MongoDB schema
//  Ye file naye "models" folder mein rakhni hai backend repo ke andar
// ════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  category: { type: String, index: true },
  title: { type: String, required: true },
  excerpt: String,
  body: String,
  author: String,
  views: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  image: String,
  status: { type: String, default: 'published', index: true },
  source_url: String,
  source: String,
  rewritten: { type: Boolean, default: false }, // true = body was rewritten by Gemini, not copied
  manualBreaking: { type: Boolean, default: false }, // admin override — force-shows the Live/Breaking badge

  // Each key is a language code (e.g. "ur", "ar"). Only present once that
  // language's translation has actually been generated. English (the default
  // title/excerpt/body fields above) is untouched by any of this.
  translations: { type: mongoose.Schema.Types.Mixed, default: {} },
  fetched_at: { type: Date, default: Date.now, index: true }
});

// Same title dobara save na ho isliye index
articleSchema.index({ title: 1 });

module.exports = mongoose.model('Article', articleSchema);
