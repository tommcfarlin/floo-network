/**
 * Floo — App entry point
 *
 * Handles service worker registration, authentication,
 * reading list display, and mark-as-read functionality.
 * All Supabase communication uses raw fetch — no JS client.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const STORAGE_KEYS = Object.freeze({
  SUPABASE_URL: 'floo_supabase_url',
  SUPABASE_ANON_KEY: 'floo_supabase_anon_key',
  ACCESS_TOKEN: 'floo_access_token',
  REFRESH_TOKEN: 'floo_refresh_token',
  TOKEN_EXPIRES_AT: 'floo_token_expires_at',
  USER_EMAIL: 'floo_user_email',
});

/* ------------------------------------------------------------------ */
/*  DOM references                                                    */
/* ------------------------------------------------------------------ */

const dom = {
  loginScreen: document.getElementById('login-screen'),
  appContent: document.getElementById('app-content'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  loginSubmit: document.getElementById('login-submit'),
  configDetails: document.getElementById('config-details'),
  supabaseUrl: document.getElementById('supabase-url'),
  anonKey: document.getElementById('anon-key'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  logoutBtn: document.getElementById('logout-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  userEmail: document.getElementById('user-email'),
  tabsList: document.getElementById('tabs-list'),
  emptyState: document.getElementById('empty-state'),
  loadingIndicator: document.getElementById('loading-indicator'),
  tabCount: document.getElementById('tab-count'),
  fetchError: document.getElementById('fetch-error'),
};

/* ------------------------------------------------------------------ */
/*  Service worker registration                                       */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('SW registered, scope:', registration.scope);
      })
      .catch((error) => {
        console.error('SW registration failed:', error);
      });
  });
}

/* ------------------------------------------------------------------ */
/*  Auth helpers                                                      */
/* ------------------------------------------------------------------ */

function getStoredConfig() {
  return {
    supabaseUrl: localStorage.getItem(STORAGE_KEYS.SUPABASE_URL),
    anonKey: localStorage.getItem(STORAGE_KEYS.SUPABASE_ANON_KEY),
    accessToken: localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
    refreshToken: localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN),
    expiresAt: parseInt(localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRES_AT) || '0', 10),
    email: localStorage.getItem(STORAGE_KEYS.USER_EMAIL),
  };
}

function saveTokens(data, email) {
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.access_token);
  localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh_token);
  localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRES_AT, String(data.expires_at));
  if (email) {
    localStorage.setItem(STORAGE_KEYS.USER_EMAIL, email);
  }
}

function saveConfig(url, anonKey) {
  const clean = url.replace(/\/+$/, '');
  if (!clean.startsWith('https://')) {
    throw new Error('Supabase URL must use HTTPS.');
  }
  localStorage.setItem(STORAGE_KEYS.SUPABASE_URL, clean);
  localStorage.setItem(STORAGE_KEYS.SUPABASE_ANON_KEY, anonKey);
}

function clearAuth() {
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
}

function isTokenValid() {
  const config = getStoredConfig();
  if (!config.accessToken) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return now < (config.expiresAt - 60);
}

/**
 * Refresh the access token using the stored refresh token.
 *
 * @return {Promise<boolean>} True if refresh succeeded.
 */
