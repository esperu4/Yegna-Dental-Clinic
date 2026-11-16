/** `robots.txt`: open only where `PUBLIC_INDEXABLE=1` (the real domain); staging stays hidden. */
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const body =
    import.meta.env.PUBLIC_INDEXABLE === '1'
      ? `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap.xml', site).href}\n`
      : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
