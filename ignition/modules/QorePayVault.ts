import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys QorePayVault, funded with `initialFunding` QOR by the deployer.
 * The deployer account IS the vault owner (guardian): its registered
 * ML-DSA-87 key authorises guardian withdrawals.
 *
 * On QoreChain the deployer needs a registered ML-DSA-87 key and a live
 * EVM authorisation window first (see README: pnpm window open).
 */
export default buildModule("QorePayVaultModule", (m) => {
  const owner = m.getParameter("owner");
  const initialFunding = m.getParameter("initialFunding", 0n);
  const vault = m.contract("QorePayVault", [owner], { value: initialFunding });
  return { vault };
});
