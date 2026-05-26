import type { ServerConfig } from './types.js';

export function getConfig(): ServerConfig {
    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    return {
        port:      parseInt(process.env.BROWSER_MANAGER_PORT       || '8600'),
        adminPort: parseInt(process.env.BROWSER_MANAGER_ADMIN_PORT || '8610'),
        cdpPort:   parseInt(process.env.BROWSER_MANAGER_CDP_PORT   || '8620'),
        noisePort: parseInt(process.env.BROWSER_MANAGER_NOISE_PORT || '8630'),
        adminKey:  process.env.BROWSER_MANAGER_ADMIN_KEY?.trim() || '',
        host: '0.0.0.0',
        cors: {
            origins: isDev
                ? ['http://localhost:3000', 'http://localhost:8600', 'http://localhost:8620']
                : ['https://todofor.ai', 'https://browser.todofor.ai'],
        },
    };
}
