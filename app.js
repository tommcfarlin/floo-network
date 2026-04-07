/**
 * Floo — App entry point
 *
 * Handles service worker registration, authentication,
 * reading list display, and mark-as-read functionality.
 * All Supabase communication uses raw fetch — no JS client.
 *
 * Supabase URL and anon key are provided by config.js (FLOO_CONFIG).
 * Auth uses Google SSO via Supabase OAuth (implicit flow).
 * Only auth tokens and user email are stored in localStorage.
 */

/* ------------------------------------------------------------------ */
/*  Utilities                                                         */
/* ------------------------------------------------------------------ */

/**
 * Decode HTML entities in a string (e.g. &amp; → &).
 * Some sites emit raw entities in their <title> tag.
 *
 * @param {string} str
 * @return {string}
 */
function decodeHtmlEntities(str) {
  const el = document.createElement('textarea');
  el.innerHTML = str;
  return el.value;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const STORAGE_KEYS = Object.freeze({
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
  googleSigninBtn: document.getElementById('google-signin-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  userEmail: document.getElementById('user-email'),
  tabsList: document.getElementById('tabs-list'),
  emptyState: document.getElementById('empty-state'),
  loadingIndicator: document.getElementById('loading-indicator'),
  tabCount: document.getElementById('tab-count'),
  fetchError: document.getElementById('fetch-error'),
  filterBar: document.getElementById('filter-bar'),
};

/* ------------------------------------------------------------------ */
/*  Service worker registration                                       */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
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
    supabaseUrl: FLOO_CONFIG.SUPABASE_URL,
    anonKey: FLOO_CONFIG.SUPABASE_ANON_KEY,
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
  if (!config.refreshToken) {
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
 * @param {string} token    Access token.
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
/*  Login — Google SSO                                                */
/* ------------------------------------------------------------------ */

/**
 * Redirect the user to Supabase's Google OAuth authorize endpoint.
 * Supabase will handle the Google consent screen and redirect back
 * to the PWA with tokens in the URL fragment (implicit flow).
 */
function handleGoogleSignIn() {
  const config = getStoredConfig();
  const redirectTo = encodeURIComponent(window.location.origin + window.location.pathname);
  window.location.href = `${config.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}`;
}

/**
 * Extract the email from a Supabase JWT access token.
 * The payload is a base64url-encoded JSON object.
 *
 * @param {string} token  JWT access token.
 * @return {string|null}  Email string, or null if not found.
 */
function emailFromJwt(token) {
  try {
    const payload = token.split('.')[1];
    // base64url → base64, then decode
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(json);
    return data.email || null;
  } catch {
    return null;
  }
}

/**
 * Check whether the current URL fragment contains an OAuth callback
 * from Supabase (access_token, refresh_token, expires_at).
 * If so, parse and persist the tokens, clean the URL, and return true.
 *
 * @return {boolean} True if an OAuth callback was detected and handled.
 */
function handleOAuthCallback() {
  const hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) {
    return false;
  }

  // Parse key=value pairs from the fragment (strip leading #)
  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const expiresAt = params.get('expires_at');

  if (!accessToken) {
    return false;
  }

  const email = emailFromJwt(accessToken);
  saveTokens(
    {
      access_token: accessToken,
      refresh_token: refreshToken || '',
      expires_at: parseInt(expiresAt || '0', 10),
    },
    email
  );

  // Remove the fragment from the URL so it is not re-processed on reload
  history.replaceState(null, '', window.location.pathname + window.location.search);

  return true;
}

/* ------------------------------------------------------------------ */
/*  Screen management                                                 */
/* ------------------------------------------------------------------ */

function showLogin() {
  dom.loginScreen.hidden = false;
  dom.appContent.hidden = true;
  dom.logoutBtn.hidden = true;
  dom.filterBar.hidden = true;
}

function showApp() {
  dom.loginScreen.hidden = true;
  dom.appContent.hidden = false;
  dom.logoutBtn.hidden = false;
  dom.filterBar.hidden = false;

  // Reset filter manually rather than calling setFilter('all') because allTabs
  // is empty here — calling setFilter would trigger renderTabs([]) and briefly
  // flash the empty state before fetchTabs() resolves.
  activeFilter = 'all';
  document.querySelectorAll('.filter-tab').forEach((btn) => {
    btn.classList.toggle('filter-tab--active', btn.dataset.filter === 'all');
  });

  const config = getStoredConfig();
  dom.userEmail.textContent = config.email || '';

  fetchTabs();
}

function handleLogout() {
  clearAuth();
  allTabs = [];
  activeFilter = 'all';
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
 * Infer a content type from a URL.
 * Rules are checked in priority order; 'article' is the default.
 *
 * @param {string} url  Full URL.
 * @return {'video'|'thread'|'article'|'other'}
 */
function detectType(url) {
  let hostname, pathname;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.replace(/^www\./, '');
    pathname = parsed.pathname;
  } catch {
    return 'article';
  }

  // Video
  const videoDomains = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv'];
  if (videoDomains.includes(hostname)) return 'video';
  if (hostname === 'instagram.com' && pathname.startsWith('/reel/')) return 'video';

  // Thread
  if (
    (hostname === 'x.com' || hostname === 'twitter.com') &&
    /^\/[^/]+\/status\//.test(pathname)
  ) return 'thread';
  if (hostname === 'reddit.com' && /\/r\/[^/]+\/comments\//.test(pathname)) return 'thread';
  if (hostname === 'threads.net') return 'thread';

  // Other
  const otherDomains = ['github.com', 'stackoverflow.com', 'stackexchange.com'];
  if (otherDomains.includes(hostname)) return 'other';
  if (hostname.startsWith('docs.') || hostname === 'developer.apple.com') return 'other';

  return 'article';
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

    allTabs = await response.json();
    const filtered =
      activeFilter === 'all'
        ? allTabs
        : allTabs.filter((tab) => detectType(tab.url) === activeFilter);
    renderTabs(filtered);
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
  closeOpenSwipeItem();

  if (!tabs || tabs.length === 0) {
    dom.emptyState.hidden = false;
    return;
  }

  dom.emptyState.hidden = true;

  tabs.forEach((tab) => {
    const li = document.createElement('li');
    li.className = 'tab-item';
    li.dataset.tabId = tab.id;

    // Action buttons sit behind the content, revealed on left-swipe
    const swipeActions = document.createElement('div');
    swipeActions.className = 'tab-swipe-actions';
    buildSwipeActions(tab.id, li, swipeActions);

    // Sliding content layer
    const content = document.createElement('div');
    content.className = 'tab-item-content';

    const link = document.createElement('a');
    link.href = tab.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'tab-link';

    const faviconEl = document.createElement('img');
    faviconEl.className = 'tab-favicon';
    faviconEl.src = `https://www.google.com/s2/favicons?domain=${extractDomain(tab.url)}&sz=32`;
    faviconEl.alt = '';
    faviconEl.width = 20;
    faviconEl.height = 20;
    faviconEl.addEventListener('error', () => { faviconEl.hidden = true; });

    const textEl = document.createElement('span');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = decodeHtmlEntities(tab.title || tab.url);

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

    textEl.appendChild(titleEl);
    textEl.appendChild(metaEl);

    link.appendChild(faviconEl);
    link.appendChild(textEl);
    content.appendChild(link);

    li.appendChild(swipeActions);
    li.appendChild(content);

    attachSwipeGesture(li);
    dom.tabsList.appendChild(li);
  });
}

/**
 * Update the tab count badge in the toolbar.
 */
function updateTabCount() {
  const count = allTabs.length;
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
 * @param {string} tabId      The tab's UUID.
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

    // Haptic feedback on success (supported in Safari 16.4+)
    if (navigator.vibrate) {
      navigator.vibrate(10);
    }

    allTabs = allTabs.filter((t) => t.id !== tabId);

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
/*  Swipe-to-reveal                                                   */
/* ------------------------------------------------------------------ */

const SWIPE_ACTIONS_WIDTH = 136; // px — must match --swipe-actions-width in CSS
let allTabs = [];
let activeFilter = 'all';
let openSwipeItem = null;

function closeOpenSwipeItem() {
  if (!openSwipeItem) return;
  const content = openSwipeItem.querySelector('.tab-item-content');
  if (content) {
    content.style.transition = '';
    content.style.transform = '';
  }
  openSwipeItem.classList.remove('tab-item--open');
  openSwipeItem = null;
}

/**
 * Set the active filter and re-render the visible list.
 *
 * @param {string} filter  One of 'all', 'article', 'video', 'thread', 'other'.
 */
function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-tab').forEach((btn) => {
    btn.classList.toggle('filter-tab--active', btn.dataset.filter === filter);
  });
  const filtered =
    filter === 'all'
      ? allTabs
      : allTabs.filter((tab) => detectType(tab.url) === filter);
  renderTabs(filtered);
}

/**
 * Build (or rebuild) the Done + Delete buttons inside the swipe actions panel.
 * Called on initial render and after a delete confirmation is cancelled.
 */
function buildSwipeActions(tabId, li, swipeActionsEl) {
  swipeActionsEl.innerHTML = '';

  const markBtn = document.createElement('button');
  markBtn.className = 'btn-mark-read';
  markBtn.textContent = 'Done';
  markBtn.setAttribute('aria-label', 'Mark as read');
  markBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    markAsRead(tabId, li);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.setAttribute('aria-label', 'Delete');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDelete(tabId, li, swipeActionsEl);
  });

  swipeActionsEl.appendChild(markBtn);
  swipeActionsEl.appendChild(deleteBtn);
}

