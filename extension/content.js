const DEFAULT_SETTINGS = {
    timelinePosition: 'right',
    enableDragging: true,
    enableLongPressDrag: true,
    enableTOC: true,
    tocWidth: 280,
    tocPosition: 'left',
    enableChatGPTTimeline: true,
    enableGeminiTimeline: true,
    chatgptWidth: 48,
    taskPageWidth: 48
};

const SITE_CONFIGS = {
    chatgpt: {
        id: 'chatgpt',
        hostMatches: ['chatgpt.com', 'chat.openai.com'],
        pathPrefixes: ['/c/', '/g/'],
        userTurnSelector: 'article[data-turn="user"]',
        allTurnSelector: 'article[data-turn-id]',
        assistantTurnSelector: 'article[data-turn="assistant"]',
        userTextSelector: null,
        assistantTextSelector: null,
        conversationRootSelectors: [
            'article[data-turn-id]',
            '[data-testid="conversation-turn"]',
            '.conversation-turn'
        ]
    },
    gemini: {
        id: 'gemini',
        hostMatches: ['gemini.google.com'],
        pathPrefixes: ['/app/', '/app'],
        userTurnSelector: 'user-query',
        allTurnSelector: 'div.conversation-container',
        assistantTurnSelector: 'model-response',
        userTextSelector: 'user-query .query-text, user-query-content .query-text, .query-text',
        assistantTextSelector: 'message-content, .markdown, .model-response-text',
        conversationRootSelectors: [
            'div.conversation-container',
            'user-query',
            'chat-window-content',
            '#chat-history',
            'infinite-scroller'
        ]
    }
};

function getSiteType(hostname = location.hostname) {
    const host = hostname || '';
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
        if (config.hostMatches.some(match => host === match || host.endsWith(`.${match}`))) {
            return key;
        }
    }
    return 'unknown';
}

function getSiteConfig(siteType = getSiteType()) {
    return SITE_CONFIGS[siteType] || SITE_CONFIGS.chatgpt;
}

function isTimelineEnabledForSite(settings, siteType = getSiteType()) {
    if (!settings) return true;
    if (siteType === 'gemini') return settings.enableGeminiTimeline !== false;
    if (siteType === 'chatgpt') return settings.enableChatGPTTimeline !== false;
    return false;
}

let settingsCache = { ...DEFAULT_SETTINGS };
let settingsCacheLoaded = false;

async function loadSettingsCache() {
    try {
        const result = await chrome.storage.local.get(['chatgptTimelineSettings']);
        const saved = result.chatgptTimelineSettings || {};
        settingsCache = { ...DEFAULT_SETTINGS, ...saved };
        settingsCacheLoaded = true;
        return settingsCache;
    } catch (error) {
        console.warn('Failed to load settings cache:', error);
        settingsCacheLoaded = true;
        return settingsCache;
    }
}

function getCachedSettings() {
    return settingsCacheLoaded ? settingsCache : { ...DEFAULT_SETTINGS, ...settingsCache };
}

function isSupportedConversationUrl(url) {
    try {
        const parsed = new URL(url, location.origin);
        const siteType = getSiteType(parsed.hostname);
        const config = SITE_CONFIGS[siteType];
        if (!config) return false;
        return config.pathPrefixes.some(prefix => parsed.pathname.startsWith(prefix));
    } catch {
        return false;
    }
}

function getFirstTurnElementForSite() {
    const config = getSiteConfig();
    return document.querySelector(config.allTurnSelector) ||
           document.querySelector(config.userTurnSelector);
}

function getAllTurnElementsForSite() {
    const config = getSiteConfig();
    return Array.from(document.querySelectorAll(config.allTurnSelector));
}

class TimelineManager {
    constructor() {
        this.scrollContainer = null;
        this.conversationContainer = null;
        this.markers = [];
        this.markerById = new Map();
        this.activeTurnId = null;
        this.ui = { timelineBar: null, tooltip: null };
        this.isScrolling = false;

        // 语言管理器实例
        this.i18n = null;

        this.mutationObserver = null;
        this.resizeObserver = null;
        this.intersectionObserver = null;
        this.visibleTurns = new Set();
        this.onTimelineBarClick = null;
        this.onScroll = null;
        this.onTimelineBarOver = null;
        this.onTimelineBarOut = null;
        this.onTimelineBarFocusIn = null;
        this.onTimelineBarFocusOut = null;
        this.onWindowResize = null;
        this.onTimelineWheel = null;
        this.scrollRafId = null;
        this.lastActiveChangeTime = 0;
        this.minActiveChangeInterval = 120; // ms
        this.pendingActiveId = null;
        this.activeChangeTimer = null;
        this.tooltipHideDelay = 100;
        this.tooltipHideTimer = null;
        this.measureEl = null; // legacy DOM measurer (kept as fallback)
        this.truncateCache = new Map();
        this.measureCanvas = null;
        this.measureCtx = null;
        this.showRafId = null;
        // Long-canvas scrollable track (Linked mode)
        this.ui.track = null;
        this.ui.trackContent = null;
        this.scale = 1;
        this.contentHeight = 0;
        this.yPositions = [];
        this.visibleRange = { start: 0, end: -1 };
        this.firstUserTurnOffset = 0;
        this.contentSpanPx = 1;
        this.usePixelTop = false; // fallback when CSS var positioning is unreliable
        this._cssVarTopSupported = null;
        // Left-side slider (only controls timeline scroll)
        this.ui.slider = null;
        this.ui.sliderHandle = null;
        this.sliderDragging = false;
        this.sliderFadeTimer = null;
        this.sliderFadeDelay = 1000;
        this.sliderAlwaysVisible = false; // show slider persistently when scrollable
        this.onSliderDown = null;
        this.onSliderMove = null;
        this.onSliderUp = null;
        this.markersVersion = 0;
        // Resize idle correction scheduling + debug perf
        this.resizeIdleTimer = null;
        this.resizeIdleDelay = 140; // ms settle time before min-gap correction
        this.resizeIdleRICId = null; // requestIdleCallback id
        this.debugPerf = false;
        try { this.debugPerf = (localStorage.getItem('chatgptTimelineDebugPerf') === '1'); } catch {}
        this.onVisualViewportResize = null;
        this.resizeIdleTimer = null;
        this.resizeIdleDelay = 140; // ms, settle time before min-gap correction

        // Draggable functionality
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.barStartX = 0;
        this.barStartY = 0;
        this.onDragHandleDown = null;
        this.onDragHandleMove = null;
        this.onDragHandleUp = null;
        this.dragHandle = null;

        // Long press drag functionality for timeline
        this.longPressTimer = null;
        this.isLongPress = false;
        this.longPressStartX = 0;
        this.longPressStartY = 0;
        this.longPressDelay = 500; // 500ms long press delay
        this.longPressMoveThreshold = 10; // 10px movement threshold

        // TOC Draggable functionality
        this.tocDragging = false;
        this.tocDragStartX = 0;
        this.tocDragStartY = 0;
        this.tocStartX = 0;
        this.tocStartY = 0;
        this.tocDragHandle = null;
        this.onTOCDragMove = null;
        this.onTOCDragUp = null;
        this.tocOriginalCursor = null;
        this.tocDragScrollSyncDisabled = false;

        // Position persistence
        this.positionKey = 'chatgptTimelinePosition';

        // Settings management
        this.settingsKey = 'chatgptTimelineSettings';
        this.settings = { ...DEFAULT_SETTINGS };
        this.siteType = getSiteType();

        this.debouncedRecalculateAndRender = this.debounce(this.recalculateAndRenderMarkers, 350);

        // Debounced TOC update to prevent flickering during rapid state changes
        this.debouncedTOCUpdate = this.debounce(() => {
            const tocContainer = document.querySelector('.timeline-toc');
            if (tocContainer) {
                this.updateTOCIncrementally(tocContainer);
            }
        }, 150);

        // Debounced TOC collapse to prevent rapid state changes
        this.debouncedCollapseTOC = this.debounce(() => {
            this.collapseTOC();
        }, 100);

        // Set up periodic visibility check (reduced frequency since we have better event-driven updates)
        this.tocVisibilityCheckInterval = setInterval(() => {
            this.ensureTOCVisible();
        }, 10000); // Check every 10 seconds (reduced from 5 seconds)
    }

    perfStart(name) {
        if (!this.debugPerf) return;
        try { performance.mark(`tg-${name}-start`); } catch {}
    }

    perfEnd(name) {
        if (!this.debugPerf) return;
        try {
            performance.mark(`tg-${name}-end`);
            performance.measure(`tg-${name}`, `tg-${name}-start`, `tg-${name}-end`);
            const entries = performance.getEntriesByName(`tg-${name}`).slice(-1)[0];
            if (entries) console.debug(`[TimelinePerf] ${name}: ${Math.round(entries.duration)}ms`);
        } catch {}
    }

    async init() {
        try {
            // 初始化语言管理器
            if (typeof i18n !== 'undefined') {
                this.i18n = i18n;
            }

            await this.loadSettings();
            if (!isTimelineEnabledForSite(this.settings, this.siteType)) {
                console.log(`Timeline disabled for ${this.siteType}, skipping initialization`);
                return;
            }

            // Find critical elements with fallbacks
            await this.findCriticalElements();

            // Inject timeline UI
            await this.injectTimelineUI();

            // Setup event listeners and observers
            this.setupEventListeners();
            this.setupObservers();

            // Create TOC if enabled
            if (this.settings.enableTOC) {
                // Use requestAnimationFrame for better timing
                requestAnimationFrame(() => {
                    try {
                        this.createTOC();
                    } catch (error) {
                        console.warn('Failed to create TOC:', error);
                    }
                });
            }

            console.log('Timeline initialized successfully');
        } catch (error) {
            console.error('Timeline initialization failed:', error);
            // Don't re-throw the error to prevent breaking the entire extension
        }
    }
    
    async findCriticalElements() {
        const maxRetries = 5;
        const retryDelay = 1000; // 1 second
        let firstTurn = null;
        const siteConfig = getSiteConfig(this.siteType);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`Finding critical elements, attempt ${attempt}/${maxRetries}`);

            // Try multiple selectors for conversation turns (ChatGPT may have changed their DOM structure)
            const possibleSelectors = [
                ...(siteConfig.conversationRootSelectors || []),
                'article[data-turn-id]',
                '[data-testid="conversation-turn"]',
                '.conversation-turn',
                'article',
                '[data-message-id]',
                '.message',
                'main [class*="conversation"]',
                'main [class*="message"]',
                '[data-testid*="message"]',
                '[class*="message"]',
                '[class*="turn"]',
                '[data-testid*="turn"]',
                'div[data-testid*="conversation"]',
                'div[class*="conversation"]',
                // More generic selectors for ChatGPT-like content
                'div[class*="chat"]',
                'div[data-testid*="chat"]',
                'main div[class*="content"]',
                'main div[data-testid*="content"]',
                // Additional ChatGPT-specific selectors
                '[data-testid*="thread"]',
                '[class*="thread"]',
                '[data-testid*="history"]',
                '[class*="history"]'
            ];
            for (const selector of possibleSelectors) {
                firstTurn = document.querySelector(selector);
                if (firstTurn) {
                    console.log(`Found conversation element with selector: ${selector}`, firstTurn);
                    break;
                }
            }

            // If no specific turn found, try to find any conversation-like content
            if (!firstTurn) {
                // Try to find the main content area first
                const mainContent = document.querySelector('main') ||
                                  document.querySelector('[role="main"]') ||
                                  document.querySelector('[class*="main"]') ||
                                  document.querySelector('[data-testid*="main"]') ||
                                  document.body;

                // Look for elements that contain conversation-like content
                const conversationCandidates = mainContent.querySelectorAll('div, section, article, [class*="content"], [data-testid*="content"]');
                let bestCandidate = null;
                let maxTextLength = 0;

                conversationCandidates.forEach(candidate => {
                    const textContent = candidate.textContent || '';
                    // Look for elements that have substantial text content and might be conversation containers
                    if (textContent.length > maxTextLength &&
                        (textContent.includes('ChatGPT') || textContent.includes('GPT') ||
                         textContent.includes('Gemini') || textContent.includes('Bard') ||
                         textContent.includes('You said') || textContent.includes('user') ||
                         textContent.includes('Human') || textContent.includes('Assistant') ||
                         textContent.length > 500)) {
                        maxTextLength = textContent.length;
                        bestCandidate = candidate;
                    }
                });

                if (bestCandidate) {
                    firstTurn = bestCandidate;
                    console.log('Using conversation-like content area as conversation element:', bestCandidate);
                } else if (mainContent.textContent &&
                           (mainContent.textContent.includes('ChatGPT') ||
                            mainContent.textContent.includes('GPT') ||
                            mainContent.textContent.includes('Gemini') ||
                            mainContent.textContent.includes('Bard') ||
                            mainContent.textContent.length > 1000)) {
                    firstTurn = mainContent;
                    console.log('Using main content area as conversation element');
                }
            }

            if (firstTurn) {
                console.log(`Successfully found conversation element on attempt ${attempt}`);
                break;
            }

