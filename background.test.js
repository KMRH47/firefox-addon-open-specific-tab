import assert from 'assert';
import fc from 'fast-check';
import {
  normalizeHostname,
  getDomain,
  hasReuseFlag,
  removeReuseFlag,
  getRunJSCode,
  hasRunJSFlag,
  hasCloseTabsFlag,
  parseRunJSCommand,
  removeRunJSFlag,
  getCloseTabsPatterns,
  removeCloseTabsFlag,
  matchWildcard,
  normalizeUrlForComparison,
  isRootUrl,
  isPathPrefix,
} from './url-utils.js';
import { getLowestTabIndex } from './tab-utils.js';
import {
  buildCookieProbeUrl,
  findBestRecentCookieRequest,
  cookiePathMatchesRequestPath,
  filterCookiesForRequest,
  getCookieHeaderValue,
  getRequestPathFromUrl,
  normalizeCookieRequestPath,
  pruneRecentCookieRequests,
  requestPathMatchesRecord,
} from './cookie-utils.js';

const stripScheme = (url) => url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wildcardToRegExp = (pattern) => new RegExp('^' + escapeRegExp(pattern).replace(/\\\*/g, '.*') + '$');
const matchWildcardPattern = (pattern, url) => wildcardToRegExp(pattern).test(url);
const matchesAnyPattern = (url, patterns) => {
  for (const raw of patterns) {
    const pattern = String(raw || '').trim();
    if (!pattern) continue;
    if (pattern.startsWith('#')) continue;
    if (matchWildcardPattern(pattern, url)) return true;
    if (!pattern.includes('://')) {
      if (matchWildcardPattern(pattern, stripScheme(url))) return true;
    }
  }
  return false;
};

const charGen = (chars) => fc.integer({ min: 0, max: chars.length - 1 }).map(i => chars[i]);
const stringGen = (chars, minLen = 1, maxLen = 20) =>
  fc.array(charGen(chars), { minLength: minLen, maxLength: maxLen }).map(arr => arr.join(''));

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
const ALPHANUM = ALPHA + '0123456789';
const SPECIAL = ':;/?@&=+$,{}[]()<>#%"\'^~`|!* \t';

