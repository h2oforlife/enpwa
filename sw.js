const CACHE_NAME = 'reddit-pwa-v3';
const RUNTIME_CACHE_NAME = 'reddit-runtime-cache-v1'; // Separate cache for dynamic content
const MAX_RUNTIME_ENTRIES = 10000; // Adjust based on expected usage and storage constraints

// Message handler for selective cache clearing
self.addEventListener('message', event => {
  if (event.data.type === 'CLEAR_PWA_CACHE') {
    // Clear only app shell cache
    caches.delete(CACHE_NAME)
      .then(() => {
        console.log('SW: PWA cache cleared successfully');
        event.ports[0].postMessage({ success: true });
      })
      .catch(error => {
        console.error('SW: Failed to clear PWA cache:', error);
        event.ports[0].postMessage({ success: false, error: error.message });
      });
  }
});

// Install event - cache the app shell immediately
self.addEventListener('install', event => {
    console.log('SW: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('SW: Caching app shell');
                // Make sure index.html path is correct relative to your server root
                return cache.addAll([
                    './', // Usually resolves to index.html
                    './index.html', // Explicitly add index.html
                    './reddit-icon-192.png',
                    './reddit-icon-512.png',
                    './manifest.json',
                    './sw.js'
                    // Add other critical static assets (CSS, base JS) here if needed
                ]);
            })
            .then(() => {
                console.log('SW: Skip waiting');
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('SW: Install failed:', error);
                throw error; // Propagate error if critical
            })
    );
});

// Activate event - take control immediately
self.addEventListener('activate', event => {
    console.log('SW: Activating...');
    event.waitUntil(
        caches.keys()
            .then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE_NAME) {
                            console.log('SW: Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                        // Consider deleting older runtime cache versions if you change the name scheme
                        // e.g., if cacheName.startsWith('reddit-runtime-cache-') && cacheName !== RUNTIME_CACHE_NAME
                    })
                );
            })
            .then(() => {
                console.log('SW: Claiming clients');
                return self.clients.claim();
            })
            .catch(error => {
                 console.error('SW: Activation failed:', error);
            })
    );
});

// Helper function to maintain cache size
function trimCache(cacheName, maxItems) {
    caches.open(cacheName)
        .then(cache => {
            return cache.keys();
        })
        .then(requests => {
            if (requests.length > maxItems) {
                // Delete oldest entries first (assuming keys() returns them in insertion order)
                const deletePromises = [];
                for (let i = 0; i < requests.length - maxItems; i++) {
                    console.log(`SW: Evicting old item from ${cacheName}:`, requests[i].url);
                    deletePromises.push(cache.delete(requests[i]));
                }
                return Promise.all(deletePromises);
            }
        })
        .catch(error => {
             console.error('SW: Error trimming cache:', cacheName, error);
        });
}


// Fetch event - cache first for app shell, network first with cache fallback for API/data, cache first for images
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // For navigation requests (page loads) - App Shell model
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.match('./index.html') // Match against the cached shell
                .then(response => {
                    return response || fetch(event.request); // Fallback to network if shell missing (shouldn't happen after install)
                })
                .catch(() => {
                     // Very unlikely, only if cache is corrupted/missing
                     console.error("SW: Could not load app shell.");
                     // Return a minimal fallback page if possible
                     // Or just re-throw? Up to design.
                     return caches.match('./index.html'); 
                })
        );
        return; // Important to return after handling navigate
    }

    // For Reddit API requests
    if (url.hostname.includes('reddit.com')) {
        event.respondWith(
            caches.open(RUNTIME_CACHE_NAME) // Use the dedicated runtime cache
                .then(cache => {
                     return fetch(event.request)
                         .then(response => {
                             // Clone the response before putting it in cache
                             if (response && response.status === 200) {
                                 const responseClone = response.clone();
                                 cache.put(event.request, responseClone);
                                 // Trim cache after adding new item
                                 trimCache(RUNTIME_CACHE_NAME, MAX_RUNTIME_ENTRIES);
                             }
                             return response;
                         })
                         .catch(() => {
                             // Network failed, try cache
                             console.log("SW: Network failed, serving from cache for:", event.request.url);
                             return cache.match(event.request);
                         });
                })
        );
        return; // Important to return after handling API
    }

    // For images
    if (event.request.destination === 'image') {
         event.respondWith(
            caches.open(RUNTIME_CACHE_NAME) // Use the same runtime cache for images
                .then(cache => {
                    return cache.match(event.request)
                        .then(cachedResponse => {
                            if (cachedResponse) {
                                console.log("SW: Serving image from cache:", event.request.url);
                                return cachedResponse;
                            }
                            // Not in cache, fetch from network
                            return fetch(event.request)
                                .then(response => {
                                    if (response && response.status === 200) {
                                        const responseClone = response.clone();
                                        cache.put(event.request, responseClone);
                                         // Trim cache after adding new item
                                        trimCache(RUNTIME_CACHE_NAME, MAX_RUNTIME_ENTRIES);
                                    }
                                    return response;
                                })
                                .catch(() => {
                                    // Network failed, no cache available
                                     console.log("SW: Could not fetch or serve image from cache:", event.request.url);
                                     // Return a placeholder image if desired, otherwise return the failed response
                                     // return caches.match('/path/to/placeholder.jpg');
                                     return response; // This will be the failed response
                                });
                        });
                })
        );
        return; // Important to return after handling image
    }

    // For everything else (e.g., static assets like CSS/JS not in app shell), try cache first
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});