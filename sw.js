// Emergency News PWA Service Worker
// VERSION: 41 - Bump this number when you update ANY file to trigger app updates

const CACHE_NAME = 'reddit-pwa-app-shell';
const RUNTIME_CACHE = 'reddit-pwa-runtime';

// Files to cache for offline functionality
const APP_SHELL_FILES = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './reddit-icon-192.png',
    './reddit-icon-512.png'
];

const MAX_RUNTIME_CACHE_SIZE = 100; // Maximum number of runtime cache entries

// ============================================================================
// INSTALL EVENT - Cache app shell
// ============================================================================
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // Force network fetch to bypass cache and get latest files
                return cache.addAll(APP_SHELL_FILES.map(url => 
                    new Request(url, { cache: 'reload' })
                ));
            })
            .catch(error => {
                console.error('Service Worker installation failed:', error);
            })
    );
});

// ============================================================================
// ACTIVATE EVENT - Take control immediately
// ============================================================================
self.addEventListener('activate', event => {
    event.waitUntil(
        self.clients.claim()
    );
});

// ============================================================================
// FETCH EVENT - Serve from cache, fallback to network
// ============================================================================
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip chrome-extension and other non-http(s) requests
    if (!request.url.startsWith('http')) {
        return;
    }

    // For navigation requests (HTML pages)
    if (request.mode === 'navigate') {
        event.respondWith(
            caches.match('./index.html')
                .then(response => {
                    return response || fetch(request);
                })
                .catch(() => {
                    return caches.match('./index.html');
                })
        );
        return;
    }

    // For app shell files - cache first
    if (APP_SHELL_FILES.some(file => request.url.endsWith(file))) {
        event.respondWith(
            caches.match(request)
                .then(response => {
                    return response || fetch(request).then(fetchResponse => {
                        return caches.open(CACHE_NAME).then(cache => {
                            cache.put(request, fetchResponse.clone());
                            return fetchResponse;
                        });
                    });
                })
        );
        return;
    }

    // For Reddit API requests - network first, cache fallback
    if (url.hostname.includes('reddit.com')) {
        event.respondWith(
            fetch(request)
                .then(response => {
                    // Only cache successful responses
                    if (response && response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(RUNTIME_CACHE).then(cache => {
                            cache.put(request, responseClone);
                            trimCache(RUNTIME_CACHE, MAX_RUNTIME_CACHE_SIZE);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Network failed, try cache
                    return caches.match(request);
                })
        );
        return;
    }

    // For images - cache first with network fallback
    if (request.destination === 'image') {
        event.respondWith(
            caches.match(request)
                .then(response => {
                    if (response) {
                        return response;
                    }
                    return fetch(request).then(fetchResponse => {
                        if (fetchResponse && fetchResponse.status === 200) {
                            const responseClone = fetchResponse.clone();
                            caches.open(RUNTIME_CACHE).then(cache => {
                                cache.put(request, responseClone);
                                trimCache(RUNTIME_CACHE, MAX_RUNTIME_CACHE_SIZE);
                            });
                        }
                        return fetchResponse;
                    });
                })
        );
        return;
    }

    // For everything else - network first, cache fallback
    event.respondWith(
        fetch(request)
            .then(response => {
                return response;
            })
            .catch(() => {
                return caches.match(request);
            })
    );
});

// ============================================================================
// MESSAGE EVENT - Handle messages from clients
// ============================================================================
self.addEventListener('message', event => {
    if (event.data.type === 'SKIP_WAITING') {
        // User clicked "Update Now" - activate the new service worker
        self.skipWaiting();
    }

    if (event.data.type === 'CLEAR_PWA_CACHE') {
        Promise.all([
            caches.delete(CACHE_NAME),
            caches.delete(RUNTIME_CACHE)
        ])
            .then(() => {
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({ success: true });
                }
            })
            .catch(error => {
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({ success: false, error: error.message });
                }
            });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trim cache to maximum number of entries
 * @param {string} cacheName - Name of the cache to trim
 * @param {number} maxItems - Maximum number of items to keep
 */
function trimCache(cacheName, maxItems) {
    caches.open(cacheName)
        .then(cache => {
            return cache.keys().then(keys => {
                if (keys.length > maxItems) {
                    // Delete oldest entries (first items in the array)
                    const deletePromises = keys
                        .slice(0, keys.length - maxItems)
                        .map(key => cache.delete(key));
                    return Promise.all(deletePromises);
                }
            });
        })
        .catch(error => {
            console.error('Error trimming cache:', error);
        });
}