class SearchCache {
    constructor(opt = { maxCache: 20, maxCacheNumber: 20000 }) {
        this.cache = new Map()
        this.maxCache = opt.maxCache
        this.maxCacheNumber = opt.maxCacheNumber
    }
    /**
     * 
     * @param {string} search 
     * @param {*} notFound 
     * @returns 
     */
    get(search, opt = { notFound: null, overMax: null }) {
        const s = search.trim()
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
     * @returns {boolean} Indicates operation successful or not
     */
    set(key, value, c = 1) {
        let r = true
        // auto deletion after reaching maxCacheNumber
        if (this.cache.size > this.maxCacheNumber) {
            this.cache.clear()
            r = false
        }
        this.cache.set(key.trim(), { value, c })
        return r
    }
}

module.exports = { SearchCache }