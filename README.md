# Emergency News PWA (ENPWA)

A simple app that lets you read Reddit posts even when you don't have internet.

## What is this for?

ENP saves Reddit posts on your phone so you can read them later without internet. This is useful for:

- **Emergencies** — Access news and information during disasters when internet is down
- **Remote areas** — Read posts in places with poor signal
- **Saving data** — Load posts once, read them many times without using more data

## How to use it

### Getting started

1. Open the app in your web browser
2. Pick your country from the list to get suggested subreddits, then tap **Add Defaults**
3. Or skip the welcome screen and add your own subreddits manually
4. Tap **Refresh Posts** to fetch your first batch of posts

### Reading posts

- Posts are saved automatically when you refresh
- You can read them anytime, even without internet
- Posts older than 30 days are automatically removed to save space
- Tap the **★** icon on any post to star it — starred posts are kept indefinitely and never auto-deleted

### Three feeds

- **My Feed** — Posts from your chosen subreddits
- **Popular** — What's trending on Reddit right now
- **Starred** — Posts you've saved with the ★ button

Switch between them using the tabs at the top of the screen.

### Filtering My Feed

When you have multiple subreddits, a filter bar appears below the tabs. Tap any subreddit chip to show only posts from that community, or **All** to see everything together.

### Managing subreddits

- **Add** — Type a subreddit name in the settings panel and tap **Add Subreddit**
- **Remove** — Tap the × next to any subreddit in the settings list
- **Follow/Unfollow** — Tap a subreddit name on any post to open its info card, then tap Follow or Unfollow
- **Block a subreddit** — Open its info card and tap **Block**. Blocked subreddits are hidden from your Popular feed
- **Block a user** — Tap a username on any post to open the user card, then tap **Block User**. Their posts will be hidden across all feeds
- Blocked subreddits and users are listed in the settings panel where you can remove them at any time

### Backup and restore

- **Export** — Saves your subreddits, blocked lists, starred posts, and theme preference to a `.json` file
- **Import** — Loads a previously exported file and merges it with your current data without overwriting anything

### Settings panel

Open the settings panel by tapping the **☰** menu button in the top-left corner. From there you can:

- Add or remove subreddits
- View storage usage and post counts per subreddit
- Toggle **Dark Mode**
- Enable **Auto-Refresh on Start** — automatically fetches new posts every time you open the app (requires internet)
- Enable **Refresh on Reload** — fetches new posts when you pull-to-refresh or reload the page
- Export / Import your data
- View the Activity Log showing recent sync events and storage operations

## Installing on your phone

1. Open the app in your phone's browser
2. Look for **Add to Home Screen** (Safari on iOS) or **Install App** (Chrome on Android)
3. Tap it to install
4. The app now works like a regular app, even fully offline

> Works best on Chrome, Firefox, or Edge. Safari on iOS is supported but persistent storage is limited by the browser.

## Storage and data

- The app stores up to approximately 4 MB of posts locally on your device
- Each refresh fetches up to 25 posts per subreddit
- Posts older than 30 days are automatically cleaned up
- Starred posts are exempt from automatic cleanup and are kept until you remove them manually
- If storage fills up, the oldest non-starred posts are removed automatically to make room
- All data stays on your device — nothing is sent to any server

## Updates

When a new version is available, an **Update Now** banner appears at the top of the screen. Tap it to apply the update. Your posts, subreddits, and settings are not affected by updates.

## Privacy

- Everything stays on your device
- No account needed
- No tracking, no ads
- Works completely offline once set up

---

## Important Disclaimer

**This app is NOT an official emergency information source.**

- Always follow official emergency alerts and instructions from local authorities
- This app shows community discussions from Reddit, not verified emergency information
- Do not rely on this app for critical safety decisions
- In emergencies, call your local emergency number (911, 112, etc.)
- Always check official government and emergency services for accurate information

**No Warranty**: This app is provided "as is" without any guarantees. We are not responsible for the accuracy of information shown, availability of the app during emergencies, any decisions made based on content from this app, or loss of data or functionality.

---

**Use responsibly. Always verify critical information with official sources.**

---

[GitHub](https://github.com/h2oforlife/enpwa)