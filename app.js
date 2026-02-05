// Reddit PWA - Main Application Logic
// Version: 1.0.0

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    const CONFIG = {
        REQUESTS_PER_MINUTE: 10,
        REQUEST_INTERVAL: 6000, // 6 seconds between requests
        MAX_RETRIES: 3,
        INITIAL_BACKOFF: 1000,
        MAX_BACKOFF: 30000,
        POSTS_LIMIT: 25,
        UPDATE_CHECK_INTERVAL: 5 * 60 * 1000, // 5 minutes
        RATE_LIMIT_RESET_INTERVAL: 60 * 1000 // 1 minute
    };

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================
    let subreddits = [];
    let cachedPosts = [];
    let rateLimitState = {
        lastRequestTime: 0,
        remainingRequests: CONFIG.REQUESTS_PER_MINUTE,
        resetTime: Date.now() + CONFIG.RATE_LIMIT_RESET_INTERVAL,
        requestCount: 0
    };

    // ============================================================================
    // LOCAL STORAGE HELPERS (with error handling)
    // ============================================================================
    function safeGetItem(key, defaultValue) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (error) {
            console.error('Error reading from localStorage:', error);
            return defaultValue;
        }
    }

    function safeSetItem(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('Error writing to localStorage:', error);
            if (error.name === 'QuotaExceededError') {
                alert('Storage quota exceeded. Some data may not be saved.');
            }
            return false;
        }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================
    function initializeApp() {
        // Load data from localStorage
        subreddits = safeGetItem('subreddits', []);
        cachedPosts = safeGetItem('cachedPosts', []);
        const savedRateLimitState = safeGetItem('rateLimitState', null);
        
        if (savedRateLimitState) {
            rateLimitState = { ...rateLimitState, ...savedRateLimitState };
        }

        // Set up event listeners
        setupEventListeners();

        // Register service worker
        registerServiceWorker();

        // Initial render
        renderSubreddits();
        renderPosts();
        updateAllDisplays();

        // Set up periodic tasks
        setupPeriodicTasks();

        // Monitor online/offline status
        setupOnlineOfflineListeners();

        // Check for updates
        checkForUpdates();
    }

    // ============================================================================
    // EVENT LISTENERS
    // ============================================================================
    function setupEventListeners() {
        // Menu and sidebar
        const menuBtn = document.getElementById('menuBtn');
        const closeSidebar = document.getElementById('closeSidebar');
        const overlay = document.getElementById('overlay');
        const addSubredditBtn = document.getElementById('addSubredditBtn');
        const subredditInput = document.getElementById('subredditInput');
        const refreshPostsBtn = document.getElementById('refreshPostsBtn');
        const exportBtn = document.getElementById('exportBtn');
        const importBtn = document.getElementById('importBtn');
        const importFile = document.getElementById('importFile');
        const updateButton = document.getElementById('updateButton');

        if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
        if (closeSidebar) closeSidebar.addEventListener('click', toggleSidebar);
        if (overlay) overlay.addEventListener('click', toggleSidebar);

        // Subreddit management
        if (addSubredditBtn) addSubredditBtn.addEventListener('click', addSubreddit);
        if (subredditInput) {
            subredditInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    addSubreddit();
                }
            });
        }

        // Refresh posts
        if (refreshPostsBtn) refreshPostsBtn.addEventListener('click', refreshPosts);

        // Export/Import
        if (exportBtn) exportBtn.addEventListener('click', exportSubreddits);
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                if (importFile) importFile.click();
            });
        }
        if (importFile) importFile.addEventListener('change', importSubreddits);

        // Update button
        if (updateButton) updateButton.addEventListener('click', updatePWA);
    }

    // ============================================================================
    // SERVICE WORKER
    // ============================================================================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(registration => {
                    updateStatusDot();

                    // Listen for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showUpdateNotification();
                            }
                        });
                    });
                })
                .catch(error => {
                    console.error('Service Worker registration failed:', error);
                });

            // Listen for controller change (new SW activated)
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
            });
        }
    }

    function updateStatusDot() {
        const dot = document.getElementById('statusDot');
        const isOnline = navigator.onLine;
        
        if (isOnline && navigator.serviceWorker.controller) {
            dot.classList.add('online');
            dot.classList.remove('offline');
        } else {
            dot.classList.add('offline');
            dot.classList.remove('online');
        }
    }

    // ============================================================================
    // ONLINE/OFFLINE HANDLING
    // ============================================================================
    function setupOnlineOfflineListeners() {
        window.addEventListener('online', handleOnlineStatus);
        window.addEventListener('offline', handleOnlineStatus);
        handleOnlineStatus(); // Initial check
    }

    function handleOnlineStatus() {
        const banner = document.getElementById('offlineBanner');
        const refreshBtn = document.getElementById('refreshPostsBtn');
        
        if (navigator.onLine) {
            banner.classList.remove('active');
            refreshBtn.disabled = false;
        } else {
            banner.classList.add('active');
            refreshBtn.disabled = true;
        }
        
        updateStatusDot();
    }

    // ============================================================================
    // UPDATE MANAGEMENT
    // ============================================================================
    let updateCheckInterval;

    function checkForUpdates() {
        if (!navigator.onLine || !('serviceWorker' in navigator)) {
            return;
        }

        navigator.serviceWorker.getRegistration()
            .then(registration => {
                if (registration) {
                    registration.update();
                }
            })
            .catch(error => {
                console.error('Error checking for updates:', error);
            });
    }

    function showUpdateNotification() {
        const notification = document.getElementById('updateNotification');
        notification.classList.add('active');
    }

    function updatePWA() {
        if (!navigator.serviceWorker.controller) {
            // Save update timestamp
            const now = new Date();
            safeSetItem('lastUpdateTime', now.toISOString());
            window.location.reload();
            return;
        }

        // Save update timestamp before reloading
        const now = new Date();
        safeSetItem('lastUpdateTime', now.toISOString());

        // Tell the service worker to skip waiting
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    }

    // ============================================================================
    // SIDEBAR
    // ============================================================================
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');

        if (sidebar.classList.contains('open')) {
            updateVersionInfo();
        }
    }

    // ============================================================================
    // SUBREDDIT MANAGEMENT
    // ============================================================================
    function renderSubreddits() {
        const list = document.getElementById('subredditList');
        if (subreddits.length === 0) {
            list.innerHTML = '<span style="color: #7c7c7c;">No subreddits added yet</span>';
            return;
        }
        list.innerHTML = subreddits.map(sub => 
            `<span class="subreddit-tag" onclick="window.removeSubreddit('${sub}')">r/${sub} ×</span>`
        ).join('');
    }

    async function addSubreddit() {
        const input = document.getElementById('subredditInput');
        const sub = input.value.trim().replace(/^r\//, '');
        
        if (!sub) {
            return;
        }

        if (subreddits.includes(sub)) {
            alert('Subreddit already added');
            return;
        }

        subreddits.push(sub);
        safeSetItem('subreddits', subreddits);
        input.value = '';
        renderSubreddits();
        
        // Fetch posts only from the newly added subreddit
        await fetchPostsFromSubreddit(sub);
        
        toggleSidebar();
    }

    function removeSubreddit(sub) {
        subreddits = subreddits.filter(s => s !== sub);
        safeSetItem('subreddits', subreddits);
        
        // Remove posts from this subreddit
        cachedPosts = cachedPosts.filter(post => post.subreddit !== sub);
        safeSetItem('cachedPosts', cachedPosts);
        
        renderSubreddits();
        renderPosts();
    }

    // Expose removeSubreddit globally for onclick handler
    window.removeSubreddit = removeSubreddit;

    // ============================================================================
    // RATE LIMITING
    // ============================================================================
    function canMakeRequest() {
        const now = Date.now();
        
        // Reset if past reset time
        if (now >= rateLimitState.resetTime) {
            rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
            rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
            rateLimitState.requestCount = 0;
        }

        const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
        return timeSinceLastRequest >= CONFIG.REQUEST_INTERVAL && rateLimitState.remainingRequests > 0;
    }

    async function waitForRateLimit() {
        while (!canMakeRequest()) {
            const now = Date.now();
            const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
            const delay = Math.max(0, CONFIG.REQUEST_INTERVAL - timeSinceLastRequest);
            
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                // Wait for rate limit reset
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async function exponentialBackoff(retryCount) {
        const baseDelay = CONFIG.INITIAL_BACKOFF;
        const exponentialDelay = baseDelay * Math.pow(2, retryCount);
        const jitter = Math.random() * 1000;
        const totalDelay = Math.min(exponentialDelay + jitter, CONFIG.MAX_BACKOFF);
        
        await new Promise(resolve => setTimeout(resolve, totalDelay));
    }

    function updateRateLimitFromHeaders(headers) {
        if (!headers) return;

        const remaining = headers.get('X-Ratelimit-Remaining');
        const reset = headers.get('X-Ratelimit-Reset');

        if (remaining !== null) {
            rateLimitState.remainingRequests = parseInt(remaining, 10);
        }

        if (reset !== null) {
            rateLimitState.resetTime = parseInt(reset, 10) * 1000; // Convert to milliseconds
        }

        safeSetItem('rateLimitState', rateLimitState);
        updateAllDisplays();
    }

    // ============================================================================
    // FETCH POSTS
    // ============================================================================
    async function fetchSubredditPosts(subreddit, retryCount = 0) {
        await waitForRateLimit();

        try {
            const url = `https://www.reddit.com/r/${subreddit}.json?limit=${CONFIG.POSTS_LIMIT}&raw_json=1`;
            const response = await fetch(url);

            // Update rate limit state
            rateLimitState.lastRequestTime = Date.now();
            rateLimitState.remainingRequests = Math.max(0, rateLimitState.remainingRequests - 1);
            rateLimitState.requestCount++;

            updateRateLimitFromHeaders(response.headers);

            if (response.status === 429) {
                // Rate limit hit
                if (retryCount < CONFIG.MAX_RETRIES) {
                    await exponentialBackoff(retryCount);
                    return fetchSubredditPosts(subreddit, retryCount + 1);
                } else {
                    throw new Error('Rate limit exceeded. Please wait and try again.');
                }
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const posts = data.data.children.map(child => stripPostData(child.data));

            safeSetItem('rateLimitState', rateLimitState);
            updateAllDisplays();

            return posts;
        } catch (error) {
            console.error(`Error fetching r/${subreddit}:`, error);
            throw error;
        }
    }

    async function fetchPosts() {
        if (subreddits.length === 0) return;

        if (!navigator.onLine) {
            alert('You are offline. Showing cached posts.');
            return;
        }

        const status = document.getElementById('status');
        status.textContent = 'Fetching posts...';

        const errors = [];

        for (const sub of subreddits) {
            try {
                updateLoadingStatus(`Fetching r/${sub}...`);
                const posts = await fetchSubredditPosts(sub);
                
                if (posts.length > 0) {
                    // Immediately merge and display posts from this subreddit
                    const allPosts = [...cachedPosts, ...posts];
                    const uniquePosts = removeDuplicatePosts(allPosts);
                    cachedPosts = uniquePosts.sort((a, b) => b.created_utc - a.created_utc);
                    safeSetItem('cachedPosts', cachedPosts);
                    
                    // Render posts immediately after each fetch
                    renderPosts();
                }
            } catch (error) {
                errors.push(`r/${sub}: ${error.message}`);
            }
        }
        
        if (errors.length > 0) {
            status.textContent = 'Some subreddits failed to load. Check console for details.';
            errors.forEach(err => console.error(err));
        } else {
            status.textContent = '';
        }
    }

    function removeDuplicatePosts(posts) {
        const seen = new Set();
        return posts.filter(post => {
            if (seen.has(post.id)) {
                return false;
            }
            seen.add(post.id);
            return true;
        });
    }

    function stripPostData(post) {
        // Keep only essential fields to save storage space
        const result = {
            id: post.id,
            title: post.title,
            author: post.author,
            subreddit: post.subreddit,
            permalink: post.permalink,
            created_utc: post.created_utc,
            ups: post.ups,
            num_comments: post.num_comments,
            selftext: post.selftext ? post.selftext.substring(0, 500) : '', // Limit selftext
            url: post.url || '', // External link or media URL
            is_video: post.is_video || false,
            preview: post.preview?.images?.[0]?.source?.url ? {
                images: [{
                    source: {
                        url: post.preview.images[0].source.url
                    }
                }]
            } : null
        };

        // Add video URL if it's a video post
        if (post.is_video && post.media?.reddit_video?.fallback_url) {
            result.video_url = post.media.reddit_video.fallback_url;
        }

        return result;
    }

    function updateLoadingStatus(message) {
        const status = document.getElementById('status');
        status.textContent = `${message} (${rateLimitState.remainingRequests}/${CONFIG.REQUESTS_PER_MINUTE} requests remaining)`;
    }

    function refreshPosts() {
        if (!navigator.onLine) {
            alert('You are offline. Cannot refresh posts.');
            return;
        }
        toggleSidebar(); // Close sidebar
        fetchPosts();
    }

    async function fetchPostsFromSubreddit(subreddit) {
        if (!navigator.onLine) {
            alert('You are offline. Cannot fetch posts.');
            return;
        }

        const status = document.getElementById('status');
        status.textContent = `Fetching posts from r/${subreddit}...`;

        try {
            const posts = await fetchSubredditPosts(subreddit);
            
            if (posts.length > 0) {
                // Merge new posts with existing cached posts
                const allPosts = [...cachedPosts, ...posts];
                const uniquePosts = removeDuplicatePosts(allPosts);
                cachedPosts = uniquePosts.sort((a, b) => b.created_utc - a.created_utc);
                safeSetItem('cachedPosts', cachedPosts);
            }
            
            status.textContent = '';
        } catch (error) {
            status.textContent = `Failed to fetch r/${subreddit}: ${error.message}`;
            console.error(error);
        }

        renderPosts();
    }

    // ============================================================================
    // RENDER POSTS
    // ============================================================================
    function renderPosts() {
        const container = document.getElementById('posts');
        const status = document.getElementById('status');

        if (cachedPosts.length === 0) {
            container.innerHTML = '';
            status.textContent = navigator.onLine ? 
                'No posts yet. Add subreddits and click "Refresh Posts".' : 
                'No cached posts available. Connect to internet and refresh.';
            return;
        }

        status.textContent = '';
        container.innerHTML = cachedPosts.map(post => createPostHTML(post)).join('');
    }

    function createPostHTML(post) {
        const imageHtml = getImageHTML(post);
        const selftext = getSelftextHTML(post);

        return `
            <div class="post">
                <div class="post-header">
                    <span class="subreddit-name">r/${escapeHTML(post.subreddit)}</span>
                    • Posted by <span class="post-author">u/${escapeHTML(post.author)}</span>
                    • ${formatTime(post.created_utc)}
                </div>
                <div class="post-title">
                    <a href="https://reddit.com${escapeHTML(post.permalink)}" target="_blank" rel="noopener noreferrer">
                        ${escapeHTML(post.title)}
                    </a>
                </div>
                ${imageHtml}
                ${selftext}
                <div class="post-footer">
                    <span class="post-stat">⬆ ${formatNumber(post.ups)} upvotes</span>
                    <span class="post-stat">💬 ${formatNumber(post.num_comments)} comments</span>
                </div>
            </div>
        `;
    }

    function getImageHTML(post) {
        // Handle video posts
        if (post.is_video && post.video_url) {
            return `<video class="post-image" controls><source src="${escapeHTML(post.video_url)}" type="video/mp4">Your browser does not support video.</video>`;
        }

        // Handle image posts
        if (!post.preview || !post.preview.images || !post.preview.images[0]) {
            return '';
        }

        const imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
        return `<img class="post-image" src="${escapeHTML(imageUrl)}" alt="" loading="lazy" />`;
    }

    function getSelftextHTML(post) {
        if (!post.selftext) {
            return '';
        }

        let text = post.selftext.substring(0, 300);
        
        // Convert markdown links [text](url) to HTML links before escaping
        // Match and replace with a simple callback
        const parts = [];
        let lastIndex = 0;
        const linkRegex = /\[([^\]]+)\]\(([^\)]+)\)/g;
        let match;
        
        while ((match = linkRegex.exec(text)) !== null) {
            // Add text before the link (escaped)
            if (match.index > lastIndex) {
                parts.push(escapeHTML(text.substring(lastIndex, match.index)));
            }
            // Add the link
            parts.push(`<a href="${escapeHTML(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHTML(match[1])}</a>`);
            lastIndex = match.index + match[0].length;
        }
        
        // Add remaining text after last link (escaped)
        if (lastIndex < text.length) {
            parts.push(escapeHTML(text.substring(lastIndex)));
        }
        
        const html = parts.join('') + (post.selftext.length > 300 ? '...' : '');
        return `<div class="post-text">${html}</div>`;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ============================================================================
    // FORMATTING HELPERS
    // ============================================================================
    function formatTime(timestamp) {
        const now = Date.now() / 1000;
        const diff = now - timestamp;
        
        if (diff < 0) return 'just now'; // Handle future dates
        if (diff < 60) return `${Math.floor(diff)}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
        
        // For older posts, show actual date
        const date = new Date(timestamp * 1000);
        return date.toLocaleDateString();
    }

    function formatNumber(num) {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
        return num.toString();
    }

    // ============================================================================
    // DISPLAY UPDATES
    // ============================================================================
    function updateAllDisplays() {
        updateRateLimitDisplay();
        updateVersionInfo();
    }

    function updateRateLimitDisplay() {
        const rateLimitInfo = document.getElementById('rateLimitInfo');
        
        if (rateLimitInfo) {
            const remaining = rateLimitState.remainingRequests;
            const total = CONFIG.REQUESTS_PER_MINUTE;
            rateLimitInfo.textContent = `${remaining}/${total}`;
            
            // Change color based on remaining requests
            if (remaining <= 2) {
                rateLimitInfo.style.background = 'rgba(244, 67, 54, 0.8)';
            } else if (remaining <= 5) {
                rateLimitInfo.style.background = 'rgba(255, 152, 0, 0.8)';
            } else {
                rateLimitInfo.style.background = 'rgba(76, 175, 80, 0.8)';
            }
        }
    }

    function updateVersionInfo() {
        const versionElement = document.getElementById('versionInfo');
        if (!versionElement) return;

        const lastUpdate = safeGetItem('lastUpdateTime', null);
        
        if (lastUpdate) {
            const updateDate = new Date(lastUpdate);
            const formattedDate = updateDate.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });
            const formattedTime = updateDate.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit'
            });
            
            versionElement.innerHTML = `Last updated<br>${formattedDate} at ${formattedTime}`;
        } else {
            versionElement.innerHTML = 'No update history';
        }
    }

    // ============================================================================
    // EXPORT / IMPORT SUBREDDITS
    // ============================================================================
    function exportSubreddits() {
        const data = {
            subreddits: subreddits,
            exportDate: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `reddit-pwa-subreddits-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function importSubreddits(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                
                if (!data.subreddits || !Array.isArray(data.subreddits)) {
                    alert('Invalid file format');
                    return;
                }

                // Merge with existing subreddits (avoid duplicates)
                const merged = [...new Set([...subreddits, ...data.subreddits])];
                subreddits = merged;
                safeSetItem('subreddits', subreddits);
                
                renderSubreddits();
                alert(`Imported ${data.subreddits.length} subreddits (${merged.length - subreddits.length} new)`);
                
                // Clear file input
                event.target.value = '';
            } catch (error) {
                alert('Error reading file: ' + error.message);
            }
        };
        reader.readAsText(file);
    }

    // ============================================================================
    // PERIODIC TASKS
    // ============================================================================
    function setupPeriodicTasks() {
        // Update displays every 10 seconds
        setInterval(updateAllDisplays, 10000);

        // Check for updates every 5 minutes
        if ('serviceWorker' in navigator) {
            updateCheckInterval = setInterval(checkForUpdates, CONFIG.UPDATE_CHECK_INTERVAL);
        }

        // Reset rate limit (conservative approach)
        setInterval(() => {
            const now = Date.now();
            if (now >= rateLimitState.resetTime) {
                rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
                rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
                rateLimitState.requestCount = 0;
                safeSetItem('rateLimitState', rateLimitState);
                updateAllDisplays();
            }
        }, 10000); // Check every 10 seconds
    }

    // ============================================================================
    // START APPLICATION
    // ============================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        initializeApp();
    }

})();