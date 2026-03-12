export const COOKIE_PROBE_PARAM = '__tab_reuse_cookie_probe';

export function normalizeCookieRequestPath(rawPath, fallbackUrl) {
  let path = rawPath;

  if (!path) {
    try {
      path = new URL(fallbackUrl).pathname;
    } catch (e) {
      path = '/';
    }
  }

  try {
    const absoluteUrl = new URL(path);
    path = `${absoluteUrl.pathname}${absoluteUrl.search}`;
  } catch (e) {
    // Keep relative paths as-is.
  }

  if (!path) {
    return '/';
  }

  const hashIndex = path.indexOf('#');
  if (hashIndex !== -1) {
    path = path.slice(0, hashIndex);
  }

  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  return path || '/';
}

export function cookiePathMatchesRequestPath(cookiePath, requestPath) {
  if (!cookiePath || !requestPath) {
    return false;
  }

  if (cookiePath === requestPath) {
    return true;
  }

  if (cookiePath.endsWith('/')) {
    return requestPath.startsWith(cookiePath);
  }

  return requestPath.startsWith(`${cookiePath}/`);
}

export function filterCookiesForRequest(allCookies, requestPath) {
  return allCookies
    .filter((cookie) => cookiePathMatchesRequestPath(cookie.path, requestPath))
    .sort((a, b) => b.path.length - a.path.length);
}

export function buildCookieProbeUrl(tabUrl, cookiePath, nonce) {
  const tab = new URL(tabUrl);
  const probePath = normalizeCookieRequestPath(cookiePath, tabUrl);
  const probeUrl = new URL(probePath, tab.origin);
  probeUrl.searchParams.set(COOKIE_PROBE_PARAM, nonce);
  return probeUrl.toString();
}

export function getCookieHeaderValue(requestHeaders = []) {
  const cookieHeader = requestHeaders.find(
    (header) => header && typeof header.name === 'string' && header.name.toLowerCase() === 'cookie'
  );

  return cookieHeader?.value || '';
}

export function getRequestPathFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.pathname}${urlObj.search}` || '/';
  } catch (e) {
    return null;
  }
}

export function pruneRecentCookieRequests(requests = [], now = Date.now(), ttlMs = 0) {
  if (ttlMs <= 0) {
    return [...requests];
  }

  return requests.filter((request) => request && now - request.time <= ttlMs);
}

export function requestPathMatchesRecord(requestPath, record) {
  if (!requestPath || !record?.requestPath || !record?.pathname) {
    return false;
  }

  if (requestPath.includes('?')) {
    return record.requestPath === requestPath;
  }

  if (record.pathname === requestPath) {
    return true;
  }

  return cookiePathMatchesRequestPath(requestPath, record.pathname);
}

export function findBestRecentCookieRequest(requests = [], requestPath) {
  if (!requestPath) {
    return null;
  }

  return requests.find((request) => requestPathMatchesRecord(requestPath, request)) || null;
}
