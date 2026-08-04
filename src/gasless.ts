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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sponsorship guard: WE pay the gas, so only sponsor operations that touch OUR contracts.
//
// The app's user-signed calls have a tiny surface — the factory (createAccount), the caller's own
// SmartInvestmentAccount (executePlan / withdraw), and USDC (transfer on withdraw-elsewhere). Everything
// downstream of executePlan is already constrained on-chain by the registry's approved protocols/routes,
// so we don't need to know about Aave/Morpho/routers here.
//
// The account address is deterministic — AccountFactory uses OpenZeppelin Clones:
//     salt    = keccak256(abi.encode(owner, userSalt))
//     account = CREATE2(factory, salt, keccak256(EIP-1167 proxy initcode for `implementation`))
// so we derive the one account a given sender may touch with NO RPC call. Refusing other users' accounts
// matters financially too: such an op reverts on-chain and ERC-4337 still bills the paymaster.
// This bounds WHO we pay for, not how much a user may transact — the daily quota does that.

import { concatHex, decodeFunctionData, getContractAddress, keccak256, pad, type Address, type Hex } from "viem";

export interface SponsorConfig {
  factory: Address;
  implementation: Address; // SmartInvestmentAccount impl the factory clones
  usdc: Address;
  salt: Hex; // the userSalt the client uses (ZERO_SALT today)
}

/** EIP-1167 minimal-proxy creation code for `impl` — what Clones deploys. */
const proxyInitCode = (impl: Address): Hex =>
  concatHex(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]);

/** The account address the factory would deploy for `owner` — pure computation, mirrors `predict()`. */
export function predictAccount(cfg: SponsorConfig, owner: Address): Address {
  const salt = keccak256(concatHex([pad(owner, { size: 32 }), cfg.salt]));
  return getContractAddress({
    opcode: "CREATE2",
    from: cfg.factory,
    salt,
    bytecodeHash: keccak256(proxyInitCode(cfg.implementation)),
  });
}

// SimpleAccount (permissionless 7702) encodes a userOp's calls one of three ways depending on entrypoint
// version. We decode by selector and refuse anything we can't read — guessing would defeat the guard.
const EXECUTE_ABI = [
  { name: "execute", type: "function", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "dest", type: "address" }, { name: "value", type: "uint256" }, { name: "func", type: "bytes" }] },
] as const;
const BATCH_07_ABI = [
  { name: "executeBatch", type: "function", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "dest", type: "address[]" }, { name: "value", type: "uint256[]" }, { name: "func", type: "bytes[]" }] },
] as const;
const BATCH_08_ABI = [
  { name: "executeBatch", type: "function", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "calls", type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }] },
] as const;

/** Every contract a userOp's calldata would call, or null if we can't decode it. */
export function extractTargets(callData: Hex | undefined): Address[] | null {
  if (!callData || callData.length < 10) return null;
  for (const abi of [EXECUTE_ABI, BATCH_07_ABI, BATCH_08_ABI] as const) {
    try {
      const { args } = decodeFunctionData({ abi, data: callData });
      const first = (args as readonly unknown[])[0];
      if (typeof first === "string") return [first as Address]; // execute(dest, …)
      if (Array.isArray(first)) {
        // v0.7 → address[]; v0.8 → {target,…}[]
        return first.map((x) => (typeof x === "string" ? x : (x as { target: Address }).target)) as Address[];
      }
    } catch {
      /* selector/shape mismatch — try the next */
    }
  }
  return null;
}

export type SponsorCheck = { ok: true } | { ok: false; error: string };

/** Sponsor only if every target is the factory, USDC, or the sender's own derived account. */
export function validateSponsorship(
  userOp: { sender?: unknown; callData?: unknown },
  cfg: SponsorConfig,
): SponsorCheck {
  const sender = typeof userOp?.sender === "string" ? (userOp.sender as Address) : undefined;
  if (!sender) return { ok: false, error: "userOp.sender required" };

  const targets = extractTargets(typeof userOp?.callData === "string" ? (userOp.callData as Hex) : undefined);
  if (!targets || targets.length === 0) return { ok: false, error: "unrecognised callData" };

  const allowed = new Set([cfg.factory.toLowerCase(), cfg.usdc.toLowerCase(), predictAccount(cfg, sender).toLowerCase()]);
  for (const t of targets) {
    if (!allowed.has(String(t).toLowerCase())) return { ok: false, error: `target not sponsored: ${t}` };
  }
  return { ok: true };
}

// ── Daily per-sender quota ────────────────────────────────────────────────────────────────────
// Target-checking bounds WHO we pay for, but not how often: anyone can call createAccount, become a
// legitimate user, and loop executePlan to burn the budget. A per-sender daily cap closes that without
// capping what a user may do with their own money — they can still deposit/withdraw any amount; they
// just can't have us fund an unbounded number of transactions per day.
//
// Counted only on the calls that yield REAL sponsorship (pm_getPaymasterData / pm_sponsorUserOperation).
// The stub call returns dummy data for gas estimation and commits us to nothing, so it's free.

/** UTC day key — the quota window. */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export interface QuotaResult {
  ok: boolean;
  used: number;
  limit: number;
}

/**
 * Atomically count one sponsorship against `sender`'s daily allowance. The table is created on demand so
 * this needs no migration step. Fails OPEN on a storage error: a quota outage shouldn't break gasless for
 * real users, and the target check still bounds the blast radius.
 */
export async function consumeQuota(
  db: D1Database | undefined,
  sender: string,
  limit: number,
  now: number,
): Promise<QuotaResult> {
  if (!db) return { ok: true, used: 0, limit }; // unconfigured → no quota (dev)
  const day = utcDay(now);
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS gasless_quota (
           sender TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (sender, day))`,
      )
      .run();
    const row = await db
      .prepare(
        `INSERT INTO gasless_quota (sender, day, count) VALUES (?, ?, 1)
         ON CONFLICT(sender, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(sender.toLowerCase(), day)
      .first<{ count: number }>();
    const used = Number(row?.count ?? 1);
    return { ok: used <= limit, used, limit };
  } catch {
    return { ok: true, used: 0, limit }; // fail open — see note above
  }
}

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