const tests = {
  'normalizeUrlForComparison: handles special characters in query params': () => {
    const withFlag = 'https://tracker.example.com/agiles/141-18/current?query=has:%20-%7BSubtask%20of%7D%20or%20Subtask%20of:%20(type:%20Epic)&__reuse_tab=1';
    const withoutFlag = 'https://tracker.example.com/agiles/141-18/current?query=has%3A%20-%7BSubtask%20of%7D%20or%20Subtask%20of%3A%20(type%3A%20Epic)';
    assert.strictEqual(normalizeUrlForComparison(withFlag), normalizeUrlForComparison(withoutFlag));
  },

  'normalizeUrlForComparison: different encodings of same content match': () => {
    const encoded1 = 'https://example.com?q=hello%20world';
    const encoded2 = 'https://example.com?q=hello+world';
    assert.strictEqual(normalizeUrlForComparison(encoded1), normalizeUrlForComparison(encoded2));
  },

  'normalizeUrlForComparison: removes __reuse_tab param': () => {
    const url = 'https://example.com/path?foo=bar&__reuse_tab=1';
    const normalized = normalizeUrlForComparison(url);
    assert.ok(!normalized.includes('__reuse_tab'));
    assert.ok(normalized.includes('foo=bar'));
  },

  'normalizeUrlForComparison: removes __run_js param': () => {
    const url = 'https://example.com?__run_js=delete_cookies=test&other=value';
    const normalized = normalizeUrlForComparison(url);
    assert.ok(!normalized.includes('__run_js'));
    assert.ok(normalized.includes('other=value'));
  },

  'normalizeUrlForComparison: removes __close_tabs param': () => {
    const url = 'https://example.com?__close_tabs=login.microsoftonline.com/*&other=value';
    const normalized = normalizeUrlForComparison(url);
    assert.ok(!normalized.includes('__close_tabs'));
    assert.ok(normalized.includes('other=value'));
  },

  'normalizeUrlForComparison: sorts query params for consistent comparison': () => {
    const url1 = 'https://example.com?b=2&a=1';
    const url2 = 'https://example.com?a=1&b=2';
    assert.strictEqual(normalizeUrlForComparison(url1), normalizeUrlForComparison(url2));
  },

  'normalizeUrlForComparison: sorts duplicate query keys consistently': () => {
    const url1 = 'https://example.com?ids=1&ids=2';
    const url2 = 'https://example.com?ids=2&ids=1';
    assert.strictEqual(normalizeUrlForComparison(url1), normalizeUrlForComparison(url2));
  },

  'normalizeUrlForComparison: removes trailing slash': () => {
    const withSlash = 'https://example.com/path/';
    const withoutSlash = 'https://example.com/path';
    assert.strictEqual(normalizeUrlForComparison(withSlash), normalizeUrlForComparison(withoutSlash));
  },

  'normalizeUrlForComparison: removes multiple trailing slashes': () => {
    const withSlashes = 'https://example.com/path///';
    const withoutSlash = 'https://example.com/path';
    assert.strictEqual(normalizeUrlForComparison(withSlashes), normalizeUrlForComparison(withoutSlash));
  },

  'normalizeUrlForComparison: normalizes www prefix': () => {
    const withWww = 'https://www.example.com/path';
    const withoutWww = 'https://example.com/path';
    assert.strictEqual(normalizeUrlForComparison(withWww), normalizeUrlForComparison(withoutWww));
  },

  'normalizeUrlForComparison: handles colons in query values': () => {
    const url1 = 'https://example.com?filter=type:epic';
    const url2 = 'https://example.com?filter=type%3Aepic';
    assert.strictEqual(normalizeUrlForComparison(url1), normalizeUrlForComparison(url2));
  },

  'normalizeUrlForComparison: handles parentheses in query values': () => {
    const url1 = 'https://example.com?q=(test)';
    const url2 = 'https://example.com?q=%28test%29';
    assert.strictEqual(normalizeUrlForComparison(url1), normalizeUrlForComparison(url2));
  },

  'normalizeUrlForComparison: handles curly braces in query values': () => {
    const url1 = 'https://example.com?q={test}';
    const url2 = 'https://example.com?q=%7Btest%7D';
    assert.strictEqual(normalizeUrlForComparison(url1), normalizeUrlForComparison(url2));
  },

  'hasReuseFlag: returns true when flag present': () => {
    assert.strictEqual(hasReuseFlag('https://example.com?__reuse_tab=1'), true);
    assert.strictEqual(hasReuseFlag('https://example.com?foo=bar&__reuse_tab=1'), true);
  },

  'hasReuseFlag: returns false when flag absent': () => {
    assert.strictEqual(hasReuseFlag('https://example.com'), false);
    assert.strictEqual(hasReuseFlag('https://example.com?foo=bar'), false);
  },

  'hasReuseFlag: works with complex query strings': () => {
    const url = 'https://tracker.example.com/agiles/141-18/current?query=has:%20-%7BSubtask%20of%7D&__reuse_tab=1';
    assert.strictEqual(hasReuseFlag(url), true);
  },

  'hasCloseTabsFlag: returns true when flag present': () => {
    assert.strictEqual(hasCloseTabsFlag('https://example.com?__close_tabs=login.microsoftonline.com/*'), true);
    assert.strictEqual(hasCloseTabsFlag('https://example.com?foo=bar&__close_tabs=example.com/logout*'), true);
  },

  'hasCloseTabsFlag: returns false when flag absent': () => {
    assert.strictEqual(hasCloseTabsFlag('https://example.com'), false);
    assert.strictEqual(hasCloseTabsFlag('https://example.com?foo=bar'), false);
  },

  'parseRunJSCommand: parses command without value': () => {
    const result = parseRunJSCommand('copy_cookies');
    assert.deepStrictEqual(result, { command: 'copy_cookies', value: null });
  },

  'parseRunJSCommand: parses command with value': () => {
    const result = parseRunJSCommand('delete_cookie=mykey');
    assert.deepStrictEqual(result, { command: 'delete_cookie', value: 'mykey' });
  },

  'parseRunJSCommand: handles value with equals sign': () => {
    const result = parseRunJSCommand('delete_cookies=prefix=test');
    assert.deepStrictEqual(result, { command: 'delete_cookies', value: 'prefix=test' });
  },

  'parseRunJSCommand: returns nulls for empty input': () => {
    assert.deepStrictEqual(parseRunJSCommand(null), { command: null, value: null });
    assert.deepStrictEqual(parseRunJSCommand(''), { command: null, value: null });
  },

  'getRunJSCode: extracts __run_js value': () => {
    const url = 'https://example.com?__run_js=delete_cookies=weblang&__reuse_tab=1';
    assert.strictEqual(getRunJSCode(url), 'delete_cookies=weblang');
  },

  'getRunJSCode: returns null when not present': () => {
    assert.strictEqual(getRunJSCode('https://example.com?foo=bar'), null);
  },

  'hasRunJSFlag: returns true when flag present': () => {
    assert.strictEqual(hasRunJSFlag('https://example.com?__run_js=copy_cookies'), true);
    assert.strictEqual(hasRunJSFlag('https://example.com?foo=bar&__run_js=test'), true);
  },

  'hasRunJSFlag: returns false when flag absent': () => {
    assert.strictEqual(hasRunJSFlag('https://example.com'), false);
    assert.strictEqual(hasRunJSFlag('https://example.com?foo=bar'), false);
  },

  'getDomain: extracts and normalizes domain': () => {
    assert.strictEqual(getDomain('https://www.example.com/path'), 'example.com');
    assert.strictEqual(getDomain('https://Example.COM/path'), 'example.com');
  },

  'isRootUrl: detects root URLs': () => {
    assert.strictEqual(isRootUrl('https://example.com'), true);
    assert.strictEqual(isRootUrl('https://example.com/'), true);
    assert.strictEqual(isRootUrl('https://example.com/path'), false);
    assert.strictEqual(isRootUrl('https://example.com?query=1'), false);
  },

  'isPathPrefix: detects path prefixes': () => {
    assert.strictEqual(isPathPrefix('https://example.com/app', 'https://example.com/app/page'), true);
    assert.strictEqual(isPathPrefix('https://example.com/app', 'https://example.com/app'), false);
    assert.strictEqual(isPathPrefix('https://example.com/app', 'https://example.com/application'), false);
  },

  'normalizeCookieRequestPath: uses tab path when no override is provided': () => {
    assert.strictEqual(
      normalizeCookieRequestPath(null, 'https://example.com/app/list?foo=bar'),
      '/app/list'
    );
  },

  'normalizeCookieRequestPath: normalizes relative and absolute cookie paths': () => {
    assert.strictEqual(normalizeCookieRequestPath('app', 'https://example.com/'), '/app');
    assert.strictEqual(
      normalizeCookieRequestPath('https://example.com/app#hash', 'https://example.com/'),
      '/app'
    );
  },

  'cookiePathMatchesRequestPath: follows request path prefix rules': () => {
    assert.strictEqual(cookiePathMatchesRequestPath('/app', '/app'), true);
    assert.strictEqual(cookiePathMatchesRequestPath('/app', '/app/api'), true);
    assert.strictEqual(cookiePathMatchesRequestPath('/app', '/application'), false);
    assert.strictEqual(cookiePathMatchesRequestPath('/app/', '/app/api'), true);
  },

  'filterCookiesForRequest: keeps matching cookies and sorts by specificity': () => {
    const cookies = filterCookiesForRequest([
      { name: 'root', value: '1', path: '/' },
      { name: 'app', value: '2', path: '/app' },
      { name: 'nested', value: '3', path: '/app/api' },
      { name: 'other', value: '4', path: '/iam' },
    ], '/app/api/list');

    assert.deepStrictEqual(cookies.map((cookie) => cookie.name), ['nested', 'app', 'root']);
  },

  'buildCookieProbeUrl: targets the requested path and adds a nonce marker': () => {
    const probeUrl = new URL(buildCookieProbeUrl(
      'https://example.com/',
      '/app/api?x=1',
      'nonce-123'
    ));

    assert.strictEqual(probeUrl.pathname, '/app/api');
    assert.strictEqual(probeUrl.searchParams.get('x'), '1');
    assert.strictEqual(probeUrl.searchParams.get('__tab_reuse_cookie_probe'), 'nonce-123');
  },

  'getCookieHeaderValue: finds the outgoing Cookie header case-insensitively': () => {
    const header = getCookieHeaderValue([
      { name: 'Accept', value: '*/*' },
      { name: 'cookie', value: 'scoped_cookie=abc; root_cookie=bar' },
    ]);

    assert.strictEqual(header, 'scoped_cookie=abc; root_cookie=bar');
  },

  'getRequestPathFromUrl: returns pathname and search': () => {
    assert.strictEqual(
      getRequestPathFromUrl('https://example.com/app/api?x=1&y=2'),
      '/app/api?x=1&y=2'
    );
  },

  'pruneRecentCookieRequests: drops expired entries': () => {
    const pruned = pruneRecentCookieRequests([
      { requestPath: '/fresh', pathname: '/fresh', cookieHeader: 'a=1', time: 950 },
      { requestPath: '/stale', pathname: '/stale', cookieHeader: 'b=2', time: 100 },
    ], 1000, 100);

    assert.deepStrictEqual(pruned.map((request) => request.requestPath), ['/fresh']);
  },

  'requestPathMatchesRecord: supports exact request match with query': () => {
    assert.strictEqual(
      requestPathMatchesRecord('/app/api?x=1', {
        requestPath: '/app/api?x=1',
        pathname: '/app/api',
      }),
      true
    );
    assert.strictEqual(
      requestPathMatchesRecord('/app/api?x=1', {
        requestPath: '/app/api?x=2',
        pathname: '/app/api',
      }),
      false
    );
  },

  'requestPathMatchesRecord: supports path-prefix lookup without query': () => {
    assert.strictEqual(
      requestPathMatchesRecord('/app', {
        requestPath: '/app/api?x=1',
        pathname: '/app/api',
      }),
      true
    );
    assert.strictEqual(
      requestPathMatchesRecord('/app', {
        requestPath: '/application?x=1',
        pathname: '/application',
      }),
      false
    );
  },

  'findBestRecentCookieRequest: returns the newest matching request': () => {
    const result = findBestRecentCookieRequest([
      { requestPath: '/app/newer', pathname: '/app/newer', cookieHeader: 'new=1', time: 2 },
      { requestPath: '/app/older', pathname: '/app/older', cookieHeader: 'old=1', time: 1 },
    ], '/app');

    assert.strictEqual(result.cookieHeader, 'new=1');
  },

  'removeReuseFlag: removes flag from URL': () => {
    const result = removeReuseFlag('https://example.com?foo=bar&__reuse_tab=1');
    assert.ok(!result.includes('__reuse_tab'));
    assert.ok(result.includes('foo=bar'));
  },

  'removeRunJSFlag: removes flag from URL': () => {
    const result = removeRunJSFlag('https://example.com?foo=bar&__run_js=test');
    assert.ok(!result.includes('__run_js'));
    assert.ok(result.includes('foo=bar'));
  },

  'getCloseTabsPatterns: returns empty array when missing': () => {
    assert.deepStrictEqual(getCloseTabsPatterns('https://example.com?foo=bar'), []);
  },

  'getCloseTabsPatterns: parses comma-separated patterns': () => {
    const url = 'https://example.com?__close_tabs=login.microsoftonline.com/*,example.com/logout*';
    assert.deepStrictEqual(getCloseTabsPatterns(url), [
      'login.microsoftonline.com/*',
      'example.com/logout*',
    ]);
  },

  'removeCloseTabsFlag: removes param from URL': () => {
    const url = 'https://example.com?foo=bar&__close_tabs=login.microsoftonline.com/*';
    const result = removeCloseTabsFlag(url);
    assert.ok(!result.includes('__close_tabs'));
    assert.ok(result.includes('foo=bar'));
  },

  'matchWildcard: matches full URL patterns': () => {
    assert.strictEqual(
      matchWildcard('https://login.microsoftonline.com/*', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
      true
    );
  },

  'matchWildcard: matches patterns without scheme against URL': () => {
    assert.strictEqual(
      matchWildcard('login.microsoftonline.com/*', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
      true
    );
  },

  'matchWildcard: returns false for non-matching patterns': () => {
    assert.strictEqual(
      matchWildcard('example.com/logout*', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
      false
    );
  },

  'key-block patterns: matches with scheme': () => {
    const url = 'https://app.example.com/path';
    assert.strictEqual(matchesAnyPattern(url, ['https://app.example.com/*']), true);
  },

  'key-block patterns: matches without scheme': () => {
    const url = 'https://example.com/path';
    assert.strictEqual(matchesAnyPattern(url, ['example.com/*']), true);
  },

  'key-block patterns: supports subdomain wildcard': () => {
    const url = 'https://sub.example.com/app';
    assert.strictEqual(matchesAnyPattern(url, ['*.example.com/*']), true);
  },

  'key-block patterns: ignores comment lines': () => {
    const url = 'https://example.com/app';
    assert.strictEqual(matchesAnyPattern(url, ['# comment', 'example.com/*']), true);
  },

  'getLowestTabIndex: returns null for empty input': () => {
    assert.strictEqual(getLowestTabIndex([]), null);
  },

  'getLowestTabIndex: ignores invalid entries': () => {
    const result = getLowestTabIndex([{ index: 5 }, null, { index: 'bad' }]);
    assert.strictEqual(result, 5);
  },

  'getLowestTabIndex: returns lowest index': () => {
    const result = getLowestTabIndex([{ index: 7 }, { index: 2 }, { index: 9 }]);
    assert.strictEqual(result, 2);
  },

  'full flow: youtrack URL with special chars matches existing tab': () => {
    const shortcutUrl = 'https://tracker.example.com/agiles/141-18/current?query=has:%20-%7BSubtask%20of%7D%20or%20Subtask%20of:%20(type:%20Epic)&__reuse_tab=1';
    const existingTabUrl = 'https://tracker.example.com/agiles/141-18/current?query=has%3A%20-%7BSubtask%20of%7D%20or%20Subtask%20of%3A%20(type%3A%20Epic)';
    assert.strictEqual(normalizeUrlForComparison(shortcutUrl), normalizeUrlForComparison(existingTabUrl));
  },

  'full flow: github PRs URL works': () => {
    const url = 'https://github.com/pulls?q=user%3Ateam-example+sort%3Aupdated-desc&__reuse_tab=1';
    assert.strictEqual(hasReuseFlag(url), true);
    const normalized = normalizeUrlForComparison(url);
    assert.ok(!normalized.includes('__reuse_tab'));
    assert.ok(normalized.includes('github.com/pulls'));
  },
};

const propertyTests = {
  'property: same query value with different encodings normalizes identically': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHANUM + SPECIAL, 1, 50),
        fc.constantFrom('query', 'filter', 'search', 'q', 'param'),
        (value, paramName) => {
          const encoded1 = `https://example.com?${paramName}=${encodeURIComponent(value)}`;
          const encoded2 = `https://example.com?${paramName}=${value.split('').map(c => {
            if (/[a-zA-Z0-9]/.test(c)) return c;
            return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
          }).join('')}`;

          try {
            new URL(encoded1);
            new URL(encoded2);
          } catch {
            return true;
          }

          return normalizeUrlForComparison(encoded1) === normalizeUrlForComparison(encoded2);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: adding __reuse_tab does not affect normalized URL': () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true }),
        (url) => {
          try {
            const urlObj = new URL(url);
            if (urlObj.searchParams.has('__reuse_tab')) return true;

            const withFlag = url + (url.includes('?') ? '&' : '?') + '__reuse_tab=1';
            return normalizeUrlForComparison(url) === normalizeUrlForComparison(withFlag);
          } catch {
            return true;
          }
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: adding __run_js does not affect normalized URL': () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true }),
        stringGen(ALPHA + '_', 1, 20),
        (url, command) => {
          try {
            const urlObj = new URL(url);
            if (urlObj.searchParams.has('__run_js')) return true;

            const withFlag = url + (url.includes('?') ? '&' : '?') + '__run_js=' + command;
            return normalizeUrlForComparison(url) === normalizeUrlForComparison(withFlag);
          } catch {
            return true;
          }
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: adding __close_tabs does not affect normalized URL': () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true }),
        stringGen(ALPHA + '*./', 1, 30),
        (url, pattern) => {
          try {
            const urlObj = new URL(url);
            if (urlObj.searchParams.has('__close_tabs')) return true;

            const withFlag = url + (url.includes('?') ? '&' : '?') + '__close_tabs=' + encodeURIComponent(pattern);
            return normalizeUrlForComparison(url) === normalizeUrlForComparison(withFlag);
          } catch {
            return true;
          }
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: query param order does not affect normalized URL (unique keys)': () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(stringGen(ALPHA, 1, 10), stringGen(ALPHANUM, 1, 20)),
          { minLength: 2, maxLength: 5 }
        ),
        (params) => {
          const uniqueParams = [...new Map(params).entries()];
          if (uniqueParams.length < 2) return true;

          const url1 = 'https://example.com?' + uniqueParams.map(([k, v]) => `${k}=${v}`).join('&');
          const shuffled = [...uniqueParams].sort(() => Math.random() - 0.5);
          const url2 = 'https://example.com?' + shuffled.map(([k, v]) => `${k}=${v}`).join('&');

          return normalizeUrlForComparison(url1) === normalizeUrlForComparison(url2);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: normalization is idempotent': () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true }),
        (url) => {
          try {
            const once = normalizeUrlForComparison(url);
            const twice = normalizeUrlForComparison(once);
            return once === twice;
          } catch {
            return true;
          }
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: %20 and + are equivalent for spaces': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA + ' ', 1, 30),
        (value) => {
          const withPercent = `https://example.com?q=${value.replace(/ /g, '%20')}`;
          const withPlus = `https://example.com?q=${value.replace(/ /g, '+')}`;
          return normalizeUrlForComparison(withPercent) === normalizeUrlForComparison(withPlus);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: hasReuseFlag detects flag regardless of position': () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(stringGen(ALPHA, 1, 10), stringGen(ALPHANUM, 1, 10)), { minLength: 0, maxLength: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (params, insertPos) => {
          const allParams = [...params];
          const pos = Math.min(insertPos, allParams.length);
          allParams.splice(pos, 0, ['__reuse_tab', '1']);
          const url = 'https://example.com?' + allParams.map(([k, v]) => `${k}=${v}`).join('&');
          return hasReuseFlag(url) === true;
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: parseRunJSCommand preserves value with multiple equals signs': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA + '_', 1, 15),
        stringGen(ALPHANUM + '=', 1, 30),
        (command, value) => {
          const input = `${command}=${value}`;
          const result = parseRunJSCommand(input);
          return result.command === command && result.value === value;
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: real-world URL patterns normalize consistently': () => {
    const patterns = [
      (s) => `https://youtrack.example.com/agiles/1/current?query=has:%20-{${s}}`,
      (s) => `https://github.com/pulls?q=user:${s}+sort:updated`,
      (s) => `https://jira.example.com/browse?filter=(status:${s})`,
      (s) => `https://example.com/search?q=${s}&filter[type]=all`,
      (s) => `https://api.example.com/v1/items?ids=${s}&ids=${s}`,
    ];

    fc.assert(
      fc.property(
        stringGen(ALPHANUM, 1, 10),
        fc.constantFrom(...patterns),
        (value, pattern) => {
          const url = pattern(value);
          const withFlag = url + '&__reuse_tab=1';

          try {
            new URL(url);
            new URL(withFlag);
          } catch {
            return true;
          }

          return normalizeUrlForComparison(url) === normalizeUrlForComparison(withFlag);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: trailing slashes are normalized consistently': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA, 1, 10),
        fc.integer({ min: 0, max: 5 }),
        (path, numSlashes) => {
          const url1 = `https://example.com/${path}`;
          const url2 = `https://example.com/${path}${'/'.repeat(numSlashes)}`;
          return normalizeUrlForComparison(url1) === normalizeUrlForComparison(url2);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: www prefix only affects leading label': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA, 2, 10),
        stringGen(ALPHA, 2, 5),
        fc.boolean(),
        (domain, tld, hasWww) => {
          const host = hasWww ? `www.${domain}.${tld}` : `${domain}.${tld}`;
          const url = `https://${host}/path`;
          const normalized = normalizeUrlForComparison(url);
          return new URL(normalized).hostname === normalizeHostname(host);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: special characters in values encode consistently': () => {
    const specialChars = ':(){}[]<>';
    fc.assert(
      fc.property(
        stringGen(ALPHANUM + specialChars, 5, 40),
        (value) => {
          const url = `https://example.com?q=${encodeURIComponent(value)}&__reuse_tab=1`;
          const normalized = normalizeUrlForComparison(url);
          return !normalized.includes('__reuse_tab') && normalized.includes('example.com');
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: getDomain handles various URL formats': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA, 2, 15),
        stringGen(ALPHA, 2, 5),
        fc.boolean(),
        (domain, tld, hasWww) => {
          const host = hasWww ? `www.${domain}.${tld}` : `${domain}.${tld}`;
          const url = `https://${host}/path`;
          const result = getDomain(url);
          return result === normalizeHostname(host);
        }
      ),
      { numRuns: 10000 }
    );
  },

  'property: isPathPrefix is asymmetric': () => {
    fc.assert(
      fc.property(
        stringGen(ALPHA, 1, 10),
        stringGen(ALPHA, 1, 10),
        (parent, child) => {
          const parentUrl = `https://example.com/${parent}`;
          const childUrl = `https://example.com/${parent}/${child}`;
          return isPathPrefix(parentUrl, childUrl) === true &&
                 isPathPrefix(childUrl, parentUrl) === false;
        }
      ),
      { numRuns: 10000 }
    );
  },
};

let passed = 0;
let failed = 0;

console.log('Unit Tests:\n');
for (const [name, test] of Object.entries(tests)) {
  try {
    test();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

console.log('\nProperty-Based Tests (10,000 cases each):\n');
for (const [name, test] of Object.entries(propertyTests)) {
  try {
    test();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    if (e.counterexample) {
      console.log(`  Counterexample: ${JSON.stringify(e.counterexample)}`);
    }
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
