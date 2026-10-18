const legacy = require("./legacy.cjs");
module.exports = function display(value) { return legacy.format(value); };
