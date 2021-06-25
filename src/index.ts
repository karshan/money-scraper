import bodyParser from 'body-parser';
import chaseScraper from './chase-scraper';
import bofaScraper from './bofa-scraper';
import wfScraper from './wf-scraper';
import amexScraper from './amex-scraper';
import express from 'express';
import fetch from 'node-fetch';

const app = express();

const SOCKET = "scraper.sock";

// TODO ensure webhookURL is localhost ?
const postToWebhook = webhookURL => result => {
  const config = {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify(result)
  }
  console.log("done");
  return fetch(webhookURL, config)
}

app.use(bodyParser.json());

app.post('/chase', async (req, res) => {
  console.log("scraping chase");
  chaseScraper
    .scrape(req.body.creds)
    .then(postToWebhook(req.body.webhookURL))
    .then(res => res.json())
    .catch(err => console.log(err))
  res.send(`It's happening Chase`);
});

app.post('/bofa', async (req, res) => {
  console.log("scraping bofa");
  bofaScraper
    .scrape(req.body.creds)
    .then(postToWebhook(req.body.webhookURL))
    .then(res => res.json())
    .catch(err => console.log(err))
  res.send(`It's happening BofA`);
});

app.post('/wf', async (req, res) => {
  console.log("scraping wf");
  wfScraper
    .scrape(req.body.creds)
    .then(postToWebhook(req.body.webhookURL))
    .then(res => res.json())
    .catch(err => console.log(err))
  res.send(`It's happening WF`);
});

app.post('/amex', async (req, res) => {
  console.log("scraping amex");
  amexScraper
    .scrape(req.body.creds)
    .then(postToWebhook(req.body.webhookURL))
    .then(res => res.json())
    .catch(err => console.log(err))
  res.send(`It's happening Amex`);
});

// Test webhook endpoint.
app.post('/result', async (req, res) => {
  console.log(req.body)
  return res.send({})
});

app.listen(3200, '127.0.0.1');