/**
 * Replace swipe actions with Sure?/No confirmation buttons.
 * Tapping No rebuilds the original Done/Delete buttons.
 */
function confirmDelete(tabId, li, swipeActionsEl) {
  swipeActionsEl.innerHTML = '';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-delete-confirm';
  confirmBtn.textContent = 'Sure?';
  confirmBtn.setAttribute('aria-label', 'Confirm delete');
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTab(tabId, li);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-delete-cancel';
  cancelBtn.textContent = 'No';
  cancelBtn.setAttribute('aria-label', 'Cancel delete');
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    buildSwipeActions(tabId, li, swipeActionsEl);
  });

  swipeActionsEl.appendChild(confirmBtn);
  swipeActionsEl.appendChild(cancelBtn);
}

/**
 * Attach touch-based swipe-to-reveal gesture to a list item.
 * Left-swipe reveals Done/Delete; right-swipe or content-tap closes.
 * Only one item can be open at a time.
 *
 * @param {HTMLElement} li  The .tab-item <li> element.
 */
function attachSwipeGesture(li) {
  const content = li.querySelector('.tab-item-content');
  let startX = 0;
  let startY = 0;
  let currentTranslate = 0;
  let isTracking = false;
  let isHorizontal = null;

  content.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentTranslate = li.classList.contains('tab-item--open') ? -SWIPE_ACTIONS_WIDTH : 0;
    isTracking = true;
    isHorizontal = null;
    content.style.transition = 'none';
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!isTracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    // Wait for enough movement to determine direction
    if (isHorizontal === null) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      isHorizontal = Math.abs(dx) >= Math.abs(dy);
    }

    if (!isHorizontal) {
      isTracking = false;
      return;
    }

    e.preventDefault();
    const base = li.classList.contains('tab-item--open') ? -SWIPE_ACTIONS_WIDTH : 0;
    currentTranslate = Math.min(0, Math.max(-SWIPE_ACTIONS_WIDTH, base + dx));
    content.style.transform = `translateX(${currentTranslate}px)`;
  }, { passive: false });

  content.addEventListener('touchend', () => {
    if (!isTracking || !isHorizontal) {
      isTracking = false;
      return;
    }
    isTracking = false;
    content.style.transition = '';

    if (currentTranslate < -(SWIPE_ACTIONS_WIDTH / 2)) {
      if (openSwipeItem && openSwipeItem !== li) closeOpenSwipeItem();
      content.style.transform = `translateX(-${SWIPE_ACTIONS_WIDTH}px)`;
      li.classList.add('tab-item--open');
      openSwipeItem = li;
    } else {
      content.style.transform = '';
      li.classList.remove('tab-item--open');
      if (openSwipeItem === li) openSwipeItem = null;
    }
  });

  // Tap on content while open → close
  content.addEventListener('click', () => {
    if (li.classList.contains('tab-item--open')) {
      closeOpenSwipeItem();
    }
  });
}

