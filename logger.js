class Logger {
    constructor(debug) {
      this.debug = debug;
      this.buffer = [];
    }

    log(m) {
      var logObj;
      var ts = new Date();
      if (typeof m === "string") {
        logObj = { timestamp: ts, msg: m };
      } else {
        m.timestamp = ts;
        logObj = m;
      }

      this.buffer.push(logObj)

      if (this.debug === true) {
        if (typeof m === "string") {
          console.log(m);
        } else {
          console.log(JSON.stringify(m, null, 2));
        }
      }
    }

    getLog() {
      return this.buffer;
    }
}
module.exports = Logger;
