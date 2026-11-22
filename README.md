# One-High — Online Card Game

A full online multiplayer implementation of the family card game One-High. 4 players, 2 teams, first to 500 wins.

---

## How to Deploy (Free on Render.com)

Follow these steps exactly — takes about 10 minutes.

### Step 1: Install Git (if you don't have it)
Download from https://git-scm.com and install with default settings.

### Step 2: Create a GitHub account (if you don't have one)
Go to https://github.com and sign up — it's free.

### Step 3: Create a new GitHub repository
1. Go to https://github.com/new
2. Name it `one-high`
3. Leave everything else as default
4. Click **Create repository**

### Step 4: Upload your code to GitHub
Open a terminal (Mac: search "Terminal", Windows: search "Command Prompt"), then run:

```bash
cd path/to/one-high        # navigate to the folder containing this README
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/one-high.git
git push -u origin main
```
Replace `YOUR_USERNAME` with your actual GitHub username.

### Step 5: Deploy to Render
1. Go to https://render.com and sign up (free, no credit card)
2. Click **New +** → **Web Service**
3. Click **Connect account** next to GitHub and authorize Render
4. Find and select your `one-high` repository
5. Fill in the settings:
   - **Name**: one-high (or anything you like)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
6. Click **Create Web Service**

Render will build and deploy your app. This takes 2–3 minutes.

### Step 6: Get your URL
Once deployed, Render shows a URL like:
```
https://one-high-xxxx.onrender.com
```
Share this URL with your family. All 4 players open it, enter their names, and the game starts automatically when everyone has joined.

---

## Playing the Game

1. All 4 players open the URL and enter their names
2. The game starts automatically when all 4 are connected
3. **Teams**: Seats 1 & 3 = Team A, Seats 2 & 4 = Team B
4. Follow the on-screen prompts for bidding, trump declaration, and card play

## Important Notes

- **Cold starts**: The free Render tier sleeps after 15 minutes of inactivity. The first person to open the URL may wait 30–60 seconds for it to wake up. Just refresh if it seems stuck.
- **One game at a time**: If someone disconnects, everyone must refresh and rejoin.
- **Game state is in memory**: If the server restarts, the current game resets.

---

## Running Locally (for testing)

```bash
npm install
npm start
```
Open http://localhost:3000 in four different browser tabs to test all four seats.

---

## Tech Stack
- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no build step needed)
- **Hosting**: Render.com free tier
