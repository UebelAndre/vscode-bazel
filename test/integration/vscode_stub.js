// A minimal stand-in for the `vscode` module, enough to run the workspace
// index and its resolvers under plain node (outside the extension host).
// Loaded by hook_vscode.js, which redirects `require("vscode")` here.
const fs = require("fs");
const path = require("path");

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  translate(lineDelta, characterDelta) {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath;
    this.scheme = "file";
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  with(change) {
    const uri = new Uri(this.fsPath);
    uri.fragment = change.fragment;
    return uri;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

class RelativePattern {
  constructor(base, pattern) {
    // Accepts a WorkspaceFolder, a Uri, or a path, like the real API.
    this.base = base.uri ? base.uri.fsPath : (base.fsPath ?? base);
    this.pattern = pattern;
  }
}

const noopDisposable = { dispose() {} };
const noopEvent = () => noopDisposable;

/** Configuration defaults mirroring package.json for the settings in use. */
const defaults = {
  "bazel.executable": "bazel",
  "bazel.workspace.path": "",
  "bazel.workspace.pathsToIgnore": [],
  "bazel.commandLine.startupOptions": [],
  "bazel.commandLine.commandArgs": [],
  "bazel.commandLine.queryExpression": "...:*",
  "bazel.commandLine.queriesShareServer": true,
  "bazel.commandLine.queryOutputBase": null,
  "bazel.index.macroTargets": "off",
};
const overrides = new Map();

/** Globs of the form `{a/**,b/**}` to directory prefixes to skip. */
function excludedPrefixes(base, exclude) {
  if (!exclude) {
    return [];
  }
  const inner = /^\{(.*)\}$/.exec(exclude);
  const globs = inner ? inner[1].split(",") : [exclude];
  return globs
    .filter((g) => !g.startsWith("**"))
    .map((g) => path.join(base, g.replace(/\/\*\*$/, "")));
}

function walkBuildFiles(dir, out, excluded) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        excluded.some((p) => full === p || full.startsWith(p + path.sep))
      ) {
        continue;
      }
      walkBuildFiles(full, out, excluded);
    } else if (entry.name === "BUILD" || entry.name === "BUILD.bazel") {
      out.push(full);
    }
  }
}

const workspace = {
  workspaceFolders: [],
  textDocuments: [],
  getWorkspaceFolder(uri) {
    return workspace.workspaceFolders.find(
      (f) =>
        uri.fsPath === f.uri.fsPath ||
        uri.fsPath.startsWith(f.uri.fsPath + path.sep),
    );
  },
  getConfiguration(section) {
    const key = (name) => `${section}.${name}`;
    return {
      get: (name) =>
        overrides.has(key(name))
          ? overrides.get(key(name))
          : defaults[key(name)],
      inspect: (name) => ({
        defaultValue: defaults[key(name)],
        workspaceValue: overrides.get(key(name)),
      }),
    };
  },
  async findFiles(pattern, exclude) {
    const out = [];
    walkBuildFiles(pattern.base, out, excludedPrefixes(pattern.base, exclude));
    return out.map((p) => Uri.file(p));
  },
  createFileSystemWatcher() {
    return {
      onDidCreate: noopEvent,
      onDidChange: noopEvent,
      onDidDelete: noopEvent,
      dispose() {},
    };
  },
  onDidChangeTextDocument: noopEvent,
  onDidCloseTextDocument: noopEvent,
  onDidDeleteFiles: noopEvent,
  onDidRenameFiles: noopEvent,
  onDidOpenTextDocument: noopEvent,
  onDidSaveTextDocument: noopEvent,
  onDidChangeWorkspaceFolders: noopEvent,
  onDidChangeConfiguration: noopEvent,
  async openTextDocument() {
    throw new Error("openTextDocument is not available in the stub");
  },
};

const messages = [];
const window = {
  messages,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: noopEvent,
  async showInformationMessage(message) {
    messages.push({ level: "info", message });
    return undefined;
  },
  async showWarningMessage(message) {
    messages.push({ level: "warning", message });
    return undefined;
  },
  async showErrorMessage(message) {
    messages.push({ level: "error", message });
    return undefined;
  },
  withProgress(_options, task) {
    return task();
  },
  createOutputChannel() {
    const channel = { dispose() {} };
    for (const level of [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "appendLine",
      "show",
    ]) {
      channel[level] = () => {};
    }
    return channel;
  },
};

module.exports = {
  Position,
  Range,
  Uri,
  EventEmitter,
  RelativePattern,
  workspace,
  window,
  commands: { async executeCommand() {} },
  languages: {},
  ProgressLocation: { Notification: 15 },
  LogLevel: { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  /** Test hooks. */
  __stub: {
    setWorkspaceFolders(folders) {
      workspace.workspaceFolders = folders.map((fsPath, index) => ({
        uri: Uri.file(fsPath),
        name: path.basename(fsPath),
        index,
      }));
    },
    setConfig(key, value) {
      overrides.set(key, value);
    },
    clearConfig() {
      overrides.clear();
    },
    messages,
  },
};
