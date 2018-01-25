const chaseScraper = require('./chase-scraper');
const http = require('http');

const server = http.createServer((req, res) => {
  // TODO check request path
  // TODO get creds from request
  var p = chaseScraper.scrape(require('./creds'));
  p.then((r) => {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
  });
});

server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(8000);
console.log('listening on 8000');
