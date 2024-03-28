const { yt_validate, YouTubeVideo } = require('play-dl')

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
     * @returns {YouTubeVideo | null}
     */
    get(search) {
        const query = search.trim()
        const returnedQuery = this.cache.get(query)
        if (returnedQuery) {
            if (Date.now() > returnedQuery.ttl) {
                this.cache.delete(query)
                return null
            }
            return returnedQuery.value
        }
        return null
    }
    /**
     * 
     * @param {string} key 
     * @param {YouTubeVideo} value
     * @param {number} ttl Used Time (ms)
     * @returns {boolean} Indicates operation succeed or not
     */
    set(key, value, ttl = 3 * 60 * 1000) {
        if (yt_validate(key) === false) {
            return false
        }
        // auto deletion after reaching maxCacheNumber
        if (this.cache.size > this.maxCacheNumber) {
            this.cache.clear()
            this.urlCache.clear()
        }
        this.cache.set(key, { value, ttl: Date.now() + ttl })
        this.urlCache.set(value.url, { value, ttl: Date.now() + ttl })
        return true
    }

    /**
     * 
     * @param {string} search
     * @returns {string | null}
     */
    getUrl(search) {
        const query = search
        const returnedQuery = this.urlCache.get(query)
        if (returnedQuery) {
            if (Date.now() > returnedQuery.ttl) {
                this.urlCache.delete(query)
                return null
            }
            return returnedQuery.value
        }
        return null
    }
}

module.exports = { SearchCache }