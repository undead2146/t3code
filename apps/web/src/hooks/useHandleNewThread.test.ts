import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let activeRouteTarget: { readonly kind: "draft"; readonly draftId: string } | null = null;
  let activeDraftSession: Record<string, unknown> | null = null;
  let threadShell: Record<string, unknown> | null = null;
  const markPromotedDraftThreadByRef = vi.fn();
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => activeDraftSession),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    markPromotedDraftThreadByRef,
    get activeRouteTarget() {
      return activeRouteTarget;
    },
    set activeRouteTarget(value: typeof activeRouteTarget) {
      activeRouteTarget = value;
    },
    get activeDraftSession() {
      return activeDraftSession;
    },
    set activeDraftSession(value: typeof activeDraftSession) {
      activeDraftSession = value;
    },
    get threadShell() {
      return threadShell;
    },
    set threadShell(value: typeof threadShell) {
      threadShell = value;
    },
    get projectFileRead() {
      return projectFileRead;
    },
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      activeRouteTarget = null;
      activeDraftSession = null;
      threadShell = null;
      router.state.location.href = "/";
      router.navigate.mockClear();
      markPromotedDraftThreadByRef.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({ DEFAULT_RUNTIME_MODE: "default" }));
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: (...args: unknown[]) =>
      testState.markPromotedDraftThreadByRef(...args),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => testState.threadShell,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: {} }));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.activeRouteTarget,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it("mints a fresh draft when the current route draft thread already exists on the server", async () => {
    const existingDraft = {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      projectId: "project-remote",
      logicalProjectKey: "remote-project",
      promotedTo: null,
      threadId: "thread-existing",
      createdAt: "2026-03-29T00:00:00.000Z",
      runtimeMode: "default",
      interactionMode: "default",
    };
    testState.reset(null);
    testState.activeRouteTarget = { kind: "draft", draftId: "draft-existing" };
    testState.activeDraftSession = existingDraft;
    testState.threadShell = {
      environmentId: "environment-ssh",
      id: "thread-existing",
      title: "Existing",
    } as never;

    const openThread = useNewThreadHandler();
    testState.completeProjectFileRead(null);
    const result = await openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.markPromotedDraftThreadByRef).toHaveBeenCalledWith({
      environmentId: "environment-ssh",
      threadId: "thread-existing",
    });
    expect(result).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: "draft-delayed" },
      replace: false,
    });
  });
});
