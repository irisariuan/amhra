import { type YouTubePlayList, yt_validate, type YouTubeVideo } from 'play-dl'

export interface SearchCacheData<T extends YouTubeVideo | YouTubePlayList> {
    value: T,
    type: T extends YouTubeVideo ? 'video' : 'playlist',
    isVideo: () => this is SearchCacheData<YouTubeVideo>,
    isPlaylist: () => this is SearchCacheData<YouTubePlayList>,
    ttl: number
}

export interface SearchCacheOption {
    maxCache: number
    maxCacheNumber: number
}

export class SearchCache {
    cache: Map<string, SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlayList>>
    urlCache: Map<string, SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlayList>>
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
    set<T extends YouTubeVideo | YouTubePlayList>(key: string, value: T, type: T extends YouTubeVideo ? 'video' : 'playlist', ttl = 3 * 60 * 1000): boolean {
        if (yt_validate(key) === false) {
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
        } as SearchCacheData<YouTubeVideo> | SearchCacheData<YouTubePlayList>
        this.cache.set(key, data)
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