            if (attempt < maxRetries) {
                console.log(`No conversation elements found on attempt ${attempt}, waiting before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }

        if (!firstTurn) {
            console.warn('No conversation elements found after all retries, using fallback');
            // Use fallback container even if no conversation elements found
            firstTurn = document.querySelector('main') ||
                       document.querySelector('[role="main"]') ||
                       document.body;
        }

        const turnContainer = this.getTurnContainer(firstTurn);

        // Ensure conversationContainer is always a valid DOM element
        this.conversationContainer = turnContainer.parentElement || turnContainer;

        // Final fallback to ensure we always have a valid container
        if (!this.conversationContainer || this.conversationContainer.nodeType !== Node.ELEMENT_NODE) {
            console.debug('Invalid conversationContainer, using fallback');
            const fallback = document.querySelector('main') ||
                           document.querySelector('[role="main"]') ||
                           document.body;
            this.conversationContainer = fallback;
        }
        
        console.log('conversationContainer set to:', this.conversationContainer?.tagName || this.conversationContainer);

        // Try to find the scroll container by walking up the DOM tree
        let parent = this.conversationContainer;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                this.scrollContainer = parent;
                console.log('Found scroll container:', this.scrollContainer);
                break;
            }
            parent = parent.parentElement;
        }

        // More aggressive fallback for scroll container
        if (!this.scrollContainer) {
            const possibleScrollContainers = [
                document.querySelector('main'),
                document.querySelector('[role="main"]'),
                document.querySelector('#chat-history'),
                document.querySelector('.chat-history-scroll-container'),
                document.querySelector('.chat-history'),
                document.querySelector('.conversation-container'),
                document.querySelector('[class*="scroll"]'),
                document.querySelector('[class*="container"]'),
                document.body
            ];

            for (const container of possibleScrollContainers) {
                if (container) {
                    this.scrollContainer = container;
                    console.log('Using fallback scroll container:', this.scrollContainer);
                    break;
                }
            }
        }

        // Final fallback - use document.body if nothing else works
        if (!this.scrollContainer) {
            this.scrollContainer = document.body;
            console.warn('Using document.body as final fallback scroll container');
        }

        return true; // Always return true now that we have fallbacks
    }
    
    async injectTimelineUI() {
        try {
            // Apply ChatGPT width setting
            if (this.settings.chatgptWidth) {
                document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', this.settings.chatgptWidth + 'rem');
            }
            // Apply Codex task page width setting
            if (this.settings.taskPageWidth) {
                document.documentElement.style.setProperty('--timeline-task-page-max-width', this.settings.taskPageWidth + 'rem');
            }

            // Idempotent: ensure bar exists, then ensure track + content exist
            let timelineBar = document.querySelector('.chatgpt-timeline-bar');
            if (!timelineBar) {
                timelineBar = document.createElement('div');
                timelineBar.className = 'chatgpt-timeline-bar';
                
                // Apply position based on settings
                this.applyTimelinePosition(timelineBar);
                
                // Safely append to document body or fallback to documentElement
                const targetNode = document.body || document.documentElement;
                if (targetNode) {
                    targetNode.appendChild(timelineBar);
                    console.log('Timeline bar created and appended to', targetNode.tagName);
                } else {
                    console.error('Cannot find document body or documentElement to append timeline');
                    throw new Error('Failed to append timeline to DOM');
                }

                // Add drag handle if long press dragging is enabled
                if (this.settings.enableLongPressDrag) {
                    this.addDragHandle(timelineBar);
                }
            } else {
                console.log('Using existing timeline bar');
            }
            
            this.ui.timelineBar = timelineBar;
            
            // Verify timeline bar was successfully created and added to DOM
            if (!this.ui.timelineBar || !this.ui.timelineBar.parentNode) {
                throw new Error('Timeline bar was not successfully added to DOM');
            }
        } catch (error) {
            console.error('Error in injectTimelineUI:', error);
            throw error;
        }
        // Track + content
        let track = this.ui.timelineBar.querySelector('.timeline-track');
        if (!track) {
            track = document.createElement('div');
            track.className = 'timeline-track';
            this.ui.timelineBar.appendChild(track);
        }
        let trackContent = track.querySelector('.timeline-track-content');
        if (!trackContent) {
            trackContent = document.createElement('div');
            trackContent.className = 'timeline-track-content';
            track.appendChild(trackContent);
        }
        this.ui.track = track;
        this.ui.trackContent = trackContent;

        // Restore saved position if long press dragging is enabled
        if (this.settings.enableLongPressDrag) {
            this.restorePosition().catch(error => console.warn('Failed to restore position on init:', error));
        }

        // Retain backwards-compat: remove legacy slider if it exists, but keep refs null so helpers noop
        try {
            const straySlider = document.querySelector('.timeline-left-slider');
            if (straySlider) { straySlider.remove(); }
        } catch {}
        this.ui.slider = null;
        this.ui.sliderHandle = null;
        // Visibility will be controlled by updateSlider() based on scrollable state (now a no-op)
        if (!this.ui.tooltip) {
            const tip = document.createElement('div');
            tip.className = 'timeline-tooltip';
            tip.setAttribute('role', 'tooltip');
            tip.id = 'chatgpt-timeline-tooltip';
            document.body.appendChild(tip);
            this.ui.tooltip = tip;
            // Hidden measurement node for legacy DOM truncation (fallback)
            if (!this.measureEl) {
                const m = document.createElement('div');
                m.setAttribute('aria-hidden', 'true');
                m.style.position = 'fixed';
                m.style.left = '-9999px';
                m.style.top = '0px';
                m.style.visibility = 'hidden';
                m.style.pointerEvents = 'none';
                const cs = getComputedStyle(tip);
                Object.assign(m.style, {
                    backgroundColor: cs.backgroundColor,
                    color: cs.color,
                    fontFamily: cs.fontFamily,
                    fontSize: cs.fontSize,
                    lineHeight: cs.lineHeight,
                    padding: cs.padding,
                    border: cs.border,
                    borderRadius: cs.borderRadius,
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    maxWidth: 'none',
                    display: 'block',
                    transform: 'none',
                    transition: 'none'
                });
                // Ensure no clamping interferes with measurement
                try { m.style.webkitLineClamp = 'unset'; } catch {}
                document.body.appendChild(m);
                this.measureEl = m;
            }
            // Create canvas for text layout based truncation (primary)
            if (!this.measureCanvas) {
                this.measureCanvas = document.createElement('canvas');
                this.measureCtx = this.measureCanvas.getContext('2d');
            }
        }
    }

    recalculateAndRenderMarkers() {
        this.perfStart('recalc');
        if (!this.conversationContainer || !this.ui.timelineBar || !this.scrollContainer) return;

        // Get only user conversation turns (for timeline markers)
        const userTurnElements = this.getUserTurnElements();
        // Reset visible window to avoid cleaning with stale indices after rebuild
        this.visibleRange = { start: 0, end: -1 };
        // If the conversation is transiently empty (branch switching), don't wipe UI immediately
        if (userTurnElements.length === 0) {
            if (!this.zeroTurnsTimer) {
                this.zeroTurnsTimer = setTimeout(() => {
                    this.zeroTurnsTimer = null;
                    this.recalculateAndRenderMarkers();
                }, 350);
            }
            return;
        }
        if (this.zeroTurnsTimer) { try { clearTimeout(this.zeroTurnsTimer); } catch {} this.zeroTurnsTimer = null; }
        // Clear old dots from track/content (now that we know content exists)
        (this.ui.trackContent || this.ui.timelineBar).querySelectorAll('.timeline-dot').forEach(n => n.remove());

        let contentSpan;
        const firstTurnOffset = userTurnElements[0].offsetTop;
        if (userTurnElements.length < 2) {
            contentSpan = 1;
        } else {
            const lastTurnOffset = userTurnElements[userTurnElements.length - 1].offsetTop;
            contentSpan = lastTurnOffset - firstTurnOffset;
        }
        if (contentSpan <= 0) contentSpan = 1;

        // Cache for scroll mapping
        this.firstUserTurnOffset = firstTurnOffset;
        this.contentSpanPx = contentSpan;

        // Build markers with normalized position along conversation (only for user turns)
        this.markerById.clear();
        this.markers = Array.from(userTurnElements).map((el, index) => {
            const offsetFromStart = el.offsetTop - firstTurnOffset;
            let n = offsetFromStart / contentSpan;
            n = Math.max(0, Math.min(1, n));

            // Get ChatGPT's reply for this user turn
            const chatgptReply = this.getChatGPTReply(el);
            const markerId = this.getTurnId(el, index);
            this.markerById.set(markerId, el);

            return {
                id: markerId,
                element: el,
                summary: this.getUserSummary(el),
                chatgptReply: chatgptReply,
                n,
                baseN: n,
                dotElement: null,
            };
        });
        // Bump version after markers are rebuilt to invalidate concurrent passes
        this.markersVersion++;

        // Compute geometry and virtualize render
        this.updateTimelineGeometry();
        if (!this.activeTurnId && this.markers.length > 0) {
            this.activeTurnId = this.markers[this.markers.length - 1].id;
        }
        this.syncTimelineTrackToMain();
        this.updateVirtualRangeAndRender();
        // Ensure active class is applied after dots are created
        this.updateActiveDotUI();
        this.scheduleScrollSync();

        // Update TOC if enabled (debounced to prevent flickering)
        if (this.settings.enableTOC) {
            this.ensureTOCVisible();
            // Use debounced update to prevent flickering during rapid changes
            this.debouncedTOCUpdate();

            // Auto-expand TOC when content is available (debounced)
            const tocContainer = document.querySelector('.timeline-toc');
            if (tocContainer && this.markers.length > 0 && tocContainer.classList.contains('collapsed')) {
                // Delay expansion slightly to ensure TOC is properly updated first
                setTimeout(() => {
                    if (this.markers.length > 0) {
                        this.expandTOC();
                    }
                }, 200);
            }
        }

        this.perfEnd('recalc');
    }

    getTurnContainer(turnElement) {
        if (!turnElement) return null;
        if (this.siteType === 'gemini') {
            return turnElement.closest('div.conversation-container') || turnElement;
        }
        return turnElement;
    }

    getUserTurnElements() {
        if (!this.conversationContainer) return [];
        if (this.siteType === 'gemini') {
            const nodes = Array.from(this.conversationContainer.querySelectorAll('user-query'));
            return nodes.filter(node => node.querySelector('.query-text') || (node.textContent || '').trim().length > 0);
        }
        return Array.from(this.conversationContainer.querySelectorAll('article[data-turn="user"]'));
    }

    getAllTurnElements() {
        if (!this.conversationContainer) return [];
        const siteConfig = getSiteConfig(this.siteType);
        return Array.from(this.conversationContainer.querySelectorAll(siteConfig.allTurnSelector));
    }

    getTurnId(turnElement, index) {
        if (!turnElement) return `turn-${index}`;
        if (this.siteType === 'gemini') {
            const container = this.getTurnContainer(turnElement);
            return container?.id || turnElement.id || `gemini-turn-${index}`;
        }
        return turnElement.dataset.turnId || turnElement.id || `turn-${index}`;
    }

    getUserContentElement(turnElement) {
        if (!turnElement) return null;
        if (this.siteType === 'gemini') {
            const container = this.getTurnContainer(turnElement);
            return container?.querySelector('user-query .query-text') ||
                   container?.querySelector('user-query') ||
                   turnElement;
        }
        return turnElement;
    }

    getUserSummary(turnElement) {
        const target = this.getUserContentElement(turnElement) || turnElement;
        return this.normalizeText(target.textContent || '');
    }

    // Get ChatGPT's reply for a given user conversation turn
    getChatGPTReply(userElement) {
        if (this.siteType === 'gemini') {
            const container = this.getTurnContainer(userElement);
            const response = container?.querySelector('model-response');
            if (!response) return '';
            const siteConfig = getSiteConfig(this.siteType);
            const textNode = response.querySelector(siteConfig.assistantTextSelector) || response;
            const replyText = this.normalizeText(textNode.textContent || '');
            if (replyText && replyText.length > 10) {
                return replyText;
            }
            return '';
        }
        // Find the corresponding ChatGPT reply for this user message
        const allTurns = this.getAllTurnElements();
        const currentIndex = allTurns.indexOf(userElement);

        // Look for the next assistant turn (ChatGPT's reply) after this user turn
        for (let i = currentIndex + 1; i < allTurns.length; i++) {
            const turn = allTurns[i];
            if (turn.dataset.turn === 'assistant') {
                const replyText = this.normalizeText(turn.textContent || '');
                // Return the reply if it's not empty and not just the incomplete "哈哈，我当然不"
                if (replyText && replyText.length > 10) { // 确保回复有足够的内容
                    return replyText;
                }
                // If it's the incomplete reply, don't return it
                break;
            }
        }

        return '';
    }
    
    setupObservers() {
        // Clean up existing observers first
        if (this.mutationObserver) {
            try { this.mutationObserver.disconnect(); } catch {}
        }
        if (this.resizeObserver) {
            try { this.resizeObserver.disconnect(); } catch {}
        }
        if (this.intersectionObserver) {
            try { this.intersectionObserver.disconnect(); } catch {}
        }
        
        this.mutationObserver = new MutationObserver(() => {
            try { this.ensureContainersUpToDate(); } catch {}
            this.debouncedRecalculateAndRender();
            this.updateIntersectionObserverTargets();
        });

        // Ensure conversationContainer is a valid DOM element before observing
        if (this.conversationContainer &&
            this.conversationContainer.nodeType === Node.ELEMENT_NODE) {
            try {
                this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });
                console.log('Mutation observer setup successful for', this.conversationContainer.tagName);
            } catch (error) {
                console.debug('Failed to setup mutation observer on conversationContainer:', error);
                console.debug('conversationContainer details:', {
                    element: this.conversationContainer,
                    nodeType: this.conversationContainer?.nodeType,
                    isConnected: this.conversationContainer?.isConnected,
                    tagName: this.conversationContainer?.tagName,
                    parentElement: this.conversationContainer?.parentElement
                });

                // Try to find a valid container as fallback
                const fallbackContainer = document.querySelector('main') ||
                                        document.querySelector('[role="main"]') ||
                                        document.body;

                if (fallbackContainer && fallbackContainer.nodeType === Node.ELEMENT_NODE) {
                    console.log('Using fallback container for mutation observer:', fallbackContainer.tagName);
                    this.conversationContainer = fallbackContainer;
                    try {
                        this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });
                        console.log('Fallback mutation observer setup successful');
                    } catch (fallbackError) {
                        console.error('Failed to setup fallback mutation observer:', fallbackError);
                    }
                } else {
                    console.debug('No valid fallback container found, mutation observer disabled');
                }
            }
        } else {
            console.debug('conversationContainer is not a valid DOM element, trying fallback...');
            console.debug('conversationContainer details:', {
                element: this.conversationContainer,
                nodeType: this.conversationContainer?.nodeType,
                isConnected: this.conversationContainer?.isConnected,
                tagName: this.conversationContainer?.tagName
            });

            // Try to find a valid container as fallback
            const fallbackContainer = document.querySelector('main') ||
                                    document.querySelector('[role="main"]') ||
                                    document.body;

            if (fallbackContainer && fallbackContainer.nodeType === Node.ELEMENT_NODE) {
                console.log('Using fallback container for mutation observer:', fallbackContainer.tagName);
                this.conversationContainer = fallbackContainer;
                this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });
            } else {
                console.warn('No valid fallback container found, mutation observer disabled');
            }
        }
        // Resize: update long-canvas geometry and virtualization
        this.resizeObserver = new ResizeObserver(() => {
            this.updateTimelineGeometry();
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
        });
        if (this.ui.timelineBar) {
            this.resizeObserver.observe(this.ui.timelineBar);
        }

        this.intersectionObserver = new IntersectionObserver(entries => {
            // Maintain which user turns are currently visible
            entries.forEach(entry => {
                const target = entry.target;
                if (entry.isIntersecting) {
                    this.visibleTurns.add(target);
                } else {
                    this.visibleTurns.delete(target);
                }
            });

            // Defer active state decision to scroll-based computation
            this.scheduleScrollSync();
        }, { 
            root: this.scrollContainer,
            threshold: 0.1,
            rootMargin: "-40% 0px -59% 0px"
        });

        this.updateIntersectionObserverTargets();
    }

    // Public method to refresh timeline content when page changes
    async refreshContent() {
        console.log('Refreshing timeline content...');
        try {
            // Re-find containers and elements
            await this.findCriticalElements();
            
            // Re-setup observers with new containers
            this.setupObservers();
            
            // Trigger content recalculation immediately for page changes
            this.recalculateAndRenderMarkers();
            
            // Force TOC refresh after page change to ensure it updates properly
            if (this.settings.enableTOC) {
                // Use a short delay to ensure markers are updated and DOM is stable
                setTimeout(() => {
                    this.forceTOCRefresh();
                }, 150);
            }
            
            console.log('Timeline content refreshed successfully');
        } catch (error) {
            console.error('Failed to refresh timeline content:', error);
            throw error;
        }
    }

    // Ensure our conversation/scroll containers are still current after DOM replacements
    ensureContainersUpToDate() {
        const first = getFirstTurnElementForSite();
        if (!first) return;
        const turnContainer = this.getTurnContainer(first);
        const newConv = turnContainer?.parentElement || turnContainer;
        
        // Validate that newConv is a valid DOM element before using it
        if (newConv && 
            newConv.nodeType === Node.ELEMENT_NODE && 
            newConv !== this.conversationContainer) {
            console.log('Rebinding to new conversation container:', newConv.tagName);
            // Rebind observers and listeners to the new conversation root
            this.rebindConversationContainer(newConv);
        }
    }

    rebindConversationContainer(newConv) {
        // Validate newConv before proceeding
        if (!newConv || newConv.nodeType !== Node.ELEMENT_NODE) {
            console.warn('rebindConversationContainer: Invalid newConv element, skipping rebind');
            return;
        }
        
        // Detach old listeners
        if (this.scrollContainer && this.onScroll) {
            try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
        }
        try { this.mutationObserver?.disconnect(); } catch {}
        try { this.intersectionObserver?.disconnect(); } catch {}

        this.conversationContainer = newConv;

        // Find (or re-find) scroll container
        let parent = newConv;
        let newScroll = null;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                newScroll = parent; break;
            }
            parent = parent.parentElement;
        }
        if (!newScroll) newScroll = document.scrollingElement || document.documentElement || document.body;
        this.scrollContainer = newScroll;
        // Reattach scroll listener
        this.onScroll = () => this.scheduleScrollSync();
        this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });

        // Recreate IntersectionObserver with new root
        this.intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const target = entry.target;
                if (entry.isIntersecting) { this.visibleTurns.add(target); }
                else { this.visibleTurns.delete(target); }
            });
            this.scheduleScrollSync();
        }, { root: this.scrollContainer, threshold: 0.1, rootMargin: "-40% 0px -59% 0px" });
        this.updateIntersectionObserverTargets();

        // Re-observe mutations on the new conversation container
        this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });

        // Force a recalc right away to rebuild markers
        this.recalculateAndRenderMarkers();
    }

    updateIntersectionObserverTargets() {
        if (!this.intersectionObserver || !this.conversationContainer) return;
        this.intersectionObserver.disconnect();
        this.visibleTurns.clear();
        const allTurns = this.getUserTurnElements();
        allTurns.forEach(el => this.intersectionObserver.observe(el));
    }

    setupEventListeners() {
        // Check if timeline bar exists before setting up event listeners
        if (!this.ui.timelineBar) {
            console.warn('Timeline bar not found, skipping event listener setup');
            // Try to reinject UI if timeline bar is missing
            if (this.conversationContainer && document.body) {
                console.log('Attempting to reinject timeline UI...');
                try {
                    this.injectTimelineUI().then(() => {
                        if (this.ui.timelineBar) {
                            console.log('Timeline UI reinjected successfully, setting up event listeners');
                            this.setupEventListenersAfterUIReady();
                        }
                    }).catch(err => {
                        console.error('Failed to reinject timeline UI:', err);
                    });
                } catch (err) {
                    console.error('Error during UI reinjection:', err);
                }
            }
            return;
        }

        this.setupEventListenersAfterUIReady();
    }

    setupEventListenersAfterUIReady() {
        // Timeline bar click event for dot navigation
        this.onTimelineBarClick = (e) => {
            const dot = e.target.closest('.timeline-dot');
            if (dot) {
                const targetId = dot.dataset.targetTurnId;
                const targetElement = this.markerById.get(targetId);
                if (targetElement) {
                    // Only scroll; let scroll-based computation set active to avoid double-flash
                    this.smoothScrollTo(targetElement);
                }
            }
        };
        this.ui.timelineBar.addEventListener('click', this.onTimelineBarClick);

        // Drag functionality - long press drag from anywhere on timeline bar except dots
        this.onDragHandleDown = (e) => {
            const target = e.target;
            const isDragHandle = target.closest('.timeline-drag-handle');
            const isDot = target.closest('.timeline-dot');
            const isTimelineBar = target.closest('.chatgpt-timeline-bar');

            // Prevent dragging if clicking directly on a dot or its hit area
            if (isDot) {
                // Let the dot click event handle the interaction normally
                return;
            }

            // Only start long press detection if clicking on timeline bar or drag handle
            if (isDragHandle || isTimelineBar) {
                e.preventDefault();
                e.stopPropagation();

                this.isLongPress = false;
                this.longPressStartX = e.clientX;
                this.longPressStartY = e.clientY;

                // Add visual feedback that long press is possible
                this.ui.timelineBar.classList.add('long-press-ready');

                // Start long press timer
                this.longPressTimer = setTimeout(() => {
                    this.isLongPress = true;
                    // Remove the visual feedback class as drag starts
                    this.ui.timelineBar.classList.remove('long-press-ready');
                    this.startDrag(e);
                }, this.longPressDelay);
            }
        };
        this.onDragHandleMove = (e) => {
            if (this.isDragging) {
                this.updateDrag(e);
            } else if (this.longPressTimer && !this.isLongPress) {
                // Check if user moved beyond threshold during long press detection
                const deltaX = Math.abs(e.clientX - this.longPressStartX);
                const deltaY = Math.abs(e.clientY - this.longPressStartY);

                if (deltaX > this.longPressMoveThreshold || deltaY > this.longPressMoveThreshold) {
                    // User moved finger/mouse before long press completed, cancel timer
                    clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                    // Remove visual feedback
                    this.ui.timelineBar.classList.remove('long-press-ready');
                }
            }
        };
        this.onDragHandleUp = (e) => {
            if (this.isDragging) {
                this.endDrag(e);
            } else {
                // Clear long press timer and visual feedback if not dragging
                if (this.longPressTimer) {
                    clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                }
                this.ui.timelineBar.classList.remove('long-press-ready');
            }
        };

        // Add drag event listeners only if long press dragging is enabled
        if (this.settings.enableLongPressDrag && this.ui.timelineBar) {
            this.ui.timelineBar.addEventListener('pointerdown', this.onDragHandleDown);
            window.addEventListener('pointermove', this.onDragHandleMove);
            window.addEventListener('pointerup', this.onDragHandleUp);
        }

        // Listen to container scroll to keep marker active state in sync
        if (this.scrollContainer) {
            this.onScroll = () => this.scheduleScrollSync();
            this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
        }

        // Tooltip interactions (delegated)
        this.onTimelineBarOver = (e) => {
            const dot = e.target.closest('.timeline-dot');
            if (dot) this.showTooltipForDot(dot);
        };
        this.onTimelineBarOut = (e) => {
            const fromDot = e.target.closest('.timeline-dot');
            const toDot = e.relatedTarget?.closest?.('.timeline-dot');
            if (fromDot && !toDot) this.hideTooltip();
        };
        this.onTimelineBarFocusIn = (e) => {
            const dot = e.target.closest('.timeline-dot');
            if (dot) this.showTooltipForDot(dot);
        };
        this.onTimelineBarFocusOut = (e) => {
            const dot = e.target.closest('.timeline-dot');
            if (dot) this.hideTooltip();
        };
        if (this.ui.timelineBar) {
            this.ui.timelineBar.addEventListener('mouseover', this.onTimelineBarOver);
            this.ui.timelineBar.addEventListener('mouseout', this.onTimelineBarOut);
            this.ui.timelineBar.addEventListener('focusin', this.onTimelineBarFocusIn);
            this.ui.timelineBar.addEventListener('focusout', this.onTimelineBarFocusOut);
        }

        // Slider visibility on hover (time axis or slider itself) with stable refs
        // Define and persist handlers so we can remove them in destroy()
        this.onBarEnter = () => this.showSlider();
        this.onBarLeave = () => this.hideSliderDeferred();
        this.onSliderEnter = () => this.showSlider();
        this.onSliderLeave = () => this.hideSliderDeferred();
        try {
            if (this.ui.timelineBar) {
                this.ui.timelineBar.addEventListener('pointerenter', this.onBarEnter);
                this.ui.timelineBar.addEventListener('pointerleave', this.onBarLeave);
            }
            if (this.ui.slider) {
                this.ui.slider.addEventListener('pointerenter', this.onSliderEnter);
                this.ui.slider.addEventListener('pointerleave', this.onSliderLeave);
            }
        } catch {}

        // Reposition tooltip and TOC on resize
        this.onWindowResize = () => {
            if (this.ui.tooltip?.classList.contains('visible') && this.ui.timelineBar) {
                const activeDot = this.ui.timelineBar.querySelector('.timeline-dot:hover, .timeline-dot:focus');
                if (activeDot) {
                    // Re-run T0->T1 to avoid layout during animation
                    const tip = this.ui.tooltip;
                    tip.classList.remove('visible');
                    const fullText = (activeDot.getAttribute('aria-label') || '').trim();
                    const p = this.computePlacementInfo(activeDot);
                    const layout = this.truncateToThreeLines(fullText, p.width, true);
                    tip.textContent = layout.text;
                    this.placeTooltipAt(activeDot, p.placement, p.width, layout.height);
                    if (this.showRafId !== null) {
                        try { cancelAnimationFrame(this.showRafId); } catch {}
                        this.showRafId = null;
                    }
                    this.showRafId = requestAnimationFrame(() => {
                        this.showRafId = null;
                        tip.classList.add('visible');
                    });
                }
            }

            // Reposition TOC panel based on stored percentage coordinates
            if (this.settings.enableTOC) {
                this.restoreTOCPosition();
            }

            // Update long-canvas geometry and virtualization
            if (this.ui.timelineBar) {
                this.updateTimelineGeometry();
                this.syncTimelineTrackToMain();
                this.updateVirtualRangeAndRender();
            }
        };
        window.addEventListener('resize', this.onWindowResize);
        // VisualViewport resize can fire on zoom on some platforms; schedule correction
        if (window.visualViewport) {
            this.onVisualViewportResize = () => {
                if (this.ui.timelineBar) {
                    this.updateTimelineGeometry();
                    this.syncTimelineTrackToMain();
                    this.updateVirtualRangeAndRender();
                }
            };
            try { window.visualViewport.addEventListener('resize', this.onVisualViewportResize); } catch {}
        }

        // Scroll wheel on the timeline controls the main scroll container (Linked mode)
        this.onTimelineWheel = (e) => {
            // Prevent page from attempting to scroll anything else
            try { e.preventDefault(); } catch {}
            if (this.scrollContainer) {
                const delta = e.deltaY || 0;
                this.scrollContainer.scrollTop += delta;
                // Keep markers in sync on next frame
                this.scheduleScrollSync();
                this.showSlider();
            }
        };
        if (this.ui.timelineBar) {
            this.ui.timelineBar.addEventListener('wheel', this.onTimelineWheel, { passive: false });
        }

        // Slider drag handlers
        this.onSliderDown = (ev) => {
            if (!this.ui.sliderHandle) return;
            try { this.ui.sliderHandle.setPointerCapture(ev.pointerId); } catch {}
            this.sliderDragging = true;
            this.showSlider();
            this.sliderStartClientY = ev.clientY;
            const rect = this.ui.sliderHandle.getBoundingClientRect();
            this.sliderStartTop = rect.top;
            this.onSliderMove = (e) => this.handleSliderDrag(e);
            this.onSliderUp = (e) => this.endSliderDrag(e);
            window.addEventListener('pointermove', this.onSliderMove);
            window.addEventListener('pointerup', this.onSliderUp, { once: true });
        };
        try { this.ui.sliderHandle?.addEventListener('pointerdown', this.onSliderDown); } catch {}
    }
    
    smoothScrollTo(targetElement, duration = 600) {
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const targetPosition = targetRect.top - containerRect.top + this.scrollContainer.scrollTop;
        const startPosition = this.scrollContainer.scrollTop;
        const distance = targetPosition - startPosition;
        let startTime = null;

        const animation = (currentTime) => {
            this.isScrolling = true;
            if (startTime === null) startTime = currentTime;
            const timeElapsed = currentTime - startTime;
            const run = this.easeInOutQuad(timeElapsed, startPosition, distance, duration);
            this.scrollContainer.scrollTop = run;
            if (timeElapsed < duration) {
                requestAnimationFrame(animation);
            } else {
                this.scrollContainer.scrollTop = targetPosition;
                this.isScrolling = false;
            }
        };
        requestAnimationFrame(animation);
    }
    
    easeInOutQuad(t, b, c, d) {
        t /= d / 2;
        if (t < 1) return c / 2 * t * t + b;
        t--;
        return -c / 2 * (t * (t - 2) - 1) + b;
    }

    updateActiveDotUI() {
        this.markers.forEach(marker => {
            marker.dotElement?.classList.toggle('active', marker.id === this.activeTurnId);
        });

        // Update TOC highlighting
        this.updateTOCHighlight();
    }

    debounce(func, delay) {
        let timeout;
        const debouncedFn = (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
        
        // Add cancel method to the debounced function
        debouncedFn.cancel = () => {
            clearTimeout(timeout);
            timeout = null;
        };
        
        return debouncedFn;
    }

    // Read numeric CSS var from the timeline bar element
    getCSSVarNumber(el, name, fallback) {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    // Normalize whitespace and trim; remove leading prefixes; no manual ellipsis
    normalizeText(text) {
        try {
            let s = String(text || '').replace(/\s+/g, ' ').trim();
            // Strip common prefixes if they appear at the very start
            s = s.replace(/^\s*(you\s*said\s*[:：]?\s*)/i, '');
            s = s.replace(/^\s*(chatgpt\s*said\s*[:：]?\s*)/i, '');
            s = s.replace(/^\s*(chatgpt\s*[:：]?\s*)/i, '');
            s = s.replace(/^\s*(assistant\s*[:：]?\s*)/i, '');
            return s;
        } catch {
            return '';
        }
    }

    // Extract full text content including code blocks and formatting
    getFullTextContent(element) {
        if (!element) return '';
        
        try {
            // Clone the element to avoid modifying the original
            const clone = element.cloneNode(true);
            
            // Process code blocks to preserve formatting
            const codeBlocks = clone.querySelectorAll('pre, code');
            codeBlocks.forEach(block => {
                if (block.tagName === 'PRE') {
                    // For pre blocks, add markdown code block formatting
                    const code = block.textContent || '';
                    const language = this.detectCodeLanguage(block);
                    block.textContent = `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
                } else if (block.tagName === 'CODE' && !block.closest('pre')) {
                    // For inline code, add backticks
                    const code = block.textContent || '';
                    block.textContent = `\`${code}\``;
                }
            });
            
            // Process other formatting elements
            const strongElements = clone.querySelectorAll('strong, b');
            strongElements.forEach(el => {
                const text = el.textContent || '';
                el.textContent = `**${text}**`;
            });
            
            const emElements = clone.querySelectorAll('em, i');
            emElements.forEach(el => {
                const text = el.textContent || '';
                el.textContent = `*${text}*`;
            });
            
            // Process lists
            const listItems = clone.querySelectorAll('li');
            listItems.forEach(li => {
                const text = li.textContent || '';
                li.textContent = `• ${text}\n`;
            });
            
            // Get the final text content
            let text = clone.textContent || '';
            
            // Clean up extra whitespace but preserve code block formatting
            text = text.replace(/\n\s*\n\s*\n/g, '\n\n'); // Remove excessive line breaks
            text = text.trim();
            
            // Apply normalization but preserve code blocks
            return this.normalizeTextWithCodeBlocks(text);
            
        } catch (error) {
            console.error('Error extracting full text content:', error);
            return this.normalizeText(element.textContent || '');
        }
    }

    // Get full ChatGPT reply with proper formatting
    getFullChatGPTReply(userElement) {
        try {
            if (this.siteType === 'gemini') {
                const container = this.getTurnContainer(userElement);
                const response = container?.querySelector('model-response');
                if (!response) return '';
                const siteConfig = getSiteConfig(this.siteType);
                const replyNode = response.querySelector(siteConfig.assistantTextSelector) || response;
                const replyText = this.getFullTextContent(replyNode);
                if (replyText && replyText.length > 10) {
                    return replyText;
                }
                return '';
            }

            const allTurns = this.getAllTurnElements();
            const currentIndex = allTurns.indexOf(userElement);

            // Look for the next assistant turn (ChatGPT's reply) after this user turn
            for (let i = currentIndex + 1; i < allTurns.length; i++) {
                const turn = allTurns[i];
                if (turn.dataset.turn === 'assistant') {
                    const replyText = this.getFullTextContent(turn);
                    // Return the reply if it's not empty and has sufficient content
                    if (replyText && replyText.length > 10) {
                        return replyText;
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Error getting full ChatGPT reply:', error);
        }

        return '';
    }

    // Normalize text while preserving code blocks
    normalizeTextWithCodeBlocks(text) {
        try {
            // Split by code blocks to preserve them
            const codeBlockRegex = /```[\s\S]*?```/g;
            const parts = [];
            let lastIndex = 0;
            let match;

            while ((match = codeBlockRegex.exec(text)) !== null) {
                // Add text before code block (normalized)
                if (match.index > lastIndex) {
                    const beforeText = text.substring(lastIndex, match.index);
                    parts.push(beforeText.replace(/\s+/g, ' ').trim());
                }
                
                // Add code block as-is
                parts.push(match[0]);
                lastIndex = match.index + match[0].length;
            }
            
            // Add remaining text after last code block
            if (lastIndex < text.length) {
                const afterText = text.substring(lastIndex);
                parts.push(afterText.replace(/\s+/g, ' ').trim());
            }
            
            let result = parts.join(' ').trim();
            
            // Apply prefix removal
            result = result.replace(/^\s*(you\s*said\s*[:：]?\s*)/i, '');
            result = result.replace(/^\s*(chatgpt\s*said\s*[:：]?\s*)/i, '');
            result = result.replace(/^\s*(chatgpt\s*[:：]?\s*)/i, '');
            result = result.replace(/^\s*(assistant\s*[:：]?\s*)/i, '');
            
            return result;
        } catch (error) {
            console.error('Error normalizing text with code blocks:', error);
            return text;
        }
    }

    // Detect code language from code block
    detectCodeLanguage(codeBlock) {
        try {
            // Look for language hints in class names
            const className = codeBlock.className || '';
            const langMatch = className.match(/language-(\w+)/);
            if (langMatch) {
                return langMatch[1];
            }
            
            // Look for data attributes
            const lang = codeBlock.dataset.language || codeBlock.dataset.lang;
            if (lang) {
                return lang;
            }
            
            // Try to detect from content
            const content = codeBlock.textContent || '';
            if (content.includes('function ') || content.includes('const ') || content.includes('=>')) {
                return 'javascript';
            }
            if (content.includes('def ') || content.includes('import ')) {
                return 'python';
            }
            if (content.includes('#include') || content.includes('int main')) {
                return 'cpp';
            }
            if (content.includes('public class') || content.includes('System.out')) {
                return 'java';
            }
            
            return ''; // No language detected
        } catch {
            return '';
        }
    }

    // Copy QA text to clipboard
    async copyQAText(marker) {
        try {
            // Get full text content with proper formatting (including code blocks)
            const userText = this.getFullTextContent(this.getUserContentElement(marker.element) || marker.element);
            const chatgptText = this.getFullChatGPTReply(marker.element);
            
            // Format as QA text
            let qaText = `Q: ${userText}`;
            if (chatgptText) {
                qaText += `\n\nA: ${chatgptText}`;
            }
            
            // Copy to clipboard
            await navigator.clipboard.writeText(qaText);
            
            // Show feedback
            this.showCopyFeedback();
            
        } catch (error) {
            console.error('Failed to copy QA text:', error);
            // Fallback for older browsers
            const userText = this.getFullTextContent(this.getUserContentElement(marker.element) || marker.element);
            const chatgptText = this.getFullChatGPTReply(marker.element);
            let qaText = `Q: ${userText}`;
            if (chatgptText) {
                qaText += `\n\nA: ${chatgptText}`;
            }
            this.fallbackCopyText(qaText);
        }
    }

    // Show copy feedback
    showCopyFeedback() {
        // Create temporary feedback element
        const feedback = document.createElement('div');
        feedback.className = 'toc-copy-feedback';
        feedback.textContent = '已复制到剪贴板';
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            z-index: 10000;
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.3s ease;
        `;
        
        document.body.appendChild(feedback);
        
        // Remove after 2 seconds
        setTimeout(() => {
            feedback.style.opacity = '0';
            setTimeout(() => {
                if (feedback.parentNode) {
                    feedback.parentNode.removeChild(feedback);
                }
            }, 300);
        }, 2000);
    }

    // Fallback copy method for older browsers
    fallbackCopyText(text) {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.cssText = 'position: fixed; top: -1000px; left: -1000px;';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (successful) {
                this.showCopyFeedback();
            } else {
                console.error('Fallback copy failed');
            }
        } catch (error) {
            console.error('Fallback copy error:', error);
        }
    }

    getTrackPadding() {
        if (!this.ui.timelineBar) return 12;
        return this.getCSSVarNumber(this.ui.timelineBar, '--timeline-track-padding', 12);
    }

    getMinGap() {
        if (!this.ui.timelineBar) return 12;
        return this.getCSSVarNumber(this.ui.timelineBar, '--timeline-min-gap', 12);
    }

    getEffectiveMinGap(usableHeight, count) {
        const raw = this.getMinGap();
        if (count <= 1) return 0;
        if (!Number.isFinite(usableHeight) || usableHeight <= 0) {
            return Math.max(0, raw);
        }
        const maxGap = usableHeight / Math.max(1, count - 1);
        return Math.max(0, Math.min(raw, maxGap));
    }

    // Enforce a minimum pixel gap between positions while staying within bounds
    applyMinGap(positions, minTop, maxTop, gap) {
        const n = positions.length;
        if (n === 0) return positions;
        const out = positions.slice();
        // Clamp first and forward pass (monotonic increasing)
        out[0] = Math.max(minTop, Math.min(positions[0], maxTop));
        for (let i = 1; i < n; i++) {
            const minAllowed = out[i - 1] + gap;
            out[i] = Math.max(positions[i], minAllowed);
        }
        // If last exceeds max, backward pass
        if (out[n - 1] > maxTop) {
            out[n - 1] = maxTop;
            for (let i = n - 2; i >= 0; i--) {
                const maxAllowed = out[i + 1] - gap;
                out[i] = Math.min(out[i], maxAllowed);
            }
            // Ensure first still within min
            if (out[0] < minTop) {
                out[0] = minTop;
                for (let i = 1; i < n; i++) {
                    const minAllowed = out[i - 1] + gap;
                    out[i] = Math.max(out[i], minAllowed);
                }
            }
        }
        // Final clamp
        for (let i = 0; i < n; i++) {
            if (out[i] < minTop) out[i] = minTop;
            if (out[i] > maxTop) out[i] = maxTop;
        }
        return out;
    }

    // Debounced scheduler: after resize/zoom settles, re-apply min-gap based on cached normalized positions
    scheduleMinGapCorrection() {
        try { if (this.resizeIdleTimer) { clearTimeout(this.resizeIdleTimer); } } catch {}
        try {
            if (this.resizeIdleRICId && typeof cancelIdleCallback === 'function') {
                cancelIdleCallback(this.resizeIdleRICId);
                this.resizeIdleRICId = null;
            }
        } catch {}
        this.resizeIdleTimer = setTimeout(() => {
            this.resizeIdleTimer = null;
            // Prefer idle callback to avoid contention; fallback to immediate
            try {
                if (typeof requestIdleCallback === 'function') {
                    this.resizeIdleRICId = requestIdleCallback(() => {
                        this.resizeIdleRICId = null;
                        this.reapplyMinGapAfterResize();
                    }, { timeout: 200 });
                    return;
                }
            } catch {}
            this.reapplyMinGapAfterResize();
        }, this.resizeIdleDelay);
    }

    // Lightweight correction: map cached n -> pixel, apply min-gap, write back updated n
    reapplyMinGapAfterResize() {
        this.perfStart('minGapIdle');
        if (!this.ui.timelineBar || this.markers.length === 0) return;
        const barHeight = this.ui.timelineBar.clientHeight || 0;
        const trackPadding = this.getTrackPadding();
        const usable = Math.max(0, barHeight - 2 * trackPadding);
        const minTop = trackPadding;
        const maxTop = trackPadding + usable;
        const minGap = this.getEffectiveMinGap(usable, this.markers.length);
        // Use cached normalized positions (default 0)
        const desired = this.markers.map(m => {
            const n = Math.max(0, Math.min(1, (m.n ?? 0)));
            return minTop + n * usable;
        });
        const adjusted = this.applyMinGap(desired, minTop, maxTop, minGap);
        for (let i = 0; i < this.markers.length; i++) {
            const top = adjusted[i];
            const n = (top - minTop) / Math.max(1, (maxTop - minTop));
            this.markers[i].n = Math.max(0, Math.min(1, n));
            try { this.markers[i].dotElement?.style.setProperty('--n', String(this.markers[i].n)); } catch {}
        }
        this.perfEnd('minGapIdle');
    }

    showTooltipForDot(dot) {
        if (!this.ui.tooltip) return;
        try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; } } catch {}
        // T0: compute + write geometry while hidden
        const tip = this.ui.tooltip;
        tip.classList.remove('visible');
        const fullText = (dot.getAttribute('aria-label') || '').trim();
        const p = this.computePlacementInfo(dot);
        const layout = this.truncateToThreeLines(fullText, p.width, true);
        tip.textContent = layout.text;
        this.placeTooltipAt(dot, p.placement, p.width, layout.height);
        tip.setAttribute('aria-hidden', 'false');
        // T1: next frame add visible for non-geometric animation only
        if (this.showRafId !== null) {
            try { cancelAnimationFrame(this.showRafId); } catch {}
            this.showRafId = null;
        }
        this.showRafId = requestAnimationFrame(() => {
            this.showRafId = null;
            tip.classList.add('visible');
        });
    }

    hideTooltip(immediate = false) {
        if (!this.ui.tooltip) return;
        const doHide = () => {
            this.ui.tooltip.classList.remove('visible');
            this.ui.tooltip.setAttribute('aria-hidden', 'true');
            this.tooltipHideTimer = null;
        };
        if (immediate) return doHide();
        try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); } } catch {}
        this.tooltipHideTimer = setTimeout(doHide, this.tooltipHideDelay);
    }

    placeTooltipAt(dot, placement, width, height) {
        if (!this.ui.tooltip) return;
        const tip = this.ui.tooltip;
        const dotRect = dot.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
        const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
        const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
        const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
        const viewportPad = 8;

        let left;
        if (placement === 'left') {
            left = Math.round(dotRect.left - gap - width);
            if (left < viewportPad) {
                // Clamp within viewport: switch to right if impossible
                const altLeft = Math.round(dotRect.right + gap);
                if (altLeft + width <= vw - viewportPad) {
                    placement = 'right';
                    left = altLeft;
                } else {
                    // shrink width to fit
                    const fitWidth = Math.max(120, vw - viewportPad - altLeft);
                    left = altLeft;
                    width = fitWidth;
                }
            }
        } else {
            left = Math.round(dotRect.right + gap);
            if (left + width > vw - viewportPad) {
                const altLeft = Math.round(dotRect.left - gap - width);
                if (altLeft >= viewportPad) {
                    placement = 'left';
                    left = altLeft;
                } else {
                    const fitWidth = Math.max(120, vw - viewportPad - left);
                    width = fitWidth;
                }
            }
        }

        let top = Math.round(dotRect.top + dotRect.height / 2 - height / 2);
        top = Math.max(viewportPad, Math.min(vh - height - viewportPad, top));
        tip.style.width = `${Math.floor(width)}px`;
        tip.style.height = `${Math.floor(height)}px`;
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.setAttribute('data-placement', placement);
    }

    // --- Long-canvas geometry and virtualization (Linked mode) ---
    updateTimelineGeometry() {
        if (!this.ui.timelineBar || !this.ui.trackContent) return;
        const barHeight = this.ui.timelineBar.clientHeight || 0;
        const pad = this.getTrackPadding();
        const N = this.markers.length;
        const usable = Math.max(0, barHeight - 2 * pad);

        this.contentHeight = barHeight;
        this.scale = 1;
        this.yPositions = [];

        if (N === 1) {
            // For single marker, position it at the center
            const mid = pad + usable / 2;
            this.yPositions[0] = mid;
            this.markers[0].n = 0.5;
        } else if (N > 1) {
            // For multiple markers, distribute evenly
            const step = usable / Math.max(1, N - 1);
            for (let i = 0; i < N; i++) {
                const top = pad + step * i;
                const clampedTop = Math.max(pad, Math.min(pad + usable, top));
                const n = (clampedTop - pad) / usable;
                this.yPositions[i] = clampedTop;
                this.markers[i].n = Math.max(0, Math.min(1, n));
            }
        }

        for (let i = 0; i < N; i++) {
            if (this.markers[i].dotElement && !this.usePixelTop) {
                try { this.markers[i].dotElement.style.setProperty('--n', String(this.markers[i].n)); } catch {}
            }
        }

        if (this._cssVarTopSupported === null) {
            const usableC = Math.max(1, barHeight - 2 * pad);
            this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
            this.usePixelTop = !this._cssVarTopSupported;
        }

        try { this.ui.trackContent.style.height = `${Math.max(barHeight, 0)}px`; } catch {}
        if (this.ui.track) {
            try { this.ui.track.scrollTop = 0; } catch {}
        }

        this.sliderAlwaysVisible = false;
        try {
            this.ui.slider?.classList.remove('visible');
            if (this.ui.slider) this.ui.slider.style.opacity = '';
        } catch {}
    }

    detectCssVarTopSupport(pad, usableC) {
        try {
            if (!this.ui.trackContent) return false;
            const test = document.createElement('button');
            test.className = 'timeline-dot';
            test.style.visibility = 'hidden';
            test.style.pointerEvents = 'none';
            test.setAttribute('aria-hidden', 'true');
            const expected = pad + 0.5 * usableC;
            test.style.setProperty('--n', '0.5');
            this.ui.trackContent.appendChild(test);
            const cs = getComputedStyle(test);
            const topStr = cs.top || '';
            const px = parseFloat(topStr);
            test.remove();
            if (!Number.isFinite(px)) return false;
            return Math.abs(px - expected) <= 2;
        } catch {
            return false;
        }
    }

    syncTimelineTrackToMain() {
        if (!this.ui.track) return;
        // When all markers fit the bar we intentionally pin the internal scroll
        // position so every dot stays in view simultaneously.
        if (!this.contentHeight || (this.ui.track.clientHeight || 0) <= 0) return;
        if (this.contentHeight <= (this.ui.track.clientHeight || 0) + 1) {
            if ((this.ui.track.scrollTop || 0) !== 0) {
                this.ui.track.scrollTop = 0;
            }
            return;
        }
        if (this.sliderDragging) return; // do not override when user drags slider
        if (!this.scrollContainer) return;
        const scrollTop = this.scrollContainer.scrollTop;
        const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
        const span = Math.max(1, this.contentSpanPx || 1);
        const r = Math.max(0, Math.min(1, (ref - (this.firstUserTurnOffset || 0)) / span));
        const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
        const target = Math.round(r * maxScroll);
        if (Math.abs((this.ui.track.scrollTop || 0) - target) > 1) {
            this.ui.track.scrollTop = target;
        }
    }

    updateVirtualRangeAndRender() {
        if (!this.ui.trackContent || !this.ui.timelineBar) return;
        const count = this.markers.length;
        const frag = document.createDocumentFragment();

        const existing = new Set();
        for (let i = 0; i < count; i++) {
            const marker = this.markers[i];
            if (!marker) continue;
            let dot = marker.dotElement;
            if (!dot) {
                dot = document.createElement('button');
                dot.className = 'timeline-dot';
                dot.dataset.targetTurnId = marker.id;
                dot.setAttribute('aria-label', marker.summary);
                dot.setAttribute('tabindex', '0');
                try { dot.setAttribute('aria-describedby', 'chatgpt-timeline-tooltip'); } catch {}
                marker.dotElement = dot;
            }

            const n = Number.isFinite(marker.n) ? marker.n : 0;
            if (this.usePixelTop) {
                const top = Number.isFinite(this.yPositions[i]) ? Math.round(this.yPositions[i]) : 0;
                dot.style.top = `${top}px`;
                try { dot.style.removeProperty('--n'); } catch {}
            } else {
                try { dot.style.setProperty('--n', String(n)); } catch {}
                try { dot.style.removeProperty('top'); } catch {}
            }

            try { dot.classList.toggle('active', marker.id === this.activeTurnId); } catch {}
            frag.appendChild(dot);
            existing.add(dot);
        }

        const host = this.ui.trackContent;
        host.querySelectorAll('.timeline-dot').forEach(node => {
            if (!existing.has(node)) {
                try { node.remove(); } catch {}
            }
        });

        if (frag.childNodes.length) {
            host.appendChild(frag);
        }

        this.visibleRange = { start: 0, end: count - 1 };
    }

    lowerBound(arr, x) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < x) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    upperBound(arr, x) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= x) lo = mid + 1; else hi = mid;
        }
        return lo - 1;
    }

    // --- Left slider helpers ---
    updateSlider() {
        if (!this.ui.slider || !this.ui.sliderHandle) return;
        if (!this.contentHeight || !this.ui.timelineBar || !this.ui.track) return;
        const barRect = this.ui.timelineBar.getBoundingClientRect();
        const barH = barRect.height || 0;
        const pad = this.getTrackPadding();
        const innerH = Math.max(0, barH - 2 * pad);
        if (this.contentHeight <= barH + 1 || innerH <= 0) {
            this.sliderAlwaysVisible = false;
            try {
                this.ui.slider.classList.remove('visible');
                this.ui.slider.style.opacity = '';
            } catch {}
            return;
        }
        this.sliderAlwaysVisible = true;
        // External slider geometry (short rail centered on inner area)
        const railLen = Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
        const railTop = Math.round(barRect.top + pad + (innerH - railLen) / 2);
        const railLeftGap = 8; // px gap from bar's left edge
        const sliderWidth = 12; // matches CSS
        const left = Math.round(barRect.left - railLeftGap - sliderWidth);
        this.ui.slider.style.left = `${left}px`;
        this.ui.slider.style.top = `${railTop}px`;
        this.ui.slider.style.height = `${railLen}px`;

        const handleH = 22; // fixed concise handle
        const maxTop = Math.max(0, railLen - handleH);
        const range = Math.max(1, this.contentHeight - barH);
        const st = this.ui.track.scrollTop || 0;
        const r = Math.max(0, Math.min(1, st / range));
        const top = Math.round(r * maxTop);
        this.ui.sliderHandle.style.height = `${handleH}px`;
        this.ui.sliderHandle.style.top = `${top}px`;
        try {
            this.ui.slider.classList.add('visible');
            this.ui.slider.style.opacity = '';
        } catch {}
    }

    showSlider() {
        if (!this.ui.slider) return;
        this.ui.slider.classList.add('visible');
        if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} this.sliderFadeTimer = null; }
        this.updateSlider();
    }

    hideSliderDeferred() {
        if (this.sliderDragging || this.sliderAlwaysVisible) return;
        if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} }
        this.sliderFadeTimer = setTimeout(() => {
            this.sliderFadeTimer = null;
            try { this.ui.slider?.classList.remove('visible'); } catch {}
        }, this.sliderFadeDelay);
    }

    handleSliderDrag(e) {
        if (!this.sliderDragging || !this.ui.timelineBar || !this.ui.track) return;
        const barRect = this.ui.timelineBar.getBoundingClientRect();
        const barH = barRect.height || 0;
        const railLen = parseFloat(this.ui.slider.style.height || '0') || Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
        const handleH = this.ui.sliderHandle.getBoundingClientRect().height || 22;
        const maxTop = Math.max(0, railLen - handleH);
        const delta = e.clientY - this.sliderStartClientY;
        let top = Math.max(0, Math.min(maxTop, (this.sliderStartTop + delta) - (parseFloat(this.ui.slider.style.top) || 0)));
        const r = (maxTop > 0) ? (top / maxTop) : 0;
        const range = Math.max(1, this.contentHeight - barH);
        this.ui.track.scrollTop = Math.round(r * range);
        this.updateVirtualRangeAndRender();
        this.showSlider();
        this.updateSlider();
    }

    endSliderDrag(e) {
        this.sliderDragging = false;
        try { window.removeEventListener('pointermove', this.onSliderMove); } catch {}
        this.onSliderMove = null;
        this.onSliderUp = null;
        this.hideSliderDeferred();
    }

    computePlacementInfo(dot) {
        const tip = this.ui.tooltip || document.body;
        const dotRect = dot.getBoundingClientRect();
        const vw = window.innerWidth;
        const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
        const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
        const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
        const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
        const viewportPad = 8;
        const maxW = this.getCSSVarNumber(tip, '--timeline-tooltip-max', 288);
        const minW = 160;
        const leftAvail = Math.max(0, dotRect.left - gap - viewportPad);
        const rightAvail = Math.max(0, vw - dotRect.right - gap - viewportPad);
        let placement = (rightAvail > leftAvail) ? 'right' : 'left';
        let avail = placement === 'right' ? rightAvail : leftAvail;
        // choose width tier for determinism
        const tiers = [280, 240, 200, 160];
        const hardMax = Math.max(minW, Math.min(maxW, Math.floor(avail)));
        let width = tiers.find(t => t <= hardMax) || Math.max(minW, Math.min(hardMax, 160));
        // if no tier fits (very tight), try switching side
        if (width < minW && placement === 'left' && rightAvail > leftAvail) {
            placement = 'right';
            avail = rightAvail;
            const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
            width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
        } else if (width < minW && placement === 'right' && leftAvail >= rightAvail) {
            placement = 'left';
            avail = leftAvail;
            const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
            width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
        }
        width = Math.max(120, Math.min(width, maxW));
        return { placement, width };
    }

    truncateToThreeLines(text, targetWidth, wantLayout = false) {
        try {
            if (!this.measureEl || !this.ui.tooltip) return wantLayout ? { text, height: 0 } : text;
            const tip = this.ui.tooltip;
            const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
            const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
            const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
            const maxH = Math.round(3 * lineH + 2 * padY + 2 * borderW);
            const ell = '…';
            const el = this.measureEl;
            el.style.width = `${Math.max(0, Math.floor(targetWidth))}px`;

            // fast path: full text fits within 3 lines
            el.textContent = String(text || '').replace(/\s+/g, ' ').trim();
            let h = el.offsetHeight;
            if (h <= maxH) {
                return wantLayout ? { text: el.textContent, height: h } : el.textContent;
            }

            // binary search longest prefix that fits
            const raw = el.textContent;
            let lo = 0, hi = raw.length, ans = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                el.textContent = raw.slice(0, mid).trimEnd() + ell;
                h = el.offsetHeight;
                if (h <= maxH) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
            }
            const out = (ans >= raw.length) ? raw : (raw.slice(0, ans).trimEnd() + ell);
            el.textContent = out;
            h = el.offsetHeight;
            return wantLayout ? { text: out, height: Math.min(h, maxH) } : out;
        } catch {
            return wantLayout ? { text, height: 0 } : text;
        }
    }

    scheduleScrollSync() {
        if (this.scrollRafId !== null) return;
        this.scrollRafId = requestAnimationFrame(() => {
            this.scrollRafId = null;
            // Sync long-canvas scroll and virtualized dots before computing active
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
            this.computeActiveByScroll();
            this.updateSlider();
        });
    }

    computeActiveByScroll() {
        if (!this.scrollContainer || this.markers.length === 0) return;
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const scrollTop = this.scrollContainer.scrollTop;
        const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;

        let activeId = this.markers[0].id;
        for (let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i];
            const top = m.element.getBoundingClientRect().top - containerRect.top + scrollTop;
            if (top <= ref) {
                activeId = m.id;
            } else {
                break;
            }
        }
        if (this.activeTurnId !== activeId) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const since = now - this.lastActiveChangeTime;
            if (since < this.minActiveChangeInterval) {
                // Coalesce rapid changes during fast scrolling/layout shifts
                this.pendingActiveId = activeId;
                if (!this.activeChangeTimer) {
                    const delay = Math.max(this.minActiveChangeInterval - since, 0);
                    this.activeChangeTimer = setTimeout(() => {
                        this.activeChangeTimer = null;
                        if (this.pendingActiveId && this.pendingActiveId !== this.activeTurnId) {
                            this.activeTurnId = this.pendingActiveId;
                            this.updateActiveDotUI();
                            this.lastActiveChangeTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        }
                        this.pendingActiveId = null;
                    }, delay);
                }
            } else {
                this.activeTurnId = activeId;
                this.updateActiveDotUI();
                this.lastActiveChangeTime = now;
            }
        }
    }

    waitForElement(selector) {
        return new Promise((resolve) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    try { observer.disconnect(); } catch {}
                    resolve(el);
                }
            });
            try {
                const targetNode = document.body || document.documentElement;
                if (targetNode && targetNode.nodeType === Node.ELEMENT_NODE) {
                    observer.observe(targetNode, { childList: true, subtree: true });
                }
            } catch (err) {
                console.warn('Failed to setup waitForElement observer:', err);
            }
            // Guard against long-lived observers on wrong pages
            setTimeout(() => { try { observer.disconnect(); } catch {} resolve(null); }, 5000);
        });
    }

    destroy() {
        try { this.mutationObserver?.disconnect(); } catch {}
        try { this.resizeObserver?.disconnect(); } catch {}
        try { this.intersectionObserver?.disconnect(); } catch {}
        this.visibleTurns.clear();
        if (this.ui.timelineBar && this.onTimelineBarClick) {
            try { this.ui.timelineBar.removeEventListener('click', this.onTimelineBarClick); } catch {}
        }
        if (this.scrollContainer && this.onScroll) {
            try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
        }
        if (this.ui.timelineBar) {
            try { this.ui.timelineBar.removeEventListener('mouseover', this.onTimelineBarOver); } catch {}
            try { this.ui.timelineBar.removeEventListener('mouseout', this.onTimelineBarOut); } catch {}
            try { this.ui.timelineBar.removeEventListener('focusin', this.onTimelineBarFocusIn); } catch {}
            try { this.ui.timelineBar.removeEventListener('focusout', this.onTimelineBarFocusOut); } catch {}
            try { this.ui.timelineBar.removeEventListener('wheel', this.onTimelineWheel); } catch {}
            // Remove hover handlers with stable refs
        try { this.ui.timelineBar?.removeEventListener('pointerenter', this.onBarEnter); } catch {}
        try { this.ui.timelineBar?.removeEventListener('pointerleave', this.onBarLeave); } catch {}
        try { this.ui.slider?.removeEventListener('pointerenter', this.onSliderEnter); } catch {}
        try { this.ui.slider?.removeEventListener('pointerleave', this.onSliderLeave); } catch {}
        // Clean up drag event listeners only if long press dragging was enabled
        if (this.settings?.enableLongPressDrag) {
            try { this.ui.timelineBar?.removeEventListener('pointerdown', this.onDragHandleDown); } catch {}
            try { window.removeEventListener('pointermove', this.onDragHandleMove); } catch {}
            try { window.removeEventListener('pointerup', this.onDragHandleUp); } catch {}
        }
        this.onBarEnter = this.onBarLeave = this.onSliderEnter = this.onSliderLeave = null;
        }
        try { this.ui.sliderHandle?.removeEventListener('pointerdown', this.onSliderDown); } catch {}
        try { window.removeEventListener('pointermove', this.onSliderMove); } catch {}
        if (this.onWindowResize) {
            try { window.removeEventListener('resize', this.onWindowResize); } catch {}
        }
        if (this.onVisualViewportResize && window.visualViewport) {
            try { window.visualViewport.removeEventListener('resize', this.onVisualViewportResize); } catch {}
            this.onVisualViewportResize = null;
        }
        if (this.scrollRafId !== null) {
            try { cancelAnimationFrame(this.scrollRafId); } catch {}
            this.scrollRafId = null;
        }
        try { this.ui.timelineBar?.remove(); } catch {}
        try { this.ui.tooltip?.remove(); } catch {}
        try { this.measureEl?.remove(); } catch {}
        // Ensure external left slider is fully removed and not intercepting pointer events
        try {
            if (this.ui.slider) {
                try { this.ui.slider.style.pointerEvents = 'none'; } catch {}
                try { this.ui.slider.remove(); } catch {}
            }
            const straySlider = document.querySelector('.timeline-left-slider');
            if (straySlider) {
                try { straySlider.style.pointerEvents = 'none'; } catch {}
                try { straySlider.remove(); } catch {}
            }
        } catch {}
        this.ui.slider = null;
        this.ui.sliderHandle = null;

        // Clean up TOC dragging
        if (this.tocDragging) {
            try { window.removeEventListener('pointermove', this.onTOCDragMove); } catch {}
            try { window.removeEventListener('pointerup', this.onTOCDragUp); } catch {}
        }
        this.tocDragging = false;
        this.onTOCDragMove = null;
        this.onTOCDragUp = null;

        // Clean up timeline long press drag functionality
        if (this.ui.timelineBar) {
            this.ui.timelineBar.classList.remove('long-press-ready');
        }
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        // Clean up TOC long press drag functionality
        const tocContainer = document.querySelector('.timeline-toc');
        if (tocContainer) {
            // Remove long press event listeners (these are anonymous functions, so we need to re-add and remove)
            const newHandlePointerDown = (e) => {
                const target = e.target;
                if (target.closest('.toc-close') || target.closest('.toc-expand') ||
                    target.closest('.toc-item') || target.closest('.toc-drag-handle')) {
                    return;
                }
                tocContainer.classList.add('long-press-ready');
            };
            const newHandlePointerUp = (e) => {
                tocContainer.classList.remove('long-press-ready');
            };
            const newHandlePointerMove = (e) => {
                // Movement handling for long press cancellation
            };

            tocContainer.removeEventListener('pointerdown', newHandlePointerDown);
            tocContainer.removeEventListener('pointerup', newHandlePointerUp);
            tocContainer.removeEventListener('pointermove', newHandlePointerMove);
        }
        this.ui = { timelineBar: null, tooltip: null };
        this.markers = [];
        this.markerById.clear();
        this.activeTurnId = null;
        this.scrollContainer = null;
        this.conversationContainer = null;
        this.onTimelineBarClick = null;
        this.onTimelineBarOver = null;
        this.onTimelineBarOut = null;
        this.onTimelineBarFocusIn = null;
        this.onTimelineBarFocusOut = null;
        this.onScroll = null;
        this.onWindowResize = null;
        if (this.activeChangeTimer) {
            try { clearTimeout(this.activeChangeTimer); } catch {}
            this.activeChangeTimer = null;
        }
        if (this.tooltipHideTimer) {
            try { clearTimeout(this.tooltipHideTimer); } catch {}
            this.tooltipHideTimer = null;
        }
        if (this.resizeIdleTimer) {
            try { clearTimeout(this.resizeIdleTimer); } catch {}
            this.resizeIdleTimer = null;
        }
        try {
            if (this.resizeIdleRICId && typeof cancelIdleCallback === 'function') {
                cancelIdleCallback(this.resizeIdleRICId);
                this.resizeIdleRICId = null;
            }
        } catch {}
        if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} this.sliderFadeTimer = null; }
        if (this.tocVisibilityCheckInterval) { try { clearInterval(this.tocVisibilityCheckInterval); } catch {} this.tocVisibilityCheckInterval = null; }
        this.pendingActiveId = null;
    }

    // Drag functionality methods
    startDrag(e) {
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;

        if (!this.ui.timelineBar) {
            console.warn('Timeline bar not available for drag start');
            return;
        }

        const rect = this.ui.timelineBar.getBoundingClientRect();
        this.barStartX = rect.right;
        this.barStartY = rect.top;

        // Add dragging class for visual feedback
        this.ui.timelineBar.classList.add('dragging');
        this.dragHandle.classList.add('active');

        // Immediately disable dot interactions to prevent drag conflicts
        this.disableDotInteractions();

        // Disable scroll syncing during drag for better performance
        this.dragScrollSyncDisabled = true;

        // Add performance optimizations
        this.ui.timelineBar.style.willChange = 'transform';
        this.ui.timelineBar.style.contain = 'layout style paint';

        // Ensure timeline bar itself remains draggable
        this.ui.timelineBar.style.pointerEvents = 'auto';

        // Prevent default behavior
        e.preventDefault();
        e.stopPropagation();
    }

    updateDrag(e) {
        if (!this.isDragging) return;

        const deltaX = e.clientX - this.dragStartX;
        const deltaY = e.clientY - this.dragStartY;

        const timelineBar = this.ui.timelineBar;
        const barRect = timelineBar.getBoundingClientRect();
        const barWidth = barRect.width;
        const barHeight = barRect.height;

        // Calculate new position
        let newX = this.barStartX + deltaX;
        let newY = this.barStartY + deltaY;

        // Apply boundary constraints with bounce effect
        const margin = 10; // Minimum margin from screen edges
        const maxX = window.innerWidth - barWidth - margin;
        const maxY = window.innerHeight - barHeight - margin;

        if (newX < margin) {
            newX = margin - (margin - newX) * 0.3; // Bounce effect
        } else if (newX > maxX) {
            newX = maxX + (newX - maxX) * 0.3; // Bounce effect
        }

        if (newY < margin) {
            newY = margin - (margin - newY) * 0.3; // Bounce effect
        } else if (newY > maxY) {
            newY = maxY + (newY - maxY) * 0.3; // Bounce effect
        }

        // Apply smooth animation during drag
        timelineBar.style.transition = 'none';
        // Ensure the timeline stays within screen bounds
        const constrainedX = Math.max(margin, Math.min(newX, maxX));
        timelineBar.style.right = `${window.innerWidth - constrainedX - barWidth}px`;
        timelineBar.style.top = `${Math.max(margin, Math.min(newY, maxY))}px`;

        // Add visual feedback for boundary proximity
        const nearBoundary = newX < margin + 20 || newX > maxX - 20 ||
                           newY < margin + 20 || newY > maxY - 20;
        timelineBar.classList.toggle('near-boundary', nearBoundary);
    }

    endDrag(e) {
        if (!this.isDragging) return;

        this.isDragging = false;

        const timelineBar = this.ui.timelineBar;

        // Remove dragging and boundary classes
        timelineBar.classList.remove('dragging', 'near-boundary', 'long-press-ready');
        this.dragHandle.classList.remove('active');

        // Clear long press timer if it exists
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        // Restore transition animation and performance optimizations
        timelineBar.style.transition = '';
        timelineBar.style.willChange = '';
        timelineBar.style.contain = '';

        // Re-enable scroll syncing
        this.dragScrollSyncDisabled = false;

        // Re-enable dot interactions
        this.enableDotInteractions();

        // Save position
        this.savePosition().catch(error => console.warn('Failed to save position after drag:', error));

        // Prevent default behavior
        e.preventDefault();
        e.stopPropagation();
    }

    // Dot interaction control methods
    disableDotInteractions() {
        if (!this.ui.timelineBar) return;
        const dots = this.ui.timelineBar.querySelectorAll('.timeline-dot');
        dots.forEach(dot => {
            dot.style.pointerEvents = 'none';
            dot.disabled = true;
        });
    }

    enableDotInteractions() {
        if (!this.ui.timelineBar) return;
        const dots = this.ui.timelineBar.querySelectorAll('.timeline-dot');
        dots.forEach(dot => {
            dot.style.pointerEvents = '';
            dot.disabled = false;
        });
    }

    disableTOCInteractions() {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        // Disable all interactive elements in TOC
        const interactiveElements = tocContainer.querySelectorAll('button, .toc-item, .toc-close');
        interactiveElements.forEach(element => {
            element.style.pointerEvents = 'none';
        });

        // Store original cursor
        this.tocOriginalCursor = tocContainer.style.cursor;
        tocContainer.style.cursor = 'grabbing';
    }

    enableTOCInteractions() {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        // Re-enable all interactive elements in TOC
        const interactiveElements = tocContainer.querySelectorAll('button, .toc-item, .toc-close');
        interactiveElements.forEach(element => {
            element.style.pointerEvents = '';
        });

        // Restore original cursor
        if (this.tocOriginalCursor !== undefined) {
            tocContainer.style.cursor = this.tocOriginalCursor;
        } else {
            tocContainer.style.cursor = '';
        }
    }

    // Position persistence methods
    async savePosition() {
        try {
            if (!this.ui.timelineBar) {
                console.warn('Timeline bar not available for position save');
                return;
            }

            const rect = this.ui.timelineBar.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;

            // Convert pixel coordinates to percentage of window size
            const position = {
                right: ((windowWidth - rect.right) / windowWidth) * 100,
                top: (rect.top / windowHeight) * 100,
                width: (rect.width / windowWidth) * 100,
                height: (rect.height / windowHeight) * 100,
                // Store window dimensions for validation
                windowWidth: windowWidth,
                windowHeight: windowHeight
            };

            console.log(`[Timeline Position] Saved position: ${position.right.toFixed(2)}%, ${position.top.toFixed(2)}% of window ${windowWidth}x${windowHeight}`);
            // Use chrome.storage instead of localStorage for better persistence
            await chrome.storage.local.set({ [this.positionKey]: position });
        } catch (error) {
            console.warn('Failed to save timeline position:', error);
        }
    }

    async restorePosition() {
        try {
            const result = await chrome.storage.local.get([this.positionKey]);
            const saved = result[this.positionKey];
            if (saved) {
                const currentWindowWidth = window.innerWidth;
                const currentWindowHeight = window.innerHeight;

                // Convert percentage back to pixels based on current window size
                let right = (saved.right / 100) * currentWindowWidth;
                let top = (saved.top / 100) * currentWindowHeight;

                // Apply boundary constraints
                if (!this.ui.timelineBar) {
                    console.warn('Timeline bar not available for position restore');
                    return;
                }

                const margin = 10;
                const barRect = this.ui.timelineBar.getBoundingClientRect();
                const barWidth = barRect.width;
                const barHeight = barRect.height;

                const maxRight = currentWindowWidth - barWidth - margin;
                const maxTop = currentWindowHeight - barHeight - margin;

                right = Math.max(margin, Math.min(right, maxRight));
                top = Math.max(margin, Math.min(top, maxTop));

                this.ui.timelineBar.style.right = `${right}px`;
                this.ui.timelineBar.style.top = `${top}px`;

                console.log(`[Timeline Position] Restored position: ${right.toFixed(0)}px, ${top.toFixed(0)}px (${saved.right.toFixed(2)}%, ${saved.top.toFixed(2)}% of ${currentWindowWidth}x${currentWindowHeight})`);

                // Update stored position with current window dimensions for future use
                saved.windowWidth = currentWindowWidth;
                saved.windowHeight = currentWindowHeight;
                await chrome.storage.local.set({ [this.positionKey]: saved });
            }
        } catch (error) {
            console.warn('Failed to restore timeline position:', error);
        }
    }

    // Settings management methods
    async loadSettings() {
        try {
            const result = await chrome.storage.local.get([this.settingsKey]);
            const saved = result[this.settingsKey];
            if (saved) {
                this.settings = { ...this.settings, ...saved };
            }
            settingsCache = { ...DEFAULT_SETTINGS, ...this.settings };
            settingsCacheLoaded = true;
        } catch (error) {
            console.warn('Failed to load settings:', error);
        }
    }

    async saveSettings() {
        try {
            await chrome.storage.local.set({ [this.settingsKey]: this.settings });
            settingsCache = { ...DEFAULT_SETTINGS, ...this.settings };
            settingsCacheLoaded = true;
        } catch (error) {
            console.warn('Failed to save settings:', error);
        }
    }

    applyTimelinePosition(timelineBar) {
        const position = this.settings.timelinePosition;
        const baseClasses = 'chatgpt-timeline-bar';

        // Remove existing position classes
        timelineBar.className = baseClasses;

        // Apply new position
        switch (position) {
            case 'left':
                timelineBar.classList.add('position-left');
                break;
            case 'top':
                timelineBar.classList.add('position-top');
                break;
            case 'bottom':
                timelineBar.classList.add('position-bottom');
                break;
            case 'right':
            default:
                timelineBar.classList.add('position-right');
                break;
        }
    }

    addDragHandle(timelineBar) {
        let dragHandle = timelineBar.querySelector('.timeline-drag-handle');
        if (!dragHandle) {
            dragHandle = document.createElement('div');
            dragHandle.className = 'timeline-drag-handle';
            dragHandle.setAttribute('title', '拖拽移动时间线位置');
            dragHandle.innerHTML = '⋮⋮';
            dragHandle.style.fontFamily = 'monospace';
            timelineBar.appendChild(dragHandle);
        }
        this.dragHandle = dragHandle;
    }

    // Table of Contents (TOC) Navigation
    createTOC() {
        if (!this.settings.enableTOC) return;

        let tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            tocContainer = document.createElement('div');
            tocContainer.className = 'timeline-toc expanded'; // Always start expanded and visible
            document.body.appendChild(tocContainer);

            // Add drag handle for dragging the entire panel
            this.addTOCDragHandle(tocContainer);

            // Add long press drag functionality to the entire TOC container
            this.addTOCLongPressDrag(tocContainer);

            // Add click handler for close button and expand functionality
            tocContainer.addEventListener('click', (e) => {
                const closeButton = e.target.closest('.toc-close');
                const expandButton = e.target.closest('.toc-expand');
                if (closeButton) {
                    this.collapseTOC();
                } else if (expandButton) {
                    this.expandTOC();
                }
            });
        }

        this.updateTOC();
        this.restoreTOCPosition(); // Restore saved position

        // Ensure TOC is visible after creation
        this.ensureTOCVisible();

        return tocContainer;
    }

    updateTOC() {
        if (!this.settings.enableTOC) return;

        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        // Use incremental updates instead of full DOM rebuild to prevent flickering
        this.updateTOCIncrementally(tocContainer);
    }

    // Legacy method for backwards compatibility - redirects to new incremental method
    updateTOCContentLegacy(tocContainer) {
        // Clear existing TOC
        tocContainer.innerHTML = '';

        if (tocContainer.classList.contains('collapsed')) {
            // Collapsed state - show minimal content with close functionality
            const header = document.createElement('div');
            header.className = 'toc-header';
            header.innerHTML = `
                <h3>目录</h3>
                <div class="toc-expand"></div>
            `;
            tocContainer.appendChild(header);

            // Add expand functionality
            const expandButton = header.querySelector('.toc-expand');
            expandButton.addEventListener('click', () => {
                this.expandTOC();
            });
            return;
        }

        // Always show the TOC structure
        // Create TOC header with close button
        const header = document.createElement('div');
        header.className = 'toc-header';
        header.innerHTML = `
            <h3>目录导航</h3>
            <div class="toc-close"></div>
        `;
        tocContainer.appendChild(header);

        // Check if we have any markers
        if (this.markers.length === 0) {
            // Show empty state with instructions and make it draggable
            const emptyState = document.createElement('div');
            emptyState.className = 'toc-empty-state';
            emptyState.innerHTML = `
                <div class="empty-title">暂无对话内容</div>
                <div class="empty-subtitle">开始与AI对话后，<br>目录导航将自动显示</div>
            `;
            tocContainer.appendChild(emptyState);
        } else {
            // Create TOC list with markers
            const list = document.createElement('div');
            list.className = 'toc-list';

            this.markers.forEach((marker, index) => {
                const item = document.createElement('div');
                item.className = `toc-item${marker.id === this.activeTurnId ? ' active' : ''}`;
                item.dataset.turnId = marker.id;

                // Show user's message as title and ChatGPT's reply as content
                const userText = this.truncateText(marker.summary, 25);
                const chatgptText = marker.chatgptReply ? this.truncateText(marker.chatgptReply, 35) : '';

                item.innerHTML = `
                    <span class="toc-index">${index + 1}</span>
                    <div class="toc-content">
                        <div class="toc-user-message">${userText}</div>
                        ${chatgptText ? `<div class="toc-chatgpt-reply">${chatgptText}</div>` : ''}
                    </div>
                    <button class="toc-copy-btn" title="复制QA对话" aria-label="复制QA对话">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                `;

                item.addEventListener('click', (e) => {
                    // Don't navigate if clicking on copy button
                    if (e.target.closest('.toc-copy-btn')) {
                        return;
                    }
                    e.stopPropagation();
                    this.smoothScrollTo(marker.element);
                    this.collapseTOC();
                });

                // Add copy button functionality
                const copyBtn = item.querySelector('.toc-copy-btn');
                if (copyBtn) {
                    copyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.copyQAText(marker);
                    });
                }

                list.appendChild(item);
            });

            tocContainer.appendChild(list);
        }

        this.applyTOCPosition(tocContainer, false);
        // Ensure TOC remains visible after update
        this.ensureTOCVisible();
    }

    updateTOCIncrementally(tocContainer) {
        const isCollapsed = tocContainer.classList.contains('collapsed');
        const wasCollapsed = tocContainer.dataset.wasCollapsed === 'true';

        // Only rebuild header if state changed or it's missing
        const existingHeader = tocContainer.querySelector('.toc-header');
        if (!existingHeader || isCollapsed !== wasCollapsed) {
            // Clear and rebuild only when necessary
            tocContainer.innerHTML = '';

            const header = document.createElement('div');
            header.className = 'toc-header';

            if (isCollapsed) {
                header.innerHTML = `
                    <h3>目录</h3>
                    <div class="toc-expand"></div>
                `;
                // Add expand functionality
                const expandButton = header.querySelector('.toc-expand');
                expandButton.addEventListener('click', () => {
                    this.expandTOC();
                });
            } else {
                header.innerHTML = `
                    <h3>目录导航</h3>
                    <div class="toc-close"></div>
                `;
            }

            tocContainer.appendChild(header);
        }

        // Update collapsed state tracking
        tocContainer.dataset.wasCollapsed = isCollapsed;

        if (isCollapsed) {
            // Collapsed state - already handled above
            this.applyTOCPosition(tocContainer, false);
            this.ensureTOCVisible();
            return;
        }

        // Handle expanded state content
        this.updateTOCContent(tocContainer);

        this.applyTOCPosition(tocContainer, false);
        this.ensureTOCVisible();
    }

    updateTOCContent(tocContainer) {
        // Check if we have any markers
        if (this.markers.length === 0) {
            this.updateEmptyState(tocContainer);
        } else {
            this.updateTOCList(tocContainer);
        }
    }

    updateEmptyState(tocContainer) {
        let emptyState = tocContainer.querySelector('.toc-empty-state');
        if (!emptyState) {
            // Remove existing list if present
            const existingList = tocContainer.querySelector('.toc-list');
            if (existingList) existingList.remove();

            emptyState = document.createElement('div');
            emptyState.className = 'toc-empty-state';
            emptyState.innerHTML = `
                <div class="empty-title">暂无对话内容</div>
                <div class="empty-subtitle">开始与AI对话后，<br>目录导航将自动显示</div>
            `;
            tocContainer.appendChild(emptyState);
        }
    }

    updateTOCList(tocContainer) {
        let list = tocContainer.querySelector('.toc-list');
        if (!list) {
            // Remove empty state if present
            const emptyState = tocContainer.querySelector('.toc-empty-state');
            if (emptyState) emptyState.remove();

            list = document.createElement('div');
            list.className = 'toc-list';
            tocContainer.appendChild(list);
        }

        // Clear existing items
        list.innerHTML = '';

        // Add current markers
        this.markers.forEach((marker, index) => {
            const item = document.createElement('div');
            item.className = `toc-item${marker.id === this.activeTurnId ? ' active' : ''}`;
            item.dataset.turnId = marker.id;

            // Show user's message as title and ChatGPT's reply as content
            const userText = this.truncateText(marker.summary, 25);
            const chatgptText = marker.chatgptReply ? this.truncateText(marker.chatgptReply, 35) : '';

            item.innerHTML = `
                <span class="toc-index">${index + 1}</span>
                <div class="toc-content">
                    <div class="toc-user-message">${userText}</div>
                    ${chatgptText ? `<div class="toc-chatgpt-reply">${chatgptText}</div>` : ''}
                </div>
                <button class="toc-copy-btn" title="复制QA对话" aria-label="复制QA对话">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="m5 15-4-4 4-4"></path>
                        <path d="M5 15H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3"></path>
                    </svg>
                </button>
            `;

            // Use debounced click handler to prevent rapid-fire updates
            const debouncedClick = this.debounce((e) => {
                // Don't navigate if clicking on copy button
                if (e.target.closest('.toc-copy-btn')) {
                    return;
                }
                e.stopPropagation();
                this.smoothScrollTo(marker.element);
                // Ensure TOC remains visible after navigation
                setTimeout(() => {
                    this.ensureTOCVisible();
                }, 50);
            }, 100);

            item.addEventListener('click', debouncedClick);

            // Add copy button functionality
            const copyBtn = item.querySelector('.toc-copy-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.copyQAText(marker);
                });
            }

            list.appendChild(item);
        });
    }

    applyTOCPosition(tocContainer, forceDefault = false) {
        const position = this.settings.tocPosition;
        const width = this.settings.tocWidth;

        // Check if TOC has custom position saved (not default position)
        const hasCustomPosition = this.hasTOCCustomPosition(tocContainer);

        // For collapsed state, use fixed positioning
        if (tocContainer.classList.contains('collapsed')) {
            if (position === 'left') {
                tocContainer.style.left = '80px';
                tocContainer.style.right = 'auto';
            } else {
                tocContainer.style.right = '80px';
                tocContainer.style.left = 'auto';
            }
            return;
        }

        // For expanded state, use the configured width
        tocContainer.style.width = `${width}px`;

        // Only apply default position if forced or no custom position exists
        if (forceDefault || !hasCustomPosition) {
            if (position === 'left') {
                tocContainer.style.left = '0px';
                tocContainer.style.right = 'auto';
            } else {
                tocContainer.style.right = '0px';
                tocContainer.style.left = 'auto';
            }
        }
    }

    // Check if TOC has custom position (not the default position)
    hasTOCCustomPosition(tocContainer) {
        if (!tocContainer) return false;

        const rect = tocContainer.getBoundingClientRect();
        const position = this.settings.tocPosition;

        // Check if current position differs from default position
        if (position === 'left') {
            return Math.abs(rect.left - 0) > 10; // Allow 10px tolerance for floating point precision
        } else {
            // For right position, default is right: 0 (which means right edge at window width)
            return Math.abs(rect.right - window.innerWidth) > 10;
        }
    }

    // Toggle TOC between collapsed/expanded states
    toggleTOC() {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        const isCollapsed = tocContainer.classList.contains('collapsed');

        if (isCollapsed) {
            tocContainer.classList.remove('collapsed');
            tocContainer.classList.add('expanded');
        } else {
            tocContainer.classList.remove('expanded');
            tocContainer.classList.add('collapsed');
        }

        // Update content
        this.updateTOC();
    }

    // Collapse TOC
    collapseTOC() {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        tocContainer.classList.remove('expanded');
        tocContainer.classList.add('collapsed');
        this.updateTOC();
        this.ensureTOCVisible();
    }

    // Expand TOC (for external use)
    expandTOC() {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) return;

        tocContainer.classList.remove('collapsed');
        tocContainer.classList.add('expanded');
        this.updateTOC();
        this.ensureTOCVisible();
    }

    // Add drag handle to TOC
    addTOCDragHandle(tocContainer) {
        let dragHandle = tocContainer.querySelector('.toc-drag-handle');
        if (!dragHandle) {
            dragHandle = document.createElement('div');
            dragHandle.className = 'toc-drag-handle';
            dragHandle.innerHTML = '⋮⋮';
            dragHandle.style.fontFamily = 'monospace';
            dragHandle.title = '拖拽移动目录位置';
            dragHandle.setAttribute('role', 'button');
            dragHandle.setAttribute('tabindex', '0');
            dragHandle.setAttribute('aria-label', '拖拽移动目录导航');
            tocContainer.appendChild(dragHandle);
        }
        this.tocDragHandle = dragHandle;

        // Add drag event listeners with proper event handling
        const handlePointerDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation(); // Prevent any other event handlers
            this.startTOCDrag(e);
        };

        // Remove existing listeners to prevent duplicates
        dragHandle.removeEventListener('pointerdown', handlePointerDown);
        dragHandle.addEventListener('pointerdown', handlePointerDown, { passive: false });

        // Also handle touch events for mobile
        const handleTouchStart = (e) => {
            console.log('TOC drag handle touchstart triggered');
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            // Convert touch event to pointer event for consistency
            const pointerEvent = {
                clientX: e.touches[0].clientX,
                clientY: e.touches[0].clientY,
                preventDefault: () => e.preventDefault(),
                stopPropagation: () => e.stopPropagation(),
                stopImmediatePropagation: () => e.stopImmediatePropagation()
            };
            this.startTOCDrag(pointerEvent);
        };

        dragHandle.removeEventListener('touchstart', handleTouchStart);
        dragHandle.addEventListener('touchstart', handleTouchStart, { passive: false });

        // Add keyboard support
        const handleKeyDown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                this.startTOCDrag(e);
            }
        };

        dragHandle.removeEventListener('keydown', handleKeyDown);
        dragHandle.addEventListener('keydown', handleKeyDown);
    }

    // Add long press drag functionality to the entire TOC container
    addTOCLongPressDrag(tocContainer) {
        let longPressTimer = null;
        let isLongPress = false;
        let startX = 0;
        let startY = 0;
        const longPressDelay = 500; // 500ms long press delay
        const moveThreshold = 10; // 10px movement threshold

        const handlePointerDown = (e) => {
            // Don't start long press if clicking on interactive elements
            const target = e.target;
            if (target.closest('.toc-close') || target.closest('.toc-expand') ||
                target.closest('.toc-item') || target.closest('.toc-drag-handle')) {
                return;
            }

            isLongPress = false;
            startX = e.clientX;
            startY = e.clientY;

            // Add visual feedback that long press is possible
            tocContainer.classList.add('long-press-ready');

            longPressTimer = setTimeout(() => {
                isLongPress = true;
                // Remove the visual feedback class as drag starts
                tocContainer.classList.remove('long-press-ready');
                this.startTOCDrag(e);
            }, longPressDelay);
        };

        const handlePointerUp = (e) => {
            // Clear the visual feedback
            tocContainer.classList.remove('long-press-ready');

            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }

            if (!isLongPress) {
                // This was a short click, let normal click handling occur
                return;
            }

            // Long press drag is already started, prevent default
            e.preventDefault();
            e.stopPropagation();
        };

        const handlePointerMove = (e) => {
            if (longPressTimer && !isLongPress) {
                // Check if user moved beyond threshold
                const deltaX = Math.abs(e.clientX - startX);
                const deltaY = Math.abs(e.clientY - startY);

                if (deltaX > moveThreshold || deltaY > moveThreshold) {
                    // User moved finger/mouse before long press completed, cancel timer
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                    // Remove visual feedback
                    tocContainer.classList.remove('long-press-ready');
                }
            }
        };

        // Remove existing listeners to prevent duplicates
        tocContainer.removeEventListener('pointerdown', handlePointerDown);
        tocContainer.removeEventListener('pointerup', handlePointerUp);
        tocContainer.removeEventListener('pointermove', handlePointerMove);

        tocContainer.addEventListener('pointerdown', handlePointerDown, { passive: false });
        tocContainer.addEventListener('pointerup', handlePointerUp, { passive: false });
        tocContainer.addEventListener('pointermove', handlePointerMove, { passive: false });
    }

    // Start TOC dragging
    startTOCDrag(e) {
        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            return;
        }

        this.tocDragging = true;
        this.tocDragStartX = e.clientX;
        this.tocDragStartY = e.clientY;

        const rect = tocContainer.getBoundingClientRect();
        this.tocStartX = rect.left;
        this.tocStartY = rect.top;

        // Add dragging class for visual feedback
        tocContainer.classList.add('dragging');

        // Immediately disable interactions to prevent drag conflicts
        this.disableTOCInteractions();

        // Disable scroll syncing during drag for better performance
        this.tocDragScrollSyncDisabled = true;

        // Add performance optimizations for TOC dragging
        tocContainer.style.willChange = 'transform';
        tocContainer.style.contain = 'layout style paint';

        // Ensure TOC itself remains draggable
        tocContainer.style.pointerEvents = 'auto';

        // Add global event listeners
        this.onTOCDragMove = (e) => this.updateTOCDrag(e);
        this.onTOCDragUp = (e) => this.endTOCDrag(e);

        window.addEventListener('pointermove', this.onTOCDragMove);
        window.addEventListener('pointerup', this.onTOCDragUp);

        e.preventDefault();
        e.stopPropagation();
    }

    // Update TOC position during drag with bounce effect
    updateTOCDrag(e) {
        if (!this.tocDragging) return;

        const deltaX = e.clientX - this.tocDragStartX;
        const deltaY = e.clientY - this.tocDragStartY;

        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            return;
        }

        const containerRect = tocContainer.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const containerHeight = containerRect.height;

        // Calculate new position with boundary constraints
        let newX = this.tocStartX + deltaX;
        let newY = this.tocStartY + deltaY;

        // Apply boundary constraints with improved bounce effect
        const margin = 10; // Minimum margin from screen edges
        const maxX = window.innerWidth - containerWidth - margin;
        const maxY = window.innerHeight - containerHeight - margin;

        // Improved bounce effect with smoother animation
        const bounceFactor = 0.4; // Increased bounce factor for better feedback

        if (newX < margin) {
            newX = margin - (margin - newX) * bounceFactor;
        } else if (newX > maxX) {
            newX = maxX + (newX - maxX) * bounceFactor;
        }

        if (newY < margin) {
            newY = margin - (margin - newY) * bounceFactor;
        } else if (newY > maxY) {
            newY = maxY + (newY - maxY) * bounceFactor;
        }

        // Apply smooth animation during drag
        tocContainer.style.transition = 'none';
        tocContainer.style.left = `${newX}px`;
        tocContainer.style.right = 'auto';
        tocContainer.style.top = `${newY}px`;

        // Add visual feedback for boundary proximity
        const nearBoundary = newX < margin + 20 || newX > maxX - 20 ||
                           newY < margin + 20 || newY > maxY - 20;
        tocContainer.classList.toggle('near-boundary', nearBoundary);
    }

    // End TOC dragging
    endTOCDrag(e) {
        if (!this.tocDragging) return;

        this.tocDragging = false;

        const tocContainer = document.querySelector('.timeline-toc');
        if (tocContainer) {
            // Remove dragging and boundary classes
            tocContainer.classList.remove('dragging', 'near-boundary');
            // Restore transition animation and performance optimizations
            tocContainer.style.transition = '';
            tocContainer.style.willChange = '';
            tocContainer.style.contain = '';
            // Save position
            this.saveTOCPosition();

        // Re-enable scroll syncing and interactions
        this.tocDragScrollSyncDisabled = false;
        this.enableTOCInteractions();

        // Ensure TOC remains visible after drag
        this.ensureTOCVisible();
        }

        // Remove global event listeners
        window.removeEventListener('pointermove', this.onTOCDragMove);
        window.removeEventListener('pointerup', this.onTOCDragUp);

        e.preventDefault();
        e.stopPropagation();
    }

    // Save TOC position as percentage of window size
    saveTOCPosition() {
        try {
            const tocContainer = document.querySelector('.timeline-toc');
            if (!tocContainer) {
                return;
            }

            const rect = tocContainer.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;

            // Convert pixel coordinates to percentage of window size
            const position = {
                left: (rect.left / windowWidth) * 100,
                top: (rect.top / windowHeight) * 100,
                width: (rect.width / windowWidth) * 100,
                height: (rect.height / windowHeight) * 100,
                // Store window dimensions for validation
                windowWidth: windowWidth,
                windowHeight: windowHeight
            };

            console.log(`[TOC Position] Saved position: ${position.left.toFixed(2)}%, ${position.top.toFixed(2)}% of window ${windowWidth}x${windowHeight}`);
            localStorage.setItem('chatgptTimelineTOCPosition', JSON.stringify(position));
        } catch (error) {
            console.warn('Failed to save TOC position:', error);
        }
    }

    // Restore TOC position from percentage coordinates
    restoreTOCPosition() {
        try {
            const saved = localStorage.getItem('chatgptTimelineTOCPosition');
            if (saved) {
                const position = JSON.parse(saved);
                const tocContainer = document.querySelector('.timeline-toc');
                if (tocContainer && position.left !== undefined && position.top !== undefined) {
                    // Convert percentage back to pixels based on current window size
                    const currentWindowWidth = window.innerWidth;
                    const currentWindowHeight = window.innerHeight;

                    // Check if window dimensions have changed significantly (>10% difference)
                    const widthDiff = Math.abs(currentWindowWidth - (position.windowWidth || currentWindowWidth)) / currentWindowWidth;
                    const heightDiff = Math.abs(currentWindowHeight - (position.windowHeight || currentWindowHeight)) / currentWindowHeight;

                    if (widthDiff > 0.1 || heightDiff > 0.1) {
                        console.log(`[TOC Position] Window size changed significantly (${(widthDiff * 100).toFixed(1)}% width, ${(heightDiff * 100).toFixed(1)}% height), adjusting TOC position`);
                    }

                    // Convert percentage to pixels and apply boundary constraints
                    let left = (position.left / 100) * currentWindowWidth;
                    let top = (position.top / 100) * currentWindowHeight;
                    const width = (position.width / 100) * currentWindowWidth;
                    const height = (position.height / 100) * currentWindowHeight;

                    // Apply boundary constraints
                    const margin = 10;
                    const maxLeft = currentWindowWidth - width - margin;
                    const maxTop = currentWindowHeight - height - margin;

                    left = Math.max(margin, Math.min(left, maxLeft));
                    top = Math.max(margin, Math.min(top, maxTop));

                    tocContainer.style.left = `${left}px`;
                    tocContainer.style.top = `${top}px`;
                    tocContainer.style.right = 'auto';

                    console.log(`[TOC Position] Restored position: ${left.toFixed(0)}px, ${top.toFixed(0)}px (${position.left.toFixed(2)}%, ${position.top.toFixed(2)}% of ${currentWindowWidth}x${currentWindowHeight})`);

                    // Update stored position with current window dimensions for future use
                    position.windowWidth = currentWindowWidth;
                    position.windowHeight = currentWindowHeight;
                    localStorage.setItem('chatgptTimelineTOCPosition', JSON.stringify(position));
                }
            }
        } catch (error) {
            console.warn('Failed to restore TOC position:', error);
        }
    }

    // Force TOC refresh after page changes - bypasses debouncing for immediate update
    forceTOCRefresh() {
        if (!this.settings.enableTOC) return;

        console.log('Force refreshing TOC after page change...');
        
        // Check if TOC container exists, create if needed
        let tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            console.log('TOC container not found, creating new one...');
            tocContainer = this.createTOC();
            if (!tocContainer) {
                console.warn('Failed to create TOC container');
                return;
            }
        } else {
            // Ensure existing TOC is visible
            tocContainer.style.display = 'block';
            tocContainer.style.visibility = 'visible';
            tocContainer.style.opacity = '1';
            tocContainer.style.pointerEvents = 'auto';
        }
        
        // Cancel any pending debounced updates to avoid conflicts
        if (this.debouncedTOCUpdate.cancel) {
            this.debouncedTOCUpdate.cancel();
        }
        
        // Force immediate incremental update
        this.updateTOCIncrementally(tocContainer);
        
        // Auto-expand TOC if it has content and is collapsed
        if (this.markers.length > 0 && tocContainer.classList.contains('collapsed')) {
            setTimeout(() => {
                if (this.markers.length > 0) {
                    this.expandTOC();
                }
            }, 50);
        }
        
        console.log('TOC force refresh completed');
    }

    // Ensure TOC is always visible and properly styled
    ensureTOCVisible() {
        if (!this.settings.enableTOC) return;

        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            console.log('TOC container not found, creating...');
            this.createTOC();
            return;
        }

        // Ensure TOC is always visible
        tocContainer.style.display = 'block';
        tocContainer.style.visibility = 'visible';
        tocContainer.style.opacity = '1';
        tocContainer.style.pointerEvents = 'auto';

        // Ensure proper positioning
        if (!tocContainer.style.left && !tocContainer.style.right) {
            this.restoreTOCPosition();
        }

        console.log('TOC visibility ensured');
    }

    // Update TOC item highlighting
    updateTOCHighlight() {
        if (!this.settings.enableTOC) return;

        const tocContainer = document.querySelector('.timeline-toc');
        if (!tocContainer) {
            this.ensureTOCVisible();
            return;
        }

        // Ensure TOC is visible before updating
        this.ensureTOCVisible();

        // Use requestAnimationFrame for smooth highlighting updates
        requestAnimationFrame(() => {
            // Remove all active classes
            tocContainer.querySelectorAll('.toc-item').forEach(item => {
                item.classList.remove('active');
            });

            // Add active class to current item
            const activeItem = tocContainer.querySelector(`.toc-item[data-turn-id="${this.activeTurnId}"]`);
            if (activeItem) {
                activeItem.classList.add('active');
            }
        });
    }

    truncateText(text, maxLength) {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    // Message handler for settings updates
    async handleMessage(request, sender, sendResponse) {
        if (request.action === 'updateSettings') {
            try {
                // Handle backwards compatibility for enableDragging vs enableLongPressDrag
                if (request.settings.hasOwnProperty('enableDragging') && !request.settings.hasOwnProperty('enableLongPressDrag')) {
                    request.settings.enableLongPressDrag = request.settings.enableDragging;
                }
                this.settings = { ...this.settings, ...request.settings };
                await this.saveSettings();
                settingsCache = { ...DEFAULT_SETTINGS, ...this.settings };
                settingsCacheLoaded = true;

                if (!isTimelineEnabledForSite(this.settings, this.siteType)) {
                    this.destroy();
                    timelineManagerInstance = null;
                    sendResponse({ success: true, disabled: true });
                    return;
                }

                // Re-inject UI with new settings
                if (this.ui.timelineBar) {
                    this.ui.timelineBar.remove();
                    this.ui = { timelineBar: null, tooltip: null };
                }
                await this.injectTimelineUI();
                this.setupEventListeners();

                // Update drag handle visibility based on new settings
                if (this.settings.enableLongPressDrag && !this.dragHandle) {
                    this.addDragHandle(this.ui.timelineBar);
                } else if (!this.settings.enableLongPressDrag && this.dragHandle) {
                    this.dragHandle.remove();
                    this.dragHandle = null;
                }

                if (this.settings.enableTOC) {
                    const existingTOC = document.querySelector('.timeline-toc');
                    if (existingTOC) {
                        // Update existing TOC with new settings instead of recreating
                        this.applyTOCPosition(existingTOC, true); // Force default position for new settings
                        this.updateTOC();
                    } else {
                        this.createTOC();
                    }
                } else {
                    const toc = document.querySelector('.timeline-toc');
                    if (toc) toc.remove();
                }

                sendResponse({ success: true });
            } catch (error) {
                console.warn('Failed to handle settings update:', error);
                sendResponse({ success: false, error: error.message });
            }
        } else if (request.action === 'getSettings') {
            sendResponse(this.settings);
        } else if (request.action === 'updateChatGPTWidth') {
            try {
                // Update CSS variable for ChatGPT width (width already includes unit)
                document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', request.width);
                sendResponse({ success: true });
            } catch (error) {
                console.warn('Failed to update ChatGPT width:', error);
                sendResponse({ success: false, error: error.message });
            }
        } else if (request.action === 'updateTaskPageWidth') {
            try {
                // Update CSS variable for task page width (width already includes unit)
                document.documentElement.style.setProperty('--timeline-task-page-max-width', request.width);
                sendResponse({ success: true });
            } catch (error) {
                console.warn('Failed to update task page width:', error);
                sendResponse({ success: false, error: error.message });
            }
        }
    }
}


// --- Entry Point and SPA Navigation Handler ---
let timelineManagerInstance = null;
let currentUrl = location.href;
let initTimerId = null;            // cancellable delayed init
let pageObserver = null;           // page-level MutationObserver (managed)
let routeCheckIntervalId = null;   // lightweight href polling fallback

// Cached DOM elements for performance optimization
let lastConversationCheck = 0;
let conversationElementsCache = null;
const CONVERSATION_CACHE_TTL = 100; // Cache TTL in milliseconds
let routeListenersAttached = false;

// Enhanced page content change detection
let contentChangeObserver = null;
const CONTENT_CHANGE_DEBOUNCE = 150; // Debounce DOM change detection

const URL_CHANGE_MAX_ATTEMPTS = 8;
const URL_CHANGE_RETRY_DELAY = 200;

// Utility function for debouncing function calls
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function isTimelineSupportedPath(pathname = location.pathname, hostname = location.hostname) {
    try {
        const siteType = getSiteType(hostname);
        const config = SITE_CONFIGS[siteType];
        if (!config) return false;
        return config.pathPrefixes.some(prefix => pathname.startsWith(prefix));
    } catch {
        return false;
    }
}

// Hook into History API for SPA navigation detection
let originalPushState = null;
let originalReplaceState = null;

function setupPushStateHooks() {
    // Only hook once to avoid multiple hooks
    if (originalPushState) return;
    
    try {
        // Store original methods
        originalPushState = history.pushState;
        originalReplaceState = history.replaceState;
        
        // Hook pushState
        history.pushState = function(...args) {
            const result = originalPushState.apply(this, args);
            console.log('PushState detected, triggering URL change check');
            // Use setTimeout to ensure the URL change is processed after the pushState
            setTimeout(() => {
                handleUrlChange();
            }, 10);
            return result;
        };
        
        // Hook replaceState
        history.replaceState = function(...args) {
            const result = originalReplaceState.apply(this, args);
            console.log('ReplaceState detected, triggering URL change check');
            // Use setTimeout to ensure the URL change is processed after the replaceState
            setTimeout(() => {
                handleUrlChange();
            }, 10);
            return result;
        };
        
        console.log('PushState/ReplaceState hooks installed for SPA navigation detection');
        
        // Also listen for click events on links to catch navigation attempts
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (link && link.href && isSupportedConversationUrl(link.href)) {
                console.log('Navigation link clicked, scheduling URL change check');
                // Schedule a check after a short delay to allow navigation to complete
                setTimeout(() => {
                    if (location.href !== currentUrl) {
                        handleUrlChange();
                    }
                }, 50);
            }
        }, true); // Use capture phase to catch early
    } catch (err) {
        console.warn('Failed to setup pushState hooks:', err);
    }
}

function attachRouteListenersOnce() {
    if (routeListenersAttached) return;
    routeListenersAttached = true;

    // Standard navigation event listeners
    try { window.addEventListener('popstate', handleUrlChange); } catch {}
    try { window.addEventListener('hashchange', handleUrlChange); } catch {}

    // Hook into pushState and replaceState for SPA navigation detection
    setupPushStateHooks();

    // Enhanced DOM content change detection for SPA navigation
    setupContentChangeObserver();

    // Lightweight polling fallback for pushState-driven SPA changes - increased frequency for better responsiveness
    try {
        routeCheckIntervalId = setInterval(() => {
            if (location.href !== currentUrl) handleUrlChange();
        }, 200); // Reduced from 800ms to 200ms for better responsiveness
    } catch {}
}

function setupContentChangeObserver() {
    if (contentChangeObserver) return;

    try {
        contentChangeObserver = new MutationObserver(debounce(() => {
            // Check if we're on a supported path and have conversation elements
            if (isTimelineSupportedPath() &&
                isTimelineEnabledForSite(getCachedSettings(), getSiteType()) &&
                hasRequiredConversationElements(true)) {
                // Handle both URL changes and content changes
                if (location.href !== currentUrl) {
                    // URL changed - this is SPA navigation
                    console.log('DOM content changed with URL change, triggering navigation handler');
                    handleUrlChange();
                } else if (!timelineManagerInstance) {
                    // URL same but content changed - might be dynamic content loading
                    console.log('DOM content changed without URL change, checking if timeline should be initialized');
                    processUrlChange();
                } else if (timelineManagerInstance) {
                    // Timeline exists but content changed - might need refresh
                    console.log('DOM content changed with existing timeline, checking if refresh needed');
                    // Check if the conversation structure has significantly changed
                    const currentTurns = getAllTurnElementsForSite().length;
                    if (currentTurns !== timelineManagerInstance.markers.length) {
                        console.log('Conversation structure changed, refreshing timeline');
                        timelineManagerInstance.refreshContent();
                    }
                }
            }
        }, CONTENT_CHANGE_DEBOUNCE));
    } catch (err) {
        console.warn('Failed to setup content change observer:', err);
        return;
    }

    try {
        // Observe main content areas for changes
        const targetSelectors = [
            'main', 
            '[role="main"]',
            '#__next', // Common React app root
            '.react-scroll-to-bottom', // ChatGPT specific
            'article', 
            '[data-testid="conversation-turn"]', 
            '.conversation-turn',
            'chat-window-content',
            '#chat-history',
            'infinite-scroller',
            'div.conversation-container',
            'user-query'
        ];
        
        let observerAttached = false;
        targetSelectors.forEach(selector => {
            const element = document.querySelector(selector);
            if (element && !observerAttached) {
                console.log(`Attaching content change observer to: ${selector}`);
                contentChangeObserver.observe(element, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['data-turn-id', 'class', 'data-testid']
                });
                observerAttached = true;
            }
        });

        // Also observe body as fallback if no specific element found
        if (!observerAttached && document.body) {
            console.log('Attaching content change observer to body as fallback');
            contentChangeObserver.observe(document.body, { 
                childList: true, 
                subtree: true,
                attributes: true,
                attributeFilter: ['data-turn-id', 'class', 'data-testid']
            });
        }
    } catch (err) {
        console.warn('Failed to start content change observer:', err);
    }
}

function detachRouteListeners() {
    if (!routeListenersAttached) return;
    routeListenersAttached = false;

    // Clean up standard event listeners
    try { window.removeEventListener('popstate', handleUrlChange); } catch {}
    try { window.removeEventListener('hashchange', handleUrlChange); } catch {}

    // Restore original pushState and replaceState methods
    try {
        if (originalPushState) {
            history.pushState = originalPushState;
            originalPushState = null;
        }
        if (originalReplaceState) {
            history.replaceState = originalReplaceState;
            originalReplaceState = null;
        }
    } catch {}

    // Clean up content change observer
    try { if (contentChangeObserver) { contentChangeObserver.disconnect(); contentChangeObserver = null; } } catch {}

    // Clean up polling interval
    try { if (routeCheckIntervalId) { clearInterval(routeCheckIntervalId); routeCheckIntervalId = null; } } catch {}
}

function cleanupGlobalObservers() {
    try { pageObserver?.disconnect(); } catch {}
    pageObserver = null;

    try { contentChangeObserver?.disconnect(); } catch {}
    contentChangeObserver = null;
}

async function initializeTimeline() {
    await loadSettingsCache();
    if (!isTimelineEnabledForSite(getCachedSettings(), getSiteType())) {
        console.log('Timeline disabled for current site, skipping initialization');
        return;
    }
    // Clean up existing instance if any
    if (timelineManagerInstance) {
        try { timelineManagerInstance.destroy(); } catch (err) {
            console.warn("Error destroying existing timeline instance:", err);
        }
        timelineManagerInstance = null;
    }

    // Remove any leftover UI before creating a new instance
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
    try { document.querySelector('.timeline-toc')?.remove(); } catch {}

    // Check if we have the necessary elements before creating new instance
    const hasConversationElements = hasRequiredConversationElements(true); // Force fresh check

    if (!hasConversationElements) {
        console.log('No conversation elements found, skipping timeline initialization');
        return;
    }

    timelineManagerInstance = new TimelineManager();
    try {
        await timelineManagerInstance.init();
        console.log('Timeline initialized successfully');
    } catch (err) {
        console.error("Timeline initialization failed:", err);
        timelineManagerInstance = null;
    }
 }

function handleUrlChange() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;

    // Reset cached conversation lookups so we don't rely on stale results
    conversationElementsCache = null;
    lastConversationCheck = 0;

    // Cancel any pending init from previous route
    try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}

    if (isTimelineSupportedPath() && isTimelineEnabledForSite(getCachedSettings(), getSiteType())) {
        // Attempt to process the route change with retries to wait for DOM readiness
        attemptProcessUrlChange();
    }
}

function attemptProcessUrlChange(attempt = 1) {
    if (!isTimelineSupportedPath() || !isTimelineEnabledForSite(getCachedSettings(), getSiteType())) return;

    const hasConversationElements = hasRequiredConversationElements(true);

    if (hasConversationElements) {
        processUrlChange();
        return;
    }

    if (attempt >= URL_CHANGE_MAX_ATTEMPTS) {
        console.warn('Timeline: conversation elements not found after URL change retries');
        return;
    }

    initTimerId = setTimeout(() => {
        initTimerId = null;
        attemptProcessUrlChange(attempt + 1);
    }, URL_CHANGE_RETRY_DELAY);
}

// Optimized DOM element detection with caching for better performance
function hasRequiredConversationElements(forceCheck = false) {
    const now = Date.now();

    // Use cached result if available and not expired
    if (!forceCheck && conversationElementsCache !== null &&
        (now - lastConversationCheck) < CONVERSATION_CACHE_TTL) {
        return conversationElementsCache;
    }

    // Optimized selector list - check in order of specificity and likelihood
    const siteConfig = getSiteConfig();
    const possibleSelectors = [
        siteConfig.allTurnSelector,
        siteConfig.userTurnSelector,
        'article[data-turn-id]',
        '[data-testid="conversation-turn"]',
        '.conversation-turn',
        'article',
        '[data-message-id]',
        '.message',
        'div.conversation-container',
        'user-query'
    ];

    let foundElement = null;
    for (const selector of possibleSelectors) {
        const element = document.querySelector(selector);
        if (element) {
            foundElement = element;
            break;
        }
    }

    const hasElements = Boolean(foundElement || document.querySelector('main'));

    // Cache the result (boolean)
    conversationElementsCache = hasElements;
    lastConversationCheck = now;

    if (forceCheck) {
        return foundElement || hasElements;
    }

    return hasElements;
}

async function processUrlChange() {
    if (!timelineManagerInstance) {
        try {
            console.log('Initializing timeline after URL change');
            await initializeTimeline();
        } catch (err) {
            console.error("Failed to initialize timeline after URL change:", err);
        }
    } else {
        try {
            console.log('Updating timeline content after URL change');
            // Use the new refreshContent method
            await timelineManagerInstance.refreshContent();
            
            // Additional TOC check after page change - ensure it's properly updated
            if (timelineManagerInstance.settings.enableTOC) {
                setTimeout(() => {
                    const tocContainer = document.querySelector('.timeline-toc');
                    // Only force refresh if TOC is missing or still showing empty state after our initial refresh
                    if (!tocContainer || (tocContainer.querySelector('.toc-empty-state') && timelineManagerInstance.markers.length > 0)) {
                        console.log('TOC needs additional refresh after URL change, forcing update...');
                        timelineManagerInstance.forceTOCRefresh();
                    }
                }, 400); // Give more time for the initial refresh to complete
            }
        } catch (err) {
            console.error("Failed to update timeline after URL change:", err);
            // If update fails, try to reinitialize
            try {
                // Clean up existing UI first
                if (timelineManagerInstance.ui.timelineBar) {
                    timelineManagerInstance.ui.timelineBar.remove();
                    timelineManagerInstance.ui = { timelineBar: null, tooltip: null };
                }
                timelineManagerInstance.destroy();
                timelineManagerInstance = null;
                await initializeTimeline();
            } catch (reinitErr) {
                console.error("Failed to reinitialize timeline:", reinitErr);
            }
        }
    }
}

const initialObserver = new MutationObserver(async () => {
    if (getFirstTurnElementForSite()) {
        if (isTimelineSupportedPath() && isTimelineEnabledForSite(getCachedSettings(), getSiteType())) {
            try {
                await initializeTimeline();
            } catch (err) {
                console.error("Failed to initialize timeline on page load:", err);
            }
        }
        try { initialObserver.disconnect(); } catch {}
        // Create a single managed pageObserver
        pageObserver = new MutationObserver(handleUrlChange);
        try {
            const targetNode = document.body || document.documentElement;
            if (targetNode && targetNode.nodeType === Node.ELEMENT_NODE) {
                pageObserver.observe(targetNode, { childList: true, subtree: true });
            }
        } catch (err) {
            console.warn('Failed to setup page observer:', err);
        }
        attachRouteListenersOnce();
    }
});

// More aggressive initialization detection
let initializationAttempts = 0;
const maxInitializationAttempts = 10;
const initializationInterval = setInterval(async () => {
    initializationAttempts++;

    // Check if we can find conversation elements (updated for new DOM structure)
    const bodyText = document.body.textContent || '';
    const hasConversationElements = hasRequiredConversationElements() ||
                                   (document.querySelector('main') && (bodyText.includes('ChatGPT') || bodyText.includes('Gemini')));

    if (hasConversationElements && isTimelineSupportedPath() &&
        isTimelineEnabledForSite(getCachedSettings(), getSiteType()) &&
        !timelineManagerInstance) {
        console.log(`Attempting timeline initialization (attempt ${initializationAttempts})`);
        try {
            await initializeTimeline();
            clearInterval(initializationInterval);
            console.log('Timeline initialized successfully');
        } catch (err) {
            console.error(`Failed to initialize timeline (attempt ${initializationAttempts}):`, err);
            if (initializationAttempts >= maxInitializationAttempts) {
                console.warn('Max initialization attempts reached, stopping attempts');
                clearInterval(initializationInterval);
            }
        }
    } else if (initializationAttempts >= maxInitializationAttempts) {
        clearInterval(initializationInterval);
    }
}, 1000); // Check every second

// Scroll-triggered initialization as fallback
let scrollInitAttempts = 0;
const maxScrollInitAttempts = 3;
const handleScrollForInit = async () => {
    if (timelineManagerInstance || !isTimelineSupportedPath() ||
        !isTimelineEnabledForSite(getCachedSettings(), getSiteType())) return;

    scrollInitAttempts++;
    const hasConversationElements = getFirstTurnElementForSite() ||
                                   document.querySelector('[data-testid="conversation-turn"]') ||
                                   document.querySelector('.conversation-turn') ||
                                   document.querySelector('main');

    if (hasConversationElements && scrollInitAttempts <= maxScrollInitAttempts) {
        console.log(`Scroll-triggered initialization attempt ${scrollInitAttempts}`);
        try {
            await initializeTimeline();
        } catch (err) {
            console.error(`Scroll-triggered initialization failed (attempt ${scrollInitAttempts}):`, err);
        }
    }
};

// Safely observe document body, fallback to documentElement if body is not available
try {
    const targetNode = document.body || document.documentElement;
    if (targetNode && targetNode.nodeType === Node.ELEMENT_NODE) {
        initialObserver.observe(targetNode, { childList: true, subtree: true });
    }
} catch (err) {
    console.warn('Failed to setup initial observer:', err);
}

// Add scroll listener for fallback initialization
let scrollListenerAdded = false;
function addScrollListenerForInit() {
    if (scrollListenerAdded) return;
    scrollListenerAdded = true;

    // Use passive scroll listener for better performance
    const throttledScrollHandler = throttle(handleScrollForInit, 500);
    window.addEventListener('scroll', throttledScrollHandler, { passive: true });

    // Also listen for touch events on mobile
    window.addEventListener('touchmove', throttledScrollHandler, { passive: true });
}

// Simple throttle function to avoid too many calls
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

// Start scroll listener after initial attempts
setTimeout(addScrollListenerForInit, 2000);

async function applyStoredWidthSettings() {
    try {
        const result = await chrome.storage.local.get(['chatgptTimelineSettings']);
        const saved = result.chatgptTimelineSettings || {};
        const chatgptWidth = saved.chatgptWidth ?? 48;
        const taskPageWidth = saved.taskPageWidth ?? 48;
        document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', chatgptWidth + 'rem');
        document.documentElement.style.setProperty('--timeline-task-page-max-width', taskPageWidth + 'rem');
    } catch (error) {
        console.warn('Failed to apply stored width settings:', error);
    }
}

async function handleStandaloneMessage(request, sendResponse) {
    if (request.action === 'updateSettings') {
        try {
            if (request.settings && request.settings.hasOwnProperty('enableDragging') &&
                !request.settings.hasOwnProperty('enableLongPressDrag')) {
                request.settings.enableLongPressDrag = request.settings.enableDragging;
            }
            const result = await chrome.storage.local.get(['chatgptTimelineSettings']);
            const saved = result.chatgptTimelineSettings || {};
            const merged = { ...saved, ...request.settings };
            await chrome.storage.local.set({ chatgptTimelineSettings: merged });
            settingsCache = { ...DEFAULT_SETTINGS, ...merged };
            settingsCacheLoaded = true;
            if (merged.chatgptWidth) {
                document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', merged.chatgptWidth + 'rem');
            }
            if (merged.taskPageWidth) {
                document.documentElement.style.setProperty('--timeline-task-page-max-width', merged.taskPageWidth + 'rem');
            }

            const enabledForSite = isTimelineEnabledForSite(settingsCache, getSiteType());
            if (!enabledForSite) {
                try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
                try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
                try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
                try { document.querySelector('.timeline-toc')?.remove(); } catch {}
            } else if (!timelineManagerInstance && isTimelineSupportedPath()) {
                await initializeTimeline();
            }
            sendResponse({ success: true });
        } catch (error) {
            console.warn('Failed to handle settings update (standalone):', error);
            sendResponse({ success: false, error: error.message });
        }
        return;
    }

    if (request.action === 'updateChatGPTWidth') {
        try {
            document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', request.width);
            sendResponse({ success: true });
        } catch (error) {
            console.warn('Failed to update ChatGPT width (standalone):', error);
            sendResponse({ success: false, error: error.message });
        }
        return;
    }

    if (request.action === 'updateTaskPageWidth') {
        try {
            document.documentElement.style.setProperty('--timeline-task-page-max-width', request.width);
            sendResponse({ success: true });
        } catch (error) {
            console.warn('Failed to update task page width (standalone):', error);
            sendResponse({ success: false, error: error.message });
        }
    }
}

applyStoredWidthSettings();
loadSettingsCache();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (timelineManagerInstance) {
        timelineManagerInstance.handleMessage(request, sender, sendResponse);
    } else {
        handleStandaloneMessage(request, sendResponse);
    }
    return true; // Keep message channel open for async response
});
