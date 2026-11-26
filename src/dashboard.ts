/**
 * dashboard.ts — QorePay status dashboard (read-only).
 *
 * A tiny HTTP server: vault balance, plans, agent session, payment history.
 * No key material is used here — only public reads.
 */
import { createServer } from "node:http";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { QORE_PAY_VAULT_ABI } from "./abi.js";
import { TESTNET, vaultAddress } from "./qore.js";

const CHAIN = defineChain({
  id: TESTNET.evmChainId,
  name: "QoreChain Diana Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET.evmRpc] } },
});

const publicClient = createPublicClient({ chain: CHAIN, transport: http(TESTNET.evmRpc) });

const PAYMENT_EVENT = {
  type: "event",
  name: "PaymentExecuted",
  inputs: [
    { indexed: true, name: "planId", type: "uint256" },
    { indexed: true, name: "agent", type: "address" },
    { indexed: true, name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "paymentsLeft", type: "uint256" },
  ],
} as const;

export async function startDashboard(): Promise<void> {
  const port = Number(process.env.QOREPAY_PORT ?? "3000");
  const server = createServer(async (_req, res) => {
    try {
      const address = vaultAddress();
      const v = { address, abi: QORE_PAY_VAULT_ABI };
      const [balance, count, active, due] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ ...v, functionName: "planCount" }),
        publicClient.readContract({ ...v, functionName: "activePlanCount" }),
        publicClient.readContract({ ...v, functionName: "duePlanIds", args: [10n] }),
      ]);
      const plans: string[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0n; i < count; i++) {
        const p = await publicClient.readContract({ ...v, functionName: "plans", args: [i] });
        const dueIn = Number(p[4]) - now;
        plans.push(
          `<tr><td>#${i}</td><td>${p[0].slice(0, 10)}…</td><td>${formatEther(p[1])} QOR</td>` +
            `<td>${p[2]}s</td><td>${p[3]}</td><td>${p[6] ? (dueIn <= 0 ? "DUE NOW" : `in ${dueIn}s`) : "done"}</td></tr>`,
        );
      }
      const logs = await publicClient.getLogs({
        address,
        event: PAYMENT_EVENT,
        fromBlock: BigInt(process.env.VAULT_DEPLOY_BLOCK ?? "0"),
        toBlock: "latest",
      });
      const history = logs
        .slice(-10)
        .reverse()
        .map(
          (l) =>
            `<tr><td>plan ${l.args.planId}</td><td>${formatEther(l.args.amount ?? 0n)} QOR</td>` +
            `<td>${(l.args.payee ?? "").slice(0, 10)}…</td><td>${l.args.paymentsLeft} left</td></tr>`,
        )
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>QorePay — status</title><style>
body{font-family:system-ui,sans-serif;background:#0b1026;color:#e8ecff;margin:0;padding:24px}
h1{color:#ffb454}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #334;padding:6px 10px;text-align:left}
th{color:#2dd4bf}.card{background:#141a3a;border-radius:12px;padding:16px 20px;margin:12px 0}
a{color:#2dd4bf}</style></head><body>
<h1>QorePay — recurring bill payments</h1>
<p>Post-quantum agent on QoreChain testnet. Limits are enforced on chain: max 1 QOR/payment, 3 QOR/day, 24h sessions, fixed payees.</p>
<div class="card"><b>Vault</b> ${address}<br>
<b>Balance</b> ${formatEther(balance)} QOR &nbsp;|&nbsp; <b>Plans</b> ${count} (${active} active) &nbsp;|&nbsp; <b>Due now</b> ${due.length}</div>
<div class="card"><b>Plans</b><table><tr><th>ID</th><th>Payee</th><th>Amount</th><th>Interval</th><th>Left</th><th>Next due</th></tr>${plans.join("") || "<tr><td colspan=6>No plans yet — run: pnpm agent plan …</td></tr>"}</table></div>
<div class="card"><b>Payment history</b> (${logs.length} executed)<table><tr><th>Plan</th><th>Amount</th><th>Payee</th><th>Left</th></tr>${history || "<tr><td colspan=4>None yet</td></tr>"}</table></div>
<p><a href="https://explore.qore.network/address/${address}" target="_blank">Explorer</a> · auto-refreshes every 30s</p>
</body></html>`);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`error: ${e instanceof Error ? e.message : e}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`QorePay dashboard: http://localhost:${port}`);
  console.log("Ctrl+C to stop.");
  await new Promise(() => {});
}

// Standalone: `tsx --env-file=.env src/dashboard.ts`
if (process.argv[1]?.endsWith("dashboard.ts")) {
  startDashboard().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
