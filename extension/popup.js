const DEEPSEEK_PADDING_MIN = 0;
const DEEPSEEK_PADDING_MAX = 60;
const DEFAULT_DEEPSEEK_PADDING = 5;
const DEFAULT_DEEPSEEK_WIDTH = DEEPSEEK_PADDING_MAX + DEEPSEEK_PADDING_MIN - DEFAULT_DEEPSEEK_PADDING;

function migrateDeepseekWidthSetting(settings) {
    if (!settings) return { settings, migrated: false };
    if (settings.deepseekWidthMode === 'width') return { settings, migrated: false };
    const raw = Number.parseFloat(settings.deepseekWidth);
    const normalized = Number.isFinite(raw) ? raw : DEFAULT_DEEPSEEK_PADDING;
    settings.deepseekWidth = DEEPSEEK_PADDING_MAX + DEEPSEEK_PADDING_MIN - normalized;
    settings.deepseekWidthMode = 'width';
    return { settings, migrated: true };
}

// ChatGPT Timeline Settings Popup
class SettingsManager {
    constructor() {
        this.settingsKey = 'chatgptTimelineSettings';
        this.defaultSettings = {
            timelinePosition: 'right',
            enableDragging: true,
            enableTOC: false,
            tocWidth: 280,
            tocPosition: 'left',
            enableLongPressDrag: true,
            enableChatGPTTimeline: true,
            enableGeminiTimeline: true,
            enableClaudeTimeline: true,
            chatgptWidth: 48,
            taskPageWidth: 48,
            geminiWidth: 48,
            claudeWidth: 48,
            deepseekWidth: DEFAULT_DEEPSEEK_WIDTH,
            deepseekWidthMode: 'width',
            grokWidth: 85
        };
        this.settings = { ...this.defaultSettings };

        this.init();
    }

    async init() {
        // 等待语言管理器初始化完成
        await i18n.init();

        // 初始化翻译
        await this.initTranslations();

        // 监听语言变化
        i18n.onLanguageChange(() => {
            this.updateUITranslations();
        });

        this.loadSettings();
        this.setupEventListeners();
        this.updateUI();
    }

    /**
     * 初始化翻译
     */
    async initTranslations() {
        const elements = document.querySelectorAll('[data-i18n]');
        for (const element of elements) {
            const key = element.getAttribute('data-i18n');
            if (key) {
                const text = await i18n.t(key);
                if (element.tagName === 'TITLE') {
                    document.title = text;
                } else {
                    element.textContent = text;
                }
            }
        }
    }

