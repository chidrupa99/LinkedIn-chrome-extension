# LinkedIn Job Filter

A Chrome extension that makes LinkedIn job search a lot less repetitive. It surfaces the **real** posting date on reposted jobs, auto-dismisses listings from companies you don't want to see, and warns you when you're about to engage with a role you already canceled at a different location.

Works on both the classic job search and the new **AI-powered (beta) search**.

## What it does

### Surfaces the actual posting date
- Inline annotation next to LinkedIn's "Reposted X ago" text: `Reposted 5 days ago · originally posted 2 Weeks ago (18 May)`
- A "Posted N Days ago" pill below every card so you can spot stale repostings from the list view without clicking in
- Comfortable relative formatting: `Today`, `Yesterday`, `3 Days ago`, `1 Week ago`, `40 Days ago`, etc.

### Engagement tracking
Each card gets a small pill row below it showing the actions you've taken on that job:
- 👁 **Viewed** — when you opened the detail panel
- ✓ **Applied** — when you clicked Apply / Easy Apply
- ⚠️ **You dismissed this** — when you clicked the X

The data is stored in `chrome.storage.local` and persists across browser restarts so you can tell at a glance whether you've already considered (or rejected) a job before, even days later.

### Duplicate detection
For each card, the script checks every other job you've seen for the same `title + company` and shows one of:
- 📍 **Also at: Seattle, Remote, +2 more** — same role posted at other locations
- 🚫 **You canceled this for N other locations** — same role you've already dismissed elsewhere

The "you canceled this elsewhere" case is **auto-dismissed by default**: the script clicks LinkedIn's X for you so you don't waste time re-deciding on a role you already passed on. A small banner explains why.

### Customisable auto-dismiss list
Click the extension's toolbar icon to open the popup:
- Toggle the built-in rules (DataAnnotation, Dice) on or off
- Add any other company name you want to auto-hide
- The script clicks LinkedIn's native dismiss button for matching cards so they enter LinkedIn's normal faded "We won't show you this again" state
- An **"Apply filters now"** button lets you force a re-scan without refreshing the page

### Results count overlay
LinkedIn's "X results" header gets an inline overlay showing the post-filter count: `427 results · 25 visible`.

## Install (developer mode)

1. Clone or download this repo
2. Open `chrome://extensions/` in Chrome
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked**
5. Select this folder
6. Pin the extension to your toolbar
7. Open `linkedin.com/jobs` and scroll

## How it works

Data sources (in priority order):
1. **Voyager API** (`/voyager/api/jobs/jobPostings/<id>`) authenticated with your existing JSESSIONID cookie. Returns `listedAt` and `originalListedAt` timestamps directly.
2. **Public job-view page** (`/jobs/view/<id>` fetched without credentials) — parsed for the JSON-LD `JobPosting`'s `datePosted` field. Used as a fallback.

The script runs on every page under `linkedin.com/*` but no-ops unless the current path matches a job search route. It uses a `MutationObserver` + `IntersectionObserver` combo so cards are processed only as they scroll into view, plus periodic safety-net scans to catch anything LinkedIn re-renders.

All cached job dates (24h TTL) and engagement records are stored in `chrome.storage.local` — nothing leaves your browser.

### Beta search support
LinkedIn's new AI-powered search uses obfuscated/hashed CSS class names that change on every deploy. The extension matches those cards via structural selectors (`div[role="button"]` containing a "Dismiss … job" button) and synthesises a stable per-card key from `title + company + location` to keep engagement tracking and dedup working — even without LinkedIn's usual `data-job-id` attribute.

## Configuration

All settings live in `chrome.storage.local` and sync between the popup and the content script in real time:

| Key | Shape | Description |
|---|---|---|
| `autodismiss_rules` | `[{ id, companyName, enabled, builtIn }]` | The list shown in the popup |
| `engaged:<jobId>` | `{ title, company, location, viewedAt, appliedAt, dismissedAt, dismissedAuto }` | Per-job engagement record |
| `dupgroup:<key>` | `[{ jobId, location, at }]` | Title+company groups for dedup |
| `jd:<jobId>` | `{ datePosted, listedAt, originalListedAt, cachedAt }` | Voyager response cache (24h) |

## Files

- `manifest.json` — MV3 manifest, content script + action popup config
- `content.js` — all the runtime logic (~1900 lines)
- `styles.css` — banner, pill, panel, and faded-card styling
- `popup.html` / `popup.js` — toolbar popup UI for managing auto-dismiss rules

## Caveats

- **Reloading the extension orphans the content script** in any open LinkedIn tab — the old script will silently shut down but you'll need to refresh the tab to pick up the new code.
- **Auto-dismiss clicks LinkedIn's X**, which is a permanent signal on their side. Toggling a rule off won't bring already-dismissed cards back.
- **Beta cards have no real `jobId`**, so the date pill (which needs the Voyager API's numeric ID) won't appear on them. Engagement, dedup, and auto-dismiss still work via the synthetic key.

## License

MIT — see [LICENSE](LICENSE).