/**
 * Delete a tab permanently via Supabase DELETE, then remove from DOM.
 *
 * @param {string}      tabId     The tab's UUID.
 * @param {HTMLElement} listItem  The <li> to remove on success.
 */
async function deleteTab(tabId, listItem) {
  const token = await getValidToken();
  if (!token) {
    handleLogout();
    return;
  }

  const config = getStoredConfig();

  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/tabs?id=eq.${tabId}`,
      {
        method: 'DELETE',
        headers: {
          ...authHeaders(token, config.anonKey),
          'Prefer': 'return=minimal',
        },
      }
    );

    if (response.status === 401) {
      handleLogout();
      return;
    }

    if (!response.ok) {
      console.error('Failed to delete tab:', response.status);
      return;
    }

    if (navigator.vibrate) {
      navigator.vibrate(10);
    }

    allTabs = allTabs.filter((t) => t.id !== tabId);

    listItem.classList.add('tab-item--removing');
    listItem.addEventListener('animationend', () => {
      listItem.remove();
      updateTabCount();
      if (dom.tabsList.children.length === 0) {
        dom.emptyState.hidden = false;
      }
    }, { once: true });

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
    console.error('Error deleting tab:', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Event listeners                                                   */
/* ------------------------------------------------------------------ */

dom.googleSigninBtn.addEventListener('click', handleGoogleSignIn);
dom.logoutBtn.addEventListener('click', handleLogout);
dom.refreshBtn.addEventListener('click', fetchTabs);
document.querySelectorAll('.filter-tab').forEach((btn) => {
  btn.addEventListener('click', () => setFilter(btn.dataset.filter));
});

// Auto-refresh when the user switches back to the app (e.g. after saving
// a tab in Brave and returning to the PWA to find their list updated).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !dom.appContent.hidden) {
    fetchTabs();
  }
});

/* ------------------------------------------------------------------ */
/*  Init                                                              */
/* ------------------------------------------------------------------ */

(async function init() {
  // Handle OAuth callback first — Supabase redirects back here with
  // tokens in the URL fragment after the Google consent screen.
  const wasCallback = handleOAuthCallback();

  const token = await getValidToken();
  if (token) {
    showApp();
  } else {
    if (wasCallback) {
      // Callback was detected but we still could not get a valid token —
      // something went wrong during the OAuth flow.
      console.error('OAuth callback detected but no valid token found.');
    }
    showLogin();
  }
})();
