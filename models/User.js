// ════════════════════════════════════════════════════════════
//  USER MODEL — real accounts, hashed passwords, email verification
// ════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  password: { type: String, required: true }, // bcrypt hash, never plain text

  verified: { type: Boolean, default: false },
  verificationCode: { type: String, default: null },      // 6-digit code, cleared once used
  verificationExpires: { type: Date, default: null },     // code valid for 15 minutes

  bookmarks: { type: [String], default: [] }, // article ids saved by this user

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