    /**
     * 更新UI翻译
     */
    async updateUITranslations() {
        await this.initTranslations();
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem(this.settingsKey);
            if (saved) {
                const loadedSettings = JSON.parse(saved);
                // Handle backwards compatibility for enableDragging vs enableLongPressDrag
                if (loadedSettings.hasOwnProperty('enableDragging') && !loadedSettings.hasOwnProperty('enableLongPressDrag')) {
                    loadedSettings.enableLongPressDrag = loadedSettings.enableDragging;
                }
                const { settings: migrated, migrated: didMigrate } = migrateDeepseekWidthSetting({ ...loadedSettings });
                this.settings = { ...this.defaultSettings, ...migrated };
                if (didMigrate) {
                    localStorage.setItem(this.settingsKey, JSON.stringify(this.settings));
                }
            }
        } catch (error) {
            console.warn('Failed to load settings:', error);
            this.settings = { ...this.defaultSettings };
        }
    }

    saveSettings() {
        try {
            localStorage.setItem(this.settingsKey, JSON.stringify(this.settings));
            // 通知content script更新设置
            this.notifyContentScript();
        } catch (error) {
            console.warn('Failed to save settings:', error);
        }
    }

    notifyContentScript() {
        // 通过消息传递通知content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'updateSettings',
                    settings: this.settings
                }).catch(err => {
                    console.log('Content script not ready, settings will be applied on next page load');
                });

                // 实时更新 CSS 变量（如果在 ChatGPT 页面上）
                if (this.settings.chatgptWidth) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateChatGPTWidth',
                        width: this.settings.chatgptWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update ChatGPT width in real-time');
                    });
                }

                if (this.settings.taskPageWidth) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateTaskPageWidth',
                        width: this.settings.taskPageWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update task page width in real-time');
                    });
                }

                if (this.settings.geminiWidth) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateGeminiWidth',
                        width: this.settings.geminiWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update Gemini width in real-time');
                    });
                }

                if (this.settings.claudeWidth) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateClaudeWidth',
                        width: this.settings.claudeWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update Claude width in real-time');
                    });
                }

                if (Number.isFinite(this.settings.deepseekWidth)) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateDeepseekWidth',
                        width: this.settings.deepseekWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update DeepSeek width in real-time');
                    });
                }

                if (this.settings.grokWidth) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'updateGrokWidth',
                        width: this.settings.grokWidth + 'rem'
                    }).catch(err => {
                        console.log('Failed to update Grok width in real-time');
                    });
                }
            }
        });
    }

    setupEventListeners() {
        // 语言选择器
        document.getElementById('languageSelect').addEventListener('change', (e) => {
            i18n.setLanguage(e.target.value);
        });

        // 进度条位置选择
        document.getElementById('timelinePosition').addEventListener('change', (e) => {
            this.settings.timelinePosition = e.target.value;
            this.saveSettings();
        });

        // 允许长按拖拽复选框
        document.getElementById('enableDragging').addEventListener('change', (e) => {
            this.settings.enableLongPressDrag = e.target.checked;
            this.saveSettings();
        });

        // 站点开关
        document.getElementById('enableChatGPTTimeline').addEventListener('change', (e) => {
            this.settings.enableChatGPTTimeline = e.target.checked;
            this.saveSettings();
        });

        document.getElementById('enableGeminiTimeline').addEventListener('change', (e) => {
            this.settings.enableGeminiTimeline = e.target.checked;
            this.saveSettings();
        });

        document.getElementById('enableClaudeTimeline').addEventListener('change', (e) => {
            this.settings.enableClaudeTimeline = e.target.checked;
            this.saveSettings();
        });

        // 启用目录导航复选框
        document.getElementById('enableTOC').addEventListener('change', (e) => {
            this.settings.enableTOC = e.target.checked;
            this.updateTOCOptionVisibility();
            this.saveSettings();
        });

        // 目录导航宽度滑块
        const tocWidthSlider = document.getElementById('tocWidth');
        const tocWidthValue = document.getElementById('tocWidthValue');

        tocWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            tocWidthValue.textContent = value + 'px';
            this.settings.tocWidth = parseInt(value);
        });

        tocWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // 目录导航位置选择
        document.getElementById('tocPosition').addEventListener('change', (e) => {
            this.settings.tocPosition = e.target.value;
            this.saveSettings();
        });

        // ChatGPT 对话宽度滑块
        const chatgptWidthSlider = document.getElementById('chatgptWidth');
        const chatgptWidthValue = document.getElementById('chatgptWidthValue');

        chatgptWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            chatgptWidthValue.textContent = value + 'rem';
            this.settings.chatgptWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-chatgpt-html-content-max-width', value + 'rem');
            this.notifyContentScript();
        });

        chatgptWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // 任务页宽度滑块
        const taskPageWidthSlider = document.getElementById('taskPageWidth');
        const taskPageWidthValue = document.getElementById('taskPageWidthValue');

        taskPageWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            taskPageWidthValue.textContent = value + 'rem';
            this.settings.taskPageWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-task-page-max-width', value + 'rem');
            this.notifyContentScript();
        });

        taskPageWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // Gemini 对话宽度滑块
        const geminiWidthSlider = document.getElementById('geminiWidth');
        const geminiWidthValue = document.getElementById('geminiWidthValue');

        geminiWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            geminiWidthValue.textContent = value + 'rem';
            this.settings.geminiWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-gemini-conversation-max-width', value + 'rem');
            this.notifyContentScript();
        });

        geminiWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // Claude 对话宽度滑块
        const claudeWidthSlider = document.getElementById('claudeWidth');
        const claudeWidthValue = document.getElementById('claudeWidthValue');

        claudeWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            claudeWidthValue.textContent = value + 'rem';
            this.settings.claudeWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-claude-content-max-width', value + 'rem');
            this.notifyContentScript();
        });

        claudeWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // DeepSeek 内容宽度滑块
        const deepseekWidthSlider = document.getElementById('deepseekWidth');
        const deepseekWidthValue = document.getElementById('deepseekWidthValue');

        deepseekWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            deepseekWidthValue.textContent = value + 'rem';
            this.settings.deepseekWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-deepseek-content-width', this.settings.deepseekWidth + 'rem');
            this.notifyContentScript();
        });

        deepseekWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // Grok 内容宽度滑块
        const grokWidthSlider = document.getElementById('grokWidth');
        const grokWidthValue = document.getElementById('grokWidthValue');

        grokWidthSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            grokWidthValue.textContent = value + 'rem';
            this.settings.grokWidth = parseInt(value);
            // 实时更新 CSS 变量
            document.documentElement.style.setProperty('--timeline-grok-content-max-width', value + 'rem');
            this.notifyContentScript();
        });

        grokWidthSlider.addEventListener('change', () => {
            this.saveSettings();
        });

        // 重置按钮
        document.getElementById('resetSettings').addEventListener('click', () => {
            this.settings = { ...this.defaultSettings };
            this.updateUI();
            this.saveSettings();
        });
    }

    updateUI() {
        // 更新语言选择器
        document.getElementById('languageSelect').value = i18n.currentLanguage;

        // 更新进度条位置选择
        document.getElementById('timelinePosition').value = this.settings.timelinePosition;

        // 更新允许长按拖拽复选框
        document.getElementById('enableDragging').checked = this.settings.enableLongPressDrag;

        // 更新站点开关
        document.getElementById('enableChatGPTTimeline').checked = this.settings.enableChatGPTTimeline !== false;
        document.getElementById('enableGeminiTimeline').checked = this.settings.enableGeminiTimeline !== false;
        document.getElementById('enableClaudeTimeline').checked = this.settings.enableClaudeTimeline !== false;

        // 更新启用目录导航复选框
        document.getElementById('enableTOC').checked = this.settings.enableTOC;

        // 更新目录导航选项显示状态
        this.updateTOCOptionVisibility();

        // 更新目录导航宽度滑块和显示值
        const tocWidthSlider = document.getElementById('tocWidth');
        const tocWidthValue = document.getElementById('tocWidthValue');
        tocWidthSlider.value = this.settings.tocWidth;
        tocWidthValue.textContent = this.settings.tocWidth + 'px';

        // 更新目录导航位置选择
        document.getElementById('tocPosition').value = this.settings.tocPosition;

        // 更新 ChatGPT 对话宽度滑块和显示值
        const chatgptWidthSlider = document.getElementById('chatgptWidth');
        const chatgptWidthValue = document.getElementById('chatgptWidthValue');
        chatgptWidthSlider.value = this.settings.chatgptWidth;
        chatgptWidthValue.textContent = this.settings.chatgptWidth + 'rem';

        // 更新任务页宽度滑块和显示值
        const taskPageWidthSlider = document.getElementById('taskPageWidth');
        const taskPageWidthValue = document.getElementById('taskPageWidthValue');
        taskPageWidthSlider.value = this.settings.taskPageWidth;
        taskPageWidthValue.textContent = this.settings.taskPageWidth + 'rem';

        // 更新 Gemini 对话宽度滑块和显示值
        const geminiWidthSlider = document.getElementById('geminiWidth');
        const geminiWidthValue = document.getElementById('geminiWidthValue');
        geminiWidthSlider.value = this.settings.geminiWidth;
        geminiWidthValue.textContent = this.settings.geminiWidth + 'rem';

        // 更新 Claude 对话宽度滑块和显示值
        const claudeWidthSlider = document.getElementById('claudeWidth');
        const claudeWidthValue = document.getElementById('claudeWidthValue');
        claudeWidthSlider.value = this.settings.claudeWidth;
        claudeWidthValue.textContent = this.settings.claudeWidth + 'rem';

        // 更新 DeepSeek 内容宽度滑块和显示值
        const deepseekWidthSlider = document.getElementById('deepseekWidth');
        const deepseekWidthValue = document.getElementById('deepseekWidthValue');
        deepseekWidthSlider.value = this.settings.deepseekWidth;
        deepseekWidthValue.textContent = this.settings.deepseekWidth + 'rem';

        // 更新 Grok 内容宽度滑块和显示值
        const grokWidthSlider = document.getElementById('grokWidth');
        const grokWidthValue = document.getElementById('grokWidthValue');
        grokWidthSlider.value = this.settings.grokWidth;
        grokWidthValue.textContent = this.settings.grokWidth + 'rem';
    }

    updateTOCOptionVisibility() {
        const tocEnabled = this.settings.enableTOC;
        const tocOptions = document.getElementById('tocOptions');
        const tocPositionOptions = document.getElementById('tocPositionOptions');

        if (tocEnabled) {
            tocOptions.style.display = 'block';
            tocPositionOptions.style.display = 'block';
        } else {
            tocOptions.style.display = 'none';
            tocPositionOptions.style.display = 'none';
        }
    }

    // 获取当前设置
    getSettings() {
        return { ...this.settings };
    }

    // 重置为默认设置
    resetToDefaults() {
        this.settings = { ...this.defaultSettings };
        this.updateUI();
        this.saveSettings();
    }
}

// 初始化设置管理器
document.addEventListener('DOMContentLoaded', () => {
    const settingsManager = new SettingsManager();

    // 监听来自content script的设置更新请求
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getSettings') {
            sendResponse(settingsManager.getSettings());
        }
    });
});
