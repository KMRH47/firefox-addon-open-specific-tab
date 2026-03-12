import {
  getDomain,
  hasReuseFlag,
  removeReuseFlag,
  getRunJSCode,
  hasRunJSFlag,
  parseRunJSCommand,
  removeRunJSFlag,
  getCloseTabsPatterns,
  hasCloseTabsFlag,
  removeCloseTabsFlag,
  matchWildcard,
  normalizeUrlForComparison,
  isRootUrl,
  isPathPrefix,
} from './url-utils.js';
import { getLowestTabIndex } from './tab-utils.js';
import {
  COOKIE_PROBE_PARAM,
  buildCookieProbeUrl,
  findBestRecentCookieRequest,
  getCookieHeaderValue,
  getRequestPathFromUrl,
  normalizeCookieRequestPath,
  pruneRecentCookieRequests,
  requestPathMatchesRecord,
} from './cookie-utils.js';

const handledTabs = new Set();
const RECENT_COOKIE_REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_COOKIE_REQUESTS = 200;
const recentCookieRequests = [];
const PENDING_EXACT_COPY_TIMEOUT_MS = 60 * 1000;
const pendingExactCookieCopies = new Map();

browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

function rememberRecentCookieRequest(details) {
  const cookieHeader = getCookieHeaderValue(details.requestHeaders);
  if (!cookieHeader) {
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(details.url);
    if (!/^https?:$/.test(requestUrl.protocol)) {
      return;
    }
  } catch (error) {
    return;
  }

  const requestPath = getRequestPathFromUrl(details.url);
  const domain = getDomain(details.url);
  if (!requestPath) {
    return;
  }
  if (!domain) {
    return;
  }

  const now = Date.now();
  const existingRequests = pruneRecentCookieRequests(
    recentCookieRequests,
    now,
    RECENT_COOKIE_REQUEST_TTL_MS
  );
  const dedupedRequests = existingRequests.filter((request) => (
    request.requestPath !== requestPath ||
    request.domain !== domain ||
    request.cookieStoreId !== (details.cookieStoreId || null)
  ));
  recentCookieRequests.length = 0;
  recentCookieRequests.push({
    requestPath,
    pathname: requestPath.split('?')[0],
    domain,
    cookieStoreId: details.cookieStoreId || null,
    tabId: details.tabId,
    isProbe: requestUrl.searchParams.has(COOKIE_PROBE_PARAM),
    isInternalCommand:
      requestUrl.searchParams.has('__reuse_tab') ||
      requestUrl.searchParams.has('__run_js') ||
      requestUrl.searchParams.has('__close_tabs'),
    probeNonce: requestUrl.searchParams.get(COOKIE_PROBE_PARAM),
    cookieHeader,
    time: now,
  }, ...dedupedRequests.slice(0, MAX_RECENT_COOKIE_REQUESTS - 1));

  const pendingEntries = [...pendingExactCookieCopies.entries()];
  for (const [pendingId, pending] of pendingEntries) {
    if (pending.domain !== domain) {
      continue;
    }

    if (pending.cookieStoreId && details.cookieStoreId && pending.cookieStoreId !== details.cookieStoreId) {
      continue;
    }

    if (!requestPathMatchesRecord(pending.requestPath, {
      requestPath,
      pathname: requestPath.split('?')[0],
    })) {
      continue;
    }

    clearTimeout(pending.timeoutId);
    pendingExactCookieCopies.delete(pendingId);
    copyTextToClipboard(pending.targetTabId, cookieHeader).catch((error) => {
      console.error('[Tab Reuse] Error copying deferred cookies:', error);
    });
  }
}

function getRecentCookieRequests(tab, options = {}) {
  const existingRequests = pruneRecentCookieRequests(
    recentCookieRequests,
    Date.now(),
    RECENT_COOKIE_REQUEST_TTL_MS
  );
  recentCookieRequests.length = 0;
  recentCookieRequests.push(...existingRequests);

  const tabDomain = getDomain(tab.url);
  if (!tabDomain) {
    return [];
  }

  return existingRequests.filter((request) => {
    if (request.domain !== tabDomain) {
      return false;
    }

    if (request.cookieStoreId && tab.cookieStoreId) {
      return request.cookieStoreId === tab.cookieStoreId;
    }

    if (!options.includeProbes && request.isProbe) {
      return false;
    }

    if (!options.includeInternalCommands && request.isInternalCommand) {
      return false;
    }

    return true;
  });
}

async function copyTextToClipboard(tabId, text) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: (value) => {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    },
    args: [text],
  });
}

function getObservedCookieRequest(tab, requestPath) {
  const recentRequests = getRecentCookieRequests(tab);
  const matchedRequest = findBestRecentCookieRequest(recentRequests, requestPath);
  return { recentRequests, matchedRequest };
}

function createCookieProbeNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function triggerCookieProbe(tabId, probeUrl) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: async (url) => {
      try {
        await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
      } catch (error) {
        // Ignore probe failures. The sent headers are what matters.
      }
    },
    args: [probeUrl],
  });
}

