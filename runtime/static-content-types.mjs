/**
 * Content types for static files, by extension. Shared by build uploads and
 * platform serving so a file is stored and served under one type.
 *
 * Mirrors src/utils/static-content-types.ts for the standalone local runtime.
 */
const contentTypes = {
    // Web
    'html': 'text/html; charset=utf-8',
    'htm': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'mjs': 'application/javascript; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'csv': 'text/csv; charset=utf-8',
    'tsv': 'text/tab-separated-values; charset=utf-8',
    'xml': 'application/xml; charset=utf-8',

    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'avif': 'image/avif',
    'ico': 'image/x-icon',

    // Fonts
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'otf': 'font/otf',

    // Other
    'txt': 'text/plain; charset=utf-8',
    'md': 'text/markdown; charset=utf-8',
    'pdf': 'application/pdf',
    // Media
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'm4a': 'audio/mp4',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'map': 'application/json',
};

/**
 * Get content type for a file path
 *
 * @param path - File path
 * @returns Content-Type header value
 */
export function getContentType(path) {
    const ext = path.split('.').pop()?.toLowerCase();
    return (ext && contentTypes[ext]) || 'application/octet-stream';
}
