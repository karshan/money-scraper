const chaseScraper = require('./chase-scraper');

var p = chaseScraper.scrape(require('./creds'));
p.then((r) => {
  if (r.ok) {
    console.log(JSON.stringify(r.downloadedFiles, null, 2));
  } else {
    console.log(JSON.stringify(r, null, 2));
  }
});
