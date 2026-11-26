// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {QorePayVault} from "../contracts/QorePayVault.sol";

/// Minimal cheatcode interface (Foundry), so this suite needs no external
/// test library: it runs with a bare `forge test`.
interface Vm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
    function store(address, bytes32, bytes32) external;
    function addr(uint256) external returns (address);
}

/// Stand-ins for the QoreChain precompiles on Foundry's local EVM, which has
/// none. The real ones run on the testnet. A signature counts as valid here
/// when it equals keccak256("ok", key, message).
contract MockPqc {
    bool public registered = true;
    bool public proven = true;
    bytes public key = hex"c0ffee";

    function set(bool registered_, bool proven_) external {
        registered = registered_;
        proven = proven_;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(signature)
            == keccak256(abi.encodePacked(keccak256(abi.encodePacked("ok", pubkey, message))));
    }

    function pqcKeyStatus(address) external view returns (bool, uint8, bytes memory, bool) {
        return (registered, 1, registered ? key : bytes(""), proven);
    }
}

contract QorePayVaultTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    QorePayVault vault;
    MockPqc keys;
    address owner;
    address agent;
    address payable alice;
    address payable bob;

    function setUp() public {
        vm.deal(address(this), 100 ether);
        owner = vm.addr(1);
        agent = vm.addr(2);
        alice = payable(vm.addr(3));
        bob = payable(vm.addr(4));

        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        keys = MockPqc(PQC_KEYS);
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0101))); // registered = proven = true
        // key = hex"c0ffee" (short bytes layout: data left-aligned, length*2 in the last byte)
        vm.store(
            PQC_KEYS,
            bytes32(uint256(1)),
            bytes32(hex"c0ffee0000000000000000000000000000000000000000000000000000000006")
        );

        // No prank here: a pranked deployment would pay the 10 ether from the
        // owner's (empty) balance. The constructor takes the owner explicitly.
        vault = new QorePayVault{value: 10 ether}(owner);
    }

    // ------------------------------------------------------------ helpers

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq(uint) failed");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq(address) failed");
    }

    function assertTrue(bool c) internal pure {
        require(c, "assertTrue failed");
    }

    function sign(address to, uint256 amount, uint256 n) internal view returns (bytes memory) {
        return abi.encodePacked(
            keccak256(abi.encodePacked("ok", hex"c0ffee", vault.withdrawalMessage(to, amount, n)))
        );
    }

    function makePlan(uint256 amount, uint256 interval, uint256 payments) internal returns (uint256) {
        vm.prank(owner);
        return vault.createPlan(alice, amount, interval, payments, agent);
    }

    // ------------------------------------------------------------ funding

    function test_deposit() public {
        // Deposit is permissionless: no prank (a pranked call would pay the
        // value from the pranked address's balance).
        vault.deposit{value: 2 ether}();
        assertEq(address(vault).balance, 12 ether);
    }

    function test_receiveAcceptsQor() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 11 ether);
    }

    // ------------------------------------------------------------ plans

    function test_createPlanSetsSession() public {
        uint256 id = makePlan(0.8 ether, 1 days, 3);
        (address payee, uint256 amount, uint256 interval, uint256 left, uint256 due, address ag, bool active) =
            vault.plans(id);
        assertEq(payee, alice);
        assertEq(amount, 0.8 ether);
        assertEq(interval, 1 days);
        assertEq(left, 3);
        assertEq(due, block.timestamp + 1 days);
        assertEq(ag, agent);
        assertTrue(active);

        QorePayVault.Session memory s = vault.getSession(agent);
        assertEq(s.perPaymentCap, 1 ether);
        assertEq(s.dailyCap, 3 ether);
        assertEq(s.spentToday, 0);
        assertEq(uint256(s.expiresAt), block.timestamp + 24 hours);
        assertTrue(s.active);
    }

    function test_createPlanRevertsForNonOwner() public {
        vm.prank(agent);
        vm.expectRevert(QorePayVault.NotOwner.selector);
        vault.createPlan(alice, 0.5 ether, 1 days, 2, agent);
    }

    function test_createPlanRevertsAbovePerPaymentCap() public {
        vm.prank(owner);
        vm.expectRevert(QorePayVault.InvalidPlan.selector);
        vault.createPlan(alice, 1.5 ether, 1 days, 2, agent);
    }

    function test_createPlanKeepsExistingSession() public {
        makePlan(0.5 ether, 1 days, 2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vault.pay(0);
        // Second plan: session must NOT reset its daily spend or expiry.
        uint256 expiresBefore = vault.getSession(agent).expiresAt;
        vm.prank(owner);
        vault.createPlan(bob, 0.5 ether, 1 days, 2, agent);
        QorePayVault.Session memory s = vault.getSession(agent);
        assertEq(s.spentToday, 0.5 ether);
        assertEq(uint256(s.expiresAt), uint256(expiresBefore));
    }

    // ------------------------------------------------------------ payments

    function test_payExecutesWhenDue() public {
        uint256 id = makePlan(0.8 ether, 1 days, 2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vault.pay(id);
        assertEq(alice.balance, 0.8 ether);
        (, , , uint256 left, uint256 due, , bool active) = vault.plans(id);
        assertEq(left, 1);
        assertEq(due, block.timestamp + 1 days);
        assertTrue(active);
        assertEq(vault.getSession(agent).spentToday, 0.8 ether);
    }

    function test_payCompletesPlan() public {
        uint256 id = makePlan(0.5 ether, 1 hours, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vault.pay(id);
        (, , , uint256 left, , , bool active) = vault.plans(id);
        assertEq(left, 0);
        assertTrue(!active);
    }

    function test_payRevertsBeforeDue() public {
        uint256 id = makePlan(0.8 ether, 1 days, 2);
        vm.prank(agent);
        vm.expectRevert(QorePayVault.PaymentNotDue.selector);
        vault.pay(id);
    }

    function test_payRevertsForNonAgent() public {
        uint256 id = makePlan(0.8 ether, 1 days, 2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        vm.expectRevert(QorePayVault.NotAgent.selector);
        vault.pay(id);
    }

    function test_payDailyCapEnforced() public {
        makePlan(0.9 ether, 1 hours, 5);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vault.pay(0);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vault.pay(0);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vault.pay(0);
        assertEq(vault.getSession(agent).spentToday, 2.7 ether);
        // 4th payment today would be 3.6 QOR > 3 QOR daily cap.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vm.expectRevert(QorePayVault.DailyCapExceeded.selector);
        vault.pay(0);
        // A fresh session (revoke + new plan) starts a new day window.
        vm.prank(owner);
        vault.revokeSession(agent);
        vm.prank(owner);
        vault.createPlan(alice, 0.9 ether, 1 hours, 2, agent);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vault.pay(1);
        assertEq(vault.getSession(agent).spentToday, 0.9 ether);
    }

    function test_payRevertsAfterExpiry() public {
        uint256 id = makePlan(0.5 ether, 1 hours, 3);
        vm.warp(block.timestamp + 25 hours);
        vm.prank(agent);
        vm.expectRevert(QorePayVault.SessionExpired.selector);
        vault.pay(id);
    }

    function test_revokeSessionStopsPayments() public {
        uint256 id = makePlan(0.5 ether, 1 hours, 3);
        vm.prank(owner);
        vault.revokeSession(agent);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vm.expectRevert(QorePayVault.SessionNotActive.selector);
        vault.pay(id);
    }

    function test_cancelPlanStopsPayments() public {
        uint256 id = makePlan(0.5 ether, 1 hours, 3);
        vm.prank(owner);
        vault.cancelPlan(id);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        vm.expectRevert(QorePayVault.PlanNotActive.selector);
        vault.pay(id);
    }

    function test_duePlanIds() public {
        makePlan(0.5 ether, 1 hours, 2);
        makePlan(0.5 ether, 5 hours, 2);
        assertEq(vault.duePlanIds(10).length, 0);
        vm.warp(block.timestamp + 2 hours);
        uint256[] memory due = vault.duePlanIds(10);
        assertEq(due.length, 1);
        assertEq(due[0], 0);
    }

    // ------------------------------------------------------------ guardian exit

    function test_guardianWithdrawWithValidSignature() public {
        vm.prank(bob);
        vault.guardianWithdraw(bob, 1 ether, sign(bob, 1 ether, 0));
        assertEq(bob.balance, 1 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_guardianWithdrawRevertsOnBadSignature() public {
        vm.expectRevert(QorePayVault.BadPqcSignature.selector);
        vault.guardianWithdraw(bob, 1 ether, hex"deadbeef");
    }

    function test_guardianWithdrawSignatureWorksOnce() public {
        bytes memory sig = sign(bob, 1 ether, 0);
        vault.guardianWithdraw(bob, 1 ether, sig);
        vm.expectRevert(QorePayVault.BadPqcSignature.selector);
        vault.guardianWithdraw(bob, 1 ether, sig);
    }

    function test_guardianWithdrawSignatureBoundToAmountAndRecipient() public {
        bytes memory sig = sign(bob, 1 ether, 0);
        vm.expectRevert(QorePayVault.BadPqcSignature.selector);
        vault.guardianWithdraw(bob, 2 ether, sig);
        vm.expectRevert(QorePayVault.BadPqcSignature.selector);
        vault.guardianWithdraw(alice, 1 ether, sig);
    }

    function test_guardianWithdrawRevertsWhenKeyNotRegistered() public {
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0100))); // registered = false
        bytes memory sig = sign(bob, 1 ether, 0); // sign first: expectRevert applies to the next call
        vm.expectRevert(QorePayVault.GuardianKeyNotRegistered.selector);
        vault.guardianWithdraw(bob, 1 ether, sig);
    }

    function test_guardianWithdrawRevertsWhenKeyNotProven() public {
        vm.store(PQC_KEYS, bytes32(uint256(0)), bytes32(uint256(0x0001))); // proven = false
        bytes memory sig = sign(bob, 1 ether, 0); // sign first: expectRevert applies to the next call
        vm.expectRevert(QorePayVault.GuardianKeyNotProven.selector);
        vault.guardianWithdraw(bob, 1 ether, sig);
    }
}
