import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { runCliAgent } from "../../agents/cli-runner.runtime.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTalkClientAgentRuntime } from "./client-agent-runtime.js";

const embedded = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
const cli = vi.hoisted(() => vi.fn<typeof runCliAgent>());
// mock-isolation: Assert the selected execution route without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: embedded }));
vi.mock("../../agents/cli-runner.runtime.js", () => ({ runCliAgent: cli }));
// mock-isolation: Register claude-cli without loading the Anthropic plugin.
vi.mock("../../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: () => [{ id: "claude-cli" }],
}));
vi.mock("../../agents/model-runtime-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-runtime-aliases.js")>()),
  resolveCliRuntimeExecutionProvider: (params: {
    cfg?: OpenClawConfig;
    provider: string;
    modelId?: string;
  }) =>
    params.cfg?.agents?.defaults?.models?.[`${params.provider}/${params.modelId}`]?.agentRuntime
      ?.id,
}));
vi.mock("../../agents/cli-execution-auth.js", () => ({
  cliBackendAcceptsAuthProfileForwarding: () => false,
  resolveCliExecutionAuthProfileId: vi.fn(),
}));
// mock-isolation: Placement serialization is covered by its own suite.
vi.mock("../../agents/session-placement-admission.js", () => ({
  withLocalSessionPlacementTurnSettlement: async (
    _claim: unknown,
    task: (assertCurrent: () => void) => Promise<unknown>,
  ) => await task(() => {}),
}));

const result = { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
let state: OpenClawTestState;
let workspace: string;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-cli-route" });
  workspace = state.workspaceDir;
});
afterEach(() => {
  embedded.mockReset();
  cli.mockReset();
});
afterAll(async () => state?.cleanup());

function configFor(model: string, runtime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model,
        models: runtime ? { [model]: { agentRuntime: { id: runtime } } } : {},
      },
    },
  };
}

async function consult(config: OpenClawConfig, authority: { toolsAllow?: string[] } = {}) {
  const sessionKey = "agent:main:talk-cli-route";
  const runtime = createTalkClientAgentRuntime({ config });
  return await runtime.runEmbeddedAgent({
    runId: `talk-realtime-consult-${Math.random()}`,
    sessionId: "voice-session",
    sessionKey,
    sessionTarget: {
      agentId: "main",
      sessionId: "voice-session",
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    },
    agentId: "main",
    config,
    prompt: "What is on my calendar?",
    workspaceDir: workspace,
    timeoutMs: 1_000,
    senderIsOwner: false,
    ...authority,
  });
}

it("routes a claude-cli-mapped model through the CLI runtime", async () => {
  cli.mockResolvedValue(result);
  await expect(
    consult(configFor("anthropic/claude-opus-5-5", "claude-cli")),
  ).resolves.toMatchObject({ payloads: [{ text: "Answer" }] });
  expect(embedded).not.toHaveBeenCalled();
  expect(cli).toHaveBeenCalledOnce();
  expect(cli.mock.calls[0]?.[0]).toMatchObject({
    provider: "claude-cli",
    modelProvider: "anthropic",
    model: "claude-opus-5-5",
    sessionFile: "agent:main:talk-cli-route",
    disableCliLiveSession: true,
  });
});

it("keeps a model without a CLI runtime on the embedded runner", async () => {
  embedded.mockResolvedValue(result);
  await consult(configFor("openai/gpt-5.6-sol"));
  expect(cli).not.toHaveBeenCalled();
  expect(embedded).toHaveBeenCalledOnce();
});

it("carries restricted Talk tool authority into the CLI run", async () => {
  cli.mockResolvedValue(result);
  await consult(configFor("anthropic/claude-opus-5-5", "claude-cli"), { toolsAllow: ["read"] });
  expect(cli.mock.calls[0]?.[0]).toMatchObject({ toolsAllow: ["read"], senderIsOwner: false });
});