async function captureProbeCookieRequest(tab, cookiePath) {
  const probeNonce = createCookieProbeNonce();
  const probeUrl = buildCookieProbeUrl(tab.url, cookiePath, probeNonce);
  await triggerCookieProbe(tab.id, probeUrl);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const probeRequests = getRecentCookieRequests(tab, {
      includeProbes: true,
      includeInternalCommands: false,
    });
    const matchedProbeRequest = probeRequests.find((request) => request.probeNonce === probeNonce);
    if (matchedProbeRequest) {
      return matchedProbeRequest;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return null;
}

async function copyCookiesExact(tabId, cookiePath) {
  const tab = await browser.tabs.get(tabId);
  const requestPath = normalizeCookieRequestPath(cookiePath, tab.url);
  const { matchedRequest } = getObservedCookieRequest(tab, requestPath);

  if (!matchedRequest?.cookieHeader) {
    for (const [pendingId, pending] of pendingExactCookieCopies.entries()) {
      if (pending.targetTabId === tabId && pending.requestPath === requestPath) {
        clearTimeout(pending.timeoutId);
        pendingExactCookieCopies.delete(pendingId);
      }
    }

    const pendingId = `${tabId}:${requestPath}:${Date.now()}`;
    const timeoutId = setTimeout(() => {
      pendingExactCookieCopies.delete(pendingId);
      console.warn('[Tab Reuse] Timed out waiting for observed Cookie header', {
        tabId,
        requestPath,
      });
    }, PENDING_EXACT_COPY_TIMEOUT_MS);

    pendingExactCookieCopies.set(pendingId, {
      targetTabId: tabId,
      requestPath,
      domain: getDomain(tab.url),
      cookieStoreId: tab.cookieStoreId || null,
      timeoutId,
    });

    console.info('[Tab Reuse] Waiting for next observed Cookie header', {
      tabId,
      requestPath,
      timeoutMs: PENDING_EXACT_COPY_TIMEOUT_MS,
    });
    return null;
  }

  await copyTextToClipboard(tabId, matchedRequest.cookieHeader);
  return matchedRequest.cookieHeader;
}

async function copyCookies(tabId, cookiePath) {
  try {
    const tab = await browser.tabs.get(tabId);
    const requestPath = normalizeCookieRequestPath(cookiePath, tab.url);
    const { matchedRequest } = getObservedCookieRequest(tab, requestPath);
    if (matchedRequest?.cookieHeader) {
      await copyTextToClipboard(tabId, matchedRequest.cookieHeader);
      return matchedRequest.cookieHeader;
    }

    const probeRequest = await captureProbeCookieRequest(tab, cookiePath);
    if (!probeRequest?.cookieHeader) {
      console.error('[Tab Reuse] Probe request did not yield a Cookie header', {
        tabId,
        requestPath,
      });
      return null;
    }

    await copyTextToClipboard(tabId, probeRequest.cookieHeader);
    return probeRequest.cookieHeader;
  } catch (error) {
    console.error('[Tab Reuse] Error copying cookies:', error);
    return null;
  }
}

async function deleteCookie(tabId, cookieName) {
  try {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: (name) => {
        let deleted = false;

        if (localStorage.getItem(name) !== null) {
          localStorage.removeItem(name);
          deleted = true;
        }

        if (sessionStorage.getItem(name) !== null) {
          sessionStorage.removeItem(name);
          deleted = true;
        }

        return deleted;
      },
      args: [cookieName]
    });

    if (result[0].result) {
      console.log(`[Tab Reuse] Deleted storage item: ${cookieName}`);
    } else {
      console.log(`[Tab Reuse] Storage item not found: ${cookieName}`);
    }
  } catch (error) {
    console.error('[Tab Reuse] Error deleting storage item:', error);
  }
}

async function deleteCookiesByPrefix(tabId, prefix) {
  try {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: (prefix) => {
        const localStorageKeys = Object.keys(localStorage);
        const sessionStorageKeys = Object.keys(sessionStorage);

        const localKeysToDelete = localStorageKeys.filter(k => k.startsWith(prefix));
        for (const key of localKeysToDelete) {
          localStorage.removeItem(key);
        }

        const sessionKeysToDelete = sessionStorageKeys.filter(k => k.startsWith(prefix));
        for (const key of sessionKeysToDelete) {
          sessionStorage.removeItem(key);
        }

        return {
          deletedLocal: localKeysToDelete,
          deletedSession: sessionKeysToDelete
        };
      },
      args: [prefix]
    });

    const data = result[0].result;
    const totalDeleted = data.deletedLocal.length + data.deletedSession.length;
    console.log(`[Tab Reuse] Deleted ${totalDeleted} storage items with prefix '${prefix}'`);
    if (data.deletedLocal.length > 0) {
      console.log(`[Tab Reuse] localStorage:`, data.deletedLocal);
    }
    if (data.deletedSession.length > 0) {
      console.log(`[Tab Reuse] sessionStorage:`, data.deletedSession);
    }
  } catch (error) {
    console.error('[Tab Reuse] Error deleting storage items by prefix:', error);
  }
}

