# Site cache behind a reverse proxy

After a deploy, visitors should see the new version without a forced refresh (Ctrl+F5).
That depends on one header, `Cache-Control`, and on nothing between the browser and the
site keeping its own copy. This guide covers the common reverse proxies. For the setting
itself, see [HTTP cache between deploys](manager.md#http-cache-between-deploys).

## The rule

| What | `Cache-Control` | Why |
|---|---|---|
| Pages: HTML, and `index.html` of a single-page app | `no-cache` | The browser asks again on each visit and gets a cheap `304` when nothing changed |
| Hashed files: `/assets/app.3f9c2a1.js`, `/_next/static/…` | `public, max-age=31536000, immutable` | Their name changes with their content, so they can stay forever |

`no-cache` does not mean "never store": the browser keeps the page but checks it first.
`no-store` turns caching off and makes every visit download everything again.

Without any `Cache-Control` header, browsers guess a lifetime from `Last-Modified`, often
a day or more. That is why a page can stay stale on another computer long after a deploy.

## Which case is yours

**The proxy forwards to Node.js** (the usual case with Nyx sites). Set **HTTP cache** to
**Always revalidate** on the site and deploy: the app then sends the right header. The
proxy has only two jobs: not cache the pages itself, and not replace the header. All the
proxies below pass headers through untouched by default, so check only the sections that
mention a cache option.

**The proxy serves the built files itself** (a `dist/` or `build/` folder, no Node.js
process). The Nyx setting cannot help, since no Node.js code answers. Set the headers in
the proxy, as shown in each section.

## Nginx

Forwarding to Node.js needs nothing more than `proxy_pass`. Make sure no `proxy_cache` is
active for the site. If one must stay, skip it for pages:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_cache off;
}
```

Serving files:

```nginx
root /srv/my-site/dist;

location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}

location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache" always;
}
```

`add_header` in a `location` drops every `add_header` inherited from `server`, such as
HSTS. Repeat those lines in each block, or keep them in a file you `include`.

## Nginx Proxy Manager

1. Open **Hosts → Proxy Hosts**, then **Edit** on the site.
2. On the **Details** tab, turn **Cache Assets** off. When on, NPM keeps CSS, JS and
   images in its own cache, and a deploy is invisible until that copy expires.
3. Save, and set **Always revalidate** on the site in Nyx.

To force the header from NPM instead, for an app you cannot change, add this on the
**Advanced** tab:

```nginx
proxy_hide_header Cache-Control;
add_header Cache-Control "no-cache" always;
```

That applies to every answer, hashed files included: fine for a small site, wasteful
for a large one.

## Caddy

`reverse_proxy` does not cache, so forwarding to Node.js needs nothing:

```caddyfile
site.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Serving files:

```caddyfile
site.example.com {
    root * /srv/my-site/dist

    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"
    @pages not path /assets/*
    header @pages Cache-Control "no-cache"

    try_files {path} /index.html
    file_server
}
```

Keep the two matchers exclusive as above. Caddy sorts `header` lines by matcher, so a
bare `header Cache-Control "no-cache"` could run last and overwrite the hashed files.

To replace what the app sends: `reverse_proxy 127.0.0.1:3000 { header_down Cache-Control "no-cache" }`.

## Traefik

Traefik has no response cache by default and passes the app's headers through. Only a
cache plugin, such as Souin, stores pages: exclude HTML from it, or purge it after each
deploy.

To force the header, add a `headers` middleware. With Docker labels:

```yaml
labels:
  - traefik.http.middlewares.no-cache.headers.customresponseheaders.Cache-Control=no-cache
  - traefik.http.routers.my-site.middlewares=no-cache
```

With a file provider:

```yaml
http:
  middlewares:
    no-cache:
      headers:
        customResponseHeaders:
          Cache-Control: "no-cache"
```

The middleware applies to every answer of the router. To leave hashed files alone, add a
second router for `PathPrefix(`/assets`)` without it.

## Zoraxy

Zoraxy forwards answers as the app sends them and keeps no copy of pages. Setting
**Always revalidate** in Nyx is enough.

To force the header from Zoraxy, open the proxy rule under **HTTP Proxy**, then its custom
headers, and add `Cache-Control: no-cache` on the response sent to the client
(downstream), not on the request sent to the app (upstream).

## Pangolin

Pangolin is built on Traefik and passes headers through without caching, so **Always
revalidate** in Nyx is enough. If Cloudflare sits in front of Pangolin, see
[CDNs](#cdns-cloudflare).

## NetBird

NetBird connects machines over WireGuard and does not read or change HTTP traffic, so it
cannot cause a stale page. If you publish the site through a proxy on top of NetBird, see
that proxy's section.

## CDNs (Cloudflare…)

By default Cloudflare caches static files by extension (`.js`, `.css`, images), not HTML.
A **Cache Everything** rule caches pages too, and then the browser header no longer
decides: purge the cache after each deploy (**Caching → Configuration → Purge Cache**), or
add a rule that bypasses the cache for HTML. A **Browser Cache TTL** setting other than
**Respect Existing Headers** also replaces the header Nyx sets.

## Check it

```sh
curl -sI https://site.example.com/ | grep -iE 'cache-control|age|x-cache|cf-cache-status'
```

- `cache-control: no-cache` on the page: right.
- No `cache-control` line: the setting is not applied. Deploy the site again, then check
  that the proxy does not remove the header.
- `age: <seconds>`, `x-cache: HIT` or `cf-cache-status: HIT` on the page: something in
  between keeps a copy. Find which proxy adds that header and turn its cache off for pages.

A browser that kept the old page before the change still has it until it expires: force
one last refresh on it. After that, a deploy shows up on the next visit.
