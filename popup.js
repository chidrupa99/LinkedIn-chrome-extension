const STORAGE_KEY = 'autodismiss_rules';
const FILTERS_KEY = 'filter_settings';

const DEFAULT_RULES = [
  { id: 'data-annotation', companyName: 'DataAnnotation', enabled: true, builtIn: true },
  { id: 'dice',            companyName: 'Dice',            enabled: true, builtIn: true },
];

const DEFAULT_FILTERS = {
  hideDupCancelled: false,
  hideDupLoc:       false,
};

function loadFilters() {
  return new Promise((resolve) => {
    chrome.storage.local.get([FILTERS_KEY], (out) => {
      resolve({ ...DEFAULT_FILTERS, ...(out[FILTERS_KEY] || {}) });
    });
  });
}

function saveFilters(filters) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [FILTERS_KEY]: filters }, resolve);
  });
}

function loadRules() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (out) => {
      const rules = out[STORAGE_KEY];
      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_RULES });
        resolve(DEFAULT_RULES.slice());
      } else {
        resolve(rules);
      }
    });
  });
}

function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: rules }, resolve);
  });
}

function render(rules) {
  const list = document.getElementById('rules-list');
  list.innerHTML = '';
  if (rules.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'rule';
    empty.style.cssText = 'color:#888;font-style:italic;font-size:12px';
    empty.textContent = 'No rules yet — add a company name below.';
    list.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const li = document.createElement('li');
    li.className = 'rule';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rule.enabled !== false;
    checkbox.addEventListener('change', async () => {
      rule.enabled = checkbox.checked;
      await saveRules(rules);
    });
    label.appendChild(checkbox);

    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.companyName;
    name.title = rule.companyName;
    label.appendChild(name);

    if (rule.builtIn) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'built-in';
      label.appendChild(badge);
    }

    li.appendChild(label);

    if (!rule.builtIn) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '×';
      removeBtn.type = 'button';
      removeBtn.title = 'Remove this rule';
      removeBtn.addEventListener('click', async () => {
        const idx = rules.indexOf(rule);
        if (idx >= 0) rules.splice(idx, 1);
        await saveRules(rules);
        render(rules);
      });
      li.appendChild(removeBtn);
    }

    list.appendChild(li);
  }
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('new-company');
  const name = input.value.trim();
  if (!name) return;

  const rules = await loadRules();
  if (rules.some((r) => r.companyName.toLowerCase() === name.toLowerCase())) {
    // Already exists — just flash the input and bail.
    input.style.borderColor = '#cf222e';
    setTimeout(() => { input.style.borderColor = ''; }, 800);
    return;
  }
  rules.push({
    id: 'user-' + Date.now(),
    companyName: name,
    enabled: true,
    builtIn: false,
  });
  await saveRules(rules);
  input.value = '';
  render(rules);
});

loadRules().then(render);

// Apply filters button — sends an explicit message to the content script
// to re-scan the active LinkedIn tab (in addition to the automatic re-scan
// that the content script does when storage changes).
document.getElementById('apply-btn').addEventListener('click', async () => {
  const btn = document.getElementById('apply-btn');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/linkedin\.com/.test(tab.url || '')) {
      btn.textContent = 'Open a LinkedIn tab';
      setTimeout(() => { btn.textContent = 'Apply filters now'; btn.disabled = false; }, 1500);
      return;
    }
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'apply-filters' }, () => {
        if (chrome.runtime.lastError) { /* ignore — content script may be reloading */ }
        resolve();
      });
    });
    btn.classList.add('applied');
    btn.textContent = 'Applied ✓';
  } finally {
    setTimeout(() => {
      btn.classList.remove('applied');
      btn.textContent = 'Apply filters now';
      btn.disabled = false;
    }, 1500);
  }
});

// Wire up duplicate-filter checkboxes
loadFilters().then((filters) => {
  const cancelled = document.getElementById('hide-dup-cancelled');
  const loc       = document.getElementById('hide-dup-loc');
  cancelled.checked = !!filters.hideDupCancelled;
  loc.checked       = !!filters.hideDupLoc;
  cancelled.addEventListener('change', async () => {
    filters.hideDupCancelled = cancelled.checked;
    await saveFilters(filters);
  });
  loc.addEventListener('change', async () => {
    filters.hideDupLoc = loc.checked;
    await saveFilters(filters);
  });
});
