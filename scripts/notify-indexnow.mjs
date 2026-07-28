const host = 'blog.kwl4b.com';
const key = 'e60543352faefacfc1c5b5e6be789ccbdd9a1220e96f1fd2057be9d59a11f003';
const siteURL = `https://${host}`;
const sitemapIndexURL = `${siteURL}/sitemap-index.xml`;

async function fetchXML(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Could not fetch ${url}: ${response.status}`);
	}

	return response.text();
}

function locations(xml) {
	return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

const sitemapIndex = await fetchXML(sitemapIndexURL);
const sitemapURLs = locations(sitemapIndex);
const urlLists = await Promise.all(sitemapURLs.map(async (url) => locations(await fetchXML(url))));
const urlList = urlLists.flat();

const response = await fetch('https://searchadvisor.naver.com/indexnow', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json; charset=utf-8' },
	body: JSON.stringify({
		host,
		key,
		keyLocation: `${siteURL}/${key}.txt`,
		urlList,
	}),
});

if (!response.ok) {
	throw new Error(`IndexNow request failed: ${response.status} ${await response.text()}`);
}

console.log(`IndexNow accepted ${urlList.length} URLs.`);
