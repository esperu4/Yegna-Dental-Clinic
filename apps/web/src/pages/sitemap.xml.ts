/** `sitemap.xml` (PRD §15): every page in both languages, with its hreflang alternates. */
import type { APIRoute } from 'astro';
import { LOCALES, PAGES, pathOf } from '../lib/site';

export const GET: APIRoute = ({ site }) => {
  const url = (path: string) => new URL(path, site).href;
  const entries = PAGES.flatMap((page) =>
    LOCALES.map(
      (locale) => `  <url>
    <loc>${url(pathOf(locale, page))}</loc>
${LOCALES.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${url(pathOf(l, page))}"/>`).join('\n')}
    <xhtml:link rel="alternate" hreflang="x-default" href="${url(pathOf('am', page))}"/>
  </url>`,
    ),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
