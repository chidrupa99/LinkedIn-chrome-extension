# LinkedIn Repost Original Date

A tiny Chrome extension that does one thing: when a LinkedIn job card says **"Reposted X ago"**, it appends the **original posting date** next to it.

Example:

```
Reposted 2 hours ago · originally posted May 3, 2026
```

Nothing is hidden, dimmed, or filtered. Cards that don't say "Reposted" are left completely untouched.

## Install (developer mode)

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select this `linkedin-filter-extension/` folder
5. Visit `linkedin.com/jobs/...`

## How it works

For each reposted card visible on screen:

1. Reads the job ID from the card link (`/jobs/view/<id>`).
2. Fetches the public version of the detail page (`credentials: 'omit'`).
3. Parses the embedded `<script type="application/ld+json">` `JobPosting` schema and reads `datePosted` — this is the original posting date and doesn't change on repost.
4. Inserts ` · originally posted <date>` right after the existing "Reposted ..." text.

Results are cached per job ID for 24 hours so repeat scrolls are instant. Cards are processed lazily as they scroll into view.

## Files

- `manifest.json` — MV3 manifest
- `content.js` — the entire logic
- `styles.css` — small grey style for the appended date
