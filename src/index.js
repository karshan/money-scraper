// @flow
const bodyParser = require('body-parser');
const chaseScraper = require('./chase-scraper');
const bofaScraper = require('./bofa-scraper');
const express = require('express');
const app = express();
const fetch = require('node-fetch');


const SOCKET = "scraper.sock";

const postToWebhook = webhookURL => result => {
  const config = {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify(result)
  }
  return fetch(webhookURL, config)
}

app.use(bodyParser.json());

app.post('/chase', async (req, res) => {
  chaseScraper
  .scrape(req.body.creds)
  .then(postToWebhook(req.body.webhookURL))
  .then(res => res.json())
  .catch(err => console.log(err))
  res.send(`It's happening Chase`);
});

app.post('/bofa', async (req, res) => {
  bofaScraper
  .scrape(req.body.creds)
  .then(postToWebhook(req.body.webhookURL))
  .then(res => res.json())
  .catch(err => console.log(err))
  res.send(`It's happening BofA`);
});

app.listen(8003, '127.0.0.1');
