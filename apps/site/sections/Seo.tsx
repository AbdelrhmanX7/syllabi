import Head from 'next/head';

const SITE = 'https://syllabi.studio';
const IMAGE = `${SITE}/shots/today.png`;

/** One page's search + link-preview tags: title, description, canonical URL, Open Graph and Twitter. */
export function Seo({
  title,
  description,
  path,
  image = IMAGE,
  noindex = false,
}: {
  title: string;
  description: string;
  /** Path with trailing slash, e.g. `/download/`; `/` for home. */
  path: string;
  image?: string;
  noindex?: boolean;
}) {
  const url = `${SITE}${path}`;

  return (
    <Head>
      <title>{title}</title>
      <meta content={description} name='description' />
      <meta content='width=device-width, initial-scale=1' name='viewport' />
      <link href={url} rel='canonical' />
      {noindex && <meta content='noindex' name='robots' />}
      <meta content='website' property='og:type' />
      <meta content='Syllabi' property='og:site_name' />
      <meta content={url} property='og:url' />
      <meta content={title} property='og:title' />
      <meta content={description} property='og:description' />
      <meta content={image} property='og:image' />
      <meta content='Syllabi Today screen with sample classes' property='og:image:alt' />
      <meta content='summary_large_image' name='twitter:card' />
      <meta content={title} name='twitter:title' />
      <meta content={description} name='twitter:description' />
      <meta content={image} name='twitter:image' />
    </Head>
  );
}
