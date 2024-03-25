const { yt_validate, YouTubeVideo, search } = require('play-dl')

class SearchCache {
    cache
    urlCache
    maxCache
    maxCacheNumber
    /**
     * @type {{id: NodeJS.Timeout, query: string, url: string, ttl: number}[]}
     */
    interval

    constructor(opt = { maxCache: 20, maxCacheNumber: 20000 }) {
        this.cache = new Map()
        this.urlCache = new Map()
        this.maxCache = opt.maxCache
        this.maxCacheNumber = opt.maxCacheNumber
        this.interval = []
    }
    /**
     * 
     * @param {string} search 
     * @param {{notFound: any, overMax: any}} opt
     * @returns {YouTubeVideo}
     */
    get(search, opt = { notFound: null, overMax: null }) {
        const query = search.trim()
        const returnedQuery = this.cache.get(query)
        if (returnedQuery) {
            if (returnedQuery.c > this.maxCache) {
                this.cache.delete(query)
                const index = this.interval.findIndex(v => v.query === query)
                if (index >= 0) {
                    clearInterval(this.interval[index].id)
                    this.interval.splice(index, 1)
                }
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
     * @param {YouTubeVideo} value
     * @param {number} cachedTime Used Time
     * @param {number} ttl Time to revalidate the cache (ms)
     * @returns {boolean} Indicates reaching maxCacheNumber or not
     */
    set(key, value, cachedTime = 1, ttl = 2000) {
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

        this.interval.push({
            id: setInterval(async () => {
                const video = await search(key)
                this.cache.set(key, { value: video, c: 0 })
                this.urlCache.delete(value.url)
                this.urlCache.set(video.url, { value: video, c: 0 })
            }),
            query: key,
            url: value.url,
            ttl
        }, ttl)

        return returnValue
    }

    /**
     * 
     * @param {string} url 
     * @param {{notFound: any, overMax: any}} opt
     * @returns {typeof opt.notFound | typeof opt.overMax | string}
     */
    getUrl(url, opt = { notFound: null, overMax: null }) {
        const query = url.trim()
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

    close() {
        this.interval.forEach(clearInterval)
    }
}

module.exports = { SearchCache }