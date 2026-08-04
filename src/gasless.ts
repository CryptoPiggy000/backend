// Server-side sponsorship-policy enforcement for the /gasless/rpc proxy.
//
// THE HOLE THIS CLOSES: a Pimlico sponsorship policy (spend caps, contract allowlist) is the only real
// defence against paymaster drain — the proxy's method/chain allowlists stop it being a general RPC, but
// they don't limit *spending*. The policy id used to travel in the CLIENT's `paymasterContext`, which means
// anyone hitting the proxy could just omit it (or send another) and be sponsored under no policy at all.
// A control the attacker opts into is not a control.
//
// So the proxy stamps the configured policy id into the paymaster calls itself, overwriting whatever the
// client sent. With PIMLICO_SPONSORSHIP_POLICY_ID unset the body passes through untouched (no behaviour
// change) — but then the dashboard limits are advisory, so set it before relying on gasless in production.

/** ERC-7677: pm_getPaymaster*Data(userOp, entryPoint, chainId, context) — context is params[3]. */
const CONTEXT_INDEX: Record<string, number> = {
  pm_getPaymasterData: 3,
  pm_getPaymasterStubData: 3,
  // Pimlico's legacy shape: pm_sponsorUserOperation(userOp, entryPoint, { sponsorshipPolicyId }).
  pm_sponsorUserOperation: 2,
};

/**
 * Return `body` with our sponsorship policy stamped into the paymaster context. Non-paymaster methods and
 * an unset `policyId` pass through unchanged. Never mutates the input.
 */
export function withSponsorshipPolicy<T>(body: T, policyId: string | undefined): T {
  if (!policyId) return body;
  const call = body as { method?: unknown; params?: unknown };
  if (!call || typeof call.method !== "string") return body;

  const idx = CONTEXT_INDEX[call.method];
  if (idx === undefined) return body;

  const params = Array.isArray(call.params) ? [...call.params] : [];
  // Pad so the context lands at the right position even if the client sent a short params array.
  while (params.length <= idx) params.push(undefined);
  const existing = params[idx];
  params[idx] = {
    ...(existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {}),
    sponsorshipPolicyId: policyId, // ours wins — deliberately last
  };
  return { ...(body as object), params } as T;
}