async function refreshAccessToken() {
  const config = getStoredConfig();
  if (!config.supabaseUrl || !config.anonKey || !config.refreshToken) {
    return false;
  }

  try {
    const response = await fetch(
      `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.anonKey,
        },
        body: JSON.stringify({ refresh_token: config.refreshToken }),
      }
    );

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    saveTokens(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no valid session can be established.
 *
 * @return {Promise<string|null>}
 */
async function getValidToken() {
  if (isTokenValid()) {
    return getStoredConfig().accessToken;
  }

  const refreshed = await refreshAccessToken();
  if (refreshed) {
    return getStoredConfig().accessToken;
  }

  return null;
}

/**
 * Build standard auth headers for Supabase REST calls.
 *
 * @param {string} token  Access token.
 * @param {string} anonKey  Supabase anon key.
 * @return {Object}
 */
function authHeaders(token, anonKey) {
  return {
    'apikey': anonKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/* ------------------------------------------------------------------ */
/*  Login                                                             */
/* ------------------------------------------------------------------ */

async function handleLogin(event) {
  event.preventDefault();

  const emailVal = dom.email.value.trim();
  const passwordVal = dom.password.value;
  const urlVal = dom.supabaseUrl.value.trim();
  const keyVal = dom.anonKey.value.trim();

  // Hide any previous error
  showError('');

  // Save config if provided (first time or changed)
  if (urlVal && keyVal) {
    try {
      saveConfig(urlVal, keyVal);
    } catch (err) {
      showError(err.message);
      return;
    }
  }

  const config = getStoredConfig();
  if (!config.supabaseUrl || !config.anonKey) {
    showError('Supabase URL and anon key are required. Open the configuration section above.');
    dom.configDetails.open = true;
    return;
  }

  if (!emailVal || !passwordVal) {
    showError('Email and password are required.');
    return;
  }

  dom.loginSubmit.disabled = true;
  dom.loginSubmit.textContent = 'Signing in\u2026';

  try {
    const response = await fetch(
      `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.anonKey,
        },
        body: JSON.stringify({ email: emailVal, password: passwordVal }),
      }
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.error_description || body.msg || body.error || 'Login failed.';
      showError(message);
      return;
    }

    const data = await response.json();
    saveTokens(data, emailVal);
    showApp();
  } catch (err) {
    showError(err.message || 'Network error during login.');
  } finally {
    dom.loginSubmit.disabled = false;
    dom.loginSubmit.textContent = 'Sign in';
  }
}

function showError(message) {
  if (!message) {
    dom.loginError.hidden = true;
    dom.loginError.textContent = '';
    return;
  }
  dom.loginError.textContent = message;
  dom.loginError.hidden = false;
}

/* ------------------------------------------------------------------ */
/*  Screen management                                                 */
/* ------------------------------------------------------------------ */

function showLogin() {
  dom.loginScreen.hidden = false;
  dom.appContent.hidden = true;
  dom.logoutBtn.hidden = true;

  // Pre-fill config fields if already stored
  const config = getStoredConfig();
  if (config.supabaseUrl) {
    dom.supabaseUrl.value = config.supabaseUrl;
  }
  if (config.anonKey) {
    dom.anonKey.value = config.anonKey;
  }
  if (config.email) {
    dom.email.value = config.email;
  }
  // Collapse config section if already configured
  if (config.supabaseUrl && config.anonKey) {
    dom.configDetails.open = false;
  } else {
    dom.configDetails.open = true;
  }
}

function showApp() {
  dom.loginScreen.hidden = true;
  dom.appContent.hidden = false;
  dom.logoutBtn.hidden = false;

  const config = getStoredConfig();
  dom.userEmail.textContent = config.email || '';

  // Clear password field for security
  dom.password.value = '';

  fetchTabs();
}

function handleLogout() {
  clearAuth();
  dom.tabsList.innerHTML = '';
  dom.emptyState.hidden = true;
  showLogin();
}

/* ------------------------------------------------------------------ */
/*  Reading list                                                      */
/* ------------------------------------------------------------------ */

/**
 * Format a relative time string from a timestamp.
 *
 * @param {string} dateStr  ISO date string.
 * @return {string}
 */
function relativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSeconds = Math.floor((now - then) / 1000);

  if (diffSeconds < 60) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) {
    return `${diffWeeks}w ago`;
  }

  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

/**
 * Extract domain from a URL string.
 *
 * @param {string} urlStr  Full URL.
 * @return {string}
 */
