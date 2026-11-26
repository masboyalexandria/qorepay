import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

type PlanTuple = readonly [string, bigint, bigint, bigint, bigint, string, boolean];
type SessionTuple = { perPaymentCap: bigint; dailyCap: bigint; spentToday: bigint; dayStart: bigint; expiresAt: bigint; active: boolean };

describe("QorePayVault (Hardhat simulated network)", async () => {
  // Runs on Hardhat's simulated network; no QoreChain endpoint is needed.
  // The PQC precompiles do not exist here, so guardianWithdraw is covered
  // by the Foundry suite (test/QorePayVault.t.sol) with mocked precompiles.
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  async function deploy() {
    const [owner, agent, alice] = await viem.getWalletClients();
    const vault = await viem.deployContract("QorePayVault", [owner.account.address], {
      value: 10n * 10n ** 18n,
    });
    return { vault, owner, agent, alice };
  }

  const planOf = async (vault: Awaited<ReturnType<typeof deploy>>["vault"], id: bigint) =>
    (await vault.read.plans([id])) as unknown as PlanTuple;
  const sessionOf = async (vault: Awaited<ReturnType<typeof deploy>>["vault"], addr: `0x${string}`) =>
    (await vault.read.getSession([addr])) as unknown as SessionTuple;

  it("owner creates a plan with a 24h session (1 QOR / payment, 3 QOR / day)", async () => {
    const { vault, owner, agent, alice } = await deploy();
    const amount = 8n * 10n ** 17n; // 0.8 QOR
    await vault.write.createPlan(
      [alice.account.address, amount, 86_400n, 3n, agent.account.address],
      { account: owner.account },
    );
    const plan = await planOf(vault, 0n);
    assert.equal(plan[0].toLowerCase(), alice.account.address.toLowerCase()); // payee
    assert.equal(plan[1], amount);
    assert.equal(plan[3], 3n); // paymentsLeft
    assert.equal(plan[5].toLowerCase(), agent.account.address.toLowerCase());
    assert.equal(plan[6], true); // active
    const session = await sessionOf(vault, agent.account.address);
    assert.equal(session.perPaymentCap, 10n ** 18n); // perPaymentCap 1 QOR
    assert.equal(session.dailyCap, 3n * 10n ** 18n); // dailyCap 3 QOR
    assert.equal(session.active, true); // active
  });

  it("refuses a plan above the 1 QOR per-payment cap", async () => {
    const { vault, owner, agent, alice } = await deploy();
    await viem.assertions.revertWithCustomError(
      vault.write.createPlan(
        [alice.account.address, 15n * 10n ** 17n, 86_400n, 2n, agent.account.address],
        { account: owner.account },
      ),
      vault,
      "InvalidPlan",
    );
  });

  it("agent pays a due bill; a stranger cannot", async () => {
    const { vault, owner, agent, alice } = await deploy();
    const amount = 5n * 10n ** 17n; // 0.5 QOR
    await vault.write.createPlan(
      [alice.account.address, amount, 3_600n, 2n, agent.account.address],
      { account: owner.account },
    );
    const before = await publicClient.getBalance({ address: alice.account.address });
    // Too early: not due yet.
    await viem.assertions.revertWithCustomError(vault.write.pay([0n], { account: agent.account }), vault, "PaymentNotDue");
    // Advance one hour: due.
    await networkHelpers.time.increase(3_600);
    await vault.write.pay([0n], { account: agent.account });
    const after = await publicClient.getBalance({ address: alice.account.address });
    assert.equal(after - before, amount);
    const plan = await planOf(vault, 0n);
    assert.equal(plan[3], 1n); // paymentsLeft
    // A stranger (the owner, who is not the plan's agent) cannot pay.
    await viem.assertions.revertWithCustomError(vault.write.pay([0n], { account: owner.account }), vault, "NotAgent");
  });

  it("daily cap blocks the 4th 0.9 QOR payment of the day", async () => {
    const { vault, owner, agent, alice } = await deploy();
    const amount = 9n * 10n ** 17n; // 0.9 QOR
    await vault.write.createPlan(
      [alice.account.address, amount, 3_600n, 5n, agent.account.address],
      { account: owner.account },
    );
    for (let i = 0; i < 3; i++) {
      await networkHelpers.time.increase(3_600);
      await vault.write.pay([0n], { account: agent.account });
    }
    await networkHelpers.time.increase(3_600);
    await viem.assertions.revertWithCustomError(vault.write.pay([0n], { account: agent.account }), vault, "DailyCapExceeded");
  });

  it("owner revokes the session and cancels the plan", async () => {
    const { vault, owner, agent, alice } = await deploy();
    await vault.write.createPlan(
      [alice.account.address, 5n * 10n ** 17n, 3_600n, 3n, agent.account.address],
      { account: owner.account },
    );
    await vault.write.revokeSession([agent.account.address], { account: owner.account });
    await networkHelpers.time.increase(3_600);
    await viem.assertions.revertWithCustomError(
      vault.write.pay([0n], { account: agent.account }),
      vault,
      "SessionNotActive",
    );
    await vault.write.cancelPlan([0n], { account: owner.account });
    const plan = await planOf(vault, 0n);
    assert.equal(plan[6], false);
  });
});
