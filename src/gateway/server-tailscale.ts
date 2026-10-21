import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { TailscaleServeDisabledError } from "../infra/tailscale-serve-disabled-error.js";
import {
  claimTailscaleRoute,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareTailscalePublishedOrigin } from "./tailscale-published-origin.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
  signal?: AbortSignal;
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const backendTarget = params.backend.port;
  const effectiveMode = params.tailscaleMode;
  let clearPublishedOrigin: (() => void) | undefined;
  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    if (preservedFunnel) {
      params.logTailscale.warn(
        `external Tailscale Funnel for port ${params.port} remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject its unattributable ingress. ` +
          "First configure a durable gateway password (gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD) and set gateway.auth.mode=password, " +
          "then run `openclaw config set gateway.tailscale.mode funnel` and `openclaw config unset gateway.tailscale.preserveFunnel`; " +
          "see https://docs.openclaw.ai/gateway/tailscale#public-internet-funnel-%2B-shared-password",
      );
      return null;
    }
  }

  type RouteClaim = Awaited<ReturnType<typeof claimTailscaleRoute>>;
  const acquireClaim = async (signal: AbortSignal | undefined): Promise<RouteClaim> => {
    let nextClaim: RouteClaim | undefined;
    try {
      nextClaim = await claimTailscaleRoute(
        effectiveMode,
        backendTarget,
        params.port,
        params.logTailscale.info,
        signal,
      );
      const hostname = (
        params.tailscaleMode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
      ).catch((error: unknown) => {
        params.logTailscale.warn(
          `Could not read the Tailscale hostname; managed portal ingress is unavailable: ${formatErrorMessage(error)}`,
        );
        return null;
      });
      const host = await racePromiseWithAbortSignal(hostname, signal, (aborted) => aborted.reason);
      signal?.throwIfAborted();
      if (!nextClaim.isActive()) {
        throw new Error(`Managed Tailscale ${params.tailscaleMode} claim exited during startup`);
      }
      if (host) {
        const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
        const publicHost = resolveTailscalePublishedHost({
          tailscaleMode: effectiveMode,
          tailnetHost: host,
        });
        if (publicHost) {
          clearPublishedOrigin = prepareTailscalePublishedOrigin({
            origin: `https://${publicHost}`,
            mode: effectiveMode,
          });
          params.logTailscale.info(
            `${params.tailscaleMode} enabled: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
          );
        } else {
          params.logTailscale.info(`${params.tailscaleMode} enabled`);
        }
      } else {
        params.logTailscale.info(`${params.tailscaleMode} enabled`);
      }
      return nextClaim;
    } catch (err) {
      clearPublishedOrigin?.();
      try {
        await nextClaim?.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          "Tailscale exposure startup and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw err;
    }
  };

  let claim: RouteClaim;
  try {
    claim = await acquireClaim(params.signal);
  } catch (err) {
    if (err instanceof AggregateError) {
      throw err;
    }
    params.signal?.throwIfAborted();
    if (params.tailscaleMode === "serve" && err instanceof TailscaleServeDisabledError) {
      params.logTailscale.warn(
        "Tailscale Serve is not enabled on this tailnet. The authenticated local Gateway remains available on loopback; remote access is unavailable. Restore the intended tailnet Serve policy and restart the Gateway.",
      );
      return null;
    }
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
    throw err;
  }

  // Startup's signal ends with startup; recovery attempts are owned by this exposure.
  const recoveryAbort = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovery: Promise<void> | undefined;
  const scheduleRecovery = (delayMs = 5_000) => {
    if (recoveryAbort.signal.aborted) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      recovery = acquireClaim(recoveryAbort.signal)
        .then(
          (nextClaim) => {
            claim = nextClaim;
            watchClaim(nextClaim);
          },
          (err: unknown) => {
            if (recoveryAbort.signal.aborted) {
              return;
            }
            params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
            scheduleRecovery(Math.min(delayMs * 2, 30_000));
          },
        )
        .finally(() => {
          recovery = undefined;
        });
    }, delayMs);
    retryTimer.unref?.();
  };
  const watchClaim = (activeClaim: RouteClaim) => {
    void activeClaim.exited.then(() => {
      if (recoveryAbort.signal.aborted) {
        return;
      }
      clearPublishedOrigin?.();
      params.logTailscale.warn(
        `${params.tailscaleMode} route claim exited; retrying managed Tailscale ingress`,
      );
      scheduleRecovery();
    });
  };
  watchClaim(claim);
  return async () => {
    recoveryAbort.abort(new Error("Managed Tailscale exposure is stopping"));
    clearTimeout(retryTimer);
    clearPublishedOrigin?.();
    await recovery;
    await claim.stop();
  };
}