function extractDomain(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

/**
 * Fetch unread tabs from Supabase and render the list.
 */
async function fetchTabs() {
  const token = await getValidToken();
  if (!token) {
    handleLogout();
    return;
  }

  const config = getStoredConfig();
  dom.loadingIndicator.hidden = false;
  dom.tabsList.innerHTML = '';
  dom.emptyState.hidden = true;
  dom.fetchError.hidden = true;
  dom.tabCount.hidden = true;

  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/tabs?is_read=eq.false&order=created_at.desc&select=id,url,title,created_at`,
      {
        method: 'GET',
        headers: authHeaders(token, config.anonKey),
      }
    );

    if (response.status === 401) {
      handleLogout();
      return;
    }

    if (!response.ok) {
      console.error('Failed to fetch tabs:', response.status);
      dom.fetchError.hidden = false;
      return;
    }

    const tabs = await response.json();
    renderTabs(tabs);
    updateTabCount();
  } catch (err) {
    console.error('Error fetching tabs:', err);
    dom.fetchError.hidden = false;
  } finally {
    dom.loadingIndicator.hidden = true;
  }
}

/**
 * Render a list of tabs into the DOM.
 *
 * @param {Array} tabs  Array of tab objects from Supabase.
 */
function renderTabs(tabs) {
  dom.tabsList.innerHTML = '';

  if (!tabs || tabs.length === 0) {
    dom.emptyState.hidden = false;
    return;
  }

  dom.emptyState.hidden = true;

  tabs.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'tab-item';
    li.dataset.tabId = tab.id;

    const link = document.createElement('a');
    link.href = tab.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'tab-link';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || tab.url;

    const metaEl = document.createElement('span');
    metaEl.className = 'tab-meta';

    const domainEl = document.createElement('span');
    domainEl.className = 'tab-domain';
    domainEl.textContent = extractDomain(tab.url);

    const timeEl = document.createElement('span');
    timeEl.className = 'tab-time';
    timeEl.textContent = relativeTime(tab.created_at);

    metaEl.appendChild(domainEl);
    metaEl.appendChild(document.createTextNode(' \u00B7 '));
    metaEl.appendChild(timeEl);

    link.appendChild(titleEl);
    link.appendChild(metaEl);

    const markBtn = document.createElement('button');
    markBtn.className = 'btn-mark-read';
    markBtn.textContent = 'Done';
    markBtn.setAttribute('aria-label', `Mark "${tab.title || tab.url}" as read`);
    markBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      markAsRead(tab.id, li);
    });

    li.appendChild(link);
    li.appendChild(markBtn);
    dom.tabsList.appendChild(li);
  });
}

/**
 * Update the tab count badge in the toolbar.
 */
function updateTabCount() {
  const count = dom.tabsList.children.length;
  if (count > 0) {
    dom.tabCount.textContent = `${count} tab${count === 1 ? '' : 's'}`;
    dom.tabCount.hidden = false;
  } else {
    dom.tabCount.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/*  Mark as read                                                      */
/* ------------------------------------------------------------------ */

/**
 * Mark a tab as read via Supabase PATCH, then remove from DOM.
 *
 * @param {string} tabId  The tab's UUID.
 * @param {HTMLElement} listItem  The <li> to remove on success.
 */
async function markAsRead(tabId, listItem) {
  const token = await getValidToken();
  if (!token) {
    handleLogout();
    return;
  }

  const config = getStoredConfig();
  const markBtn = listItem.querySelector('.btn-mark-read');

  // Disable the button to prevent double-taps
  if (markBtn) {
    markBtn.disabled = true;
    markBtn.textContent = '\u2026';
  }

  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/tabs?id=eq.${tabId}`,
      {
        method: 'PATCH',
        headers: {
          ...authHeaders(token, config.anonKey),
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ is_read: true }),
      }
    );

    if (response.status === 401) {
      if (markBtn) {
        markBtn.disabled = false;
        markBtn.textContent = 'Done';
      }
      handleLogout();
      return;
    }

    if (!response.ok) {
      if (markBtn) {
        markBtn.disabled = false;
        markBtn.textContent = 'Done';
      }
      console.error('Failed to mark as read:', response.status);
      return;
    }

    // Animate removal
    listItem.classList.add('tab-item--removing');

    listItem.addEventListener('animationend', () => {
      listItem.remove();
      updateTabCount();
      if (dom.tabsList.children.length === 0) {
        dom.emptyState.hidden = false;
      }
    }, { once: true });

    // Fallback: if animationend doesn't fire
    setTimeout(() => {
      if (listItem.parentNode) {
        listItem.remove();
        updateTabCount();
        if (dom.tabsList.children.length === 0) {
          dom.emptyState.hidden = false;
        }
      }
    }, 400);
  } catch (err) {
    if (markBtn) {
      markBtn.disabled = false;
      markBtn.textContent = 'Done';
    }
    listItem.classList.remove('tab-item--removing');
    console.error('Error marking tab as read:', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Event listeners                                                   */
/* ------------------------------------------------------------------ */

dom.loginForm.addEventListener('submit', handleLogin);
dom.logoutBtn.addEventListener('click', handleLogout);
dom.refreshBtn.addEventListener('click', fetchTabs);

/* ------------------------------------------------------------------ */
/*  Init                                                              */
/* ------------------------------------------------------------------ */

(async function init() {
  const token = await getValidToken();
  if (token) {
    showApp();
  } else {
    showLogin();
  }
})();
