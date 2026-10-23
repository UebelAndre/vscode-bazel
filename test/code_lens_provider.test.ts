import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { CodeLensProvider } from "../src/codelens/code_lens_provider";
import {
  CodeLensBuilder,
  CodeLensTarget,
} from "../src/codelens/code_lens_builder";
import { BazelWorkspaceInfo } from "../src/bazel/bazel_workspace_info";
import { BuildFileModel, IndexedTarget } from "../src/index";

describe("CodeLensProvider", () => {
  let sandbox: sinon.SinonSandbox;
  let buildCodeLenses: sinon.SinonStub;
  let logger: {
    logDebug: sinon.SinonStub;
    logInfo: sinon.SinonStub;
    logWarn: sinon.SinonStub;
    logError: sinon.SinonStub;
  };

  const buildFile = "/workspace/path/to/BUILD";

  function createTestDocument(overrides: Partial<vscode.TextDocument> = {}) {
    return {
      isDirty: false,
      version: 1,
      uri: {
        fsPath: buildFile,
        scheme: "file",
        toString: () => `file://${buildFile}`,
      } as vscode.Uri,
      fileName: buildFile,
      lineCount: 10,
      getText: () => 'cc_binary(name = "test")\ncc_test(name = "t")',
      ...overrides,
    } as unknown as vscode.TextDocument;
  }

  function createWorkspaceInfo() {
    return {
      bazelWorkspacePath: "/workspace",
      workspaceFolder: {
        uri: vscode.Uri.file("/workspace"),
        name: "workspace",
        index: 0,
      },
    } as unknown as BazelWorkspaceInfo;
  }

  function position(line: number) {
    return { line, character: 0 };
  }

  function target(name: string, kind: string, line: number): IndexedTarget {
    return {
      label: `//path/to:${name}`,
      name,
      pkg: "path/to",
      kind,
      file: buildFile,
      range: { start: position(line), end: position(line) },
      nameRange: { start: position(line), end: position(line) },
    };
  }

  /** A stand-in for the workspace index holding one package. */
  function fakeManager(targets: IndexedTarget[]) {
    const model: BuildFileModel = {
      file: buildFile,
      pkg: "path/to",
      loads: [],
      targets,
      calls: [],
      errorCount: 0,
    };
    const index = {
      root: "/workspace",
      ready: Promise.resolve(),
      syncDocument: sinon
        .stub()
        .returns({ pkg: "path/to", file: buildFile, model }),
      getTargets: () => targets,
      getPackage: () => ({ pkg: "path/to", file: buildFile, model }),
      getBzlModel: (): undefined => undefined,
    };
    return {
      index,
      manager: {
        getIndexForDocument: () => index,
        labels: {
          schemas: { schemaFor: async (): Promise<undefined> => undefined },
        },
      } as any,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    logger = {
      logDebug: sandbox.stub(),
      logInfo: sandbox.stub(),
      logWarn: sandbox.stub(),
      logError: sandbox.stub(),
    };
    buildCodeLenses = sandbox
      .stub(CodeLensBuilder.prototype, "buildCodeLenses")
      .returns([]);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("provideCodeLenses", () => {
    it("returns empty array when not in a Bazel workspace", async () => {
      sandbox.stub(BazelWorkspaceInfo, "fromDocument").returns(undefined);
      const { manager } = fakeManager([]);
      const provider = new CodeLensProvider(manager, logger);
      const result = await provider.provideCodeLenses(createTestDocument());
      assert.strictEqual(result.length, 0);
      sinon.assert.notCalled(buildCodeLenses);
    });

    it("builds lenses from the indexed targets of the document", async () => {
      const workspaceInfo = createWorkspaceInfo();
      sandbox.stub(BazelWorkspaceInfo, "fromDocument").returns(workspaceInfo);
      const { manager, index } = fakeManager([
        target("test", "cc_binary", 0),
        target("t", "cc_test", 1),
      ]);
      const provider = new CodeLensProvider(manager, logger);
      const document = createTestDocument();

      await provider.provideCodeLenses(document);

      sinon.assert.calledWith(index.syncDocument, document);
      sinon.assert.calledOnce(buildCodeLenses);
      const [info, targets] = buildCodeLenses.firstCall.args as [
        BazelWorkspaceInfo,
        CodeLensTarget[],
      ];
      assert.strictEqual(info, workspaceInfo);
      assert.deepStrictEqual(targets, [
        { label: "//path/to:test", line: 0, isTest: false, isExecutable: true },
        { label: "//path/to:t", line: 1, isTest: true, isExecutable: true },
      ]);
    });

    it("still provides lenses for dirty documents", async () => {
      sandbox
        .stub(BazelWorkspaceInfo, "fromDocument")
        .returns(createWorkspaceInfo());
      const { manager } = fakeManager([target("test", "cc_binary", 0)]);
      const provider = new CodeLensProvider(manager, logger);

      await provider.provideCodeLenses(createTestDocument({ isDirty: true }));

      sinon.assert.calledOnce(buildCodeLenses);
    });
  });

  describe("refresh", () => {
    it("triggers onDidChangeCodeLenses event", (done) => {
      const { manager } = fakeManager([]);
      const provider = new CodeLensProvider(manager, logger);
      provider.onDidChangeCodeLenses(() => {
        done();
      });
      provider.refresh();
    });
  });
});
