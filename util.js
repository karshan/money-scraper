const fs = require('fs');

// log network requests made by puppeteer
// usage: page.on('response', responseLogger);
async function responseLogger(response) {
  var request = response.request();
  var responseBody = await response.text();
  if (!/\/raw\/$/.test(request.url()) && !/dynaTraceMonitor/.test(request.url())) {
      console.log("======== LOG ========");
      console.log("url: " + request.url());
      console.log("method: " + request.method());
      if (request.postData()) {
        console.log("request-length: " + request.postData().length);
        console.log("postData: " + request.postData().substring(0, 1000));
      }
      console.log("response-length: " + responseBody.length);
      console.log("response: " + responseBody.substring(0, 1000));
      console.log("----------8<---------");
  }
}

// wait for an element identified by a CSS selector (sel) in an iframe (frame)
// to appear and then click it. frame: puppeteer.Frame
async function frameWaitAndClick(frame, sel) {
  try {
    await frame.waitForSelector(sel, {visible: true});
    const toClick = await frame.$(sel);
    await toClick.click();
  } catch(e) {
    throw {
      msg: `frameWaitAndClick(${sel}) FAILED`,
      exception: e
    };
  }
}

// wait for an element identified by a CSS selector (sel) in a puppeteer page
// to appear and then click it.
async function waitAndClick(page, sel, logger) {
  try {
    logger.log(`waitAndClick(${sel}) START`);
    await page.waitForSelector(sel, {visible: true});
    await page.click(sel);
    logger.log(`waitAndClick(${sel}) END`);
  } catch(e) {
    throw {
      msg: `waitAndClick(${sel}) FAILED`,
      exception: e
    };
  }
}

function promiseTimeout(ms, promise){
  // Create a promise that rejects in <ms> milliseconds
  let id;
  let timeout = new Promise((resolve, reject) => {
    id = setTimeout(() => {
      const msg = 'Timed out in '+ ms + 'ms.';
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

function waitForResponse(page, predicate, logger) {
  return promiseTimeout(15000, new Promise(function(resolve, reject) {
    var responseHandler = function(response) {
      if (predicate(response.request(), response)) {
        page.removeListener('response', responseHandler);
        logger.log(`waitForResponse(url: ${response.request().url()}) END`);
        resolve();
      }
    }
    page.on('response', responseHandler);
  }), true);
}

function waitForUrlRegex(page, urlRegex, logger) {
  logger.log(`waitForUrlRegex(${urlRegex}) START`);
  return waitForResponse(page, (req, resp) => urlRegex.test(req.url()), logger).catch((e) => {
    logger.log(`waitForUrlRegex(${urlRegex}) TIMEOUT`);
    return e;
  });
}

function waitForFileCreation(dir, fileRegex, logger) {
  logger.log(`waitForFileCreation(${dir}, ${fileRegex}) START`);
  return promiseTimeout(15000, new Promise(function(resolve, reject) {
    const watcher = fs.watch(dir, (eventType, filename) => {
      if (eventType == "change" && fileRegex.test(filename)) {
        watcher.close();
        logger.log(`waitForFileCreation(filename: ${filename}) END`);
        resolve(filename);
      }
    });
  }));
}

module.exports = {
  responseLogger: responseLogger,
  frameWaitAndClick: frameWaitAndClick,
  waitAndClick: waitAndClick,
  promiseTimeout: promiseTimeout,
  waitForResponse: waitForResponse,
  waitForUrlRegex: waitForUrlRegex,
  waitForFileCreation: waitForFileCreation,
}
