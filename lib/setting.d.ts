export type LogFile = 'errim' | 'error' | 'errwn' | 'express' | 'main' | 'message'

export interface Setting {
    TOKEN: string,
    CLIENT_ID: string,
    
    TEST_CLIENT_ID: string,
    TESTING_TOKEN: string,
    
    OAUTH_TOKEN: string,
    AUTH_TOKEN: string,
    
    QUEUE_SIZE: number,
    HTTPS: boolean,
    PORT: number,
    RATE_LIMIT: number,
    REDIRECT_URI: string,
    WEBSITE?: null | string,
    
    PRELOAD: LogFile[],
    DETAIL_LOGGING: boolean,
    USE_YOUTUBE_DL: boolean,
    PREFIX: string
}
