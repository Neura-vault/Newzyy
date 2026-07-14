// ════════════════════════════════════════════════════════════
//  SUBSCRIBER MODEL — real newsletter subscribers
// ════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  active: { type: Boolean, default: true },
  subscribedAt: { type: Date, default: Date.now },
  lastSentAt: { type: Date, default: null }
});

module.exports = mongoose.model('Subscriber', subscriberSchema);
