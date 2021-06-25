import fs from 'fs'
import type { Frame, Page, HTTPResponse, HTTPRequest } from 'puppeteer';
import Logger from './logger';

// log network requests made by puppeteer
// usage: page.on('response', responseLogger);
function responseLogger(urlWhiteRegex: RegExp, urlBlackRegex: RegExp, logger: Logger) {
  return async function (response: HTTPResponse) {
    var request = response.request();
    var responseBody: Buffer, resp: string;
    if (urlWhiteRegex.test(request.url()) && !urlBlackRegex.test(request.url())) {

      try {
        responseBody = await response.buffer();
      } catch (e) {
      }

      var postData = null;

      if (request.postData()) {
        postData = {
          len: request.postData().length,
          data: request.postData().substring(0, 1000)
        };
      }

      if (responseBody) {
        resp = responseBody.toString('ascii').substring(0, 1000)
      }

      logger.log({
        url: request.url(),
        method: request.method(),
        truncatedResponse: resp,
        responseHeaders: response.headers(),
        postData
      });
    }
  }
}

// wait for an element identified by a CSS selector (sel) in an iframe (frame)
// to appear and then click it. frame: puppeteer.Frame
async function frameWaitAndClick(frame: Frame, sel: string) {
  try {
    await frame.waitForSelector(sel, { visible: true });
    const toClick = await frame.$(sel);
    await toClick.click();
  } catch (e) {
    throw {
      msg: `frameWaitAndClick(${sel}) FAILED`,
      exception: e.toString()
    };
  }
}

// wait for an element identified by a CSS selector (sel) in a puppeteer page
// to appear and then click it.
async function waitAndClick(page: Page, sel: string, logger: Logger) {
  try {
    logger.log(`waitAndClick(${sel}) START`);
    await page.waitForSelector(sel, { visible: true });
    await page.click(sel);
    logger.log(`waitAndClick(${sel}) END`);
  } catch (e) {
    throw {
      msg: `waitAndClick(${sel}) FAILED`,
      exception: e.toString()
    };
  }
}

function promiseTimeout(ms: number, promise: Promise<any>) {
  // Create a promise that rejects in <ms> milliseconds
  let id: NodeJS.Timeout;
  let timeout = new Promise((_, reject) => {
    id = setTimeout(() => {
      const msg = 'Timed out in ' + ms + 'ms.';
      reject(msg);
    }, ms)
  })

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout
  ]).then((result) => {
    clearTimeout(id);
    return result;
  })
}

function waitForResponse(page: Page, predicate:(a: HTTPRequest, b: HTTPResponse) => boolean, logger: Logger) {
  return promiseTimeout(30000, new Promise(function (resolve, _) {
    var responseHandler = function (response: HTTPResponse) {
      if (predicate(response.request(), response)) {
        page.off('response', responseHandler);
        logger.log(`waitForResponse(url: ${response.request().url()}) END`);
        resolve(response);
      }
    }
    page.on('response', responseHandler);
  }).then((response: { buffer: Function }) => response.buffer()));
}

function waitForUrlRegex(page: Page, urlRegex: RegExp, logger: Logger) {
  logger.log(`waitForUrlRegex(${urlRegex}) START`);
  return waitForResponse(page, (req, _) => urlRegex.test(req.url()), logger).catch((e) => {
    logger.log(`waitForUrlRegex(${urlRegex}) TIMEOUT`);
    throw e;
  });
}

function waitForFileCreation(dir: fs.PathLike, fileRegex: RegExp, logger: Logger) {
  logger.log(`waitForFileCreation(${dir}, ${fileRegex}) START`);
  return promiseTimeout(15000, new Promise(function (resolve, _) {
    const watcher = fs.watch(dir, (eventType, filename) => {
      if (eventType == "change" && fileRegex.test(filename)) {
        watcher.close();
        logger.log(`waitForFileCreation(filename: ${filename}) END`);
        resolve(filename);
      }
    });
  }));
}

function readFile(filename: fs.PathLike) {
  return new Promise(function (resolve, reject) {
    fs.readFile(filename, (err, data) => {
      if (err) reject(err);
      resolve(data)
    })
  })
}

function unlink(filename: fs.PathLike): Promise<void> {
  return new Promise(function (resolve, reject) {
    fs.unlink(filename, (err) => {
      if (err) reject(err);
      resolve();
    })
  });
}

export default {
  responseLogger: responseLogger,
  frameWaitAndClick: frameWaitAndClick,
  waitAndClick: waitAndClick,
  promiseTimeout: promiseTimeout,
  waitForResponse: waitForResponse,
  waitForUrlRegex: waitForUrlRegex,
  waitForFileCreation: waitForFileCreation,
  readFile: readFile,
  unlink: unlink
}
