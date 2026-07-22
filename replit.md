# NS Platform — Social Media Engagement Platform

## Overview
A Node.js/Express web app for social media engagement. Users can sign up, log in, link their YouTube, TikTok, Instagram, and Facebook profiles, and access platform services.

## Stack
- **Runtime:** Node.js 20
- **Framework:** Express
- **Database:** MongoDB (via Mongoose)
- **Auth:** JWT (cookie-based) + bcrypt
- **Frontend:** Static HTML/CSS/JS in `public/`

## Running the app
The workflow `Start application` runs `npm start` (i.e. `node server.js`) on port 5000.

## Environment variables / secrets
- `MONGODB_URI` — MongoDB connection string (required, stored as a Replit Secret)
- `JWT_SECRET` — JWT signing secret (optional; falls back to a hardcoded default — set this in production)
- `PORT` — defaults to `5000`

## Project structure
- `server.js` — main Express server (routes, auth middleware, DB schema)
- `lib/db.js` — Mongoose connection helper
- `public/` — static frontend files (HTML, CSS, JS)
- `private/` — protected page HTML served behind auth
- `admin.html` / `page.js` / `page1-3.js` — admin/page assets

## User preferences
