// ════════════════════════════════════════════════════════════
//  CONTACT MESSAGE MODEL — stores every contact form submission
// ════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const contactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
