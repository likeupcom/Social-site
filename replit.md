# NS Platform

A social media engagement platform where users can register, link their YouTube, TikTok, Instagram, and Facebook accounts, and manage deposits.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 5
- **Database:** MongoDB via Mongoose
- **Auth:** JWT (cookies + query param fallback)
- **File uploads:** Multer (memory storage)

## Running the app

```
npm start
```

The server listens on `PORT` (defaults to 3000; Replit sets it to `5000`).

## Required environment variables

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (e.g. from MongoDB Atlas) |
| `JWT_SECRET` | Optional — defaults to a hardcoded fallback if not set |

Set these as Replit Secrets (Tools → Secrets).

## Project structure

```
server.js          # Main Express app — auth, profile, deposit routes
lib/db.js          # Mongoose connection helper
page.js            # General page router
page1.js           # TikTok dashboard router
page2.js           # Instagram dashboard router
page3.js           # Facebook dashboard router
public/            # Static HTML pages (login, signup, home, etc.)
private/           # Auth-gated platform dashboards
admin.html         # Admin panel
```

## User preferences

<!-- Agent: record user preferences here -->
