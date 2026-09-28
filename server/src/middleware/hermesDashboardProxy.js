import http from 'node:http';
// Reverse proxy for the Hermes dashboard. Blitz exposes only port 8080, so the
// dashboard (internal 9119) is published on the existing origin at /hermes-dashboard.
// Hermes supports this natively: it reads X-Forwarded-Prefix to inject
// window.__HERMES_BASE_PATH__, rewrite the absolute /assets|/fonts|/favicon.ico URLs
// baked into the Vite build, and scope its session cookies to the prefix
// (hermes_cli/dashboard_auth/prefix.py, web_server_dashboard.py:140-190).
// Authentication stays Hermes' own: the Authorization header and cookies are
// forwarded untouched, so HERMES_DASHBOARD_BASIC_AUTH_* keeps gating every request.
// This adds no auth of its own and bypasses nothing.
export const HERMES_DASHBOARD_PREFIX='/hermes-dashboard';
// Same opt-in flag the container supervisor uses, so the process and the route
// always agree: enabled in one place means available in the other.
const ENABLED=/^(true|1|yes)$/i.test(String(process.env.HERMES_DASHBOARD??'').trim());
const UPSTREAM_HOST='127.0.0.1';
const UPSTREAM_PORT=Number(process.env.HERMES_DASHBOARD_PORT||9119);
// Hop-by-hop headers are connection-scoped and must not be forwarded (RFC 9110 7.6.1).
const HOP_BY_HOP=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const pathOf=(url)=>{const i=url.indexOf('?');return i<0?url:url.slice(0,i)};
// Segment-aware so /hermes-dashboardfoo is not treated as the dashboard.
const underPrefix=(url)=>url===HERMES_DASHBOARD_PREFIX||url.startsWith(HERMES_DASHBOARD_PREFIX+'/')||url.startsWith(HERMES_DASHBOARD_PREFIX+'?');
// Express strips the mount path for app.use but the raw upgrade event does not,
// so the prefix is removed defensively in both paths.
const toUpstreamPath=(url)=>{const p=pathOf(url);const q=url.slice(p.length);const out=(underPrefix(p)?p.slice(HERMES_DASHBOARD_PREFIX.length):p)||'/';return out+q};
const forwarded=(req)=>{const h=req.headers||{};return {'x-forwarded-prefix':HERMES_DASHBOARD_PREFIX,'x-forwarded-host':h.host||'','x-forwarded-proto':String(req.protocol||h['x-forwarded-proto']||'https'),'x-forwarded-for':String(req.ip||req.socket?.remoteAddress||'')}};
// WS upgrade: the dashboard SPA talks to /api/ws and /api/pty, so the SPA is only
// fully functional (live updates, terminal) when upgrades are proxied too.
const rawResponse=(res)=>`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${Object.entries(res.headers).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', '):v}\r\n`).join('')}\r\n`;
export function hermesDashboardProxy(req,res,next){if(!ENABLED)return next();const headers={...req.headers,...forwarded(req)};for(const name of Object.keys(headers))if(HOP_BY_HOP.has(name.toLowerCase()))delete headers[name];const upstream=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,method:req.method,path:toUpstreamPath(req.url),headers},proxied=>{const out={...proxied.headers};const loc=out.location;if(loc&&loc.startsWith('/')&&!loc.startsWith('//')&&!underPrefix(pathOf(loc)))out.location=HERMES_DASHBOARD_PREFIX+(loc==='/'?'':loc);/* Safety net: keep root-relative redirects inside the prefix. Hermes already builds prefixed Locations from X-Forwarded-Prefix, so never double-prefix. */res.removeHeader('content-security-policy');/* helmet 8 defaults to script-src 'self' with no 'unsafe-inline', which would block the inline bootstrap <script> Hermes injects into index.html. Dropped for dashboard responses only; every other helmet header still applies. */res.writeHead(proxied.statusCode||502,out);proxied.pipe(res)});upstream.on('error',err=>{console.error(`Hermes dashboard proxy error: ${err.code||err.message}`);if(res.headersSent){res.destroy();return}res.status(502).json({error:{message:'Hermes dashboard is unavailable.'}})});res.on('close',()=>{if(!res.writableEnded)upstream.destroy()});req.pipe(upstream)}
export function attachHermesDashboardProxy(server){if(!ENABLED)return;server.on('upgrade',(req,socket,head)=>{if(!underPrefix(pathOf(req.url||''))){socket.destroy();return}const headers={...req.headers,...forwarded(req),host:`${UPSTREAM_HOST}:${UPSTREAM_PORT}`};const upstream=http.request({host:UPSTREAM_HOST,port:UPSTREAM_PORT,method:'GET',path:toUpstreamPath(req.url),headers});upstream.on('upgrade',(proxied,upSocket,upHead)=>{socket.write(rawResponse(proxied));if(upHead&&upHead.length)upSocket.unshift(upHead);if(head&&head.length)upSocket.unshift(head);upSocket.on('error',()=>socket.destroy());socket.on('error',()=>upSocket.destroy());upSocket.pipe(socket).pipe(upSocket)});upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.end()})}
