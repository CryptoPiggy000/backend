// Tests for the /gasless/rpc Pimlico proxy: the guards that stop it being an open relay, and the
// server-side sponsorship-policy injection that makes the dashboard spend limits actually binding.
//
// Why the injection matters: the policy id used to travel in the CLIENT's paymasterContext, so anyone
// hitting the proxy could simply omit it and be sponsored under no policy — i.e. the "real spend control"
// was opt-in for the attacker. The proxy now stamps it server-side.
// Run: `npm run test:gasless`.
import app from "../src/index";
import { withSponsorshipPolicy } from "../src/gasless";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), msg);

const ENV = { PIMLICO_API_KEY: "pim_test", PIMLICO_SPONSORSHIP_POLICY_ID: "sp_ours", MOCK: "true" };
const rpc = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 1, method, params });
const post = (body: unknown, env: Record<string, string> = ENV, chain = 8453) =>
  app.request(
    `/gasless/rpc?chain=${chain}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );

async function main() {
  console.log("withSponsorshipPolicy — server-side enforcement");

  // ERC-7677: pm_getPaymasterData(userOp, entryPoint, chainId, context) → context is params[3]
  {
    const out = withSponsorshipPolicy(rpc("pm_getPaymasterData", [{}, "0xEP", 8453, {}]), "sp_ours") as {
      params: { sponsorshipPolicyId?: string }[];
    };
    eq(out.params[3].sponsorshipPolicyId, "sp_ours", "stamps the policy into pm_getPaymasterData context");
  }
  {
    const out = withSponsorshipPolicy(rpc("pm_getPaymasterStubData", [{}, "0xEP", 8453, {}]), "sp_ours") as {
      params: { sponsorshipPolicyId?: string }[];
    };
    eq(out.params[3].sponsorshipPolicyId, "sp_ours", "stamps the policy into pm_getPaymasterStubData context");
  }

  // the whole point: a client-supplied policy must NOT win
  {
    const out = withSponsorshipPolicy(
      rpc("pm_getPaymasterData", [{}, "0xEP", 8453, { sponsorshipPolicyId: "sp_ATTACKER" }]),
      "sp_ours",
    ) as { params: { sponsorshipPolicyId?: string }[] };
    eq(out.params[3].sponsorshipPolicyId, "sp_ours", "OVERRIDES a client-supplied policy id");
  }
  {
    const out = withSponsorshipPolicy(rpc("pm_getPaymasterData", [{}, "0xEP", 8453]), "sp_ours") as {
      params: { sponsorshipPolicyId?: string }[];
    };
    eq(out.params[3]?.sponsorshipPolicyId, "sp_ours", "adds the context when the client omitted it entirely");
  }
  // legacy Pimlico shape: pm_sponsorUserOperation(userOp, entryPoint, {sponsorshipPolicyId})
  {
    const out = withSponsorshipPolicy(rpc("pm_sponsorUserOperation", [{}, "0xEP"]), "sp_ours") as {
      params: { sponsorshipPolicyId?: string }[];
    };
    eq(out.params[2]?.sponsorshipPolicyId, "sp_ours", "stamps the policy into pm_sponsorUserOperation");
  }

  // non-paymaster methods are left alone, and no policy configured = unchanged passthrough
  {
    const send = rpc("eth_sendUserOperation", [{}, "0xEP"]);
    eq(withSponsorshipPolicy(send, "sp_ours"), send, "leaves non-paymaster methods untouched");
    const pm = rpc("pm_getPaymasterData", [{}, "0xEP", 8453, {}]);
    eq(withSponsorshipPolicy(pm, undefined), pm, "no policy configured → body unchanged");
  }

  console.log("/gasless/rpc — guards");
  eq((await post(rpc("eth_call"))).status, 403, "disallowed method → 403");
  eq((await post(rpc("eth_sendTransaction"))).status, 403, "eth_sendTransaction → 403");
  eq((await post(rpc("eth_chainId"), ENV, 999)).status, 400, "unsupported chain → 400");
  eq((await post({ nope: true })).status, 400, "malformed JSON-RPC → 400");
  eq((await post(rpc("eth_chainId"), { MOCK: "true" })).status, 503, "no API key → 503");

  console.log("/gasless/rpc — forwarding");
  {
    // stub the upstream so we can see exactly what the proxy sends to Pimlico
    const realFetch = globalThis.fetch;
    let sentUrl = "";
    let sentBody: { params?: { sponsorshipPolicyId?: string }[] } = {};
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sentUrl = String(url);
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const res = await post(rpc("pm_getPaymasterData", [{}, "0xEP", 8453, { sponsorshipPolicyId: "sp_ATTACKER" }]));
    eq(res.status, 200, "allowed method → 200");
    ok(sentUrl.includes("api.pimlico.io/v2/8453/rpc"), "forwards to the right Pimlico chain endpoint");
    ok(sentUrl.includes("apikey=pim_test"), "injects the API key server-side");
    eq(sentBody.params?.[3]?.sponsorshipPolicyId, "sp_ours", "upstream receives OUR policy, not the client's");

    globalThis.fetch = realFetch;
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