async function handleTabReuse(tabId, url) {
  if (handledTabs.has(tabId)) return;
  handledTabs.add(tabId);

  const jsCode = getRunJSCode(url);
  const closeTabPatterns = getCloseTabsPatterns(url);
  const { command, value } = parseRunJSCommand(jsCode);
  let cleanUrl = removeReuseFlag(url);
  cleanUrl = removeRunJSFlag(cleanUrl);
  cleanUrl = removeCloseTabsFlag(cleanUrl);
  const normalizedCleanUrl = normalizeUrlForComparison(cleanUrl);
  const allTabs = await browser.tabs.query({});
  const existingTabs = allTabs.filter(t => t.id !== tabId);

  const executeCommand = async (targetTabId) => {
    if (!command) return;

    if (command === 'copy_cookies') {
      await new Promise(resolve => setTimeout(resolve, 100));
      await copyCookies(targetTabId, value);
    } else if (command === 'copy_cookies_exact') {
      await new Promise(resolve => setTimeout(resolve, 100));
      await copyCookiesExact(targetTabId, value);
    } else if (command === 'delete_cookie' && value) {
      await deleteCookie(targetTabId, value);
    } else if (command === 'delete_cookies' && value) {
      await deleteCookiesByPrefix(targetTabId, value);
    }
  };

  let closedTabIndex = null;
  if (closeTabPatterns.length > 0) {
    const tabsToClose = existingTabs.filter((tab) => {
      if (!tab.url) return false;
      return closeTabPatterns.some((pattern) => matchWildcard(pattern, tab.url));
    });

    if (tabsToClose.length > 0) {
      closedTabIndex = getLowestTabIndex(tabsToClose);
      await Promise.all(tabsToClose.map((tab) => browser.tabs.remove(tab.id)));
    }
  }

  const refreshedTabs = closeTabPatterns.length > 0
    ? (await browser.tabs.query({})).filter((tab) => tab.id !== tabId)
    : existingTabs;

  const exactMatch = refreshedTabs.find(t => {
    if (!t.url) return false;
    const normalizedTabUrl = normalizeUrlForComparison(t.url);
    return normalizedTabUrl === normalizedCleanUrl;
  });

  if (exactMatch) {
    await browser.tabs.update(exactMatch.id, { active: true });
    await browser.windows.update(exactMatch.windowId, { focused: true });
    await executeCommand(exactMatch.id);
    await browser.tabs.remove(tabId);
    setTimeout(() => handledTabs.delete(tabId), 5000);
    return;
  }

  const prefixMatch = refreshedTabs.find(t => {
    if (!t.url) return false;
    return isPathPrefix(cleanUrl, t.url);
  });
  if (prefixMatch) {
    await browser.tabs.update(prefixMatch.id, { active: true });
    await browser.windows.update(prefixMatch.windowId, { focused: true });
    await executeCommand(prefixMatch.id);
    await browser.tabs.remove(tabId);
    setTimeout(() => handledTabs.delete(tabId), 5000);
    return;
  }

  if (isRootUrl(cleanUrl)) {
    const domain = getDomain(cleanUrl);
    if (domain) {
      const domainMatch = refreshedTabs.find(t => {
        if (!t.url) return false;
        return getDomain(t.url) === domain;
      });
      if (domainMatch) {
        await browser.tabs.update(domainMatch.id, { active: true });
        await browser.windows.update(domainMatch.windowId, { focused: true });
        await executeCommand(domainMatch.id);
        await browser.tabs.remove(tabId);
        setTimeout(() => handledTabs.delete(tabId), 5000);
        return;
      }
    }
  }

  if (closedTabIndex !== null) {
    try {
      await browser.tabs.move(tabId, { index: closedTabIndex });
    } catch (error) {
      console.warn('[Tab Reuse] Unable to move tab after closing tabs:', error);
    }
  }

  await browser.tabs.update(tabId, { url: cleanUrl });
  if (command) {
    browser.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        executeCommand(tabId);
        browser.tabs.onUpdated.removeListener(listener);
      }
    });
  }
  setTimeout(() => handledTabs.delete(tabId), 5000);
}

browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (hasReuseFlag(details.url) || hasCloseTabsFlag(details.url) || hasRunJSFlag(details.url)) {
    await handleTabReuse(details.tabId, details.url);
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.url && getDomain(tab.url) && (hasReuseFlag(tab.url) || hasCloseTabsFlag(tab.url) || hasRunJSFlag(tab.url))) {
    await handleTabReuse(tab.id, tab.url);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url && getDomain(tab.url) && (hasReuseFlag(tab.url) || hasCloseTabsFlag(tab.url) || hasRunJSFlag(tab.url))) {
    await handleTabReuse(tabId, tab.url);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  const remainingRequests = recentCookieRequests.filter((request) => request.tabId !== tabId);
  recentCookieRequests.length = 0;
  recentCookieRequests.push(...remainingRequests);

  for (const [pendingId, pending] of pendingExactCookieCopies.entries()) {
    if (pending.targetTabId !== tabId) {
      continue;
    }
    clearTimeout(pending.timeoutId);
    pendingExactCookieCopies.delete(pendingId);
  }
});

browser.webRequest.onSendHeaders.addListener(
  rememberRecentCookieRequest,
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);
