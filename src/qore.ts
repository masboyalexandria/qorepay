/**
 * qore.ts — QoreChain testnet helpers for the QorePay agent.
 *
 * Every EVM transaction on QoreChain needs (1) a registered ML-DSA-87 key
 * for the sending account and (2) a live EVM authorisation window, opened
 * by a native-lane message signed hybrid (secp256k1 + ML-DSA-87).
 * This module wraps that ceremony for any throwaway account whose key
 * material lives in .env (testnet only — never mainnet keys).
 *
 * Key material is never printed or logged.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";

export const TESTNET = {
  chainId: "qorechain-diana",
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
  evmChainId: 9800,
  explorerTx: "https://explore.qore.network/tx/",
} as const;

/** A native-lane fee: hybrid transactions are large, so the gas limit is generous. */
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name} in .env (run: pnpm agent init)`);
  return v;
}

/** Load a throwaway unified account from `<PREFIX>_PRIVATE_KEY` + `<PREFIX>_PQC_RECOVERY_CODE`. */
export function accountFromEnv(prefix: string): UnifiedAccount {
  const key = env(`${prefix}_PRIVATE_KEY`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${prefix}_PRIVATE_KEY must be 0x + 64 hex chars`);
  const recoveryCode = env(`${prefix}_PQC_RECOVERY_CODE`);
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
}

export function vaultAddress(): `0x${string}` {
  const v = env("VAULT_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("VAULT_ADDRESS must be a 0x address");
  return v as `0x${string}`;
}

async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${TESTNET.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} does not exist on chain yet: send it some QOR first`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcast(
  acc: UnifiedAccount,
  mode: "hybrid" | "classical",
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: TESTNET.rest });
  const transport = await StargateClient.connect(TESTNET.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: TESTNET.chainId,
      accountNumber,
      sequence,
      fee: FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/** Register the account's ML-DSA-87 key (once). No-op when already registered. */
export async function ensureRegistered(acc: UnifiedAccount): Promise<boolean> {
  const pqc = await fetchPqcStatus({ rest: TESTNET.rest, address: acc.cosmos });
  if (pqc.registered && isRegisteredPqcKey(pqc, acc.pqc.publicKey)) return false;
  const proof = signProofOfPossession({ chainId: TESTNET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: proof });
  const hash = await broadcast(acc, "classical", [msg]);
  console.log(`  registered ML-DSA-87 key: ${hash}`);
  return true;
}

/** Open an EVM authorisation window when none is live. Returns true when a window was opened. */
export async function ensureWindow(acc: UnifiedAccount, blocks = 600n, maxTxs = 5n): Promise<boolean> {
  const w = await evmWindowStatus({ rest: TESTNET.rest, address: acc.cosmos });
  if (w.found && w.live && w.remainingTxs > 0n && w.remainingBlocks > 0n) {
    console.log(`  window live: ${w.remainingBlocks} blocks, ${w.remainingTxs} txs left`);
    return false;
  }
  const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
  const maxValue = perTx * maxTxs;
  const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue });
  const hash = await broadcast(acc, "hybrid", [msg]);
  console.log(`  window opened: ${blocks} blocks, ${maxTxs} txs (${hash})`);
  return true;
}

/** The chain's own record of a transaction: code and the hybrid check. */
export async function onChain(hash: string): Promise<{ code: number; hybrid: boolean } | null> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${TESTNET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
    if (res.status === 200) {
      const t = (await res.json()) as {
        tx_response: { code: number; events: { type: string; attributes: { key: string; value: string }[] }[] };
      };
      const hybrid = t.tx_response.events
        .filter((e) => e.type === "pqc_hybrid_verify")
        .some((e) => e.attributes.some((a) => a.key === "status" && a.value === "verified"));
      return { code: t.tx_response.code, hybrid };
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return null;
}

export async function uqorBalance(cosmosAddress: string): Promise<bigint> {
  const res = await fetch(`${TESTNET.rest}/cosmos/bank/v1beta1/balances/${cosmosAddress}`);
  if (!res.ok) return 0n;
  const body = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(body.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

export const fmtQor = (uqor: bigint): string => `${(Number(uqor) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;
