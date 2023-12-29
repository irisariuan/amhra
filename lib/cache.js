class SearchCache {
    constructor(opt = {maxCache: 20}) {
        this.cache = new Map()
        this.maxCache = opt.maxCache
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
        if (g.c > this.maxCache) {
            this.cache.delete(s)
            return opt.overMax
        }
        if (g) {
            this.cache.set(s, { value: g.value, c: g.c + 1 })
            return g.value
        }
        return opt.notFound
    }
    /**
     * 
     * @param {string} key 
     * @param {*} value
     * @param {*} c
     */
    set(key, value, c = 1) {
        this.cache.set(key.trim(), { value, c })
    }
}

module.exports = { SearchCache }