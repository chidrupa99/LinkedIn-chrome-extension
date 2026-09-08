/*
 * LinkedIn Repost Original Date — content script v0.3
 *
 * Finds every "Reposted..." text anywhere on the page and appends the
 * original posted date right after it. Works on both the search-results
 * list and the right-side job detail panel.
 *
 * Date source priority:
 *   1. Voyager API (/voyager/api/jobs/jobPostings/<id>) using JSESSIONID
 *      CSRF token. Reads originalListedAt (preferred), then listedAt.
 *   2. Public job-view HTML (datePosted) as a fallback.
 *
 * Re-scans:
 *   - On DOM mutations (MutationObserver)
 *   - On URL changes (LinkedIn is a SPA)
 *
 * Logs to console prefixed with [LJF] so you can confirm it's running.
 */
(() => {
  const PREFIX = '[LJF]';
  const log  = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
  log('content script loaded', location.href);

  const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
  // Bump whenever the cached `jd:<jobId>` record shape changes. Old entries
  // (without this version, or with a lower one) get treated as a cache miss
  // and re-fetched from Voyager. v2: added `applies` / `views` fields.
  const CACHE_VERSION = 2;
  const ANNOTATION_CLASS = 'ljf-orig-date';
  // Calendar-day age at which a job is flagged with a "Skip" pill. Uses the
  // ORIGINAL posting timestamp (originalListedAt) so a fresh repost of a
  // months-old listing still trips the pill.
  const STALE_DAYS_THRESHOLD = 30;

  const memCache = new Map();
  const inflight = new Map();

  // ---------- Context-invalidation guard ----------
  // When the extension is reloaded while a LinkedIn tab is open, this
  // content script becomes "orphaned" — chrome.* APIs throw
  // "Extension context invalidated." Shut down cleanly so we don't spam
  // errors from the setInterval/MutationObserver until the tab refreshes.
  let alive = true;
  const teardownFns = [];
  function registerTeardown(fn) { teardownFns.push(fn); }
  function shutdown(reason) {
    if (!alive) return;
    alive = false;
    try { log('shutting down:', reason); } catch (_) {}
    for (const fn of teardownFns) { try { fn(); } catch (_) {} }
  }
  function isContextError(e) {
    const msg = (e && (e.message || e)) || '';
    return /Extension context invalidated/i.test(String(msg));
  }
  function safeStorageGet(keys) {
    if (!alive) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (out) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            if (isContextError(err)) shutdown('storage.get lastError');
            return resolve({});
          }
          resolve(out || {});
        });
      } catch (e) {
        if (isContextError(e)) shutdown('storage.get throw');
        resolve({});
      }
    });
  }
  function safeStorageSet(obj) {
    if (!alive) return;
    try {
      chrome.storage.local.set(obj, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err && isContextError(err)) shutdown('storage.set lastError');
      });
    } catch (e) {
      if (isContextError(e)) shutdown('storage.set throw');
    }
  }
  function safeStorageRemove(keys) {
    if (!alive) return;
    try {
      chrome.storage.local.remove(keys, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err && isContextError(err)) shutdown('storage.remove lastError');
      });
    } catch (e) {
      if (isContextError(e)) shutdown('storage.remove throw');
    }
  }

  // ---------- Engagement tracking (dismiss / undo) ----------
  const ENGAGED_KEY = (jobId) => `engaged:${jobId}`;
  const BANNER_CLASS = 'ljf-engaged-banner';
  const BANNER_CLEAR_CLASS = 'ljf-engaged-banner-clear';

  // Note: avoid bare `[data-job-id]` — LinkedIn puts that attribute on outer
  // wrappers and ancestors too, which leads to multiple nested matches per job.
  //
  // The last entry is for LinkedIn's "AI-powered search" beta, where the cards
  // use obfuscated hashed CSS class names that change every deploy. The only
  // stable structural feature is: a clickable div containing a "Dismiss …
  // job" button. We match on that.
  const CARD_SELECTOR = [
    'li.jobs-search-results__list-item',
    'li.scaffold-layout__list-item',
    'div.job-card-container',
    'div.jobs-search-results-list__list-item',
    'div.job-card-job-posting-card-wrapper',
    'li[data-occludable-job-id]',
    'div[data-occludable-job-id]',
    'div[role="button"][tabindex="0"]:has(> div button[aria-label^="Dismiss" i][aria-label$="job" i])',
  ].join(',');

  const DETAIL_SELECTOR = [
    '.jobs-unified-top-card',
    '.job-details-jobs-unified-top-card__container--two-pane',
    '.jobs-details',
    '.jobs-search__job-details',
    '.job-view-layout',
  ].join(',');

  // From a list of overlapping matches, keep only those that don't contain
  // any other match (i.e. the leaf-most elements).
  function pickInnermostMatches(matches) {
    return matches.filter((el) =>
      !matches.some((other) => other !== el && el.contains(other))
    );
  }

  // Walk up from a card element to the outermost ancestor that is a direct
  // child of the list root. On the classic layout the card IS the direct
  // child, so this returns the card unchanged. On the AI-powered "beta"
  // layout each card sits inside one or more `display: contents` wrappers,
  // and the outermost wrapper is the actual list row — that's where sibling
  // banners/panels need to attach for the layout to include them.
  function getCardOuter(card) {
    const root = findListRoot();
    if (!root || !root.contains(card)) return card;
    let outer = card;
    while (outer.parentElement && outer.parentElement !== root) {
      outer = outer.parentElement;
    }
    return outer;
  }

  function extractJobIdFromContainer(el) {
    if (!el) return null;
    for (const attr of ['data-job-id', 'data-occludable-job-id']) {
      const direct = el.getAttribute && el.getAttribute(attr);
      if (direct && /^\d+$/.test(direct)) return direct;
      const sub = el.querySelector && el.querySelector(`[${attr}]`);
      if (sub) {
        const id = sub.getAttribute(attr);
        if (id && /^\d+$/.test(id)) return id;
      }
    }
    const link = el.querySelector && el.querySelector('a[href*="/jobs/view/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    // AI-powered search: the numeric jobId is embedded in a componentkey
    // attribute on the card itself (e.g. "job-card-component-ref-4443025780").
    // This is the real jobId — hitting it means Voyager can fetch the posted
    // date, applicant count, and original-repost timestamps just like the
    // classic layout.
    const compKey = (el.getAttribute && el.getAttribute('componentkey'))
      || el.querySelector?.('[componentkey^="job-card-component-ref-"]')?.getAttribute('componentkey');
    if (compKey) {
      const m = compKey.match(/job-card-component-ref-(\d+)/);
      if (m) return m[1];
    }
    // Beta search fallback: hashed classes, no data-job-id, no /jobs/view/ link.
    // Synthesize a stable key from title + company + location so engagement
    // tracking, dedup, and the auto-dismiss banner all still work.
    // Prefixed with `beta:` so getJobInfo can skip the Voyager fetch.
    const meta = extractCardMeta(el);
    if (meta.title && meta.company) {
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      return `beta:${norm(meta.title)}:${norm(meta.company)}:${norm(meta.location || '')}`;
    }
    return null;
  }

  function currentJobIdFromUrl() {
    const params = new URLSearchParams(location.search);
    for (const k of ['currentJobId', 'jobId']) {
      const v = params.get(k);
      if (v && /^\d+$/.test(v)) return v;
    }
    return null;
  }

  // In-memory mirror of `engaged:<jobId>` for synchronous lookups during
  // per-card rendering (especially for cross-referencing duplicates against
  // dismissed siblings without async storage hops per pill).
  const engagedCache = new Map();

  async function getEngaged(jobId) {
    if (engagedCache.has(jobId)) return engagedCache.get(jobId);
    const out = await safeStorageGet([ENGAGED_KEY(jobId)]);
    const v = out[ENGAGED_KEY(jobId)] || null;
    if (v) engagedCache.set(jobId, v);
    return v;
  }

  // Record an engagement event. Supports multiple event types per job —
  // each call updates the corresponding `<type>At` timestamp without
  // clobbering the others. Known types: 'viewed' | 'applied' | 'dismissed'
  // | 'autoHidden'. `extras` is an optional bag of scalars merged into the
  // stored record (e.g. { autoHiddenRule: 'DataAnnotation' }).
  //
  // Each call also fires postEngagement — the outbound sheet sync — so the
  // sheet ends up with one row per engagement moment (a view of the same
  // job three times = three rows), which is what makes it useful as an
  // input to future "make the extension smarter" heuristics.
  async function recordEngaged(jobId, type, meta, extras) {
    if (!jobId || !type) return;
    const out = await safeStorageGet([ENGAGED_KEY(jobId)]);
    const existing = out[ENGAGED_KEY(jobId)] || {};
    const now = Date.now();
    const updated = {
      ...existing,
      title:    (meta && meta.title)    || existing.title,
      company:  (meta && meta.company)  || existing.company,
      location: (meta && meta.location) || existing.location,
      [`${type}At`]: now,
      ...(extras || {}),
    };
    engagedCache.set(jobId, updated);
    safeStorageSet({ [ENGAGED_KEY(jobId)]: updated });
    log('recorded', type, 'for', jobId);
    postEngagement({
      timestamp: new Date(now).toISOString(),
      action: type,
      jobId,
      title: updated.title || '',
      company: updated.company || '',
      location: updated.location || '',
      url: location.href,
      ...(extras || {}),
    });
  }

  function clearEngaged(jobId) {
    if (!jobId) return;
    engagedCache.delete(jobId);
    safeStorageRemove([ENGAGED_KEY(jobId)]);
    log('cleared engagement', jobId);
  }

  // Clear a single event type while preserving the others.
  async function clearEngagedType(jobId, type) {
    if (!jobId || !type) return;
    const out = await safeStorageGet([ENGAGED_KEY(jobId)]);
    const existing = out[ENGAGED_KEY(jobId)];
    if (!existing) return;
    delete existing[`${type}At`];
    const remaining = ['viewedAt', 'appliedAt', 'dismissedAt'].some(k => existing[k]);
    if (!remaining) {
      clearEngaged(jobId);
    } else {
      engagedCache.set(jobId, existing);
      safeStorageSet({ [ENGAGED_KEY(jobId)]: existing });
    }
  }

  // Bulk-load all engagement records into the in-memory cache on startup.
  // Also migrates v0.3-style records ({type, at}) into the v0.4 multi-event
  // schema ({dismissedAt, viewedAt, appliedAt}) in-place. This is how we
  // recover dismissals made before the schema change without losing history.
  async function loadEngagedCache() {
    const all = await safeStorageGet(null);
    let loaded = 0, migrated = 0;
    const updates = {};
    for (const [k, v] of Object.entries(all || {})) {
      if (!k.startsWith('engaged:')) continue;
      let record = v || {};
      const hasNewSchema = record.dismissedAt || record.viewedAt || record.appliedAt;
      if (!hasNewSchema && record.type && record.at) {
        // Old v0.3 record — migrate
        record = {
          title: record.title,
          company: record.company,
          location: record.location,
          [`${record.type}At`]: record.at,
        };
        updates[k] = record;
        migrated++;
      }
      engagedCache.set(k.slice('engaged:'.length), record);
      loaded++;
    }
    if (migrated > 0) {
      // Write migrations back in one batch
      try {
        await new Promise((resolve) => {
          chrome.storage.local.set(updates, () => {
            if (chrome.runtime?.lastError) warn('migration write error', chrome.runtime.lastError);
            resolve();
          });
        });
      } catch (e) { warn('migration write threw', e); }
      log('migrated', migrated, 'engagement records from v0.3 schema');
    }
    log('loaded', loaded, 'engagement records');
  }

  // ---------- Card metadata extraction & helpers ----------
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function dupKey(title, company) {
    const t = normalize(title);
    const c = normalize(company);
    if (!t || !c) return null;
    return `${t}|${c}`;
  }

  // Comfortable relative-day format:
  //   0 → Today
  //   1 → Yesterday
  //   2-6 → "N Days ago"
  //   7-34 → "N Week(s) ago"   (floor division: 7-13 = 1 week, 14-20 = 2 weeks, etc.)
  //   35-364 → "N Days ago"
  //   365+ → "N Year(s) ago"
  function formatRelativeDays(daysAgo) {
    if (daysAgo <= 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo < 7) return `${daysAgo} Days ago`;
    if (daysAgo < 35) {
      const weeks = Math.floor(daysAgo / 7);
      return `${weeks} Week${weeks === 1 ? '' : 's'} ago`;
    }
    if (daysAgo < 365) return `${daysAgo} Days ago`;
    const years = Math.floor(daysAgo / 365);
    return `${years} Year${years === 1 ? '' : 's'} ago`;
  }

  // Calendar-day diff in local time. Stable across times-of-day.
  function calendarDaysAgo(ts) {
    const d = new Date(ts);
    const then = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - then) / 86400000);
  }

  // For viewed/applied: keep minute/hour precision under a day, then route
  // through the calendar-day format above for everything older.
  function formatRelative(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(diff / 3600000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    if (hrs < 24)  return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
    return formatRelativeDays(calendarDaysAgo(ts));
  }

  // ---------- Auto-dismiss rules (loaded from chrome.storage) ----------
  // Stored as: autodismiss_rules → [{ id, companyName, enabled, builtIn }]
  // Compiled into runtime patterns by compileAutoDismissRule below.
  let AUTO_DISMISS_RULES = [];

  const DEFAULT_AUTO_DISMISS_RULES = [
    { id: 'data-annotation', companyName: 'DataAnnotation', enabled: true, builtIn: true },
    { id: 'dice',            companyName: 'Dice',            enabled: true, builtIn: true },
  ];

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Compile a user-facing rule { companyName } into the runtime shape used by
  // checkAutoDismiss.
  //   - companyPatterns: anchored at start (for the extracted company field)
  //   - loosePatterns:   word-boundary, anywhere (for alt/aria/href/slug)
  //   - textPatterns:    full-card textContent scan (only safe for CamelCase
  //                      brands where the literal string can't false-positive)
  //   - slugCandidates:  url-slug variants (for matching /company/<slug>)
  function compileAutoDismissRule(rule) {
    const name = (rule.companyName || '').trim();
    if (!name) return null;
    const escaped = escapeRegex(name).replace(/[\s-]+/g, '[\\s-]*');
    const isDistinctBrand = /[a-z][A-Z]/.test(name) && !/\s/.test(name);
    const lower = name.toLowerCase();
    const slugCandidates = new Set([
      lower.replace(/\s+/g, ''),       // "dataannotation"
      lower.replace(/\s+/g, '-'),      // "data-annotation"
      lower.replace(/\s+/g, '_'),      // "data_annotation"
    ]);
    return {
      name: rule.id || lower.replace(/\s+/g, '-'),
      label: name,
      companyPatterns: [new RegExp('^' + escaped + '(?:\\b|$)', 'i')],
      loosePatterns:   [new RegExp('\\b' + escaped + '\\b', 'i')],
      textPatterns:    isDistinctBrand ? [new RegExp('\\b' + escaped + '\\b')] : [],
      slugCandidates,
    };
  }

  async function loadAutoDismissRules() {
    const out = await safeStorageGet([STORAGE_AUTO_DISMISS]);
    let stored = out[STORAGE_AUTO_DISMISS];
    if (!stored || !Array.isArray(stored) || stored.length === 0) {
      stored = DEFAULT_AUTO_DISMISS_RULES.slice();
      safeStorageSet({ [STORAGE_AUTO_DISMISS]: stored });
    }
    AUTO_DISMISS_RULES = stored
      .filter((r) => r && r.enabled !== false)
      .map(compileAutoDismissRule)
      .filter(Boolean);
    log('loaded', AUTO_DISMISS_RULES.length, 'auto-dismiss rules:',
        AUTO_DISMISS_RULES.map((r) => r.label).join(', '));
  }

  const STORAGE_AUTO_DISMISS = 'autodismiss_rules';
  const STORAGE_FILTER_SETTINGS = 'filter_settings';
  const STORAGE_SHEETS_SYNC = 'sheets_sync';

  // Google Sheets sync — writes each engagement event to a user-supplied
  // Apps Script web-app URL. Empty webhookUrl / enabled=false is a no-op.
  let SHEETS_SYNC = { enabled: false, webhookUrl: '' };

  async function loadSheetsSync() {
    const out = await safeStorageGet([STORAGE_SHEETS_SYNC]);
    SHEETS_SYNC = { ...SHEETS_SYNC, ...(out[STORAGE_SHEETS_SYNC] || {}) };
  }

  // Fire-and-forget POST to the Apps Script webhook. Uses `mode: 'no-cors'`
  // and JSON body — Apps Script's doPost reads e.postData.contents. Errors
  // are swallowed on purpose: sync must never break job browsing.
  function postEngagement(event) {
    if (!SHEETS_SYNC.enabled || !SHEETS_SYNC.webhookUrl) return;
    try {
      fetch(SHEETS_SYNC.webhookUrl, {
        method: 'POST',
        // 'text/plain' avoids a CORS preflight (Apps Script doesn't
        // implement OPTIONS), so the request goes through directly.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(event),
        // credentials omitted — we don't want to attach LinkedIn cookies
        credentials: 'omit',
      }).catch(() => { /* fire-and-forget */ });
    } catch (_) { /* fire-and-forget */ }
  }

  // Live filter settings (toggled from the popup). Apply to cards based on
  // their duplicate-detection panelVariant.
  let FILTER_SETTINGS = {
    hideDupCancelled:  false,
    hideDupLoc:        false,
    sortByListedDate:  false,
  };

  async function loadFilterSettings() {
    const out = await safeStorageGet([STORAGE_FILTER_SETTINGS]);
    FILTER_SETTINGS = { ...FILTER_SETTINGS, ...(out[STORAGE_FILTER_SETTINGS] || {}) };
    log('filter settings:', FILTER_SETTINGS);
  }

  // React to changes made via the popup — reload rules/settings and re-scan
  // so cards that no longer match get unhidden, and newly-matching ones get
  // hidden.
  // Full reset + re-scan. Used by the storage listener and the popup's
  // "Apply filters" button. More aggressive than just clearing hidden
  // state — also drops every meta panel and unsets the observer flag so
  // each card gets re-evaluated from scratch under the new rules/filters.
  function reapplyAllFilters() {
    return Promise.all([loadAutoDismissRules(), loadFilterSettings()]).then(() => {
      // Un-hide both the card and its outer wrapper — applyAutoDismiss may
      // have marked either or both, depending on layout.
      document.querySelectorAll('.ljf-auto-hidden').forEach((el) => {
        el.classList.remove('ljf-auto-hidden');
        el.removeAttribute('data-ljf-auto-rule');
        el.style.removeProperty('display');
      });
      document.querySelectorAll('[data-ljf-card-observed]').forEach((el) => {
        delete el.dataset.ljfCardObserved;
        delete el.dataset.ljfAutoDismissed;
      });
      document.querySelectorAll('.' + META_CLASS).forEach((el) => el.remove());
      scheduleScan();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Sheets-sync settings change independently of the filter pipeline —
    // just refresh the in-memory copy, no re-scan needed.
    if (changes[STORAGE_SHEETS_SYNC]) loadSheetsSync();
    if (!changes[STORAGE_AUTO_DISMISS] && !changes[STORAGE_FILTER_SETTINGS]) return;
    reapplyAllFilters();
  });

  // Manual trigger from the popup's "Apply filters" button.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'apply-filters') return false;
    reapplyAllFilters().then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for async sendResponse
  });

  function checkAutoDismiss(cardMeta, card) {
    // 1. Structured company field (extracted by extractCardMeta)
    const company = (cardMeta.company || '').trim();
    if (company) {
      for (const rule of AUTO_DISMISS_RULES) {
        if (rule.companyPatterns?.some((re) => re.test(company))) {
          log('autoDismiss MATCH (company):', rule.label, '←', JSON.stringify(company));
          return rule;
        }
      }
    }

    if (!card) return null;

    // 2. Any image alt attribute inside the card (logo, brand mark, etc.).
    //    Strip a trailing "logo" suffix common in LinkedIn alt text.
    const images = card.querySelectorAll('img[alt]');
    for (const img of images) {
      const alt = (img.getAttribute('alt') || '').replace(/\s+logo$/i, '').trim();
      if (!alt || /^(logo|company logo|company|premium|verified)$/i.test(alt)) continue;
      for (const rule of AUTO_DISMISS_RULES) {
        if (rule.companyPatterns?.some((re) => re.test(alt))
            || rule.loosePatterns?.some((re) => re.test(alt))) {
          log('autoDismiss MATCH (img alt):', rule.label, '←', JSON.stringify(alt));
          return rule;
        }
      }
    }

    // 3. /company/<slug> link href — slugified company name in URL.
    const companyLink = card.querySelector('a[href*="/company/"]');
    if (companyLink) {
      const href = companyLink.getAttribute('href') || '';
      const m = href.match(/\/company\/([^/?#]+)/);
      if (m) {
        const slug = decodeURIComponent(m[1]).toLowerCase();
        const normalized = slug.replace(/[-_]/g, '');
        for (const rule of AUTO_DISMISS_RULES) {
          if (!rule.slugCandidates) continue;
          for (const cand of rule.slugCandidates) {
            if (slug === cand || normalized === cand.replace(/[-_]/g, '')) {
              log('autoDismiss MATCH (company slug):', rule.label, '←', slug);
              return rule;
            }
          }
        }
      }
    }

    // 4. Any aria-label inside the card (dismiss button often reads
    //    "Dismiss job, <title> at <company>" — contains the company name
    //    even when the visible text is collapsed).
    const ariaEls = card.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (!aria || aria.length > 300) continue;
      for (const rule of AUTO_DISMISS_RULES) {
        if (rule.loosePatterns?.some((re) => re.test(aria))) {
          log('autoDismiss MATCH (aria-label):', rule.label, '←', JSON.stringify(aria));
          return rule;
        }
      }
    }

    // 5. Full-card textContent (includes CSS-hidden text). Only safe rules
    //    with textPatterns (CamelCase brand names) run here.
    const text = (card.textContent || '').slice(0, 800);
    for (const rule of AUTO_DISMISS_RULES) {
      if (rule.textPatterns?.some((re) => re.test(text))) {
        log('autoDismiss MATCH (text):', rule.label);
        return rule;
      }
    }

    if (!company) {
      log('autoDismiss: no match. cardMeta=', JSON.stringify(cardMeta));
    }
    return null;
  }

  function extractCardMeta(el) {
    if (!el) return { title: '', company: '', location: '' };

    // Title — try structured selectors
    const titleEl = el.querySelector([
      '.job-card-list__title',
      '.job-card-list__title--link',
      '.job-card-container__link',
      '.job-card-job-posting-card-wrapper__title',
      '.jobs-unified-top-card__job-title',
      'a[href*="/jobs/view/"]',
    ].join(','));
    let title = (titleEl?.innerText || titleEl?.getAttribute('aria-label') || '').trim();

    // Company — try the structured selectors first, then the company-link
    // fallback (LinkedIn always renders a /company/<slug> link adjacent to the
    // company name in the card).
    let company = '';
    const companyEl = el.querySelector([
      '.job-card-container__primary-description',
      '.job-card-container__company-name',
      '.job-card-list__company-name',
      '.artdeco-entity-lockup__subtitle',
      '.job-card-job-posting-card-wrapper__entity-lockup .artdeco-entity-lockup__subtitle',
      '.jobs-unified-top-card__company-name',
    ].join(','));
    if (companyEl) company = (companyEl.innerText || companyEl.textContent || '').trim();
    if (!company) {
      const companyLink = el.querySelector('a[href*="/company/"]');
      if (companyLink) company = (companyLink.innerText || companyLink.textContent || companyLink.getAttribute('aria-label') || '').trim();
    }
    if (!company) {
      // Logo's alt attribute is usually the company name, even when LinkedIn
      // hides the company text in collapsed / dismissed card states.
      const logo = el.querySelector('img[alt]');
      const alt = (logo?.getAttribute('alt') || '').replace(/\s+logo$/i, '').trim();
      if (alt && !/^(logo|company|premium|verified)$/i.test(alt)) company = alt;
    }

    // Location
    const locEl = el.querySelector([
      '.job-card-container__metadata-item',
      '.job-card-container__metadata-wrapper',
      '.artdeco-entity-lockup__caption',
      '.jobs-unified-top-card__bullet',
      '.job-card-job-posting-card-wrapper__metadata-item',
    ].join(','));
    let location = (locEl?.innerText || '').trim();

    // Beta-search title fallback: the dismiss button's aria-label is
    // structured as "Dismiss <title> job" and survives every redesign.
    if (!title) {
      const dismissBtn = el.querySelector('button[aria-label^="Dismiss" i][aria-label$="job" i]');
      if (dismissBtn) {
        const aria = dismissBtn.getAttribute('aria-label') || '';
        const m = aria.match(/^Dismiss\s+(.+?)\s+job$/i);
        if (m) title = m[1].trim();
      }
    }

    // Last-resort fallback: line-based parsing of the card's text content.
    // LinkedIn cards typically render as: Title \n Company \n Location \n ...
    // On the beta layout the title is emitted twice (visible link + accessible
    // label), and may carry a "(Verified job)" suffix on one copy — collapse
    // adjacent duplicates and normalize before slotting into fields.
    if (!company || !title) {
      const stripSuffix = (s) => s.replace(/\s*\((?:Verified job|Promoted|Reposted)\)\s*$/i, '').trim();
      const raw = (el.innerText || '')
        .split('\n')
        .map((l) => stripSuffix(l.trim()))
        .filter((l) => l && !/^(viewed|easy apply|promoted|be an early applicant|in your network|new|posted .+ ago|\d+\s+(connection|connections)\s+work\s+here|actively reviewing applicants|\d+\s+hours?\s+ago|\d+\s+days?\s+ago|\d+\s+weeks?\s+ago|reposted .+ ago|·)$/i.test(l));
      const lines = [];
      for (const l of raw) {
        if (lines.length && lines[lines.length - 1].toLowerCase() === l.toLowerCase()) continue;
        lines.push(l);
      }
      if (!title    && lines[0]) title    = lines[0];
      if (!company  && lines[1]) company  = lines[1];
      if (!location && lines[2]) location = lines[2];
    }

    // Strip trailing junk like " · 2,345 followers" and "(Verified job)"
    title = title.replace(/\s*\((?:Verified job|Promoted|Reposted)\)\s*$/i, '').trim();
    company = company.split(/\s+·\s+|\n/)[0].trim();

    return { title, company, location };
  }

  // ---------- Duplicate detection ----------
  // dupGroups: Map<dupKey, [{ jobId, location, at }]>
  // Persisted to chrome.storage.local under `dupgroup:<key>` keys.
  const DUPGROUP_PREFIX = 'dupgroup:';
  const dupGroups = new Map();

  async function loadDupGroups() {
    const all = await safeStorageGet(null);
    let n = 0;
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith(DUPGROUP_PREFIX)) {
        dupGroups.set(k.slice(DUPGROUP_PREFIX.length), v);
        n++;
      }
    }
    log('loaded', n, 'dup groups');
  }

  function recordDup(title, company, jobId, location) {
    const key = dupKey(title, company);
    if (!key) return;
    const existing = dupGroups.get(key) || [];
    const found = existing.find((e) => e.jobId === jobId);
    if (found) {
      if (location && found.location !== location) {
        found.location = location;
        safeStorageSet({ [DUPGROUP_PREFIX + key]: existing });
      }
      return;
    }
    existing.push({ jobId, location: location || '', at: Date.now() });
    dupGroups.set(key, existing);
    safeStorageSet({ [DUPGROUP_PREFIX + key]: existing });
  }

  function getDupSiblings(title, company, jobId) {
    const key = dupKey(title, company);
    if (!key) return [];
    const all = dupGroups.get(key) || [];
    return all.filter((e) => e.jobId !== jobId);
  }

  function buildBanner(jobId, info) {
    const banner = document.createElement('div');
    banner.className = BANNER_CLASS;
    const at = info.dismissedAt || info.at; // back-compat with v0.3 records
    const daysAgo = calendarDaysAgo(at);
    // Lowercased so it reads naturally inline ("...dismissed this 3 days ago")
    const ago = formatRelativeDays(daysAgo).toLowerCase();
    const text = document.createElement('span');
    text.textContent = `⚠️ You dismissed this ${ago}`;
    banner.appendChild(text);
    const clearBtn = document.createElement('button');
    clearBtn.className = BANNER_CLEAR_CLASS;
    clearBtn.type = 'button';
    clearBtn.textContent = '×';
    clearBtn.title = 'Clear this marker';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Only clear the dismissed marker — preserve viewed / applied history.
      clearEngagedType(jobId, 'dismissed');
      banner.remove();
    });
    banner.appendChild(clearBtn);
    return banner;
  }

  /**
   * Insert (or reposition) a banner for the given job.
   *  - For list cards: banner is inserted AFTER the card as a sibling, so it
   *    sits below the card and takes the column's full width without fighting
   *    the card's internal flex layout.
   *  - For the detail panel: banner is inserted at the top of the panel.
   * Idempotent: if the banner is already in the correct location, does nothing.
   */
  async function ensureBanner(container, jobId, isDetail) {
    if (!jobId || !container) return;
    const key = `${jobId}:${isDetail ? 'detail' : 'card'}`;
    const selector = `.${BANNER_CLASS}[data-ljf-key="${CSS.escape(key)}"]`;
    const existing = document.querySelector(selector);
    // For list cards on the beta layout the card is wrapped in one or more
    // display:contents divs. Anchor sibling insertion to the outermost
    // wrapper so the banner participates in the list's grid layout.
    const anchor = isDetail ? container : getCardOuter(container);
    const expectedParent = isDetail ? container : anchor.parentElement;
    if (!expectedParent) return;

    if (existing) {
      const inRightPlace = isDetail
        ? existing.parentElement === expectedParent && existing === expectedParent.firstChild
        : existing.parentElement === expectedParent && existing.previousElementSibling === anchor;
      if (inRightPlace) return;
      existing.remove();
    }

    const info = await getEngaged(jobId);
    // Only show the prominent banner if the user actually dismissed this job
    // (not for plain views or applies — those show as pills in the meta panel).
    if (!info || !info.dismissedAt) return;

    const banner = buildBanner(jobId, info);
    banner.setAttribute('data-ljf-key', key);
    banner.setAttribute('data-ljf-jobid', jobId);
    banner.classList.add(isDetail ? 'ljf-banner-detail' : 'ljf-banner-card');

    if (isDetail) {
      expectedParent.insertBefore(banner, expectedParent.firstChild);
    } else {
      expectedParent.insertBefore(banner, anchor.nextSibling);
    }
  }

  function scanForEngaged() {
    // Desired state: key -> { container, jobId, isDetail }
    const desired = new Map();

    // List cards: pick the innermost match per job ID
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const innerCards = pickInnermostMatches(cards);
    const seenJobIds = new Set();
    for (const card of innerCards) {
      // Skip auto-hidden cards: they're still in the DOM (display:none) but
      // we don't want to render a banner/panel for them — those would float
      // visibly between adjacent cards with no card to point to.
      if (card.classList?.contains('ljf-auto-hidden')) continue;
      const jobId = extractJobIdFromContainer(card);
      if (!jobId || seenJobIds.has(jobId)) continue;
      seenJobIds.add(jobId);
      desired.set(`${jobId}:card`, { container: card, jobId, isDetail: false });
      // Lazy-fetch original posted date for this card
      if (!card.dataset.ljfCardObserved) {
        card.dataset.ljfCardObserved = '1';
        cardObserver.observe(card);
      }
      // Belt-and-suspenders: if the card is in (or near) the viewport AND
      // has no meta panel yet, render it directly. IntersectionObserver
      // sometimes misses cards during LinkedIn's React hydration.
      const hasPanel = !!document.querySelector(
        `.${META_CLASS}[data-ljf-jobid="${CSS.escape(jobId)}"]`
      );
      if (!hasPanel) {
        const rect = card.getBoundingClientRect();
        const inView = rect.bottom > -300 && rect.top < (window.innerHeight + 300);
        if (inView) renderCardMeta(card);
      }
    }

    // Detail panel: pick the innermost match overall
    const detailMatches = Array.from(document.querySelectorAll(DETAIL_SELECTOR));
    const innerDetails = pickInnermostMatches(detailMatches);
    const detailJobId = currentJobIdFromUrl();
    if (detailJobId && innerDetails.length) {
      desired.set(`${detailJobId}:detail`, { container: innerDetails[0], jobId: detailJobId, isDetail: true });
    }

    // Remove banners whose key is no longer desired
    document.querySelectorAll('.' + BANNER_CLASS).forEach((banner) => {
      const key = banner.getAttribute('data-ljf-key');
      if (!key || !desired.has(key)) banner.remove();
    });

    // Reconcile: ensure each desired banner exists in the right place
    for (const { container, jobId, isDetail } of desired.values()) {
      ensureBanner(container, jobId, isDetail);
    }

    // Clean up orphaned card-date annotations
    cleanupCardDateAnnotations();
  }

  // Delegated click listener for dismiss / undo / apply buttons.
  // We only OBSERVE clicks — LinkedIn's own handler runs unchanged, so its
  // native "grey overlay + Undo" state on dismiss is what the user sees.
  // Our job is just to record engagement so pills and dedup history work.
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (!label) return;

    let container = btn.closest(CARD_SELECTOR);
    let jobId = container ? extractJobIdFromContainer(container) : null;
    if (!container || !jobId) {
      container = btn.closest(DETAIL_SELECTOR);
      if (container) jobId = currentJobIdFromUrl();
    }
    if (!jobId || !container) return;

    const meta = extractCardMeta(container);

    if (/\b(dismiss|hide|not interested)\b/.test(label)) {
      recordEngaged(jobId, 'dismissed', meta);
    } else if (/\bundo\b/.test(label)) {
      // LinkedIn's undo only fires when the user just dismissed — clear that
      // event but keep any viewed/applied history.
      clearEngagedType(jobId, 'dismissed');
      container.querySelectorAll('.' + BANNER_CLASS).forEach((b) => b.remove());
    } else if (/^(easy apply|apply)\b/.test(label) || /\bapply on company website\b/.test(label)) {
      recordEngaged(jobId, 'applied', meta);
    }
  }, true);

  // ---------- CSRF token (from JSESSIONID cookie) ----------
  function getCsrfToken() {
    const m = document.cookie.match(/JSESSIONID=([^;]+)/);
    return m ? m[1].replace(/"/g, '') : null;
  }

  // ---------- Cache ----------
  async function cacheGet(jobId) {
    if (memCache.has(jobId)) {
      const m = memCache.get(jobId);
      if (m && m.version === CACHE_VERSION) return m;
      memCache.delete(jobId); // stale shape; force re-fetch
    }
    const key = `jd:${jobId}`;
    const out = await safeStorageGet([key]);
    const v = out[key] || null;
    if (!v) return null;
    if (v.version !== CACHE_VERSION) {
      log('cache miss (stale schema):', jobId, 'had version', v.version);
      return null; // outdated shape — let getJobInfo re-fetch
    }
    memCache.set(jobId, v);
    return v;
  }
  function cacheSet(jobId, value) {
    const stored = { ...value, version: CACHE_VERSION, cachedAt: Date.now() };
    memCache.set(jobId, stored);
    safeStorageSet({ [`jd:${jobId}`]: stored });
    return stored;
  }

  // ---------- Voyager API (primary) ----------
  async function fetchViaVoyager(jobId) {
    const csrf = getCsrfToken();
    if (!csrf) { warn('no JSESSIONID cookie — are you logged in?'); return null; }
    try {
      const res = await fetch(
        `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`,
        {
          credentials: 'include',
          headers: {
            'csrf-token': csrf,
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'x-li-lang': 'en_US',
            'x-restli-protocol-version': '2.0.0',
          },
        }
      );
      if (!res.ok) { warn('voyager HTTP', res.status, 'for', jobId); return null; }
      const data = await res.json();

      // Walk the response for the fields we care about.
      //  - originalListedAt / listedAt: posting timestamps
      //  - applies / numberOfApplicants / applicantCount: applicant count
      //    (different shapes appear in different decorations)
      //  - views:                       impression count (less useful but cheap)
      let originalListedAt = null;
      let listedAt = null;
      let applies = null;
      let views = null;
      const APPLY_KEYS = ['applies', 'numberOfApplicants', 'applicantCount', 'numApplies'];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node.originalListedAt === 'number' && !originalListedAt) {
          originalListedAt = node.originalListedAt;
        }
        if (typeof node.listedAt === 'number' && !listedAt) {
          listedAt = node.listedAt;
        }
        for (const k of APPLY_KEYS) {
          if (typeof node[k] === 'number' && (applies === null || node[k] > applies)) {
            applies = node[k];
          }
        }
        if (typeof node.views === 'number' && views === null) {
          views = node.views;
        }
        for (const k of Object.keys(node)) walk(node[k]);
      })(data);

      const ts = originalListedAt || listedAt;
      log('voyager', jobId, { originalListedAt, listedAt, applies, views });
      return {
        originalListedAt,
        listedAt,
        applies,
        views,
        datePosted: ts ? new Date(ts).toISOString() : null,
      };
    } catch (e) {
      warn('voyager error', e);
      return null;
    }
  }

  // ---------- Public HTML JSON-LD (fallback) ----------
  async function fetchViaPublic(jobId) {
    try {
      const res = await fetch(`https://www.linkedin.com/jobs/view/${jobId}`, {
        credentials: 'omit',
      });
      const html = await res.text();
      const m = html.match(/"datePosted"\s*:\s*"([^"]+)"/);
      if (m) {
        log('public datePosted', jobId, m[1]);
        return m[1];
      }
    } catch (e) {
      warn('public error', e);
    }
    return null;
  }

  async function getJobInfo(jobId) {
    // Beta search cards don't expose a real numeric jobId; we synthesize
    // `beta:<title>:<company>:<location>`. Voyager won't accept those, so
    // skip the fetch and return an empty record (date pill won't show, but
    // engagement / dedup / auto-dismiss still work via the synthetic key).
    if (typeof jobId === 'string' && jobId.startsWith('beta:')) {
      return { datePosted: null, isBeta: true };
    }
    if (inflight.has(jobId)) return inflight.get(jobId);
    const cached = await cacheGet(jobId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

    const p = (async () => {
      let info = await fetchViaVoyager(jobId);
      if (!info || !info.datePosted) {
        const iso = await fetchViaPublic(jobId);
        if (iso) info = { ...(info || {}), datePosted: iso };
      }
      return cacheSet(jobId, info || { datePosted: null });
    })().finally(() => inflight.delete(jobId));

    inflight.set(jobId, p);
    return p;
  }

  async function getDatePosted(jobId) {
    const info = await getJobInfo(jobId);
    return info ? info.datePosted : null;
  }

  // A job is a repost if its original posting predates its current listing
  // by more than an hour (avoid noise from sub-second clock skew).
  function isRepost(info) {
    if (!info) return false;
    const { originalListedAt, listedAt } = info;
    if (!originalListedAt || !listedAt) return false;
    return listedAt - originalListedAt > 60 * 60 * 1000;
  }

  // ---------- Resolve job ID for a text node ----------
  function findJobIdForNode(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      const id = el.getAttribute && el.getAttribute('data-job-id');
      if (id && /^\d+$/.test(id)) return id;
      const compKey = el.getAttribute && el.getAttribute('componentkey');
      if (compKey) {
        const cm = compKey.match(/job-card-component-ref-(\d+)/);
        if (cm) return cm[1];
      }
      const link = el.querySelector && el.querySelector('a[href*="/jobs/view/"]');
      if (link) {
        const m = link.getAttribute('href').match(/\/jobs\/view\/(\d+)/);
        if (m) return m[1];
      }
      el = el.parentElement;
    }
    // Fallback: URL params for the detail panel
    const params = new URLSearchParams(location.search);
    for (const k of ['currentJobId', 'jobId']) {
      const v = params.get(k);
      if (v && /^\d+$/.test(v)) return v;
    }
    return null;
  }

  // ---------- Find unannotated "Reposted" text nodes ----------
  function findRepostNodes() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!/\bRepost(ed)?\b/i.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = n.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.classList.contains(ANNOTATION_CLASS)) return NodeFilter.FILTER_REJECT;
        if (parent.querySelector('.' + ANNOTATION_CLASS)) return NodeFilter.FILTER_REJECT;
        // Skip text nodes inside our own card-date annotation — otherwise the
        // word "Repost" in our own banner text re-triggers annotateNode and
        // produces a double annotation.
        if (parent.closest('.' + META_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // ---------- Format ----------
  // For posting dates: leads with the human-friendly relative form, with the
  // absolute date appended in parens for anything older than yesterday so the
  // user has an anchor when scrolling fast.
  //   Today
  //   Yesterday
  //   3 Days ago (17 May)
  //   1 Week ago (13 May)
  //   42 Days ago (8 Apr 2026)
  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    const daysAgo = calendarDaysAgo(d.getTime());
    const rel = formatRelativeDays(daysAgo);
    if (daysAgo <= 1) return rel;
    // Drop the year unless the date is from a previous year
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const abs = d.toLocaleDateString(undefined, sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
    return `${rel} (${abs})`;
  }

  // Match "X seconds/minutes/hours/days/weeks/months/years ago"
  const TIME_AGO_RE = /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i;

  // Walk up from the "Reposted" text node to find the smallest ancestor that
  // also contains the relative-time text (e.g. "25 minutes ago"). We append
  // the annotation at the END of that ancestor so the result reads:
  //   "Reposted · 25 minutes ago · originally posted <date> (N days ago)"
  function findRepostContainer(node) {
    let el = node.parentElement;
    let hops = 8; // safety bound
    while (el && hops-- > 0) {
      const text = el.innerText || '';
      if (/\bRepost(ed)?\b/i.test(text) && TIME_AGO_RE.test(text)) return el;
      el = el.parentElement;
    }
    return node.parentElement;
  }

  // ---------- Annotate ----------
  async function annotateNode(node) {
    const jobId = findJobIdForNode(node);
    if (!jobId) { log('no job id for repost text:', node.nodeValue?.trim()); return; }
    const iso = await getDatePosted(jobId);
    if (!iso) { log('no datePosted for', jobId); return; }
    const container = findRepostContainer(node);
    if (!container || container.querySelector('.' + ANNOTATION_CLASS)) return;
    const span = document.createElement('span');
    span.className = ANNOTATION_CLASS;
    span.textContent = ` · originally posted ${formatDate(iso)}`;
    container.appendChild(span);
    log('annotated', jobId, '→', formatDate(iso));
  }

  /**
   * Build & insert the per-card "meta" panel as a SIBLING below the card.
   * Shows pills: Posted date, Repost warning, Viewed, Applied, Duplicate.
   * For dups whose siblings include a dismissed job, the whole panel gets a
   * distinctive red background ("you canceled this elsewhere").
   * Idempotent — re-runs replace the panel only if its contents changed.
   */
  const META_CLASS = 'ljf-card-meta';
  const PILL_CLASS = 'ljf-pill';

  async function renderCardMeta(card) {
    const cardMeta = extractCardMeta(card);

    // Auto-dismiss check FIRST — sponsored / promoted cards may not have a
    // jobId, but we can still match them by company name.
    const autoRule = checkAutoDismiss(cardMeta, card);
    if (autoRule) {
      card.setAttribute('data-ljf-auto-rule', autoRule.label);
      applyAutoDismiss(card, autoRule.label);

      // Clean up any orphan banner / meta panel for this job.
      const idForCleanup = extractJobIdFromContainer(card);
      if (idForCleanup) {
        document.querySelectorAll(`[data-ljf-jobid="${CSS.escape(idForCleanup)}"]`).forEach((el) => {
          if (el !== card) el.remove();
        });
      }
      log('auto-dismissed', autoRule.label, '·', cardMeta.title, '·', cardMeta.company);
      return;
    }
    card.classList.remove('ljf-auto-hidden');
    card.style.removeProperty('display');

    const jobId = extractJobIdFromContainer(card);
    if (!jobId) { log('no jobId for card', '|', cardMeta.title, '@', cardMeta.company); return; }
    log('card', jobId, '|', cardMeta.title, '@', cardMeta.company, '·', cardMeta.location);

    const info = await getJobInfo(jobId);
    if (cardMeta.title && cardMeta.company) {
      recordDup(cardMeta.title, cardMeta.company, jobId, cardMeta.location);
    }

    const pills = [];

    // Date pill (always, if we have a date). When the original posting is
    // 30+ calendar days old we fold the "Skip" verdict INTO the date/repost
    // pill instead of emitting a separate pill — otherwise the age would
    // show twice ("Skip · 151 Days ago" + "Repost · original 151 Days ago").
    if (info) {
      const ts = info.originalListedAt || info.listedAt;
      const iso = ts ? new Date(ts).toISOString() : info.datePosted;
      if (iso) {
        const daysOld = calendarDaysAgo(new Date(iso).getTime());
        const repost = isRepost(info);
        const stale = daysOld >= STALE_DAYS_THRESHOLD;
        const dateStr = formatDate(iso);
        let text, type;
        if (stale && repost)      { type = 'stale'; text = `⏭ Skip · Repost from ${dateStr}`; }
        else if (stale)           { type = 'stale'; text = `⏭ Skip · Posted ${dateStr}`; }
        else if (repost)          { type = 'repost'; text = `↻ Repost · original ${dateStr}`; }
        else                      { type = 'date';   text = `📅 ${dateStr}`; }
        pills.push({ type, text });
      }

      // Applicant-count pill (from Voyager's `applies` field).
      if (typeof info.applies === 'number' && info.applies > 0) {
        const n = info.applies;
        let label;
        if (n === 1) label = '1 applicant';
        else if (n >= 100) label = '100+ applicants';
        else label = `${n} applicants`;
        pills.push({ type: 'applicants', text: `👥 ${label}` });
      }
    }

    // Engagement pills (viewed / applied)
    const engaged = await getEngaged(jobId);
    if (engaged?.viewedAt) {
      pills.push({ type: 'viewed', text: `👁 Viewed ${formatRelative(engaged.viewedAt)}` });
    }
    if (engaged?.appliedAt) {
      pills.push({ type: 'applied', text: `✓ Applied ${formatRelative(engaged.appliedAt)}` });
    }

    // Duplicate pill — cross-reference siblings against dismissal history
    let panelVariant = null;
    const siblings = getDupSiblings(cardMeta.title, cardMeta.company, jobId);
    if (siblings.length > 0) {
      const cancelledSiblings = siblings
        .map((s) => ({ ...s, eng: engagedCache.get(s.jobId) }))
        .filter((s) => s.eng && s.eng.dismissedAt);

      // Strip work-mode suffixes ("(On-site)", "(Remote)", "(Hybrid)") so
      // location lists stay compact.
      const shortLoc = (l) => String(l || '').replace(/\s*\((?:on-?site|remote|hybrid)\)\s*$/i, '').trim();
      const fmtLocs = (arr, max = 2) => {
        const uniq = [...new Set(arr.map(shortLoc).filter(Boolean))];
        const preview = uniq.slice(0, max);
        const more = uniq.length - preview.length;
        return preview.length
          ? `${preview.join(', ')}${more > 0 ? `, +${more} more` : ''}`
          : '';
      };

      if (cancelledSiblings.length > 0) {
        const n = cancelledSiblings.length;
        const locText = fmtLocs(cancelledSiblings.map((s) => s.location));
        pills.push({
          type: 'dup-cancelled',
          text: `🚫 You canceled this for ${n} other location${n === 1 ? '' : 's'}${locText ? ': ' + locText : ''}`,
        });
        panelVariant = 'cancelled';
      } else {
        const otherLocs = siblings
          .map((s) => s.location)
          .filter((l) => l && shortLoc(l) !== shortLoc(cardMeta.location));
        if (otherLocs.length > 0) {
          pills.push({
            type: 'dup-loc',
            text: `📍 Also at: ${fmtLocs(otherLocs)}`,
          });
          panelVariant = 'loc';
        } else {
          const n = siblings.length;
          pills.push({
            type: 'dup-exact',
            text: `🔁 +${n} duplicate${n === 1 ? '' : 's'}`,
          });
          panelVariant = 'exact';
        }
      }
    }

    // Always auto-dismiss the "cancelled" variant: you've already decided
    // on this exact role at another location, so we save you the click.
    // The banner will show "Auto-dismissed: same role you canceled at
    // another location" so the reason is obvious.
    //
    // The "loc" variant (same role at other locations, none cancelled yet)
    // is NOT auto-dismissed — you may prefer a specific location/format,
    // and clicking LinkedIn's X is irreversible. The pill stays visible.
    if (panelVariant === 'cancelled') {
      card.setAttribute('data-ljf-auto-rule', 'Cancelled elsewhere');
      applyAutoDismiss(card, 'Cancelled elsewhere', 'cancelled-duplicate');
      document.querySelectorAll(`[data-ljf-jobid="${CSS.escape(jobId)}"]`).forEach((el) => {
        if (el !== card) el.remove();
      });
      log('auto-dismissed cancelled duplicate:', cardMeta.title, '@', cardMeta.company);
      return;
    }

    renderMetaPanel(card, jobId, pills, panelVariant);
  }

  // Shared auto-dismiss action.
  //   1. If the card has a clickable LinkedIn dismiss button → click it
  //      (card enters LinkedIn's faded "We won't show you this again" state).
  //   2. Otherwise fall back to CSS-only hiding (display:none) so the card
  //      doesn't keep cluttering the feed even though LinkedIn can't dismiss
  //      it (typical for some sponsored / promoted ads without an X button).
  function applyAutoDismiss(card, label) {
    if (card.classList.contains('job-card-list--is-dismissed')) return; // already dismissed
    if (card.dataset.ljfAutoDismissed) return; // we've already clicked once

    // Fire an 'autoHidden' engagement event exactly once per job (per
    // extension install) — checked against engagedCache so page reloads
    // don't produce duplicate sheet rows. We record BEFORE the click so
    // we capture the metadata while the card is still fully rendered.
    const jobId = extractJobIdFromContainer(card);
    if (jobId && !engagedCache.get(jobId)?.autoHiddenAt) {
      const meta = extractCardMeta(card);
      recordEngaged(jobId, 'autoHidden', meta, { autoHiddenRule: label || '' });
    }

    const dismissBtn = card.querySelector(
      'button[aria-label*="dismiss" i]:not([aria-label*="undo" i]):not([aria-label*="restore" i])'
    );
    if (dismissBtn) {
      card.dataset.ljfAutoDismissed = '1';
      log('clicking LinkedIn dismiss for', label);
      dismissBtn.click();
      return;
    }
    // No dismiss button → fall back to CSS hide. On the beta layout the card
    // is a role="button" nested in a wrapper; hide the outer wrapper too so
    // the whole list row collapses (otherwise its `display: contents` parent
    // leaves the wrapper in the flow but empty).
    card.classList.add('ljf-auto-hidden');
    card.style.setProperty('display', 'none', 'important');
    const outer = getCardOuter(card);
    if (outer !== card) {
      outer.classList.add('ljf-auto-hidden');
      outer.style.setProperty('display', 'none', 'important');
    }
    log('no dismiss button — hiding via CSS for', label);
  }

  function renderMetaPanel(card, jobId, pills, variant) {
    // Find ALL panels for this jobId anywhere in the document. LinkedIn
    // sometimes keeps the old card DOM around briefly while rendering a new
    // one, and we may have inserted a panel after each — dedup here.
    const allExisting = document.querySelectorAll(
      `.${META_CLASS}[data-ljf-jobid="${CSS.escape(jobId)}"]`
    );

    if (pills.length === 0) {
      allExisting.forEach((p) => p.remove());
      return;
    }

    // On the beta layout each card sits inside a display:contents wrapper
    // that is itself the direct child of the list root. Inserting a sibling
    // of the card would put the panel inside that wrapper, which the beta
    // grid layout won't display as its own row. Anchor to the outer wrapper
    // instead — on the classic layout getCardOuter returns the card itself,
    // so behaviour is unchanged there.
    const outer = getCardOuter(card);
    const parent = outer.parentElement;
    if (!parent) return;

    // Compute the correct insertion target: right after the card, skipping
    // any dismissal banner that may sit between card and panel.
    let target = outer.nextSibling;
    while (
      target
      && target.nodeType === Node.ELEMENT_NODE
      && target.classList?.contains(BANNER_CLASS)
    ) {
      target = target.nextSibling;
    }

    // Keep one panel (prefer the one already adjacent to THIS card),
    // discard the rest.
    let panel = null;
    allExisting.forEach((p) => {
      if (!panel && p === target) panel = p;
    });
    if (!panel && allExisting.length > 0) panel = allExisting[0];
    allExisting.forEach((p) => { if (p !== panel) p.remove(); });

    if (panel) {
      // Move to correct position if not already there
      if (panel !== target || panel.parentElement !== parent) {
        parent.insertBefore(panel, target);
      }
    } else {
      panel = document.createElement('div');
      panel.className = META_CLASS;
      panel.setAttribute('data-ljf-jobid', jobId);
      parent.insertBefore(panel, target);
    }

    // Avoid re-render if nothing changed
    const state = JSON.stringify({ pills, variant });
    if (panel.dataset.ljfState === state) return;
    panel.dataset.ljfState = state;

    // Reset variant class then apply
    panel.classList.remove('ljf-card-meta-cancelled', 'ljf-card-meta-loc', 'ljf-card-meta-exact');
    if (variant) panel.classList.add(`ljf-card-meta-${variant}`);

    panel.innerHTML = '';
    for (const pill of pills) {
      const el = document.createElement('span');
      el.className = `${PILL_CLASS} ${PILL_CLASS}-${pill.type}`;
      el.textContent = pill.text;
      panel.appendChild(el);
    }
  }

  // Remove orphaned meta panels (whose previous sibling is no longer the
  // matching card — happens when LinkedIn re-renders the list). Also dedup
  // same-jobId panels and drop panels that follow auto-hidden cards.
  function cleanupCardDateAnnotations() {
    // Dedup pass: for each jobId, keep only the FIRST panel in document order.
    const seen = new Set();
    document.querySelectorAll('.' + META_CLASS).forEach((el) => {
      const jobId = el.getAttribute('data-ljf-jobid');
      if (!jobId) return;
      if (seen.has(jobId)) { el.remove(); return; }
      seen.add(jobId);
    });
    // Orphan pass: drop panels whose preceding sibling isn't a visible card
    // (or a wrapper around one, on the beta layout).
    document.querySelectorAll('.' + META_CLASS).forEach((el) => {
      const jobId = el.getAttribute('data-ljf-jobid');
      let prev = el.previousElementSibling;
      while (prev && prev.classList?.contains(BANNER_CLASS)) prev = prev.previousElementSibling;
      if (!prev) { el.remove(); return; }
      const prevCard = prev.matches?.(CARD_SELECTOR) ? prev : prev.querySelector?.(CARD_SELECTOR);
      if (!prevCard) { el.remove(); return; }
      if (prev.classList?.contains('ljf-auto-hidden') || prevCard.classList?.contains('ljf-auto-hidden')) {
        el.remove(); return;
      }
      if (extractJobIdFromContainer(prevCard) !== jobId) el.remove();
    });
    // Also drop any banner whose preceding card is auto-hidden — those are
    // floating banners with no visible card above them.
    document.querySelectorAll('.' + BANNER_CLASS).forEach((banner) => {
      let prev = banner.previousElementSibling;
      // Skip past panels that may sit between card and banner in unusual orderings
      while (prev && (prev.classList?.contains(META_CLASS) || prev.classList?.contains(BANNER_CLASS))) {
        prev = prev.previousElementSibling;
      }
      if (!prev) return;
      const prevCard = prev.matches?.(CARD_SELECTOR) ? prev : prev.querySelector?.(CARD_SELECTOR);
      if (prevCard && (prev.classList?.contains('ljf-auto-hidden') || prevCard.classList?.contains('ljf-auto-hidden'))) {
        banner.remove();
      }
    });
  }

  // Lazily fetch & annotate cards only when they scroll into view, so we
  // don't fire 25+ Voyager requests on page load.
  const cardObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        renderCardMeta(entry.target);
        cardObserver.unobserve(entry.target);
      }
    }
  }, { rootMargin: '300px' });
  registerTeardown(() => cardObserver.disconnect());

  // ---------- Scan + observe ----------
  function isOnJobsPage() {
    return /^\/jobs(\/|$)/.test(location.pathname);
  }

  // Walk the DOM looking for any text node matching an auto-dismiss rule's
  // textPatterns and hide the nearest card-like ancestor. Catches sponsored /
  // promoted listings whose DOM doesn't match CARD_SELECTOR.
  //
  // CAUTION: must NOT walk into the right-side detail panel. The detail
  // panel contains /jobs/view/ links and dismiss buttons, which match the
  // "looks like a card" heuristic — without this guard, a "DataAnnotation"
  // mention anywhere in the detail panel (related jobs list, autocomplete,
  // etc.) would cause the entire detail panel to get display:none.
  // Find the smallest ancestor that contains the bulk of the visible cards —
  // i.e. the search-results list container on the left. We restrict the
  // brute-force walker to this root so it can never accidentally walk into
  // (or up past) the right-side detail panel, no matter what classes
  // LinkedIn uses.
  function findListRoot() {
    const cards = pickInnermostMatches(Array.from(document.querySelectorAll(CARD_SELECTOR)));
    if (cards.length < 2) return null;
    let common = cards[0].parentElement;
    while (common && common !== document.body) {
      if (cards.every((c) => common.contains(c))) return common;
      common = common.parentElement;
    }
    return null;
  }

  // Aggressive cleanup of anything previously auto-hidden that turns out to
  // be (or contain) the detail panel.
  function uncoverDetailPanel() {
    const detailRoot = document.querySelector(DETAIL_SELECTOR);
    if (!detailRoot) return;
    document.querySelectorAll('.ljf-auto-hidden').forEach((el) => {
      if (el === detailRoot || el.contains(detailRoot) || detailRoot.contains(el)) {
        el.classList.remove('ljf-auto-hidden');
        el.removeAttribute('data-ljf-auto-rule');
        el.style.removeProperty('display');
        log('un-hid (related to detail panel):', el.tagName);
      }
    });
  }

  function bruteForceAutoDismissScan() {
    uncoverDetailPanel();

    // Only walk within the search-results list — never touches the detail panel.
    const listRoot = findListRoot();
    if (!listRoot) {
      log('brute-force scan: no list root found, skipping');
      return;
    }

    for (const rule of AUTO_DISMISS_RULES) {
      if (!rule.textPatterns) continue;
      const walker = document.createTreeWalker(listRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const v = n.nodeValue;
          if (!v || v.length > 200) return NodeFilter.FILTER_REJECT;
          const parent = n.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // Skip text inside our own injected UI
          if (parent.closest('.ljf-card-meta, .ljf-engaged-banner, .ljf-pill, .ljf-orig-date')) {
            return NodeFilter.FILTER_REJECT;
          }
          // Skip the detail panel — never auto-hide anything in there
          if (parent.closest(DETAIL_SELECTOR)) {
            return NodeFilter.FILTER_REJECT;
          }
          return rule.textPatterns.some((re) => re.test(v))
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        let el = node.parentElement;
        let hops = 15;
        while (el && hops-- > 0 && el !== document.body) {
          if (el.classList?.contains('ljf-auto-hidden')) break;
          // Stop walking up if we hit the detail panel — never hide it
          if (el.matches?.(DETAIL_SELECTOR)) break;
          const looksLikeCard = el.matches?.(CARD_SELECTOR)
            || ((el.tagName === 'LI' || el.tagName === 'DIV')
                && el.querySelector('a[href*="/jobs/view/"], button[aria-label*="dismiss" i], button[aria-label*="hide" i]'));
          if (looksLikeCard) {
            el.classList.add('ljf-auto-hidden');
            el.setAttribute('data-ljf-auto-rule', rule.label);
            log('brute-hidden', rule.label, '· ancestor:', el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
            break;
          }
          el = el.parentElement;
        }
      }
    }
  }

  // ---------- Client-side sort by listed date ----------
  // Mimic LinkedIn's removed "Sort by Most Recent" by reordering cards in
  // the list root. Sort key = Voyager `listedAt` (falling back to
  // `originalListedAt`). Cards whose date hasn't been fetched yet sink to
  // the bottom and re-slot on the next scan once the data arrives.
  //
  // The list has structure: [wrapper, hr, wrapper, hr, wrapper, ...]. We
  // treat each (wrapper + trailing hr) as one unit so the separators stay
  // between cards after the reorder.
  // Prefetch state — tracks Voyager fetches kicked off by the sort feature
  // so we can (a) hold the sort until the batch settles (avoids visible
  // shuffle) and (b) surface progress in the results-count pill.
  const SORT_PREFETCH_CONCURRENCY = 5;
  const prefetchState = { requested: 0, completed: 0, activeBatches: 0 };

  async function prefetchAllCardDates() {
    if (!FILTER_SETTINGS.sortByListedDate) return;
    const cards = pickInnermostMatches(Array.from(document.querySelectorAll(CARD_SELECTOR)));
    const queue = [];
    const seen = new Set();
    for (const card of cards) {
      const jobId = extractJobIdFromContainer(card);
      if (!jobId || String(jobId).startsWith('beta:')) continue;
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      if (memCache.has(jobId) || inflight.has(jobId)) continue;
      queue.push(jobId);
    }
    if (queue.length === 0) return;

    prefetchState.requested += queue.length;
    prefetchState.activeBatches++;
    updateResultsCount();

    let idx = 0;
    const workers = Array.from({ length: Math.min(SORT_PREFETCH_CONCURRENCY, queue.length) }, () => (async () => {
      while (alive && idx < queue.length) {
        const jobId = queue[idx++];
        try { await getJobInfo(jobId); } catch (_) { /* ignore individual failures */ }
        prefetchState.completed++;
        updateResultsCount();
      }
    })());
    await Promise.all(workers);

    prefetchState.activeBatches--;
    // Once every card in this batch has a date (or gave up), we can sort.
    sortCardsByListedDate();
    updateResultsCount();
  }

  function sortCardsByListedDate() {
    if (!FILTER_SETTINGS.sortByListedDate) return;
    // Skip while a bulk prefetch is still in flight — the terminal sort
    // fires from prefetchAllCardDates() once the batch drains, and any
    // interim sort would just cause visible shuffle.
    if (prefetchState.activeBatches > 0) return;
    const root = findListRoot();
    if (!root) return;

    // Group children into per-card units. Each unit = [wrapper, ...trailing
    // extras until the next wrapper]. "Trailing extras" includes our own
    // meta panels and dismissal banners (which are inserted as siblings of
    // the wrapper) and LinkedIn's <hr> separators. Keeping them all attached
    // to the wrapper means the sort preserves card ↔ panel adjacency; if we
    // moved just the wrappers, the panels would be left behind and the
    // cleanup pass would delete them.
    //
    // Anything AFTER the last card wrapper (footer, pagination, "Are these
    // results helpful?", job-alerts toggle) is captured as a fixed suffix
    // that always re-appends at the end. Without this, the last card's tail
    // ate all those elements and dragged them along whenever it moved.
    const children = Array.from(root.children);
    const isCardWrapper = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (el.tagName === 'HR') return false;
      if (el.classList?.contains(META_CLASS) || el.classList?.contains(BANNER_CLASS)) return false;
      // Must actually contain a job card — otherwise it's a divider / promo /
      // whatever LinkedIn injects, and we should NOT try to sort it.
      return !!(el.matches?.(CARD_SELECTOR) || el.querySelector?.(CARD_SELECTOR));
    };
    // Only recognize items that clearly "belong to" the preceding card as
    // tail extras. Anything else is treated as a suffix (fixed non-sortable
    // block at the end of the list).
    const isKnownTailExtra = (el) => (
      el?.nodeType === Node.ELEMENT_NODE
      && (el.tagName === 'HR'
          || el.classList?.contains(META_CLASS)
          || el.classList?.contains(BANNER_CLASS))
    );

    let lastCardIdx = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (isCardWrapper(children[i])) { lastCardIdx = i; break; }
    }
    if (lastCardIdx === -1) return; // no cards to sort

    const units = [];
    const trailingSuffix = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      // Everything strictly after the last card is fixed suffix.
      if (i > lastCardIdx) { trailingSuffix.push(child); continue; }
      if (isCardWrapper(child)) {
        units.push({ head: child, tail: [], key: 0 });
      } else if (units.length && isKnownTailExtra(child)) {
        units[units.length - 1].tail.push(child);
      } else if (units.length) {
        // Unknown mid-list block (e.g. an inline promo). Leave it pinned
        // between the two adjacent units by attaching it to the previous
        // unit's tail — same behaviour as before, just narrowed to elements
        // we don't recognize as tail extras.
        units[units.length - 1].tail.push(child);
      } else {
        // Orphan leading extra (nothing to attach to yet).
        units.push({ head: null, tail: [child], key: 0 });
      }
    }

    for (const u of units) {
      if (!u.head) continue;
      const card = u.head.matches?.(CARD_SELECTOR) ? u.head : u.head.querySelector?.(CARD_SELECTOR);
      if (!card) continue;
      const jobId = extractJobIdFromContainer(card);
      if (!jobId || String(jobId).startsWith('beta:')) continue;
      const cached = memCache.get(jobId);
      u.key = (cached?.listedAt || cached?.originalListedAt || 0);
    }

    const indexed = units.map((u, i) => ({ u, i }));
    // Newest first (higher timestamp wins). Stable within ties by original i.
    indexed.sort((a, b) => (b.u.key - a.u.key) || (a.i - b.i));

    const orderChanged = indexed.some((entry, idx) => entry.i !== idx);
    if (!orderChanged) return;

    // Suspend the MutationObserver while we shuffle children — otherwise
    // our own writes echo back through scheduleScan → renderCardMeta →
    // more DOM churn, which is what caused the right-hand detail panel to
    // keep jumping.
    try { mo.disconnect(); } catch (_) { /* pre-init call, no-op */ }
    const frag = document.createDocumentFragment();
    for (const { u } of indexed) {
      if (u.head) frag.appendChild(u.head);
      for (const t of u.tail) frag.appendChild(t);
    }
    // Footer / pagination / job-alerts toggle always stay at the end.
    for (const s of trailingSuffix) frag.appendChild(s);
    root.appendChild(frag);
    // Reattach after the current microtask so we skip records generated by
    // our own writes above.
    queueMicrotask(() => {
      try { mo.observe(document.body, { subtree: true, childList: true, characterData: true }); }
      catch (_) { /* pre-init call, no-op */ }
    });
    log('sorted', indexed.length, 'cards by listedAt');
  }

  // ---------- Results count display ----------
  // Locate LinkedIn's "<N> results" text and append our own count of
  // post-filter visible cards. Updated after every scan.
  function findResultsCountTextNode() {
    // LinkedIn now caps the visible count at "99+ results" on the beta
    // layout, so the optional trailing '+' has to be part of the match.
    const re = /\b\d+(?:[, ]\d{3})*\+?\s*results?\b/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.length > 100) return NodeFilter.FILTER_REJECT;
        if (n.parentElement?.closest('.ljf-results-count, .ljf-card-meta, .ljf-engaged-banner')) {
          return NodeFilter.FILTER_REJECT;
        }
        return re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    return walker.nextNode();
  }

  function countVisibleCards() {
    const all = pickInnermostMatches(Array.from(document.querySelectorAll(CARD_SELECTOR)));
    const seen = new Set();
    let visible = 0, hidden = 0;
    for (const card of all) {
      const jobId = extractJobIdFromContainer(card) || `__${Math.random()}`;
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      if (card.classList.contains('ljf-auto-hidden')) hidden++;
      else visible++;
    }
    return { visible, hidden, total: visible + hidden };
  }

  function updateResultsCount() {
    if (!isOnJobsPage()) return;
    const { visible, hidden, total } = countVisibleCards();

    let counter = document.querySelector('.ljf-results-count');
    if (!counter) {
      const textNode = findResultsCountTextNode();
      const target = textNode?.parentElement;
      if (!target) return;
      counter = document.createElement('span');
      counter.className = 'ljf-results-count';
      target.appendChild(counter);
    }

    // Sort-prefetch progress takes precedence — while dates are streaming
    // in, the visible count is meaningless (cards are still shuffling).
    const remaining = prefetchState.requested - prefetchState.completed;
    if (prefetchState.activeBatches > 0 && remaining > 0) {
      counter.textContent = ` · sorting ${remaining} more…`;
      counter.title = 'Prefetching job dates so the sort settles';
      counter.classList.add('ljf-results-count-loading');
      return;
    }
    counter.classList.remove('ljf-results-count-loading');

    if (hidden === 0) {
      counter.textContent = ` · ${visible} visible`;
      counter.title = `All ${total} cards visible (no filters matched)`;
    } else {
      counter.textContent = ` · ${visible} after filters (${hidden} hidden)`;
      counter.title = `Extension filtered ${hidden} of ${total} cards`;
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (!alive) return;
    if (!isOnJobsPage()) return;
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      if (!alive) return;
      // First: defensively un-hide the right-side detail panel if a prior
      // scan accidentally masked it.
      uncoverDetailPanel();
      // Repost annotations
      const nodes = findRepostNodes();
      if (nodes.length) log('found', nodes.length, '"Reposted" node(s)');
      nodes.forEach(annotateNode);
      // Engagement markers + per-card meta panels
      scanForEngaged();
      // Backup: brute-force pass for cards that didn't match CARD_SELECTOR
      bruteForceAutoDismissScan();
      // Kick off a bulk prefetch of Voyager dates for any card we haven't
      // fetched yet. Fire-and-forget: it drains asynchronously and calls
      // sortCardsByListedDate() once the batch settles. Only runs when the
      // sort setting is on (function short-circuits otherwise).
      prefetchAllCardDates();
      // Client-side sort (no-op when the setting is off, when a prefetch is
      // still in flight, or when the order already matches).
      sortCardsByListedDate();
      // Update the visible-card counter next to LinkedIn's results count
      updateResultsCount();
    });
  }

  // Initial scan — don't block on cache loading. Pills that depend on
  // engagement/duplicate state will fill in once the caches finish loading
  // and the next scheduled scan (via MO, periodic, or below) runs.
  scheduleScan();
  Promise.all([loadEngagedCache(), loadDupGroups(), loadAutoDismissRules(), loadFilterSettings(), loadSheetsSync()])
    .then(() => scheduleScan());

  // Late-loading content (LinkedIn hydrates cards asynchronously). Run a few
  // delayed scans after startup so we don't have to wait for the user to
  // scroll or for some other MO mutation to trigger us.
  setTimeout(scheduleScan, 500);
  setTimeout(scheduleScan, 1500);
  setTimeout(scheduleScan, 3500);
  // Safety net: re-scan periodically. Cheap because scheduleScan no-ops if
  // nothing changed (idempotent render) and bails out when not on /jobs/.
  const periodicScan = setInterval(() => {
    if (alive && isOnJobsPage()) scheduleScan();
  }, 10000);
  registerTeardown(() => clearInterval(periodicScan));

  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  registerTeardown(() => mo.disconnect());

  // SPA URL change detection — also records a `viewed` engagement whenever
  // the user opens a different job in the right detail panel.
  let lastUrl = location.href;
  let lastViewedJobId = null;
  function checkViewed() {
    const jobId = currentJobIdFromUrl();
    if (!jobId || jobId === lastViewedJobId) return;
    lastViewedJobId = jobId;
    // Grab title/company/location from the detail panel if available
    const detailMatches = pickInnermostMatches(Array.from(document.querySelectorAll(DETAIL_SELECTOR)));
    const meta = detailMatches[0] ? extractCardMeta(detailMatches[0]) : {};
    recordEngaged(jobId, 'viewed', meta);
  }
  checkViewed();
  const urlInterval = setInterval(() => {
    if (!alive) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('url changed:', lastUrl);
      checkViewed();
      scheduleScan();
    }
  }, 1000);
  registerTeardown(() => clearInterval(urlInterval));

  // Catch async rejections from any stray chrome.* calls we missed
  window.addEventListener('unhandledrejection', (ev) => {
    if (isContextError(ev.reason)) {
      shutdown('unhandledrejection');
      ev.preventDefault();
    }
  });
})();
