// Reddit PWA - Optimized & Robust Version
// Improvements: Consolidated functions, error handling, bug fixes, code reduction

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    const CONFIG = {
        REQUESTS_PER_MINUTE: 50,
        REQUEST_INTERVAL: 1200, // 1.2 seconds between requests
        MAX_RETRIES: 3,
        POSTS_LIMIT: 25,
        UPDATE_CHECK_INTERVAL: 5 * 60 * 1000,
        RATE_LIMIT_RESET_INTERVAL: 60 * 1000,
        REQUEST_TIMEOUT: 15000,
        CLEANUP_THRESHOLD: 90, // Only cleanup when storage is 90%+ full
        JOB_DELAY_MS: 1000,
        MAX_SAFE_STORAGE: 8 * 1024 * 1024,
        MAX_POST_AGE_DAYS: 30, // Posts older than this will be deleted
        POSTS_PER_PAGE: 25, // Pagination
        MAX_POST_TEXT_LENGTH: 300, // Characters before "Read More"
        
        // UI Timings
        TOAST_DURATION: 3000,
        TOAST_ANIMATION_DELAY: 10,
        DIALOG_FADE_DURATION: 300,
        RELOAD_DELAY: 500,
        DISPLAY_UPDATE_INTERVAL: 10000,
        LOAD_MORE_COUNTDOWN: 2000,
        
        // Image sizes
        IMAGE_MIN_WIDTH: 640,
        IMAGE_MAX_WIDTH: 960,
        
        // Scroll
        SCROLL_TO_TOP_THRESHOLD: 300
    };

    // ============================================================================
    // STATE MANAGEMENT - Simplified & Unified
    // ============================================================================
    const state = {
        feeds: {
            my: { posts: [], pending: { posts: [], count: 0 }, lastFetch: {}, currentPage: 1 },
            popular: { posts: [], pending: { posts: [], count: 0 }, lastFetch: {}, currentPage: 1, filtered: [] },
            starred: { posts: [], currentPage: 1 }
        },
        subreddits: [],
        blocked: [],
        blockedUsers: [],
        current: 'my',
        filter: 'all',
        rateLimitState: {
            lastRequestTime: 0,
            remainingRequests: CONFIG.REQUESTS_PER_MINUTE,
            resetTime: Date.now() + CONFIG.RATE_LIMIT_RESET_INTERVAL,
            requestCount: 0
        },
        syncQueue: [],
        isProcessingQueue: false,
        countrySuggestions: [],
        selectedCountry: null,
        storageQuota: 5 * 1024 * 1024,
        newPostsToast: null, // Reference to persistent toast
        updateAvailable: false // Track update availability persistently
    };

    // Periodic task intervals
    let intervals = {
        display: null,
        updateCheck: null,
        rateLimit: null
    };

    // ============================================================================
    // SYNC QUEUE MANAGEMENT - Enhanced with atomic operations and timeout
    // ============================================================================
    const SYNC_CONFIG = {
        JOB_TIMEOUT_MS: 30000,
        MAX_JOB_AGE_MS: 24 * 60 * 60 * 1000,
        PROCESSING_LOCK_TIMEOUT_MS: 5000,
        RETRY_DELAY_MS: 1000,
        MAX_CONCURRENT_JOBS: 3
    };

    // Processing lock to prevent race conditions
    let processingLock = false;
    let processingLockTimeout = null;
    let activeJobs = 0;

    // Toast registry to prevent memory leaks
    const activeToasts = new Map(); // id -> {element, timeout}
    
    // Pending posts lock to prevent race conditions
    let pendingPostsLock = Promise.resolve();

    // ============================================================================
    // ERROR HANDLING WRAPPER
    // ============================================================================
    async function safeExecute(fn, fallback, errorMsg) {
        try {
            return await fn();
        } catch (error) {
            console.error(errorMsg, error);
            showToast(errorMsg, { type: 'error' });
            return fallback;
        }
    }

    // ============================================================================
    // HELPER FUNCTIONS
    // ============================================================================
    function rebuildPopularFiltered() {
        state.feeds.popular.filtered = state.feeds.popular.posts.filter(p => 
            !state.blocked.some(b => b.toLowerCase() === p.subreddit.toLowerCase())
        );
    }

    function resetFeedPagination(feedType) {
        state.feeds[feedType].currentPage = 1;
    }

    function updateAllViews() {
        saveState();
        renderSubreddits();
        renderSubredditFilter();
        renderPosts();
    }

    function updateRateLimitFromHeaders(response) {
        const remaining = response.headers.get('X-Ratelimit-Remaining');
        const reset = response.headers.get('X-Ratelimit-Reset');
        if (remaining !== null) state.rateLimitState.remainingRequests = parseInt(remaining, 10);
        if (reset !== null) state.rateLimitState.resetTime = parseInt(reset, 10) * 1000;
    }

    function getJobDisplayName(job) {
        if (job.type === 'fetch_popular') return 'Popular';
        if (job.type === 'fetch_subreddit') return `r/${job.subreddit}`;
        return job.type;
    }

    function filterPostsByRules(posts) {
        return posts.filter(post => 
            !state.blocked.some(b => b.toLowerCase() === post.subreddit.toLowerCase()) &&
            !state.blockedUsers.some(u => u.toLowerCase() === post.author.toLowerCase())
        );
    }

    // ============================================================================
    // LOCAL STORAGE - Unified & Robust
    // ============================================================================
    function loadState() {
        try {
            const saved = localStorage.getItem('appState');
            if (saved) {
                const parsed = JSON.parse(saved);
                
                // Merge with defaults
                state.feeds.my.posts = parsed.cachedPosts || [];
                state.feeds.popular.posts = parsed.popularPosts || [];
                state.feeds.starred.posts = parsed.bookmarkedPosts || [];
                state.subreddits = parsed.subreddits || [];
                state.blocked = parsed.blockedSubreddits || [];
                state.blockedUsers = parsed.blockedUsers || [];
                state.current = parsed.currentFeed || 'my';
                state.syncQueue = parsed.syncQueue || [];
                state.updateAvailable = parsed.updateAvailable || false;
                
                // Load pending posts
                state.feeds.my.pending = parsed.myPending || { posts: [], count: 0 };
                state.feeds.popular.pending = parsed.popularPending || { posts: [], count: 0 };
                
                // Load lastFetch tracking
                state.feeds.my.lastFetch = parsed.myLastFetch || {};
                state.feeds.popular.lastFetch = parsed.popularLastFetch || {};
                
                // Build filtered cache for popular feed
                rebuildPopularFiltered();
                
                // Fix rate limit state corruption
                if (parsed.rateLimitState) {
                    const now = Date.now();
                    if (now >= parsed.rateLimitState.resetTime) {
                        // Expired, reset
                        state.rateLimitState = {
                            lastRequestTime: 0,
                            remainingRequests: CONFIG.REQUESTS_PER_MINUTE,
                            resetTime: now + CONFIG.RATE_LIMIT_RESET_INTERVAL,
                            requestCount: 0
                        };
                    } else {
                        state.rateLimitState = parsed.rateLimitState;
                    }
                }
                
                // Clean up stuck jobs from previous session
                state.syncQueue = state.syncQueue.map(job => {
                    if (job.status === 'processing') {
                        job.status = 'pending';
                        job.retries = 0;
                    }
                    return job;
                }).filter(job => 
                    // Remove jobs that failed too many times (older than 24h)
                    job.status !== 'failed_max_retries' ||
                    Date.now() - job.timestamp < 24 * 60 * 60 * 1000
                );
            }
        } catch (error) {
            console.error('Error loading state:', error);
            showToast('Failed to load saved data', { type: 'warning' });
        }
        
        // Validate and clean up sync queue
        validateSyncQueue();
        
        // Clean old posts after loading
        cleanupOldPostsByAge();
    }

    function validateSyncQueue() {
        const now = Date.now();
        const originalLength = state.syncQueue.length;
        
        state.syncQueue = state.syncQueue.filter(job => {
            // Remove jobs older than 24 hours
            if (now - job.timestamp > SYNC_CONFIG.MAX_JOB_AGE_MS) {
                console.log(`Removed expired job: ${job.id}`);
                return false;
            }
            
            // Reset stuck processing jobs
            if (job.status === 'processing') {
                console.warn(`Reset stuck processing job: ${job.id}`);
                job.status = 'pending';
                job.retries = 0;
                job.startTime = null;
            }
            
            // Remove jobs that failed too many times
            if (job.status === 'failed_max_retries') {
                return false;
            }
            
            return true;
        });
        
        if (state.syncQueue.length !== originalLength) {
            console.log(`Sync queue cleanup: ${originalLength} -> ${state.syncQueue.length} jobs`);
            debouncedSave();
        }
    }

    function saveState() {
        try {
            const toSave = {
                cachedPosts: state.feeds.my.posts,
                popularPosts: state.feeds.popular.posts,
                bookmarkedPosts: state.feeds.starred.posts,
                subreddits: state.subreddits,
                blockedSubreddits: state.blocked,
                blockedUsers: state.blockedUsers,
                currentFeed: state.current,
                rateLimitState: state.rateLimitState,
                syncQueue: state.syncQueue,
                myPending: state.feeds.my.pending,
                popularPending: state.feeds.popular.pending,
                myLastFetch: state.feeds.my.lastFetch,
                popularLastFetch: state.feeds.popular.lastFetch,
                updateAvailable: state.updateAvailable
            };
            
            localStorage.setItem('appState', JSON.stringify(toSave));
            return true;
        } catch (error) {
            console.error('Error saving state:', error);
            if (error.name === 'QuotaExceededError') {
                showToast('Storage full! Cleaning up old posts...', { type: 'warning' });
                cleanupOldPosts();
                // Try again after cleanup
                try {
                    localStorage.setItem('appState', JSON.stringify(toSave));
                    return true;
                } catch (e) {
                    return false;
                }
            }
            return false;
        }
    }

    // Debounced save for performance
    let saveTimeout = null;
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveState();
            saveTimeout = null;
        }, 500);
    }

    // ============================================================================
    // UNIFIED TOAST SYSTEM
    // ============================================================================
    function showToast(message, options = {}) {
        const {
            type = 'info',
            duration = 3000,
            actions = [],
            position = 'bottom',
            persistent = false,
            id = null
        } = options;
        
        const toastId = id || (type === 'update' ? 'updateToast' : (persistent ? 'persistentToast' : `toast-${Date.now()}`));
        
        // Clean up existing toast with same ID
        if (activeToasts.has(toastId)) {
            const existing = activeToasts.get(toastId);
            clearTimeout(existing.timeout);
            existing.element.remove();
            activeToasts.delete(toastId);
        }
        
        const toast = document.createElement('div');
        
        if ((type === 'update' || persistent) && actions.length > 0) {
            // Update toast (top, with actions)
            toast.id = toastId;
            toast.className = 'update-toast';
            
            const actionsHtml = actions.map(action => 
                `<button class="toast-action" onclick="window.${action.onClick}">${action.label}</button>`
            ).join('');
            
            toast.innerHTML = `
                <div class="toast-content">
                    <span class="toast-message">${message}</span>
                    ${actionsHtml}
                    <button class="toast-close" onclick="window.dismissToast('${toast.id}')">×</button>
                </div>
            `;
            
            document.body.appendChild(toast);
            setTimeout(() => toast.classList.add('visible'), CONFIG.TOAST_ANIMATION_DELAY);
            
            if (persistent) {
                state.newPostsToast = toast;
            }
            
            // Register without timeout for persistent toasts
            activeToasts.set(toastId, { element: toast, timeout: null });
        } else {
            // Regular toast (bottom, auto-dismiss)
            toast.className = `toast-message toast-${type}`;
            toast.textContent = message;
            
            document.body.appendChild(toast);
            setTimeout(() => toast.classList.add('visible'), CONFIG.TOAST_ANIMATION_DELAY);
            
            if (duration > 0) {
                const timeoutId = setTimeout(() => {
                    toast.classList.remove('visible');
                    setTimeout(() => {
                        toast.remove();
                        activeToasts.delete(toastId);
                    }, CONFIG.DIALOG_FADE_DURATION);
                }, duration);
                
                activeToasts.set(toastId, { element: toast, timeout: timeoutId });
            }
        }
        
        return toast;
    }

    window.dismissToast = function(toastId) {
        if (activeToasts.has(toastId)) {
            const { element, timeout } = activeToasts.get(toastId);
            if (timeout) clearTimeout(timeout);
            element.classList.remove('visible');
            setTimeout(() => {
                element.remove();
                activeToasts.delete(toastId);
            }, 300);
            
            if (toastId === 'persistentToast') {
                state.newPostsToast = null;
            }
        }
    };

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        activeToasts.forEach(({ element, timeout }) => {
            if (timeout) clearTimeout(timeout);
            element.remove();
        });
        activeToasts.clear();
    });

    // ============================================================================
    // CONFIRMATION DIALOGS
    // ============================================================================
    function showConfirm(message, onConfirm) {
        const dialog = document.createElement('div');
        dialog.className = 'confirm-dialog-overlay';
        dialog.innerHTML = `
            <div class="confirm-dialog">
                <div class="confirm-message">${message}</div>
                <div class="confirm-actions">
                    <button class="confirm-btn cancel">Cancel</button>
                    <button class="confirm-btn confirm">Confirm</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const cleanup = () => {
            dialog.classList.remove('visible');
            setTimeout(() => dialog.remove(), CONFIG.DIALOG_FADE_DURATION);
        };
        
        dialog.querySelector('.cancel').onclick = cleanup;
        dialog.querySelector('.confirm').onclick = () => {
            cleanup();
            onConfirm();
        };
        dialog.onclick = (e) => {
            if (e.target === dialog) cleanup();
        };
        
        setTimeout(() => dialog.classList.add('visible'), CONFIG.TOAST_ANIMATION_DELAY);
    }

    // ============================================================================
    // UNIFIED FETCH FUNCTION - Consolidates all fetch operations
    // ============================================================================
    async function fetchFeed(feedType, subreddit = null) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
        
        try {
            // Wait for rate limit
            await waitForRateLimit();
            
            // Build URL
            const sub = feedType === 'popular' ? 'popular' : subreddit;
            const url = `https://www.reddit.com/r/${sub}.json?limit=${CONFIG.POSTS_LIMIT}&raw_json=1`;
            
            // Fetch with timeout
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            // Update rate limit
            state.rateLimitState.lastRequestTime = Date.now();
            state.rateLimitState.remainingRequests = Math.max(0, state.rateLimitState.remainingRequests - 1);
            state.rateLimitState.requestCount++;
            
            // Update from headers if available
            const remaining = response.headers.get('X-Ratelimit-Remaining');
            const reset = response.headers.get('X-Ratelimit-Reset');
            if (remaining !== null) state.rateLimitState.remainingRequests = parseInt(remaining, 10);
            if (reset !== null) state.rateLimitState.resetTime = parseInt(reset, 10) * 1000;
            
            debouncedSave();
            
            // Handle rate limit
            if (response.status === 429) {
                throw new Error('Rate limited');
            }
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            // Parse and return posts
            const data = await response.json();
            const posts = data.data.children.map(child => stripPostData(child.data));
            
            return { posts, error: null };
            
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                return { posts: null, error: 'Request timeout' };
            }
            
            return { posts: null, error: error.message };
        }
    }

    function stripPostData(post) {
        const result = {
            id: post.id,
            title: post.title,
            author: post.author,
            subreddit: post.subreddit,
            permalink: post.permalink,
            created_utc: post.created_utc,
            ups: post.ups,
            num_comments: post.num_comments,
            selftext: post.selftext || '',
            url: post.url || '',
            is_video: post.is_video || false
        };

        // Gallery images - use 640px preview resolution
        if (post.gallery_data && post.media_metadata) {
            result.gallery = post.gallery_data.items.map(item => {
                const media = post.media_metadata[item.media_id];
                if (media && media.p) {
                    // Use preview resolutions around 640px width
                    const resolutions = media.p;
                    const mediumRes = resolutions.find(r => r.x >= CONFIG.IMAGE_MIN_WIDTH && r.x <= CONFIG.IMAGE_MAX_WIDTH) || 
                                     resolutions[resolutions.length - 1];
                    if (mediumRes && mediumRes.u) {
                        return mediumRes.u.replace(/&amp;/g, '&');
                    }
                }
                // Fallback to source
                if (media && media.s && media.s.u) {
                    return media.s.u.replace(/&amp;/g, '&');
                }
                return null;
            }).filter(Boolean);
        } else if (post.preview?.images?.[0]) {
            // Use preview resolution around 640px width
            const preview = post.preview.images[0];
            const resolutions = preview.resolutions || [];
            const mediumRes = resolutions.find(r => r.width >= CONFIG.IMAGE_MIN_WIDTH && r.width <= CONFIG.IMAGE_MAX_WIDTH) || 
                             resolutions[resolutions.length - 1] ||
                             preview.source;
            if (mediumRes && mediumRes.url) {
                result.gallery = [mediumRes.url.replace(/&amp;/g, '&')];
            }
        }

        // Video
        if (post.is_video && post.media?.reddit_video) {
            const videoData = post.media.reddit_video;
            result.video_url = videoData.fallback_url || videoData.dash_url;
            // Reddit DASH videos have separate audio - construct audio URL
            if (videoData.fallback_url) {
                // Audio is typically at DASH_AUDIO.mp4 or DASH_audio.mp4
                result.audio_url = videoData.fallback_url.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO.mp4');
            }
        }

        return result;
    }

    async function waitForRateLimit() {
        while (true) {
            const now = Date.now();
            
            // Reset counter if window expired
            if (now >= state.rateLimitState.resetTime) {
                state.rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
                state.rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
                state.rateLimitState.requestCount = 0;
                debouncedSave();
            }
            
            // Check if we can proceed
            if (state.rateLimitState.remainingRequests > 0) {
                const timeSinceLastRequest = now - state.rateLimitState.lastRequestTime;
                if (timeSinceLastRequest >= CONFIG.REQUEST_INTERVAL) {
                    return; // OK to proceed
                }
                
                // Wait for minimum interval
                const waitTime = CONFIG.REQUEST_INTERVAL - timeSinceLastRequest;
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return;
            }
            
            // Wait until reset time
            const waitTime = Math.max(0, state.rateLimitState.resetTime - now);
            console.log(`Rate limit reached. Waiting ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        }
    }

    // ============================================================================
    // SYNC QUEUE - Improved with better parallelization
    // ============================================================================
    function queueSyncJob(type, subreddit = null) {
        // Check for duplicate
        const isDuplicate = state.syncQueue.some(job => 
            job.type === type && 
            job.subreddit === subreddit &&
            job.status !== 'completed' &&
            job.status !== 'failed_max_retries'
        );
        
        if (isDuplicate) {
            console.log(`Job already queued: ${type}/${subreddit || 'N/A'}`);
            return null;
        }
        
        const job = {
            id: `${type}-${subreddit || 'popular'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            subreddit,
            status: 'pending',
            retries: 0,
            timestamp: Date.now(),
            startTime: null
        };
        
        state.syncQueue.push(job);
        debouncedSave();
        
        console.log(`Queued job: ${job.id}`);
        return job;
    }

    async function processSyncQueue() {
        // Prevent concurrent processing
        if (state.isProcessingQueue) {
            console.log('Already processing queue, skipping');
            return;
        }
        
        if (!navigator.onLine) {
            console.log('Offline, cannot process queue');
            return;
        }
        
        console.log(`Starting queue processing with ${state.syncQueue.length} jobs`);
        state.isProcessingQueue = true;
        updateQueueStatus();
        updateSyncingStatus(); // Update UI to show syncing
        
        const dot = document.getElementById('statusDot');
        if (dot) dot.classList.add('loading');
        
        try {
            // Process jobs
            while (state.syncQueue.some(j => j.status === 'pending' || j.status === 'failed')) {
                // Get next job
                const job = state.syncQueue.find(j => j.status === 'pending' || j.status === 'failed');
                
                if (!job) break;
                
                // Check if too many retries
                if (job.retries >= CONFIG.MAX_RETRIES) {
                    console.log(`Job ${job.id} exceeded max retries`);
                    job.status = 'failed_max_retries';
                    debouncedSave();
                    continue;
                }
                
                // Start job
                console.log(`Processing job: ${job.id} (${job.type}/${job.subreddit || 'N/A'})`);
                job.status = 'processing';
                job.startTime = Date.now();
                job.retries++;
                debouncedSave();
                updateQueueStatus();
                updateSyncingStatus(); // Update status during processing
                
                // Execute job
                const result = await executeJob(job);
                
                // Update job status
                if (result.success) {
                    console.log(`Job ${job.id} completed successfully`);
                    job.status = 'completed';
                } else {
                    console.log(`Job ${job.id} failed: ${result.error}`);
                    job.status = 'failed';
                }
                
                debouncedSave();
            }
            
            // Remove completed jobs
            state.syncQueue = state.syncQueue.filter(j => 
                j.status !== 'completed' && j.status !== 'failed_max_retries'
            );
            
            console.log(`Queue processing complete. Remaining jobs: ${state.syncQueue.length}`);
            
        } catch (error) {
            console.error('Error in processSyncQueue:', error);
        } finally {
            // Always clean up, even on error
            if (dot) dot.classList.remove('loading');
            state.isProcessingQueue = false;
            updateQueueStatus();
            updateSyncingStatus(); // Clear syncing status
            
            // Save state after sync completes
            saveState();
        }
        
        // Check if this was initial fetch - auto apply pending posts for empty feeds
        if (state.feeds.my.posts.length === 0 && state.feeds.my.pending.posts.length > 0) {
            console.log('Initial My Feed fetch complete - auto-applying posts');
            const allPosts = [...state.feeds.my.pending.posts, ...state.feeds.my.posts];
            state.feeds.my.posts = removeDuplicates(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            state.feeds.my.pending = { posts: [], count: 0 };
            saveState();
            if (state.current === 'my') renderPosts();
        }
        
        if (state.feeds.popular.posts.length === 0 && state.feeds.popular.pending.posts.length > 0) {
            console.log('Initial Popular feed fetch complete - auto-applying posts');
            const allPosts = [...state.feeds.popular.pending.posts, ...state.feeds.popular.posts];
            state.feeds.popular.posts = removeDuplicates(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            state.feeds.popular.pending = { posts: [], count: 0 };
            // Update filtered cache
            rebuildPopularFiltered();
            saveState();
            if (state.current === 'popular') renderPosts();
        }
        
        // Show toast for non-empty feeds with pending posts
        const myHasPosts = state.feeds.my.posts.length > 0;
        const popHasPosts = state.feeds.popular.posts.length > 0;
        const myHasPending = state.feeds.my.pending.posts.length > 0;
        const popHasPending = state.feeds.popular.pending.posts.length > 0;
        
        if ((myHasPosts && myHasPending) || (popHasPosts && popHasPending)) {
            showNewPostsToast();
        }
    }

    async function executeJob(job) {
        try {
            if (job.type === 'fetch_subreddit') {
                const result = await fetchFeedWithRetry('subreddit', job.subreddit, job.retries - 1);
                if (result.posts) {
                    addPostsToPending(result.posts, 'my', job.subreddit);
                    return { success: true };
                }
                return { success: false, error: result.error };
            } else if (job.type === 'fetch_popular') {
                const result = await fetchFeedWithRetry('popular', null, job.retries - 1);
                if (result.posts) {
                    addPostsToPending(result.posts, 'popular', null);
                    return { success: true };
                }
                return { success: false, error: result.error };
            }
            
            return { success: false, error: 'Unknown job type' };
        } catch (error) {
            console.error('Job execution failed:', error);
            return { success: false, error: error.message };
        }
    }

    function addPostsToPending(posts, feedType, subreddit = null) {
        // Queue this operation to prevent race conditions
        pendingPostsLock = pendingPostsLock.then(() => {
            const feed = state.feeds[feedType];
            
            // Use intelligent deduplication
            const newPosts = getNewPostsOnly(posts, subreddit, feedType);
            
            if (newPosts.length > 0) {
                feed.pending.posts = [...feed.pending.posts, ...newPosts];
                feed.pending.count = feed.pending.posts.length;
                
                // Track last fetch time for this subreddit/feed
                if (subreddit) {
                    const newest = Math.max(...newPosts.map(p => p.created_utc));
                    feed.lastFetch[subreddit] = newest;
                } else if (feedType === 'popular') {
                    const newest = Math.max(...newPosts.map(p => p.created_utc));
                    feed.lastFetch['_popular'] = newest;
                }
                
                debouncedSave();
                
                console.log(`✓ Added ${newPosts.length} new posts to ${feedType}${subreddit ? ` (r/${subreddit})` : ''}`);
            } else {
                console.log(`✓ No new posts for ${feedType}${subreddit ? ` (r/${subreddit})` : ''} - all ${posts.length} already cached`);
            }
        });
        
        return pendingPostsLock;
    }

    async function fetchFeedWithRetry(feedType, subreddit = null, retryCount = 0) {
        const maxRetries = Math.min(3, CONFIG.MAX_RETRIES - retryCount);
        let lastError = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Wait for rate limit
                await waitForRateLimit();
                
                // Build URL
                const sub = feedType === 'popular' ? 'popular' : subreddit;
                const url = `https://www.reddit.com/r/${sub}.json?limit=${CONFIG.POSTS_LIMIT}&raw_json=1`;
                
                // Fetch with timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
                
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                // Update rate limit
                state.rateLimitState.lastRequestTime = Date.now();
                state.rateLimitState.remainingRequests = Math.max(0, state.rateLimitState.remainingRequests - 1);
                state.rateLimitState.requestCount++;
                
                // Update from headers if available
                updateRateLimitFromHeaders(response);
                
                debouncedSave();
                
                // Handle rate limit
                if (response.status === 429) {
                    throw new Error('Rate limited');
                }
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                // Parse and return posts
                const data = await response.json();
                const posts = data.data.children.map(child => stripPostData(child.data));
                
                return { posts, error: null };
                
            } catch (error) {
                lastError = error;
                console.warn(`Fetch attempt ${attempt + 1} failed for ${feedType}/${subreddit}:`, error);
                
                if (attempt < maxRetries) {
                    const delay = SYNC_CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
                    console.log(`Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        return { posts: null, error: lastError?.message || 'Unknown error' };
    }

    function updateQueueStatus() {
        const indicator = document.getElementById('queueIndicator');
        if (!indicator) return;
        
        // Find currently processing job
        const processing = state.syncQueue.find(j => j.status === 'processing');
        const failed = state.syncQueue.filter(j => j.status === 'failed');
        
        if (processing) {
            const feedName = getJobDisplayName(processing);
            indicator.textContent = `Syncing ${feedName}`;
            indicator.classList.add('active');
            indicator.classList.remove('warning');
        } else if (failed.length > 0) {
            indicator.textContent = `${failed.length} failed`;
            indicator.classList.add('active', 'warning');
        } else {
            indicator.classList.remove('active', 'warning');
        }
    }

    function updateSyncingStatus() {
        const status = document.getElementById('status');
        if (!status) return;
        
        // Check if we're syncing and current feed is empty
        const currentFeed = state.feeds[state.current];
        const isSyncing = state.isProcessingQueue || state.syncQueue.some(j => 
            j.status === 'processing' || j.status === 'pending'
        );
        
        if (isSyncing && currentFeed.posts.length === 0) {
            status.textContent = 'Fetching new posts...';
            status.style.display = 'block';
        } else {
            status.textContent = '';
            status.style.display = 'none';
        }
    }

    function showNewPostsToast() {
        const myCount = state.feeds.my.pending.count;
        const popCount = state.feeds.popular.pending.count;
        const total = myCount + popCount;
        
        let message = '';
        
        if (state.current === 'my' && myCount > 0) {
            message = `${myCount}+ new post${myCount > 1 ? 's' : ''}`;
        } else if (state.current === 'popular' && popCount > 0) {
            message = `${popCount}+ new post${popCount > 1 ? 's' : ''}`;
        } else if (total > 0) {
            message = `${total}+ new post${total > 1 ? 's' : ''}`;
        }
        
        if (message) {
            // Remove existing toast first
            const existing = document.getElementById('persistentToast');
            if (existing) existing.remove();
            
            const toast = document.createElement('div');
            toast.id = 'persistentToast';
            toast.className = 'update-toast';
            toast.style.cssText = `
                position: fixed;
                top: -100px;
                left: 50%;
                transform: translateX(-50%);
                background: var(--accent-color);
                color: white;
                padding: 12px 20px;
                box-shadow: #ff4500 0px 0px 8px;
                z-index: 1000;
                transition: top 0.3s ease;
                border-radius: 20px;
                cursor: pointer;
                font-weight: 500;
                font-size: 14px;
            `;
            
            toast.textContent = message;
            toast.onclick = () => window.applyPendingUpdates();
            
            document.body.appendChild(toast);
            
            // Trigger animation
            setTimeout(() => {
                toast.style.top = '10px';
            }, 10);
            
            state.newPostsToast = toast;
        }
    }

    window.applyPendingUpdates = function() {
        // Apply my feed updates
        if (state.feeds.my.pending.posts.length > 0) {
            const allPosts = [...state.feeds.my.pending.posts, ...state.feeds.my.posts];
            state.feeds.my.posts = removeDuplicates(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            state.feeds.my.pending = { posts: [], count: 0 };
        }
        
        // Apply popular feed updates
        if (state.feeds.popular.pending.posts.length > 0) {
            const allPosts = [...state.feeds.popular.pending.posts, ...state.feeds.popular.posts];
            state.feeds.popular.posts = removeDuplicates(allPosts).sort((a, b) => b.created_utc - a.created_utc);
            state.feeds.popular.pending = { posts: [], count: 0 };
            
            // Rebuild filtered cache
            rebuildPopularFiltered();
        }
        
        saveState();
        cleanupOldPostsByAge();
        renderPosts();
        renderSubredditFilter();
        
        // Dismiss toast with animation
        const toast = document.getElementById('persistentToast');
        if (toast) {
            toast.style.top = '-100px';
            setTimeout(() => {
                toast.remove();
                state.newPostsToast = null;
            }, 300);
        }
        
        // Scroll to top smoothly
        window.scrollTo({ top: 0, behavior: 'smooth' });
        
        showToast('Feed updated!', { type: 'success' });
    };

    function removeDuplicates(posts) {
        const seen = new Set();
        return posts.filter(post => {
            if (seen.has(post.id)) return false;
            seen.add(post.id);
            return true;
        });
    }

    /**
     * Get only new posts that aren't already cached
     * Used for intelligent incremental updates
     */
    function getNewPostsOnly(fetchedPosts, subreddit, feedType = 'my') {
        const feed = state.feeds[feedType];
        
        // Build set of all existing IDs (both in feed and pending)
        const existingIds = new Set([
            ...feed.posts.filter(p => !subreddit || p.subreddit.toLowerCase() === subreddit.toLowerCase()).map(p => p.id),
            ...feed.pending.posts.filter(p => !subreddit || p.subreddit.toLowerCase() === subreddit.toLowerCase()).map(p => p.id)
        ]);
        
        const newPosts = fetchedPosts.filter(p => !existingIds.has(p.id));
        
        // Log cache efficiency
        if (fetchedPosts.length > 0) {
            const cacheHitRate = ((fetchedPosts.length - newPosts.length) / fetchedPosts.length * 100).toFixed(0);
            console.log(`Cache efficiency: ${cacheHitRate}% (${fetchedPosts.length - newPosts.length}/${fetchedPosts.length} cached)${subreddit ? ` for r/${subreddit}` : ''}`);
        }
        
        return newPosts;
    }

    // ============================================================================
    // BOOKMARKING SYSTEM
    // ============================================================================
    window.toggleBookmark = function(postId) {
        const allPosts = [...state.feeds.my.posts, ...state.feeds.popular.posts];
        const post = allPosts.find(p => p.id === postId);
        if (!post) return;
        
        const index = state.feeds.starred.posts.findIndex(p => p.id === postId);
        
        if (index > -1) {
            showConfirm('Remove this post from your starred posts?', () => {
                state.feeds.starred.posts.splice(index, 1);
                saveState();
                showToast('Removed from starred posts', { type: 'success' });
                renderPosts();
            });
        } else {
            state.feeds.starred.posts.push(post);
            saveState();
            showToast('Added to starred posts', { type: 'success' });
            renderPosts();
        }
    };

    // ============================================================================
    // STORAGE MANAGEMENT - Optimized
    // ============================================================================
    async function initializeStorageQuota() {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            try {
                const estimate = await navigator.storage.estimate();
                const availableQuota = estimate.quota || state.storageQuota;
                state.storageQuota = Math.min(availableQuota * 0.8, CONFIG.MAX_SAFE_STORAGE);
                console.log(`Storage quota: ${formatBytes(state.storageQuota)}`);
            } catch (error) {
                console.error('Could not estimate storage:', error);
            }
        }
    }

    function getLocalStorageSize() {
        let total = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                total += localStorage[key].length + key.length;
            }
        }
        return total * 2;
    }

    function getStorageUsagePercent() {
        return (getLocalStorageSize() / state.storageQuota) * 100;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function cleanupOldPosts() {
        const percent = getStorageUsagePercent();
        if (percent < CONFIG.CLEANUP_THRESHOLD) return;
        
        console.log(`Storage at ${percent.toFixed(1)}% - cleaning up`);
        
        const bookmarkedIds = new Set(state.feeds.starred.posts.map(p => p.id));
        const removeCount = Math.ceil(state.feeds.my.posts.length * 0.2);
        
        // Remove oldest non-bookmarked posts (posts are already sorted desc)
        const removedIds = new Set();
        for (let i = state.feeds.my.posts.length - 1; i >= 0 && removedIds.size < removeCount; i--) {
            const post = state.feeds.my.posts[i];
            if (!bookmarkedIds.has(post.id)) {
                removedIds.add(post.id);
            }
        }
        
        state.feeds.my.posts = state.feeds.my.posts.filter(p => !removedIds.has(p.id));
        state.feeds.popular.posts = state.feeds.popular.posts.filter(p => !removedIds.has(p.id));
        
        saveState();
        console.log(`Removed ${removedIds.size} posts. New: ${getStorageUsagePercent().toFixed(1)}%`);
    }

    function cleanupOldPostsByAge() {
        const now = Date.now() / 1000; // Current time in seconds
        const maxAge = CONFIG.MAX_POST_AGE_DAYS * 24 * 60 * 60; // Convert days to seconds
        const bookmarkedIds = new Set(state.feeds.starred.posts.map(p => p.id));
        
        let removedCount = 0;
        
        // Clean My Feed
        const originalMyCount = state.feeds.my.posts.length;
        state.feeds.my.posts = state.feeds.my.posts.filter(post => {
            const age = now - post.created_utc;
            const isOld = age > maxAge;
            const isBookmarked = bookmarkedIds.has(post.id);
            
            if (isOld && !isBookmarked) {
                removedCount++;
                return false;
            }
            return true;
        });
        
        // Clean Popular Feed
        const originalPopCount = state.feeds.popular.posts.length;
        state.feeds.popular.posts = state.feeds.popular.posts.filter(post => {
            const age = now - post.created_utc;
            const isOld = age > maxAge;
            const isBookmarked = bookmarkedIds.has(post.id);
            
            if (isOld && !isBookmarked) {
                removedCount++;
                return false;
            }
            return true;
        });
        
        if (removedCount > 0) {
            console.log(`Removed ${removedCount} posts older than ${CONFIG.MAX_POST_AGE_DAYS} days`);
            saveState();
        }
    }

    function updateStorageStats() {
        const size = getLocalStorageSize();
        const percent = getStorageUsagePercent();
        
        const usageEl = document.getElementById('storageUsage');
        const barEl = document.getElementById('storageBar');
        const totalPostsEl = document.getElementById('totalPosts');
        const postsPerSubEl = document.getElementById('postsPerSub');
        
        if (usageEl) {
            usageEl.textContent = `${formatBytes(size)} / ${formatBytes(state.storageQuota)}`;
        }
        
        if (barEl) {
            barEl.style.width = `${Math.min(percent, 100)}%`;
            barEl.style.background = percent >= 90 ? '#f44336' : percent >= 80 ? '#ff9800' : '#0079d3';
        }
        
        if (totalPostsEl) {
            const cached = state.feeds.my.posts.length + state.feeds.popular.posts.length;
            const starred = state.feeds.starred.posts.length;
            totalPostsEl.textContent = `${cached} cached + ${starred} starred`;
        }
        
        if (postsPerSubEl) {
            const breakdown = {};
            state.feeds.my.posts.forEach(p => {
                breakdown[p.subreddit] = (breakdown[p.subreddit] || 0) + 1;
            });
            if (state.feeds.popular.posts.length > 0) breakdown['popular'] = state.feeds.popular.posts.length;
            if (state.feeds.starred.posts.length > 0) breakdown['★ starred'] = state.feeds.starred.posts.length;
            
            const lines = Object.entries(breakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([sub, count]) => `${sub.startsWith('★') ? sub : 'r/' + sub}: ${count}`)
                .join('<br>');
            
            postsPerSubEl.innerHTML = lines || '<em>No posts cached</em>';
        }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================
    async function initializeApp() {
        // Load state
        loadState();
        
        // Initialize theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        const btn = document.getElementById('themeToggle');
        if (btn) {
            btn.textContent = savedTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        }
        
        // Initialize storage quota
        await initializeStorageQuota();
        
        // Load country suggestions
        await loadCountrySuggestions();
        
        // Setup
        setupEventListeners();
        registerServiceWorker();
        updateFeedTabsVisibility();
        
        // Show update notification if previously detected
        if (state.updateAvailable) {
            showUpdateNotification();
        }
        
        // Show UI
        if (state.subreddits.length === 0) {
            showWelcomeScreen();
        } else {
            renderSubreddits();
            renderSubredditFilter();
            switchFeed(state.current);
            updateAllDisplays();
        }
        
        setupPeriodicTasks();
        setupOnlineOfflineListeners();
        checkForUpdates();
        
        // Resume sync queue if needed
        if (navigator.onLine && state.syncQueue.length > 0) {
            console.log(`Resuming sync queue processing with ${state.syncQueue.length} jobs`);
            processSyncQueue();
        }
        
        // Show new posts toast if there are pending posts
        showNewPostsToast();
    }

    // ============================================================================
    // EVENT LISTENERS
    // ============================================================================
    function setupEventListeners() {
        // Menu & sidebar
        const menuBtn = document.getElementById('menuBtn');
        const closeSidebar = document.getElementById('closeSidebar');
        const overlay = document.getElementById('overlay');
        const headerTitle = document.getElementById('headerTitle');
        
        if (menuBtn) menuBtn.onclick = toggleSidebar;
        if (closeSidebar) closeSidebar.onclick = toggleSidebar;
        if (overlay) overlay.onclick = toggleSidebar;
        if (headerTitle) headerTitle.onclick = () => window.location.reload();
        
        // Subreddit management
        const addBtn = document.getElementById('addSubredditBtn');
        const input = document.getElementById('subredditInput');
        const refreshBtn = document.getElementById('refreshPostsBtn');
        
        if (addBtn) addBtn.onclick = addSubreddit;
        if (input) input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addSubreddit();
            }
        });
        if (refreshBtn) refreshBtn.onclick = refreshPosts;
        
        // Export/Import
        const exportBtn = document.getElementById('exportBtn');
        const importBtn = document.getElementById('importBtn');
        const importFile = document.getElementById('importFile');
        
        if (exportBtn) exportBtn.onclick = exportSubreddits;
        if (importBtn) importBtn.onclick = () => importFile && importFile.click();
        if (importFile) importFile.onchange = importSubreddits;
        
        // Theme toggle
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) themeToggle.onclick = toggleTheme;
        
        // Update button
        const updateBtn = document.getElementById('updateButton');
        if (updateBtn) updateBtn.onclick = updatePWA;
        
        // Welcome screen
        const skipWelcome = document.getElementById('skipWelcome');
        const addDefaults = document.getElementById('addDefaults');
        if (skipWelcome) skipWelcome.onclick = hideWelcomeScreen;
        if (addDefaults) addDefaults.onclick = addDefaultSubreddits;
        
        // Feed tabs
        const myTab = document.getElementById('myFeedTab');
        const popTab = document.getElementById('popularFeedTab');
        const starTab = document.getElementById('starredFeedTab');
        if (myTab) myTab.onclick = () => switchFeed('my');
        if (popTab) popTab.onclick = () => switchFeed('popular');
        if (starTab) starTab.onclick = () => switchFeed('starred');
        
        // Subreddit popup
        const popupClose = document.getElementById('popupCloseBtn');
        const popupFollow = document.getElementById('popupFollowBtn');
        const popupBlock = document.getElementById('popupBlockBtn');
        const popup = document.getElementById('subredditPopup');
        
        if (popupClose) popupClose.onclick = closeSubredditPopup;
        if (popupFollow) popupFollow.onclick = toggleFollowSubreddit;
        if (popupBlock) popupBlock.onclick = toggleBlockSubreddit;
        if (popup) popup.onclick = (e) => e.target === popup && closeSubredditPopup();
        
        // User popup
        const userPopupClose = document.getElementById('userPopupCloseBtn');
        const userPopupBlock = document.getElementById('popupUserBlockBtn');
        const userPopup = document.getElementById('userPopup');
        
        if (userPopupClose) userPopupClose.onclick = closeUserPopup;
        if (userPopupBlock) userPopupBlock.onclick = toggleBlockUser;
        if (userPopup) userPopup.onclick = (e) => e.target === userPopup && closeUserPopup();
        
        // Gallery navigation - event delegation
        document.addEventListener('click', handleGalleryClick);
    }

    // Simplified gallery handler
    function handleGalleryClick(e) {
        const gallery = e.target.closest('.post-gallery');
        if (!gallery) return;
        
        if (e.target.matches('.gallery-nav, .gallery-dot')) {
            e.preventDefault();
            const imgs = gallery.querySelectorAll('.post-gallery-image');
            const curr = parseInt(gallery.dataset.current || 0);
            let next = curr;
            
            if (e.target.classList.contains('prev')) {
                next = (curr - 1 + imgs.length) % imgs.length;
            } else if (e.target.classList.contains('next')) {
                next = (curr + 1) % imgs.length;
            } else if (e.target.classList.contains('gallery-dot')) {
                next = parseInt(e.target.dataset.index);
            }
            
            if (next !== curr) {
                // Wait for image to load if needed
                const nextImg = imgs[next];
                if (!nextImg.complete && !nextImg.classList.contains('loaded')) {
                    gallery.classList.add('loading');
                    nextImg.onload = () => {
                        transitionGallery(gallery, imgs, curr, next);
                        gallery.classList.remove('loading');
                    };
                } else {
                    transitionGallery(gallery, imgs, curr, next);
                }
            }
        }
    }

    function transitionGallery(gallery, imgs, curr, next) {
        imgs[curr].classList.remove('active');
        imgs[next].classList.add('active');
        
        const dots = gallery.querySelectorAll('.gallery-dot');
        dots[curr].classList.remove('active');
        dots[next].classList.add('active');
        
        gallery.dataset.current = next;
        
        const counter = gallery.querySelector('.gallery-counter');
        if (counter) counter.textContent = `${next + 1} / ${imgs.length}`;
    }

    // ============================================================================
    // SERVICE WORKER
    // ============================================================================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => {
                    reg.addEventListener('updatefound', () => {
                        const newWorker = reg.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showUpdateNotification();
                            }
                        });
                    });
                })
                .catch(error => console.error('SW registration failed:', error));
            
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload(true);
            });
        }
    }

    function updateStatusDot() {
        const dot = document.getElementById('statusDot');
        if (!dot) return;
        
        // Don't override loading state if actively syncing
        if (dot.classList.contains('loading')) return;
        
        const online = navigator.onLine;
        dot.classList.toggle('online', online);
        dot.classList.toggle('offline', !online);
    }

    function setupOnlineOfflineListeners() {
        window.addEventListener('online', handleOnlineStatus);
        window.addEventListener('offline', handleOnlineStatus);
        
        window.addEventListener('online', () => {
            if (state.syncQueue.length > 0) {
                showToast('Back online! Syncing...', { type: 'info' });
                processSyncQueue();
            }
        });
        
        handleOnlineStatus();
    }

    function handleOnlineStatus() {
        const banner = document.getElementById('offlineBanner');
        const refreshBtn = document.getElementById('refreshPostsBtn');
        
        if (navigator.onLine) {
            banner && banner.classList.remove('active');
            if (refreshBtn) refreshBtn.disabled = false;
        } else {
            banner && banner.classList.add('active');
            if (refreshBtn) refreshBtn.disabled = true;
        }
        
        updateStatusDot();
    }

    function checkForUpdates() {
        if (!navigator.onLine || !('serviceWorker' in navigator)) return;
        
        navigator.serviceWorker.getRegistration()
            .then(reg => reg && reg.update())
            .catch(error => console.error('Update check failed:', error));
    }

    function showUpdateNotification() {
        state.updateAvailable = true;
        debouncedSave();
        const notification = document.getElementById('updateNotification');
        if (notification) notification.classList.add('active');
    }

    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        
        const btn = document.getElementById('themeToggle');
        if (btn) {
            btn.textContent = next === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        }
    }

    function updatePWA() {
        const now = new Date();
        try {
            localStorage.setItem('lastUpdateTime', JSON.stringify(now.toISOString()));
        } catch (e) {}
        
        state.updateAvailable = false;
        debouncedSave();
        
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
        }
        
        setTimeout(() => window.location.reload(true), CONFIG.RELOAD_DELAY);
    }

    // ============================================================================
    // UI FUNCTIONS
    // ============================================================================
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        sidebar && sidebar.classList.toggle('open');
        overlay && overlay.classList.toggle('active');
        
        if (sidebar && sidebar.classList.contains('open')) {
            updateStorageStats();
            updateVersionInfo();
        }
    }

    function updateFeedTabsVisibility() {
        const tabs = document.getElementById('feedTabs');
        if (tabs) tabs.style.display = state.subreddits.length > 0 ? 'flex' : 'none';
    }

    function switchFeed(feed) {
        state.current = feed;
        state.filter = 'all';
        
        // Reset pagination when switching feeds
        resetFeedPagination('my');
        resetFeedPagination('popular');
        resetFeedPagination('starred');
        
        debouncedSave();
        
        const tabs = ['myFeedTab', 'popularFeedTab', 'starredFeedTab'];
        const feeds = ['my', 'popular', 'starred'];
        
        tabs.forEach((tabId, i) => {
            const tab = document.getElementById(tabId);
            if (tab) tab.classList.toggle('active', feeds[i] === feed);
        });
        
        renderSubredditFilter();
        renderPosts();
        
        if (feed === 'popular' && state.feeds.popular.posts.length === 0 && navigator.onLine) {
            queueSyncJob('fetch_popular');
            processSyncQueue();
        }
    }

    function renderSubredditFilter() {
        const filterBar = document.getElementById('subredditFilter');
        if (!filterBar) return;
        
        if (state.current === 'my' && state.subreddits.length > 0) {
            const subsWithPosts = [...new Set(state.feeds.my.posts.map(p => p.subreddit))];
            const available = state.subreddits.filter(sub => 
                subsWithPosts.some(s => s.toLowerCase() === sub.toLowerCase())
            );
            
            if (available.length === 0) {
                filterBar.classList.remove('active');
                return;
            }
            
            // Sort A-Z
            const sortedAvailable = [...available].sort((a, b) => 
                a.toLowerCase().localeCompare(b.toLowerCase())
            );
            
            filterBar.classList.add('active');
            const chips = ['<span class="filter-chip active" data-filter="all">All</span>'];
            sortedAvailable.forEach(sub => {
                chips.push(`<span class="filter-chip" data-filter="${sub}">r/${sub}</span>`);
            });
            
            filterBar.innerHTML = chips.join('');
            filterBar.querySelectorAll('.filter-chip').forEach(chip => {
                chip.onclick = () => setActiveFilter(chip.dataset.filter);
            });
        } else {
            filterBar.classList.remove('active');
        }
    }

    function setActiveFilter(filter) {
        state.filter = filter;
        resetFeedPagination(state.current);
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.filter === filter);
        });
        renderPosts();
    }

    function renderPosts() {
        const container = document.getElementById('posts');
        const status = document.getElementById('status');
        if (!container) return;
        
        let posts = state.feeds[state.current].posts;
        
        // Apply filter for My Feed
        if (state.current === 'my' && state.filter !== 'all') {
            posts = posts.filter(p => p.subreddit.toLowerCase() === state.filter.toLowerCase());
        }
        
        // Use cached filtered posts for Popular
        if (state.current === 'popular') {
            posts = state.feeds.popular.filtered.length > 0 
                ? state.feeds.popular.filtered 
                : posts.filter(p => !state.blocked.some(b => b.toLowerCase() === p.subreddit.toLowerCase()));
        }
        
        // Filter blocked users globally
        posts = posts.filter(p => !state.blockedUsers.some(u => u.toLowerCase() === p.author.toLowerCase()));
        
        // Check if we're syncing
        const isSyncing = state.isProcessingQueue || state.syncQueue.some(j => 
            j.status === 'processing' || j.status === 'pending'
        );
        
        if (posts.length === 0) {
            // Show "Fetching new posts..." in status div when syncing
            if (isSyncing) {
                if (status) {
                    status.textContent = 'Fetching new posts...';
                    status.style.display = 'block';
                }
                container.innerHTML = ''; // Empty container while syncing
                return;
            }
            
            // Clear status when not syncing
            if (status) {
                status.textContent = '';
                status.style.display = 'none';
            }
            
            const messages = {
                starred: 'No starred posts yet. Tap the ★ icon on posts to save them here.',
                my: navigator.onLine ? 'No posts yet. Add subreddits and click "Refresh Posts".' : 'No cached posts. Connect to internet and refresh.',
                popular: navigator.onLine ? 'No popular posts yet. They will load automatically.' : 'No cached popular posts. Connect to internet to fetch.'
            };
            container.innerHTML = `<div class="post"><div class="post-text" style="text-align: center; padding: 40px 20px; color: #7c7c7c;">${messages[state.current]}</div></div>`;
            return;
        }
        
        if (status) {
            status.textContent = '';
            status.style.display = 'none';
        }
        
        // Pagination - render only visible posts
        const currentPage = state.feeds[state.current].currentPage || 1;
        const visiblePosts = posts.slice(0, currentPage * CONFIG.POSTS_PER_PAGE);
        
        container.innerHTML = visiblePosts.map(createPostHTML).join('');
        
        // Add auto-loading button if there are more posts
        if (visiblePosts.length < posts.length) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn';
            loadMoreBtn.innerHTML = `<span class="load-more-spinner"></span> ${posts.length - visiblePosts.length} more posts`;
            loadMoreBtn.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 20px auto;
                padding: 12px 24px;
                background: var(--accent-color);
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 14px;
                font-weight: 500;
                cursor: default;
            `;
            
            const spinner = loadMoreBtn.querySelector('.load-more-spinner');
            spinner.style.cssText = `
                width: 14px;
                height: 14px;
                border-radius: 50%;
                border: 2px solid transparent;
                border-top-color: white;
                border-right-color: white;
                opacity: 0;
                transition: opacity 0.2s;
            `;
            
            container.appendChild(loadMoreBtn);
            
            // Intersection Observer to trigger auto-load
            let countdownTimer = null;
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // User sees the button, start countdown
                        spinner.style.opacity = '1';
                        spinner.style.animation = `spin ${CONFIG.LOAD_MORE_COUNTDOWN / 1000}s linear`;
                        loadMoreBtn.innerHTML = `<span class="load-more-spinner" style="width: 14px; height: 14px; border-radius: 50%; border: 2px solid transparent; border-top-color: white; border-right-color: white; opacity: 1; animation: spin ${CONFIG.LOAD_MORE_COUNTDOWN / 1000}s linear;"></span> Loading more...`;
                        
                        countdownTimer = setTimeout(() => {
                            state.feeds[state.current].currentPage = (state.feeds[state.current].currentPage || 1) + 1;
                            observer.disconnect();
                            renderPosts();
                        }, CONFIG.LOAD_MORE_COUNTDOWN);
                    } else {
                        // User scrolled away, cancel countdown
                        if (countdownTimer) {
                            clearTimeout(countdownTimer);
                            countdownTimer = null;
                        }
                        spinner.style.opacity = '0';
                        spinner.style.animation = 'none';
                        loadMoreBtn.innerHTML = `<span class="load-more-spinner" style="width: 14px; height: 14px; border-radius: 50%; border: 2px solid transparent; border-top-color: white; border-right-color: white; opacity: 0;"></span> ${posts.length - visiblePosts.length} more posts`;
                    }
                });
            }, { threshold: 0.5 });
            
            observer.observe(loadMoreBtn);
        }
    }

    // ============================================================================
    // TEMPLATE HELPERS
    // ============================================================================
    const templates = {
        postHeader: (post, isBookmarked) => `
            <div class="post-header">
                <span class="subreddit-name" onclick="window.openSubredditPopup('${esc(post.subreddit)}')">r/${esc(post.subreddit)}</span>
                • Posted by <span class="post-author" onclick="window.openUserPopup('${esc(post.author)}')" style="cursor: pointer; text-decoration: underline;">u/${esc(post.author)}</span>
                • ${formatTime(post.created_utc)}
                <button class="bookmark-btn ${isBookmarked ? 'bookmarked' : ''}" 
                        onclick="window.toggleBookmark('${post.id}')" 
                        title="${isBookmarked ? 'Remove from starred' : 'Add to starred'}">
                    ${isBookmarked ? '★' : '☆'}
                </button>
            </div>`,
        
        postTitle: (post) => `
            <div class="post-title">
                <a href="https://reddit.com${esc(post.permalink)}" target="_blank" rel="noopener">${esc(post.title)}</a>
            </div>`,
        
        postFooter: (post) => `
            <div class="post-footer">
                <span class="post-stat">⬆ ${formatNumber(post.ups)} upvotes</span>
                <span class="post-stat">💬 ${formatNumber(post.num_comments)} comments</span>
            </div>`,
        
        videoPreview: (post, thumbnail) => {
            const audioTrack = post.audio_url ? `<source src="${esc(post.audio_url)}" type="audio/mp4">` : '';
            return `
                <div class="video-preview" onclick="window.playVideo(this, '${esc(post.video_url)}', '${esc(post.audio_url || '')}')">
                    <img class="video-thumbnail" src="${esc(thumbnail)}" alt="Video thumbnail" loading="lazy" />
                    <div class="video-play-overlay">
                        <div class="video-play-button">▶</div>
                    </div>
                    <video class="post-video" style="display: none;" controls preload="none">
                        <source src="${esc(post.video_url)}" type="video/mp4">
                    </video>
                    ${audioTrack ? `<audio class="post-audio" style="display: none;" preload="none">${audioTrack}</audio>` : ''}
                </div>`;
        },
        
        gallery: (post) => {
            const galleryId = `gallery-${post.id}`;
            const imgs = post.gallery.map((url, i) => 
                `<img class="post-gallery-image ${i === 0 ? 'active' : ''}" src="${esc(url)}" alt="" ${i === 0 ? '' : 'loading="lazy"'} onload="this.classList.add('loaded')" />`
            ).join('');
            const dots = post.gallery.map((_, i) => 
                `<span class="gallery-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></span>`
            ).join('');
            
            return `
                <div class="post-gallery" id="${galleryId}" data-current="0">
                    ${imgs}
                    <button class="gallery-nav prev">‹</button>
                    <button class="gallery-nav next">›</button>
                    <div class="gallery-indicators">${dots}</div>
                    <div class="gallery-counter">1 / ${post.gallery.length}</div>
                </div>`;
        }
    };

    // ============================================================================
    // POST RENDERING
    // ============================================================================
    function createPostHTML(post) {
        const isBookmarked = state.feeds.starred.posts.some(p => p.id === post.id);
        
        return `
            <div class="post">
                ${templates.postHeader(post, isBookmarked)}
                ${templates.postTitle(post)}
                ${getMediaHTML(post)}
                ${getTextHTML(post)}
                ${templates.postFooter(post)}
            </div>
        `;
    }

    function getMediaHTML(post) {
        if (post.is_video && post.video_url) {
            const thumbnail = post.gallery && post.gallery[0] ? post.gallery[0] : '';
            
            if (thumbnail) {
                return templates.videoPreview(post, thumbnail);
            }
            
            return `<video class="post-image" controls preload="metadata"><source src="${esc(post.video_url)}" type="video/mp4"></video>`;
        }
        
        if (post.gallery && post.gallery.length > 0 && !post.is_video) {
            if (post.gallery.length === 1) {
                return `<img class="post-image" src="${esc(post.gallery[0])}" alt="" loading="lazy" />`;
            }
            
            return templates.gallery(post);
        }
        
        return '';
    }

    window.playVideo = function(container, videoUrl, audioUrl) {
        if (!navigator.onLine) {
            showToast('You must be online to play videos', { type: 'warning' });
            return;
        }
        
        const thumbnail = container.querySelector('.video-thumbnail');
        const overlay = container.querySelector('.video-play-overlay');
        const video = container.querySelector('.post-video');
        const audio = container.querySelector('.post-audio');
        
        if (thumbnail) thumbnail.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        
        if (video) {
            video.style.display = 'block';
            video.muted = false;
            video.volume = 1.0;
            video.load();
            
            // If there's a separate audio track, sync it with video
            if (audio && audioUrl) {
                audio.load();
                audio.volume = 1.0;
                
                // Sync audio with video
                video.addEventListener('play', () => {
                    audio.currentTime = video.currentTime;
                    audio.play().catch(err => console.log('Audio play failed:', err));
                });
                video.addEventListener('pause', () => audio.pause());
                video.addEventListener('seeked', () => {
                    audio.currentTime = video.currentTime;
                });
            }
            
            video.play().catch(err => console.log('Video play failed:', err));
        }
    };

    function getTextHTML(post) {
        if (!post.selftext) return '';
        
        let text = post.selftext;
        
        // Convert HTML anchor tags to clickable links
        text = text.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '<a href="$1" target="_blank" rel="noopener">$2</a>');
        
        // Convert markdown links
        text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        
        // Escape HTML (but preserve the links we just created)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = text;
        text = tempDiv.textContent || tempDiv.innerText;
        
        // Re-apply the link conversion after escaping
        text = text.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '<a href="$1" target="_blank" rel="noopener">$2</a>');
        text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        
        // Convert plain URLs to clickable links
        text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
        
        // Convert newlines to <br>
        text = text.replace(/\n/g, '<br>');
        
        // Check if text is too long
        if (text.length > CONFIG.MAX_POST_TEXT_LENGTH) {
            const preview = text.substring(0, CONFIG.MAX_POST_TEXT_LENGTH) + '...';
            
            return `
                <div class="post-text">
                    <div class="post-text-preview">${preview}</div>
                    <div class="post-text-full" style="display: none;">${text}</div>
                    <button class="post-text-toggle" onclick="window.togglePostText(this)">Read More</button>
                </div>
            `;
        }
        
        return `<div class="post-text">${text}</div>`;
    }

    window.togglePostText = function(button) {
        const container = button.parentElement;
        const preview = container.querySelector('.post-text-preview');
        const full = container.querySelector('.post-text-full');
        
        if (full.style.display === 'none') {
            // Expand
            preview.style.display = 'none';
            full.style.display = 'block';
            button.textContent = 'Show Less';
        } else {
            // Collapse
            preview.style.display = 'block';
            full.style.display = 'none';
            button.textContent = 'Read More';
        }
    };

    function esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTime(timestamp) {
        const diff = Date.now() / 1000 - timestamp;
        if (diff < 0) return 'just now';
        if (diff < 60) return `${Math.floor(diff)}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
        return new Date(timestamp * 1000).toLocaleDateString();
    }

    function formatNumber(num) {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
        return num.toString();
    }

    // ============================================================================
    // SCROLL TO TOP BUTTON
    // ============================================================================
    function createScrollToTopButton() {
        const button = document.createElement('button');
        button.id = 'scrollToTop';
        button.innerHTML = '↑';
        button.title = 'Scroll to top';
        button.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            border-radius: 25px;
            background: var(--accent-color);
            color: white;
            border: 2px solid #ff4500;
            font-size: 24px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 999;
            display: none;
            transition: all 0.3s ease;
        `;
        
        button.onclick = () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        
        document.body.appendChild(button);
        
        // Show/hide button based on scroll position
        window.addEventListener('scroll', () => {
            if (window.scrollY > CONFIG.SCROLL_TO_TOP_THRESHOLD) {
                button.style.display = 'block';
            } else {
                button.style.display = 'none';
            }
        });
    }

    // ============================================================================
    // SUBREDDIT MANAGEMENT
    // ============================================================================
    function renderSubreddits() {
        const list = document.getElementById('subredditList');
        const blockedList = document.getElementById('blockedList');
        const blockedSection = document.getElementById('blockedSection');
        const blockedUsersList = document.getElementById('blockedUsersList');
        const blockedUsersSection = document.getElementById('blockedUsersSection');
        
        if (list) {
            // Sort subreddits A-Z
            const sortedSubs = [...state.subreddits].sort((a, b) => 
                a.toLowerCase().localeCompare(b.toLowerCase())
            );
            
            const title = '<h3 style="font-size: 14px; margin-bottom: 10px; color: var(--text-secondary);">Followed Subreddits</h3>';
            const content = sortedSubs.length === 0 
                ? '<span style="color: var(--text-secondary);">No subreddits added yet</span>'
                : sortedSubs.map(sub => 
                    `<span class="subreddit-tag" onclick="window.removeSubreddit('${sub}')">r/${sub} ×</span>`
                  ).join('');
            
            list.innerHTML = title + content;
        }
        
        if (blockedList && blockedSection) {
            if (state.blocked.length === 0) {
                blockedSection.style.display = 'none';
            } else {
                blockedSection.style.display = 'block';
                
                // Sort blocked subreddits A-Z
                const sortedBlocked = [...state.blocked].sort((a, b) => 
                    a.toLowerCase().localeCompare(b.toLowerCase())
                );
                
                blockedList.innerHTML = sortedBlocked.map(sub => 
                    `<span class="subreddit-tag blocked" onclick="window.unblockSubreddit('${sub}')">r/${sub} ×</span>`
                ).join('');
            }
        }
        
        if (blockedUsersList && blockedUsersSection) {
            if (state.blockedUsers.length === 0) {
                blockedUsersSection.style.display = 'none';
            } else {
                blockedUsersSection.style.display = 'block';
                
                // Sort blocked users A-Z
                const sortedBlockedUsers = [...state.blockedUsers].sort((a, b) => 
                    a.toLowerCase().localeCompare(b.toLowerCase())
                );
                
                blockedUsersList.innerHTML = sortedBlockedUsers.map(user => 
                    `<span class="subreddit-tag blocked" onclick="window.unblockUser('${user}')">u/${user} ×</span>`
                ).join('');
            }
        }
    }

    window.unblockUser = function(username) {
        showConfirm(
            `Unblock u/${username}? Posts from this user will appear again in your feeds.`,
            () => {
                state.blockedUsers = state.blockedUsers.filter(u => u.toLowerCase() !== username.toLowerCase());
                updateAllViews();
                showToast(`Unblocked u/${username}`, { type: 'success' });
            }
        );
    };

    function addSubreddit() {
        const input = document.getElementById('subredditInput');
        if (!input) return;
        
        const sub = input.value.trim().replace(/^r\//, '');
        if (!sub) return;
        
        if (state.subreddits.some(s => s.toLowerCase() === sub.toLowerCase())) {
            showToast('Subreddit already added', { type: 'warning' });
            return;
        }
        
        state.subreddits.push(sub);
        saveState();
        input.value = '';
        renderSubreddits();
        toggleSidebar();
        
        queueSyncJob('fetch_subreddit', sub);
        processSyncQueue();
    }

    window.removeSubreddit = function(sub) {
        showConfirm(
            `Remove r/${sub}? This will also delete all cached posts from this subreddit.`,
            () => {
                state.subreddits = state.subreddits.filter(s => s.toLowerCase() !== sub.toLowerCase());
                state.feeds.my.posts = state.feeds.my.posts.filter(p => p.subreddit.toLowerCase() !== sub.toLowerCase());
                state.feeds.my.pending.posts = state.feeds.my.pending.posts.filter(p => p.subreddit.toLowerCase() !== sub.toLowerCase());
                state.feeds.my.pending.count = state.feeds.my.pending.posts.length;
                
                if (state.filter.toLowerCase() === sub.toLowerCase()) {
                    state.filter = 'all';
                }
                
                updateFeedTabsVisibility();
                updateAllViews();
                showToast(`Removed r/${sub}`, { type: 'success' });
            }
        );
    };

    window.unblockSubreddit = function(sub) {
        showConfirm(
            `Unblock r/${sub}? Posts from this subreddit will appear again in your Popular feed.`,
            () => {
                state.blocked = state.blocked.filter(s => s.toLowerCase() !== sub.toLowerCase());
                rebuildPopularFiltered();
                updateAllViews();
                showToast(`Unblocked r/${sub}`, { type: 'success' });
            }
        );
    };

    function refreshPosts() {
        if (!navigator.onLine) {
            showToast('You are offline. Updates queued for when connection is restored.', { type: 'info' });
            // Queue jobs for both feeds when offline
            state.subreddits.forEach(sub => {
                queueSyncJob('fetch_subreddit', sub);
            });
            queueSyncJob('fetch_popular');
            return;
        }
        
        toggleSidebar();
        
        // Always refresh both My Feed and Popular feed
        state.subreddits.forEach(sub => {
            queueSyncJob('fetch_subreddit', sub);
        });
        queueSyncJob('fetch_popular');
        
        // Start processing queue immediately
        processSyncQueue();
    }

    async function exportSubreddits() {
        const data = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            subreddits: state.subreddits,
            blocked: state.blocked,
            blockedUsers: state.blockedUsers,
            starredPosts: state.feeds.starred.posts,
            settings: {
                theme: localStorage.getItem('theme') || 'light'
            }
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        
        // Try File System Access API first (allows choosing location)
        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: 'enpwa-backup.json',
                    types: [{
                        description: 'JSON Files',
                        accept: { 'application/json': ['.json'] }
                    }]
                });
                
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                
                showToast('Backup exported!', { type: 'success' });
                return;
            } catch (err) {
                if (err.name === 'AbortError') return; // User cancelled
                console.error('Save picker error:', err);
                // Fall back to download
            }
        }
        
        // Fallback: traditional download with static filename
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'enpwa-backup.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Backup exported!', { type: 'success' });
    }

    function importSubreddits(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                // Validate structure
                if (!data.version && !data.subreddits) {
                    showToast('Invalid backup file', { type: 'error' });
                    return;
                }
                
                let imported = [];
                
                // Import subreddits
                if (data.subreddits && Array.isArray(data.subreddits)) {
                    const normalized = state.subreddits.map(s => s.toLowerCase());
                    const newSubs = data.subreddits.filter(sub => !normalized.includes(sub.toLowerCase()));
                    state.subreddits = [...state.subreddits, ...newSubs];
                    imported.push(`${newSubs.length} subs`);
                    
                    if (newSubs.length > 0) {
                        newSubs.forEach(sub => queueSyncJob('fetch_subreddit', sub));
                    }
                }
                
                // Import blocked subreddits
                if (data.blocked && Array.isArray(data.blocked)) {
                    const normalizedBlocked = state.blocked.map(s => s.toLowerCase());
                    const newBlocked = data.blocked.filter(sub => !normalizedBlocked.includes(sub.toLowerCase()));
                    state.blocked = [...state.blocked, ...newBlocked];
                    imported.push(`${newBlocked.length} blocked subs`);
                    
                    // Rebuild filtered cache
                    rebuildPopularFiltered();
                }
                
                // Import blocked users
                if (data.blockedUsers && Array.isArray(data.blockedUsers)) {
                    const normalizedBlockedUsers = state.blockedUsers.map(u => u.toLowerCase());
                    const newBlockedUsers = data.blockedUsers.filter(u => !normalizedBlockedUsers.includes(u.toLowerCase()));
                    state.blockedUsers = [...state.blockedUsers, ...newBlockedUsers];
                    imported.push(`${newBlockedUsers.length} blocked users`);
                }
                
                // Import starred posts
                if (data.starredPosts && Array.isArray(data.starredPosts)) {
                    const existingIds = new Set(state.feeds.starred.posts.map(p => p.id));
                    const newStarred = data.starredPosts.filter(p => !existingIds.has(p.id));
                    state.feeds.starred.posts = [...state.feeds.starred.posts, ...newStarred];
                    imported.push(`${newStarred.length} starred`);
                }
                
                // Import settings
                if (data.settings && data.settings.theme) {
                    localStorage.setItem('theme', data.settings.theme);
                    document.documentElement.setAttribute('data-theme', data.settings.theme);
                    const btn = document.getElementById('themeToggle');
                    if (btn) {
                        btn.textContent = data.settings.theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
                    }
                }
                
                saveState();
                renderSubreddits();
                renderSubredditFilter();
                updateFeedTabsVisibility();
                renderPosts();
                
                showToast(`Imported: ${imported.join(', ')}`, { type: 'success' });
                
                toggleSidebar();
                processSyncQueue();
                
                event.target.value = '';
            } catch (error) {
                showToast('Error reading file: ' + error.message, { type: 'error' });
            }
        };
        reader.readAsText(file);
    }

    // ============================================================================
    // SUBREDDIT POPUP
    // ============================================================================
    let currentPopupSubreddit = null;

    window.openSubredditPopup = async function(subredditName) {
        currentPopupSubreddit = subredditName;
        const popup = document.getElementById('subredditPopup');
        const nameEl = document.getElementById('popupSubredditName');
        const statsEl = document.getElementById('popupSubredditStats');
        const infoEl = document.getElementById('popupSubredditInfo');
        const iconEl = document.getElementById('popupIcon');
        const bannerEl = document.getElementById('popupBanner');
        const followBtn = document.getElementById('popupFollowBtn');
        const blockBtn = document.getElementById('popupBlockBtn');
        
        if (!popup) return;
        
        nameEl.textContent = `r/${subredditName}`;
        statsEl.textContent = 'Loading...';
        infoEl.textContent = 'Loading...';
        iconEl.style.display = 'none';
        bannerEl.style.backgroundImage = '';
        bannerEl.style.background = 'linear-gradient(to bottom, var(--accent-color), transparent)';
        
        const isFollowing = state.subreddits.some(s => s.toLowerCase() === subredditName.toLowerCase());
        const isBlocked = state.blocked.some(s => s.toLowerCase() === subredditName.toLowerCase());
        
        if (followBtn) {
            if (isFollowing) {
                followBtn.textContent = 'Unfollow';
                followBtn.className = 'popup-btn-follow following';
            } else {
                followBtn.textContent = 'Follow';
                followBtn.className = 'popup-btn-follow';
            }
        }
        
        if (blockBtn) {
            blockBtn.textContent = isBlocked ? 'Blocked' : 'Block';
            blockBtn.className = isBlocked ? 'popup-btn-block blocked' : 'popup-btn-block';
        }
        
        popup.classList.add('active');
        
        try {
            const response = await fetch(`https://www.reddit.com/r/${subredditName}/about.json`);
            if (!response.ok) throw new Error('Failed');
            
            const data = await response.json();
            const sub = data.data;
            
            nameEl.textContent = `r/${sub.display_name || subredditName}`;
            statsEl.textContent = `${formatNumber(sub.subscribers || 0)} members`;
            infoEl.textContent = sub.public_description || sub.description || 'No description available.';
            
            if (sub.icon_img && sub.icon_img.trim()) {
                iconEl.src = sub.icon_img.replace(/&amp;/g, '&');
                iconEl.style.display = 'block';
            }
            
            if (sub.header_img && sub.header_img.trim()) {
                bannerEl.style.backgroundImage = `url(${sub.header_img.replace(/&amp;/g, '&')})`;
            } else if (sub.key_color) {
                bannerEl.style.background = `linear-gradient(to bottom, ${sub.key_color}, transparent)`;
            }
        } catch (error) {
            console.error('Error fetching subreddit info:', error);
            statsEl.textContent = '';
            infoEl.textContent = `Community discussions from r/${subredditName}`;
        }
    };

    function closeSubredditPopup() {
        const popup = document.getElementById('subredditPopup');
        if (popup) popup.classList.remove('active');
        currentPopupSubreddit = null;
    }

    function toggleFollowSubreddit() {
        if (!currentPopupSubreddit) return;
        
        const isFollowing = state.subreddits.some(s => s.toLowerCase() === currentPopupSubreddit.toLowerCase());
        
        if (isFollowing) {
            // Unfollow
            showConfirm(
                `Unfollow r/${currentPopupSubreddit}? This will also remove all posts from this subreddit from your feed.`,
                () => {
                    state.subreddits = state.subreddits.filter(s => s.toLowerCase() !== currentPopupSubreddit.toLowerCase());
                    state.feeds.my.posts = state.feeds.my.posts.filter(p => p.subreddit.toLowerCase() !== currentPopupSubreddit.toLowerCase());
                    state.feeds.my.pending.posts = state.feeds.my.pending.posts.filter(p => p.subreddit.toLowerCase() !== currentPopupSubreddit.toLowerCase());
                    state.feeds.my.pending.count = state.feeds.my.pending.posts.length;
                    
                    updateFeedTabsVisibility();
                    updateAllViews();
                    
                    const followBtn = document.getElementById('popupFollowBtn');
                    if (followBtn) {
                        followBtn.textContent = 'Follow';
                        followBtn.className = 'popup-btn-follow';
                    }
                    
                    showToast(`Unfollowed r/${currentPopupSubreddit}`, { type: 'success' });
                }
            );
        } else {
            // Follow - check if already exists case-insensitively
            if (state.subreddits.some(s => s.toLowerCase() === currentPopupSubreddit.toLowerCase())) {
                showToast('Subreddit already added', { type: 'warning' });
                return;
            }
            
            state.subreddits.push(currentPopupSubreddit);
            updateFeedTabsVisibility();
            updateAllViews();
            
            const followBtn = document.getElementById('popupFollowBtn');
            if (followBtn) {
                followBtn.textContent = 'Unfollow';
                followBtn.className = 'popup-btn-follow following';
            }
            
            queueSyncJob('fetch_subreddit', currentPopupSubreddit);
            processSyncQueue();
        }
    }

    function toggleBlockSubreddit() {
        if (!currentPopupSubreddit) return;
        
        const isBlocked = state.blocked.includes(currentPopupSubreddit);
        
        if (isBlocked) {
            state.blocked = state.blocked.filter(s => s !== currentPopupSubreddit);
            rebuildPopularFiltered();
            updateAllViews();
            
            const blockBtn = document.getElementById('popupBlockBtn');
            if (blockBtn) {
                blockBtn.textContent = 'Block';
                blockBtn.className = 'popup-btn-block';
            }
            
            showToast(`Unblocked r/${currentPopupSubreddit}`, { type: 'success' });
        } else {
            showConfirm(
                `Block r/${currentPopupSubreddit}? Posts from this subreddit will be hidden from your Popular feed.`,
                () => {
                    state.blocked.push(currentPopupSubreddit);
                    rebuildPopularFiltered();
                    updateAllViews();
                    
                    const blockBtn = document.getElementById('popupBlockBtn');
                    if (blockBtn) {
                        blockBtn.textContent = 'Blocked';
                        blockBtn.className = 'popup-btn-block blocked';
                    }
                    
                    showToast(`Blocked r/${currentPopupSubreddit}`, { type: 'success' });
                }
            );
        }
    }

    // ============================================================================
    // USER POPUP
    // ============================================================================
    let currentPopupUser = null;

    window.openUserPopup = function(username) {
        currentPopupUser = username;
        const popup = document.getElementById('userPopup');
        const nameEl = document.getElementById('popupUserName');
        const blockBtn = document.getElementById('popupUserBlockBtn');
        
        if (!popup) return;
        
        nameEl.textContent = `u/${username}`;
        
        const isBlocked = state.blockedUsers.some(u => u.toLowerCase() === username.toLowerCase());
        if (blockBtn) {
            blockBtn.textContent = isBlocked ? 'Unblock User' : 'Block User';
            blockBtn.className = isBlocked ? 'popup-btn-block blocked' : 'popup-btn-block';
        }
        
        popup.classList.add('active');
    };

    window.closeUserPopup = function() {
        const popup = document.getElementById('userPopup');
        if (popup) popup.classList.remove('active');
        currentPopupUser = null;
    };

    window.toggleBlockUser = function() {
        if (!currentPopupUser) return;
        
        const isBlocked = state.blockedUsers.some(u => u.toLowerCase() === currentPopupUser.toLowerCase());
        
        if (isBlocked) {
            state.blockedUsers = state.blockedUsers.filter(u => u.toLowerCase() !== currentPopupUser.toLowerCase());
            updateAllViews();
            
            const blockBtn = document.getElementById('popupUserBlockBtn');
            if (blockBtn) {
                blockBtn.textContent = 'Block User';
                blockBtn.className = 'popup-btn-block';
            }
            
            showToast(`Unblocked u/${currentPopupUser}`, { type: 'success' });
        } else {
            state.blockedUsers.push(currentPopupUser);
            updateAllViews();
            
            const blockBtn = document.getElementById('popupUserBlockBtn');
            if (blockBtn) {
                blockBtn.textContent = 'Unblock User';
                blockBtn.className = 'popup-btn-block blocked';
            }
            
            showToast(`Blocked u/${currentPopupUser}`, { type: 'success' });
        }
    };

    // ============================================================================
    // WELCOME SCREEN
    // ============================================================================
    async function loadCountrySuggestions() {
        try {
            const response = await fetch('./subreddit-suggestions.json');
            const data = await response.json();
            state.countrySuggestions = data.countries;
        } catch (error) {
            console.error('Error loading country suggestions:', error);
            state.countrySuggestions = [];
        }
    }

    function showWelcomeScreen() {
        const screen = document.getElementById('welcomeScreen');
        const list = document.getElementById('countryList');
        if (!screen || !list) return;
        
        list.innerHTML = state.countrySuggestions.map((country, i) => `
            <div class="country-option" data-index="${i}">
                <div class="country-option-name">${country.name}</div>
                <div class="country-option-subs">${country.subreddits.join(', ')}</div>
            </div>
        `).join('');
        
        list.querySelectorAll('.country-option').forEach(opt => {
            opt.onclick = () => selectCountry(opt);
        });
        
        screen.classList.add('active');
    }

    function selectCountry(element) {
        document.querySelectorAll('.country-option').forEach(opt => opt.classList.remove('selected'));
        element.classList.add('selected');
        state.selectedCountry = parseInt(element.dataset.index);
        
        const btn = document.getElementById('addDefaults');
        if (btn) btn.disabled = false;
    }

    function addDefaultSubreddits() {
        if (state.selectedCountry === null || !state.countrySuggestions[state.selectedCountry]) return;
        
        state.subreddits = [...state.countrySuggestions[state.selectedCountry].subreddits];
        saveState();
        
        hideWelcomeScreen();
        updateFeedTabsVisibility();
        renderSubreddits();
        renderSubredditFilter();
        
        state.subreddits.forEach(sub => {
            queueSyncJob('fetch_subreddit', sub);
        });
        processSyncQueue();
    }

    function hideWelcomeScreen() {
        const screen = document.getElementById('welcomeScreen');
        if (screen) screen.classList.remove('active');
        renderSubreddits();
        renderPosts();
        updateAllDisplays();
    }

    // ============================================================================
    // PERIODIC TASKS
    // ============================================================================
    function setupPeriodicTasks() {
        // Clear existing
        Object.values(intervals).forEach(id => id && clearInterval(id));
        
        intervals.display = setInterval(updateAllDisplays, CONFIG.DISPLAY_UPDATE_INTERVAL);
        
        if ('serviceWorker' in navigator) {
            intervals.updateCheck = setInterval(checkForUpdates, CONFIG.UPDATE_CHECK_INTERVAL);
        }
        
        intervals.rateLimit = setInterval(() => {
            const now = Date.now();
            if (now >= state.rateLimitState.resetTime) {
                state.rateLimitState.remainingRequests = CONFIG.REQUESTS_PER_MINUTE;
                state.rateLimitState.resetTime = now + CONFIG.RATE_LIMIT_RESET_INTERVAL;
                state.rateLimitState.requestCount = 0;
                debouncedSave();
            }
        }, 10000);
    }

    window.addEventListener('beforeunload', () => {
        Object.values(intervals).forEach(id => id && clearInterval(id));
    });

    function updateAllDisplays() {
        updateStorageStats();
        updateVersionInfo();
        updateStatusDot(); // Update online/offline status periodically
    }

    function updateVersionInfo() {
        const el = document.getElementById('versionInfo');
        if (!el) return;
        
        try {
            const lastUpdate = JSON.parse(localStorage.getItem('lastUpdateTime') || 'null');
            if (lastUpdate) {
                const date = new Date(lastUpdate);
                el.innerHTML = `Last updated<br>${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
            } else {
                el.innerHTML = 'No update history';
            }
        } catch (e) {
            el.innerHTML = 'No update history';
        }
    }

    // ============================================================================
    // START APPLICATION
    // ============================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeApp();
            createScrollToTopButton();
        });
    } else {
        initializeApp();
        createScrollToTopButton();
    }

})();