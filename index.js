const bodyParser = require('body-parser');
const chaseScraper = require('./chase-scraper');
const express = require('express');
const app = express();

const SOCKET = "scraper.sock";

app.use(bodyParser.json());

app.post('/chase', (req, res) => {
  chaseScraper.scrape(req.body).then((result) => {
    res.send(result);
  });
});

app.listen(8000, () => console.log(`money-scraper listening on ${SOCKET}`))
