import { type YouTubePlaylist, type YouTubeVideo } from "./youtube";

export interface SearchCacheData<T extends YouTubeVideo | YouTubePlaylist> {
    value: T,
    type: T extends YouTubeVideo ? 'video' : 'playlist',
    isVideo: () => this is SearchCacheData<YouTubeVideo>,
    isPlaylist: () => this is SearchCacheData<YouTubePlaylist>,
    ttl: number
}

export interface SearchCacheOption {
    maxCache: number
    maxCacheNumber: number
}

export class SearchCache {
    cache: Map<string, SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlaylist>>
    urlCache: Map<string, SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlaylist>>
    maxCache: number
    maxCacheNumber: number

    constructor(option: SearchCacheOption = { maxCache: 20, maxCacheNumber: 20000 }) {
        this.cache = new Map()
        this.urlCache = new Map()
        this.maxCache = option.maxCache
        this.maxCacheNumber = option.maxCacheNumber
    }

    get(search: string) {
        const query = search.trim()
        const returnedQuery = this.cache.get(query)
        if (returnedQuery) {
            if (Date.now() > returnedQuery.ttl) {
                this.cache.delete(query)
                return null
            }
            return returnedQuery
        }
        return null
    }
    set<T extends YouTubeVideo | YouTubePlaylist>(key: string, value: T, type: T extends YouTubeVideo ? 'video' : 'playlist', ttl = 3 * 60 * 1000): boolean {
        const query = key.trim()
        if (!query) {
            return false
        }
        // auto deletion after reaching maxCacheNumber
        if (this.cache.size > this.maxCacheNumber) {
            this.cache.clear()
            this.urlCache.clear()
        }
        const data = {
            value,
            ttl: Date.now() + ttl,
            type,
            isVideo: () => type === 'video',
            isPlaylist: () => type === 'playlist'
        } as SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlaylist>
        this.cache.set(query, data)
        if (value.url) {
            this.urlCache.set(value.url, data)
        }
        return true
    }

    getUrl(search: string) {
        const query = search
        const returnedQuery = this.urlCache.get(query)
        if (returnedQuery) {
            if (Date.now() > returnedQuery.ttl) {
                this.urlCache.delete(query)
                return null
            }
            return returnedQuery
        }
        return null
    }
}
