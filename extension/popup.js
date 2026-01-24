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
            chatgptWidth: 48,
            taskPageWidth: 48
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
                this.settings = { ...this.defaultSettings, ...loadedSettings };
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
