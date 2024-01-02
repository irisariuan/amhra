// @ts-check
const { yt_validate } = require('play-dl')

class SearchCache {
    constructor(opt = { maxCache: 20, maxCacheNumber: 20000 }) {
        this.cache = new Map()
        this.urlCache = new Map()
        this.maxCache = opt.maxCache
        this.maxCacheNumber = opt.maxCacheNumber
    }
    /**
     * 
     * @param {string} search 
     * @param {{notFound: any, overMax: any}} opt
     * @returns 
     */
    get(search, opt = { notFound: null, overMax: null }) {
        const s = search
        const g = this.cache.get(s)
        if (g) {
            if (g.c > this.maxCache) {
                this.cache.delete(s)
                return opt.overMax
            }
            this.cache.set(s, { value: g.value, c: g.c + 1 })
            return g.value
        }
        return opt.notFound
    }
    /**
     * 
     * @param {string} key 
     * @param {*} value
     * @param {*} c Used Time
     * @returns {boolean} Indicates reaching maxCacheNumber or not
     */
    set(key, value, c = 1) {
        if (yt_validate(key) === false) {
            console.log(false)
            return false
        }
        let r = true
        // auto deletion after reaching maxCacheNumber
        if (this.cache.size > this.maxCacheNumber) {
            this.cache.clear()
            this.urlCache.clear()
            r = false
        }
        this.cache.set(key, { value, c })
        this.urlCache.set(value.url, { value, c })
        return r
    }

    /**
     * 
     * @param {string} search 
     * @param {{notFound: any, overMax: any}} opt
     * @returns 
     */
    getUrl(search, opt = { notFound: null, overMax: null }) {
        const s = search
        const g = this.urlCache.get(s)
        if (g) {
            if (g.c > this.maxCache) {
                this.urlCache.delete(s)
                return opt.overMax
            }
            this.urlCache.set(s, { value: g.value, c: g.c + 1 })
            return g.value
        }
        return opt.notFound
    }
}

module.exports = { SearchCache }