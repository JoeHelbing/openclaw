import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission, cliRunner, cliAuth, runEntry, runtimeResolution, placement] =
    await Promise.all([
      import("../../agents/embedded-agent.js"),
      import("../../agents/admitted-run-context.js"),
      import("../../agents/cli-runner.runtime.js"),
      import("../../agents/cli-execution-auth.js"),
      import("../../agents/embedded-agent-runner/run-entry-runtime.js"),
      import("../../agents/embedded-agent-runner/run/runtime-resolution.js"),
      import("../../agents/session-placement-admission.js"),
    ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    runCliAgent: cliRunner.runCliAgent,
    cliBackendAcceptsAuthProfileForwarding: cliAuth.cliBackendAcceptsAuthProfileForwarding,
    resolveCliExecutionAuthProfileId: cliAuth.resolveCliExecutionAuthProfileId,
    resolveRunEntryCliRuntime: runEntry.resolveRunEntryCliRuntime,
    resolveInitialEmbeddedRunModel: runtimeResolution.resolveInitialEmbeddedRunModel,
    withLocalSessionPlacementTurnSettlement: placement.withLocalSessionPlacementTurnSettlement,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
  };
});

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  rawSourceRef?: string;
  runAuthority?: TalkClientRunAuthority;
  assertCurrent?: () => void;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
}) {
  const agentRuntime = createPluginRuntime().agent;
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (runParams) => {
    runParams.abortSignal?.throwIfAborted();
    const config = runParams.config ?? params.config;
    const { agentId, sessionId, sessionKey, storePath } = runParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    params.assertCurrent?.();
    const retained = await params.runAuthority?.retainRun(runParams.runId);
    try {
      runParams.abortSignal?.throwIfAborted();
      const execution = await loadTalkAgentExecution();
      runParams.abortSignal?.throwIfAborted();
      const operationalRunInstance = execution.createOperationalRunInstanceRef(runParams.runId);
      retained?.assertSourceCurrent();
      params.bindOperationalRunInstance?.(operationalRunInstance);
      const preparedRunAdmission = execution.prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance,
        assertSourceCurrent: retained?.assertSourceCurrent,
        operatorAuthority: retained?.authority,
        facts: {
          runId: runParams.runId,
          agentId,
          ingress: {
            kind: "gateway-client",
            boundary: "talk-agent-consult",
            state: "present",
            ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
          },
        },
      });
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          preparedRunAdmission.close();
        }
      };
      // Abort owns authority revocation independently of core completion; the
      // post-registration check closes the prepare-to-listener race.
      runParams.abortSignal?.addEventListener("abort", close, { once: true });
      try {
        runParams.abortSignal?.throwIfAborted();
        // Provider-owned work can outlive or replace its audio transport. Unlike
        // chat-backed Talk, it has no independent Chat terminal delivery; hiding
        // its final transcript would lose the answer when no spoken replacement arrives.
        // Speech is mirrored separately. Keep generated input in current-turn custody,
        // but never display it or replay it as a later user request.
        const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
          input: {
            text: runParams.prompt,
            display: false,
            excludeFromContext: true,
            idempotencyKey: buildRunUserTurnIdempotencyKey(runParams.runId),
          },
          target: {
            agentId,
            sessionId,
            sessionKey,
            storePath,
            expectedSessionId: sessionId,
            sessionEntry: undefined,
            config,
            cwd: runParams.workspaceDir,
          },
        });
        // Resolve the route the embedded runner would pick; a CLI-runtime model
        // (e.g. agentRuntime claude-cli) must run on its CLI, never the direct API.
        const { provider, modelId } = execution.resolveInitialEmbeddedRunModel({
          config,
          agentId,
          provider: runParams.provider,
          model: runParams.model,
        });
        const { cliExecutionProvider, useCliExecution } = execution.resolveRunEntryCliRuntime({
          config,
          provider,
          model: modelId,
          agentId,
        });
        if (!useCliExecution) {
          return await execution.runEmbeddedAgent({
            ...runParams,
            preparedRunAdmission,
            userTurnTranscriptRecorder,
          });
        }
        const agentDir = runParams.agentDir;
        const authProfileId =
          agentDir &&
          execution.cliBackendAcceptsAuthProfileForwarding({
            provider: cliExecutionProvider,
            config,
            agentId,
          })
            ? await execution.resolveCliExecutionAuthProfileId({
                cliExecutionProvider,
                authProfileProvider: provider,
                config,
                agentDir,
              })
            : undefined;
        // One-shot CLI turn: tool authority (toolsAllow, owner bit, overrides) passes
        // through and the CLI runner fails closed on caps it cannot enforce. The
        // session's own CLI binding is neither resumed nor replaced.
        return await execution.withLocalSessionPlacementTurnSettlement(
          { sessionId, sessionKey, agentId, runId: runParams.runId },
          async () =>
            await execution.runCliAgent({
              ...runParams,
              preparedRunAdmission,
              userTurnTranscriptRecorder,
              sessionTarget: {
                ...runParams.sessionTarget,
                agentId,
                sessionId,
                sessionKey,
                storePath,
              },
              sessionFile: sessionKey,
              storePath,
              persistAssistantTranscript: true,
              provider: cliExecutionProvider,
              modelProvider: provider,
              model: modelId,
              requesterModel: { provider, model: modelId },
              authProfileId,
              nativeAuthOnly: authProfileId ? undefined : true,
              disableCliLiveSession: true,
            }),
          { preparedRunAdmission, abortSignal: runParams.abortSignal },
        );
      } finally {
        // Accepted terminal writes commit under this admission; abort still closes it immediately.
        try {
          await drainAgentRunTerminalWrites(operationalRunInstance);
        } finally {
          runParams.abortSignal?.removeEventListener("abort", close);
          close();
        }
      }
    } finally {
      retained?.release();
    }
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}
