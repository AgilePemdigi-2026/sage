const { normalize: clean } = require("./legacy.cjs");
function render(input) {
  return clean(input);
}
module.exports = { render };
