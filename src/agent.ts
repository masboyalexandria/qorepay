/**
 * agent.ts — QorePay: a recurring bill-payment agent whose limits the chain enforces.
 *
 * QoreChain diana testnet only. Never prints key material.
 *
 * Three keys, three roles (mirrors the official Workshop 2 bill payer):
 *   owner   your account (hybrid secp256k1 + ML-DSA-87). Holds the money,
 *           creates the plans, revokes the agent.
 *   agent   the scheduler's own EVM key. It can ask the vault to pay a due
 *           plan, but only inside the rules written on chain.
 *   (the vault itself holds the treasury; money leaves it only through a
 *   due plan payment, or through a guardian withdrawal signed ML-DSA-87.)
 *
 *   pnpm agent init                              create the agent key
 *   pnpm agent setup                             register agent PQC key + open window
 *   pnpm agent deploy [--fund QOR]               deploy the vault (owner) + fund it
 *   pnpm agent deposit <QOR>                     top up the vault (owner)
 *   pnpm agent plan <payee> <QOR> <intervalSec> <payments>
 *                                                owner creates a recurring plan
 *   pnpm agent run [--once | --watch <sec>]      pay every due plan
 *   pnpm agent status                            vault, plans, sessions, history
 *   pnpm agent revoke <agentAddress>             owner revokes an agent session
 *   pnpm agent cancel <planId>                   owner cancels a plan
 *   pnpm agent attack                            attack simulation (see README)
 *   pnpm agent dashboard                         start the status dashboard
 *
 * NOTE: there is deliberately NO limit check in this file. The agent simply
 * tries to pay; every limit you will see comes from the chain.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
} from "viem";
import {
  generatePqcRecoveryCode,
  pqcSign,
  unifiedAccountFromSeed,
} from "@qorechain/sdk";
import { QORE_PAY_VAULT_ABI } from "./abi.js";
import {
  TESTNET,
  accountFromEnv,
  ensureRegistered,
  ensureWindow,
  fmtQor,
  onChain,
  uqorBalance,
  vaultAddress,
} from "./qore.js";

const CHAIN = defineChain({
  id: TESTNET.evmChainId,
  name: "QoreChain Diana Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET.evmRpc] } },
});

const publicClient = createPublicClient({ chain: CHAIN, transport: http(TESTNET.evmRpc) });

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

function walletFor(prefix: string) {
  const key = env(`${prefix}_PRIVATE_KEY`) as `0x${string}`;
  return createWalletClient({ account: privateKeyToAccount(key), chain: CHAIN, transport: http(TESTNET.evmRpc) });
}

function vault(overrides?: { address?: `0x${string}` }) {
  return { address: overrides?.address ?? vaultAddress(), abi: QORE_PAY_VAULT_ABI };
}

const toUqor = (qor: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(qor)) throw new Error(`amount in QOR, e.g. 0.8 (got "${qor}")`);
  const [i, f = ""] = qor.split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};

const short = (addr: string) => `${addr.slice(0, 10)}...${addr.slice(-4)}`;

async function readPlans() {
  const v = vault();
  const count = await publicClient.readContract({ ...v, functionName: "planCount" });
  const plans: {
    id: number;
    payee: string;
    amount: bigint;
    interval: bigint;
    left: bigint;
    nextDue: bigint;
    agent: string;
    active: boolean;
  }[] = [];
  for (let i = 0n; i < count; i++) {
    const p = await publicClient.readContract({ ...v, functionName: "plans", args: [i] });
    plans.push({ id: Number(i), payee: p[0], amount: p[1], interval: p[2], left: p[3], nextDue: p[4], agent: p[5], active: p[6] });
  }
  return plans;
}

const cmds: Record<string, (...args: string[]) => Promise<void>> = {
  async init() {
    const envFile = ".env";
    const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    if (/^AGENT_PRIVATE_KEY=/m.test(existing)) throw new Error(".env already has an agent key; not overwriting");
    const key = generatePrivateKey();
    const recoveryCode = generatePqcRecoveryCode();
    const acc = unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
    appendFileSync(
      envFile,
      [
        "",
        "# QorePay agent key (scheduler). QoreChain diana TESTNET only. Never fund on mainnet.",
        `AGENT_PRIVATE_KEY=${key}`,
        `AGENT_PQC_RECOVERY_CODE=${recoveryCode}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    console.log(`agent key   ${acc.evm}`);
    console.log(`agent qor   ${acc.cosmos}`);
    console.log(`\nNext: fund the agent account, then: pnpm agent setup`);
    console.log(`  (owner can send QOR to the agent EVM address once the vault is deployed,`);
    console.log(`   or claim the faucet for the agent qor1 address.)`);
  },

  async setup() {
    const acc = accountFromEnv("AGENT");
    console.log(`agent: ${acc.evm} (${acc.cosmos})`);
    console.log(`balance: ${fmtQor(await uqorBalance(acc.cosmos))}`);
    await ensureRegistered(acc);
    await ensureWindow(acc);
    console.log("agent ready: PQC key registered, EVM window live.");
  },

  async deploy(...args: string[]) {
    const fundArg = args[args.indexOf("--fund") + 1] ?? "10";
    const ownerAcc = accountFromEnv("OWNER");
    console.log(`owner: ${ownerAcc.evm} (${ownerAcc.cosmos})`);
    await ensureRegistered(ownerAcc);
    await ensureWindow(ownerAcc);
    const artifact = JSON.parse(
      readFileSync("artifacts/contracts/QorePayVault.sol/QorePayVault.json", "utf8"),
    ) as { abi: unknown; bytecode: `0x${string}` };
    const ownerWallet = walletFor("OWNER");
    const fund = parseEther(fundArg);
    console.log(`deploying QorePayVault (funding ${fundArg} QOR)...`);
    const hash = await ownerWallet.deployContract({
      abi: artifact.abi as never,
      bytecode: artifact.bytecode,
      args: [ownerAcc.evm],
      value: fund,
    });
    console.log(`deploy tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const address = receipt.contractAddress;
    if (!address) throw new Error("deploy produced no contract address");
    const envFile = ".env";
    const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const lines = [`VAULT_ADDRESS=${address}`, `VAULT_DEPLOY_BLOCK=${receipt.blockNumber}`];
    appendFileSync(envFile, "\n" + lines.join("\n") + "\n");
    void existing;
    console.log(`vault deployed: ${address} (block ${receipt.blockNumber})`);
    console.log(`funded with ${fundArg} QOR. Saved to .env as VAULT_ADDRESS.`);
  },

  async deposit(qor: string) {
    if (!qor) throw new Error("usage: pnpm agent deposit <QOR>");
    const ownerAcc = accountFromEnv("OWNER");
    await ensureWindow(ownerAcc);
    const ownerWallet = walletFor("OWNER");
    const hash = await ownerWallet.writeContract({
      ...vault(),
      functionName: "deposit",
      value: parseEther(qor),
      account: ownerWallet.account,
    });
    console.log(`deposited ${qor} QOR: ${hash}`);
  },

  async plan(payee: string, qor: string, intervalSec: string, payments: string) {
    if (!payee || !qor || !intervalSec || !payments) {
      throw new Error("usage: pnpm agent plan <payee> <QOR> <intervalSec> <payments>");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payee)) throw new Error("payee must be a 0x address");
    const ownerAcc = accountFromEnv("OWNER");
    const agentAcc = accountFromEnv("AGENT");
    await ensureWindow(ownerAcc);
    const ownerWallet = walletFor("OWNER");
    const amount = parseEther(qor);
    const hash = await ownerWallet.writeContract({
      ...vault(),
      functionName: "createPlan",
      args: [payee as `0x${string}`, amount, BigInt(intervalSec), BigInt(payments), agentAcc.evm],
      account: ownerWallet.account,
    });
    console.log(`plan created: ${qor} QOR every ${intervalSec}s x ${payments} to ${short(payee)}`);
    console.log(`  agent ${agentAcc.evm} — session: max 1 QOR/payment, 3 QOR/day, expires in 24h`);
    console.log(`  tx: ${hash}`);
  },

  async run(...args: string[]) {
    const watch = args.indexOf("--watch");
    const everySec = watch >= 0 ? Number(args[watch + 1] ?? "60") : 0;
    const agentWallet = walletFor("AGENT");
    const agentAcc = accountFromEnv("AGENT");
    await ensureWindow(agentAcc);
    const once = async () => {
      const due = (await publicClient.readContract({
        ...vault(),
        functionName: "duePlanIds",
        args: [10n],
      })) as bigint[];
      if (due.length === 0) {
        console.log(`${new Date().toISOString()}: no plans due`);
        return;
      }
      for (const id of due) {
        const plan = (await publicClient.readContract({ ...vault(), functionName: "plans", args: [id] })) as readonly [
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          string,
          boolean,
        ];
        const label = `plan ${id}: ${formatEther(plan[1])} QOR -> ${short(plan[0])}`;
        try {
          const hash = await agentWallet.writeContract({
            ...vault(),
            functionName: "pay",
            args: [id],
            account: agentWallet.account,
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          console.log(`  ${label}  PAID (${receipt.transactionHash.slice(0, 18)}...)`);
        } catch (e) {
          const msg = (e as Error).message.split("\n")[0];
          console.log(`  ${label}  REFUSED BY THE CHAIN: ${msg.slice(0, 160)}`);
        }
      }
    };
    await once();
    if (everySec > 0) {
      console.log(`watching every ${everySec}s (Ctrl+C to stop)`);
      setInterval(() => void once(), everySec * 1000);
      await new Promise(() => {});
    }
  },

  async status() {
    const v = vault();
    const ownerAcc = accountFromEnv("OWNER");
    const agentAcc = accountFromEnv("AGENT");
    const [balance, count, active, due] = await Promise.all([
      publicClient.getBalance({ address: v.address }),
      publicClient.readContract({ ...v, functionName: "planCount" }),
      publicClient.readContract({ ...v, functionName: "activePlanCount" }),
      publicClient.readContract({ ...v, functionName: "duePlanIds", args: [10n] }),
    ]);
    console.log(`vault     ${v.address}`);
    console.log(`owner     ${ownerAcc.evm}  ${fmtQor(await uqorBalance(ownerAcc.cosmos))}`);
    console.log(`agent     ${agentAcc.evm}  ${fmtQor(await uqorBalance(agentAcc.cosmos))}`);
    console.log(`balance   ${formatEther(balance)} QOR  |  plans ${count} (${active} active)  |  due now: ${due.length}`);
    const plans = await readPlans();
    const now = Math.floor(Date.now() / 1000);
    for (const p of plans) {
      const dueIn = Number(p.nextDue) - now;
      console.log(
        `  #${p.id} ${p.active ? "active" : "done  "} ${formatEther(p.amount)} QOR / ${p.interval}s x ${p.left} left -> ${short(p.payee)} | next due ${dueIn <= 0 ? "NOW" : `in ${dueIn}s`}`,
      );
    }
    const session = await publicClient.readContract({ ...v, functionName: "getSession", args: [agentAcc.evm] });
    console.log(
      `session   agent ${short(agentAcc.evm)}: ${session[5] ? "active" : "inactive"}, cap ${formatEther(session[0])} QOR/pay, ${formatEther(session[1])} QOR/day, spent today ${formatEther(session[2])} QOR, expires ${new Date(Number(session[4]) * 1000).toISOString()}`,
    );
    const logs = await publicClient.getLogs({
      address: v.address,
      event: {
        type: "event",
        name: "PaymentExecuted",
        inputs: [
          { indexed: true, name: "planId", type: "uint256" },
          { indexed: true, name: "agent", type: "address" },
          { indexed: true, name: "payee", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paymentsLeft", type: "uint256" },
        ],
      },
      fromBlock: BigInt(process.env.VAULT_DEPLOY_BLOCK ?? "0"),
      toBlock: "latest",
    });
    console.log(`history   ${logs.length} payments executed`);
    for (const l of logs.slice(-5)) {
      console.log(`  plan ${l.args.planId}: ${formatEther(l.args.amount ?? 0n)} QOR -> ${short(l.args.payee ?? "")} (${l.transactionHash.slice(0, 18)}...)`);
    }
  },

  async revoke(agentAddr: string) {
    if (!agentAddr) throw new Error("usage: pnpm agent revoke <agentAddress>");
    const ownerAcc = accountFromEnv("OWNER");
    await ensureWindow(ownerAcc);
    const ownerWallet = walletFor("OWNER");
    const hash = await ownerWallet.writeContract({
      ...vault(),
      functionName: "revokeSession",
      args: [agentAddr as `0x${string}`],
      account: ownerWallet.account,
    });
    console.log(`agent session revoked: ${agentAddr} (${hash})`);
  },

  async cancel(planId: string) {
    if (planId === undefined) throw new Error("usage: pnpm agent cancel <planId>");
    const ownerAcc = accountFromEnv("OWNER");
    await ensureWindow(ownerAcc);
    const ownerWallet = walletFor("OWNER");
    const hash = await ownerWallet.writeContract({
      ...vault(),
      functionName: "cancelPlan",
      args: [BigInt(planId)],
      account: ownerWallet.account,
    });
    console.log(`plan ${planId} cancelled (${hash})`);
  },

  async attack() {
    const v = vault();
    const ownerAcc = accountFromEnv("OWNER");
    const agentAcc = accountFromEnv("AGENT");
    const agentWallet = walletFor("AGENT");
    await ensureWindow(agentAcc);
    const nonce = await publicClient.readContract({ ...v, functionName: "nonce" });
    const balance = await publicClient.getBalance({ address: v.address });
    console.log(`vault balance: ${formatEther(balance)} QOR, guardian nonce: ${nonce}`);
    console.log("\n[1] Leaked classical key: guardian withdrawal with a random ML-DSA-87 signature");
    try {
      const hash = await agentWallet.writeContract({
        ...v,
        functionName: "guardianWithdraw",
        args: [ownerAcc.evm, parseEther("0.01"), `0x${randomBytes(4627).toString("hex")}` as `0x${string}`],
        account: agentWallet.account,
      });
      console.log(`  UNEXPECTED: withdrawal accepted?! ${hash}`);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`  BLOCKED: ${msg.includes("BadPqcSignature") ? "BadPqcSignature" : msg.split("\n")[0].slice(0, 160)}`);
    }
    console.log("\n[2] Stranger tries to pay a plan (not the plan's agent)");
    const plans = await readPlans();
    if (plans.length > 0) {
      const ownerWallet = walletFor("OWNER");
      try {
        const hash = await ownerWallet.writeContract({
          ...v,
          functionName: "pay",
          args: [BigInt(plans[0].id)],
          account: ownerWallet.account,
        });
        console.log(`  UNEXPECTED: stranger payment accepted?! ${hash}`);
      } catch (e) {
        const msg = (e as Error).message;
        console.log(`  BLOCKED: ${msg.includes("NotAgent") ? "NotAgent" : msg.split("\n")[0].slice(0, 160)}`);
      }
    } else {
      console.log("  (skipped: no plans yet)");
    }
    console.log("\n[3] Legitimate guardian withdrawal: owner signs 0.01 QOR with ML-DSA-87");
    const message = (await publicClient.readContract({
      ...v,
      functionName: "withdrawalMessage",
      args: [ownerAcc.evm, parseEther("0.01"), nonce],
    })) as `0x${string}`;
    const sig = pqcSign(ownerAcc.pqc.secretKey, Buffer.from(message.slice(2), "hex"));
    const hash = await agentWallet.writeContract({
      ...v,
      functionName: "guardianWithdraw",
      args: [ownerAcc.evm, parseEther("0.01"), `0x${Buffer.from(sig).toString("hex")}` as `0x${string}`],
      account: agentWallet.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  SIGNED + EXECUTED by relayer: ${receipt.transactionHash}`);
    const c = await onChain(receipt.transactionHash);
    console.log(`  on-chain: code ${c?.code}, hybrid ML-DSA-87: ${c?.hybrid ? "verified" : "unknown"}`);
  },

  async dashboard() {
    const { startDashboard } = await import("./dashboard.js");
    await startDashboard();
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log(
    [
      "QorePay agent — recurring bill payments with on-chain limits (testnet only)",
      "",
      "  pnpm agent init | setup | deploy [--fund QOR] | deposit <QOR>",
      "  pnpm agent plan <payee> <QOR> <intervalSec> <payments>",
      "  pnpm agent run [--once | --watch <sec>] | status",
      "  pnpm agent revoke <agentAddress> | cancel <planId>",
      "  pnpm agent attack | dashboard",
    ].join("\n"),
  );
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...args).catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
