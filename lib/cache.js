class SearchCache {
    constructor() {
        this.cache = new Map()
    }
    /**
     * 
     * @param {string} search 
     * @param {*} notFound 
     * @returns 
     */
    get(search, notFound = null) {
        const g = this.cache.get(search.trim())
        if (g) {
            this.cache.set(search.trim(), { value: g.value, c: g.c + 1 })
            return g.value
        }
        return notFound
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