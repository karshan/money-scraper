const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer');
const util = require('./util');

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36";
const DOWNLOAD_DIR = './downloads/';

// login page
const LOGIN_IFRAME_NAME = "logonbox"
const SIGN_IN_BUTTON_SEL = "#signin-button"
const USERNAME_SEL = "#userId-input-field"
const PASSWORD_SEL = "#password-input-field"

// URL regex used with waitForUrlRegex()
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/card/list
const ACTIVITY_CARD_LIST_REGEX = new RegExp("/account/activity/card/list$");

// LoginPage Url
// Navigating here will open the dashboard if already logged in.
const LOGIN_PAGE_URL = 'https://secure05c.chase.com/web/auth/dashboard';

async function login(page, creds, logger) {
  await page.goto(LOGIN_PAGE_URL);

  // TODO Detect if we are already logged in. Could use page.title() probably
  await page.waitForSelector('#' + LOGIN_IFRAME_NAME);

  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);

  await util.frameWaitAndClick(logonbox, USERNAME_SEL);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(creds.password);

  await util.frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);

  await util.waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX, logger);
}

async function performRequests(page, logger) {
  const cookies = await page.cookies();

  logger.log("/tiles/list START");
  const accountTilesRaw = await new Promise(function(resolve, reject) {
    const body = "cache=1"; // This is required. (probably just a non empty body is required
    var response = "";
    const req = https.request({
      hostname: 'secure05c.chase.com',
      port: 443,
      path: '/svc/rr/accounts/secure/v4/dashboard/tiles/list',
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
        'Cookie': cookies.map((a) => a.name + '=' + a.value).join('; ') ,
        'x-jpmc-csrf-token': 'NONE'
      }
    }, function(res) {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { response = response + chunk });
      res.on('end', () => resolve(response));
    });
    req.on('error', (e) => reject("/tiles/list failed with: " + e.toString()))
    req.write(body);
  });
  logger.log({accountTilesRaw: accountTilesRaw});

  const accountTiles = JSON.parse(accountTilesRaw).accountTiles;

  for (var i = 0; i < accountTiles.length; i++) {
    logger.log(`/card/list[${i}] START`);

    jsonTransactions = await new Promise(function(resolve, reject) {
      const body = `accountId=${accountTiles[i].accountId}&filterTranType=ALL&statementPeriodId=ALL`;
      var response = "";
      const req = https.request({
        hostname: 'secure05c.chase.com',
        port: 443,
        path: '/svc/rr/accounts/secure/v1/account/activity/card/list',
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json',
          'Cookie': cookies.map((a) => a.name + '=' + a.value).join('; ') ,
          'x-jpmc-csrf-token': 'NONE'
        }
      }, function(res) {
        res.setEncoding('utf8');
        res.on('data', (chunk) => { response = response + chunk });
        res.on('end', () => resolve(response));
      });
      req.on('error', (e) => reject(`/card/list[${i}] failed with: ` + e.toString()))
      req.write(body);
    });
    logger.log(`/card/list[${i}] END`);
    logger.log({jsonTransactions: jsonTransactions});
    accountTiles[i].transactions = JSON.parse(jsonTransactions);
  }
  return accountTiles;
}

async function scrape(creds) {
  var logger = new Logger(false);

  if (typeof creds.username !== "string" || typeof creds.password !== "string") {
    return { ok: false, error: 'bad creds' };
  }

  /*
   * TODO: is a fixed userDataDir safe for concurrent use ?
   * removing the userDataDir option will make it so a temporary profile
   * dir is used instead which is deleted on browser.close(). This means
   * cookies and browser cache will not be saved.
   */
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: "chrome-profile"
  });
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  await page.setViewport({ width: 800, height: 600 });

  try {
    await login(page, creds, logger);

    const accountTiles = await performRequests(page, logger);

    return {
      ok: true,
      accountTiles: accountTiles,
      log: logger.getLog()
    };
  } catch(e) {
    var screenshot, domscreenshot;
    try {
      screenshot = (await page.screenshot()).toString('base64');
      domscreenshot = await page.evaluate(() => document.querySelector("body").innerHTML);
    } catch(e) {
    } finally {
      logger.log({
        msg: `SCRAPER FAILURE`,
        exception: (e.toString() === "[object Object]") ? JSON.stringify(e) : e.toString(),
        screenshot: screenshot,
        domscreenshot: domscreenshot
      });

      return { ok: false, error: 'see log', log: logger.getLog() };
    }
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrape: scrape
}
