// Mocha `--require` hook: serves vscode_stub.js for `require("vscode")` so
// the extension's modules can load outside VS Code.
const Module = require("module");
const stub = require("./vscode_stub");

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return stub;
  }
  return originalLoad.call(this, request, ...rest);
};
