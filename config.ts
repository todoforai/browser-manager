import type { ServerConfig } from './types.js';

export function getConfig(): ServerConfig {
    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    return {
        port:      parseInt(process.env.BROWSER_MANAGER_PORT       || '8086'),
        adminPort: parseInt(process.env.BROWSER_MANAGER_ADMIN_PORT || '8085'),
        host: '0.0.0.0',
        cors: {
            origins: isDev
                ? ['http://localhost:3000', 'http://localhost:8085', 'http://localhost:8086']
                : ['https://todofor.ai', 'https://browser.todofor.ai'],
        },
    };
}
