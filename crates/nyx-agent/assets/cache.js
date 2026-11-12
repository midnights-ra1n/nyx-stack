// Preloaded (NODE_OPTIONS --require) into a site when CACHE_MAX_AGE is set, so that browsers,
// CDNs and proxies fetch the page again after a deploy. 0 = always revalidate (ETag: 304 when unchanged).
const age = parseInt(process.env.CACHE_MAX_AGE, 10);
if (age >= 0) {
    const proto = require('http').ServerResponse.prototype;
    const writeHead = proto.writeHead;
    proto.writeHead = function (status, ...rest) {
        const cur = String(this.getHeader('cache-control') || '');
        // Hashed files (immutable) and private or no-store answers keep their header.
        if (status >= 200 && status < 400 && !/immutable|no-store|private/i.test(cur)) {
            this.setHeader('Cache-Control', age ? `public, max-age=${age}` : 'no-cache');
        }
        return writeHead.call(this, status, ...rest);
    };
}
