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
  fetched_at: { type: Date, default: Date.now, index: true }
});
 
// Same title dobara save na ho isliye index
articleSchema.index({ title: 1 });
 
module.exports = mongoose.model('Article', articleSchema);
