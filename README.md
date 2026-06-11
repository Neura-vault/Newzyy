# Newzyy OTP Backend

## Setup

```bash
cd backend
npm install
node server.js
```

Server starts on http://localhost:3001

## API Endpoints

### POST /send-otp
```json
{ "email": "user@gmail.com", "type": "signup", "name": "Ahmed Khan" }
```
Response: `{ "success": true, "message": "Verification code sent to your email." }`

### POST /verify-otp
```json
{ "email": "user@gmail.com", "code": "123456" }
```
Response: `{ "success": true, "message": "Email verified successfully." }`

## Deploy to Railway (Free)
1. Go to https://railway.app
2. New Project → Deploy from GitHub / Upload folder
3. Add env var: `RESEND_API_KEY=re_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S`
4. Railway gives you a URL like: https://newzyy-otp.up.railway.app
5. Update `API_BASE` in index.html to that URL

## Deploy to Render (Free)
1. Go to https://render.com
2. New Web Service → upload or connect GitHub
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env var: `RESEND_API_KEY=re_S4GytVCQ_BXV1iiAnkMcMzrWi79PJFR8S`

## Important: Resend Domain
- Currently using `onboarding@resend.dev` (works for testing, sends to verified emails only)
- For production: add your domain in Resend dashboard → update `from:` in server.js
