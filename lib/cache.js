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
        const query = search.trim()
        const returnedQuery = this.cache.get(query)
        if (returnedQuery) {
            if (returnedQuery.c > this.maxCache) {
                this.cache.delete(query)
                return opt.overMax
            }
            this.cache.set(query, { value: returnedQuery.value, c: returnedQuery.c + 1 })
            return returnedQuery.value
        }
        return opt.notFound
    }
    /**
     * 
     * @param {string} key 
     * @param {*} value
     * @param {*} cachedTime Used Time
     * @returns {boolean} Indicates reaching maxCacheNumber or not
     */
    set(key, value, cachedTime = 1) {
        if (yt_validate(key) === false) {
            return false
        }
        let returnValue = true
        // auto deletion after reaching maxCacheNumber
        if (this.cache.size > this.maxCacheNumber) {
            this.cache.clear()
            this.urlCache.clear()
            returnValue = false
        }
        this.cache.set(key, { value, c: cachedTime })
        this.urlCache.set(value.url, { value, c: cachedTime })
        return returnValue
    }

    /**
     * 
     * @param {string} search 
     * @param {{notFound: any, overMax: any}} opt
     * @returns 
     */
    getUrl(search, opt = { notFound: null, overMax: null }) {
        const query = search
        const returnedQuery = this.urlCache.get(query)
        if (returnedQuery) {
            if (returnedQuery.cachedTime > this.maxCache) {
                this.urlCache.delete(query)
                return opt.overMax
            }
            this.urlCache.set(query, { value: returnedQuery.value, cachedTime: returnedQuery.cachedTime + 1 })
            return returnedQuery.value
        }
        return opt.notFound
    }
}

module.exports = { SearchCache }