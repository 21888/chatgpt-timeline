/**
 * 国际化管理器
 * 支持中英文自动检测和手动切换
 */
class I18nManager {
    constructor() {
        this.currentLanguage = 'auto';
        this.supportedLanguages = ['zh-CN', 'en'];
        this.languageCache = new Map();
        this.languageKey = 'chatgptTimelineLanguage';
        this.listeners = new Set();

        this.init();
    }

    /**
     * 初始化语言管理器
     */
    async init() {
        await this.loadLanguage();
        this.detectLanguage();
    }

    /**
     * 自动检测浏览器语言
     */
    detectLanguage() {
        if (this.currentLanguage !== 'auto') return;

        const browserLang = navigator.language || navigator.userLanguage;
        const lang = this.supportedLanguages.includes(browserLang) ? browserLang : 'en';
        this.setLanguage(lang);
    }

    /**
     * 获取当前语言
     */
    getCurrentLanguage() {
        return this.currentLanguage === 'auto' ? this.getDetectedLanguage() : this.currentLanguage;
    }

    /**
     * 获取实际使用的语言
     */
    getDetectedLanguage() {
        const browserLang = navigator.language || navigator.userLanguage;
        return this.supportedLanguages.includes(browserLang) ? browserLang : 'en';
    }

    /**
     * 设置语言
     */
    setLanguage(lang) {
        if (lang === 'auto') {
            this.currentLanguage = 'auto';
            this.detectLanguage();
        } else if (this.supportedLanguages.includes(lang)) {
            this.currentLanguage = lang;
            this.saveLanguage(lang);
            this.notifyListeners();
        }
    }

    /**
     * 加载语言包
     */
    async loadLanguagePack(lang) {
        if (this.languageCache.has(lang)) {
            return this.languageCache.get(lang);
        }

        try {
            const response = await fetch(`_locales/${lang}/messages.json`);
            if (!response.ok) {
                throw new Error(`Failed to load language pack: ${lang}`);
            }
            const rawLangPack = await response.json();
            // 转换Chrome扩展的消息格式为简单的键值对
            const langPack = {};
            Object.keys(rawLangPack).forEach(key => {
                langPack[key] = rawLangPack[key].message;
            });
            this.languageCache.set(lang, langPack);
            return langPack;
        } catch (error) {
            console.warn(`Failed to load language pack for ${lang}:`, error);
            // 如果当前语言加载失败，尝试回退到英文
            if (lang !== 'en') {
                return this.loadLanguagePack('en');
            }
            throw error;
        }
    }

    /**
     * 获取翻译文本
     */
    async t(key, params = {}) {
        const lang = this.getCurrentLanguage();
        const langPack = await this.loadLanguagePack(lang);

        let text = langPack[key] || key;

        // 简单的参数替换
        Object.keys(params).forEach(param => {
            text = text.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
        });

        return text;
    }

    /**
     * 批量翻译
     */
    async translate(keys) {
        const lang = this.getCurrentLanguage();
        const langPack = await this.loadLanguagePack(lang);
        const result = {};

        keys.forEach(key => {
            result[key] = langPack[key] || key;
        });

        return result;
    }

    /**
     * 监听语言变化
     */
    onLanguageChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /**
     * 通知语言变化监听器
     */
    notifyListeners() {
        this.listeners.forEach(callback => callback(this.currentLanguage));
    }

    /**
     * 保存语言设置到本地存储
     */
    saveLanguage(lang) {
        try {
            localStorage.setItem(this.languageKey, lang);
        } catch (error) {
            console.warn('Failed to save language setting:', error);
        }
    }

    /**
     * 从本地存储加载语言设置
     */
    async loadLanguage() {
        try {
            const saved = localStorage.getItem(this.languageKey);
            if (saved && this.supportedLanguages.includes(saved)) {
                this.currentLanguage = saved;
            }
        } catch (error) {
            console.warn('Failed to load language setting:', error);
        }
    }

    /**
     * 获取支持的语言列表
     */
    getSupportedLanguages() {
        return [...this.supportedLanguages];
    }
}

// 创建全局实例
const i18n = new I18nManager();
