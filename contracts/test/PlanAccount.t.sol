// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanAccount} from "../src/PlanAccount.sol";
import {PlanBook} from "../src/PlanBook.sol";

interface VmPlanAccount {
    function addr(uint256 privateKey) external returns (address);
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256) external;
}

contract PlanAccountToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract PlanAccountRouter {
    uint256 public calls;

    function trade(address, address, uint256, uint256) external returns (uint256) {
        calls++;
        return 99;
    }
}

contract PlanAccountTest {
    VmPlanAccount private constant VM =
        VmPlanAccount(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant USER_KEY = 0xA11CE;
    address private agent = address(0x1002);
    address private tokenOut = address(0x2002);
    bytes32 private planHash = keccak256("plan");
    bytes32 private eventKey = keccak256("TSLA:weekend:2026-10-09");

    function _assert(bool condition, string memory message) private pure {
        require(condition, message);
    }

    function _book(address user) private returns (PlanBook book) {
        book = new PlanBook(user, agent);
        VM.prank(agent);
        book.freezePlan(user, eventKey, planHash, "TSLA", uint64(block.timestamp + 1 days), 1);
    }

    function _permission(
        PlanAccountRouter router,
        PlanAccountToken token,
        address user
    ) private view returns (PlanAccount.Permission memory permission) {
        permission = PlanAccount.Permission({
            planHash: planHash,
            standingRunHash: bytes32(0),
            agent: agent,
            tokenIn: address(token),
            tokenOut: tokenOut,
            maxAmount: 100,
            router: address(router),
            notBefore: uint64(block.timestamp),
            notAfter: uint64(block.timestamp + 1 hours),
            maxPriceDeviationBps: 100
        });
        user;
    }

    function _swap(
        PlanAccountToken token,
        PlanAccountRouter router
    ) private view returns (PlanAccount.SwapCall memory swap) {
        swap = PlanAccount.SwapCall({
            planHash: planHash,
            eventKey: eventKey,
            tokenIn: address(token),
            tokenOut: tokenOut,
            amountIn: 100,
            minAmountOut: 99,
            referenceAmountOut: 100,
            value: 0,
            data: abi.encodeWithSelector(router.trade.selector, address(token), tokenOut, 100, 99)
        });
    }

    function _signature(
        PlanAccount account,
        PlanAccount.Permission memory permission,
        PlanAccount.SwapCall memory swap
    ) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(USER_KEY, account.permissionDigest(permission, swap));
        return abi.encodePacked(r, s, v);
    }

    function testPermissionExecutesOneSignedCallAndCannotReplay() external {
        address user = VM.addr(USER_KEY);
        PlanBook book = _book(user);
        PlanAccountToken token = new PlanAccountToken();
        PlanAccountRouter router = new PlanAccountRouter();
        PlanAccount account = new PlanAccount(address(book), user);
        PlanAccount.Permission memory permission = _permission(router, token, user);
        PlanAccount.SwapCall memory swap = _swap(token, router);
        bytes memory signature = _signature(account, permission, swap);

        VM.prank(agent);
        account.executeSwap(permission, signature, swap);
        _assert(router.calls() == 1, "router was not called");
        _assert(token.allowance(address(account), address(router)) == 0, "approval not cleared");
        _assert(account.used(account.permissionHash(permission)), "permission was not consumed");

        bool reverted;
        VM.prank(agent);
        try account.executeSwap(permission, signature, swap) {
            reverted = false;
        } catch {
            reverted = true;
        }
        _assert(reverted, "permission replay succeeded");
    }

    function testPermissionRejectsWrongAgentTokenPairAmountAndPriceBand() external {
        address user = VM.addr(USER_KEY);
        PlanBook book = _book(user);
        PlanAccountToken token = new PlanAccountToken();
        PlanAccountRouter router = new PlanAccountRouter();
        PlanAccount account = new PlanAccount(address(book), user);
        PlanAccount.Permission memory permission = _permission(router, token, user);
        PlanAccount.SwapCall memory swap = _swap(token, router);
        bytes memory signature = _signature(account, permission, swap);

        permission.agent = address(0x3003);
        VM.prank(address(0x3003));
        bool wrongAgentReverted;
        try account.executeSwap(permission, signature, swap) {
            wrongAgentReverted = false;
        } catch {
            wrongAgentReverted = true;
        }
        _assert(wrongAgentReverted, "wrong agent call succeeded");

        permission = _permission(router, token, user);
        swap.tokenOut = address(0x4004);
        signature = _signature(account, permission, _swap(token, router));
        VM.prank(agent);
        bool wrongPairReverted;
        try account.executeSwap(permission, signature, swap) {
            wrongPairReverted = false;
        } catch {
            wrongPairReverted = true;
        }
        _assert(wrongPairReverted, "wrong token pair succeeded");

        permission = _permission(router, token, user);
        swap = _swap(token, router);
        swap.amountIn = 101;
        signature = _signature(account, permission, swap);
        VM.prank(agent);
        bool amountReverted;
        try account.executeSwap(permission, signature, swap) {
            amountReverted = false;
        } catch {
            amountReverted = true;
        }
        _assert(amountReverted, "amount cap was not enforced");

        permission = _permission(router, token, user);
        swap = _swap(token, router);
        swap.minAmountOut = 98;
        signature = _signature(account, permission, swap);
        VM.prank(agent);
        bool bandReverted;
        try account.executeSwap(permission, signature, swap) {
            bandReverted = false;
        } catch {
            bandReverted = true;
        }
        _assert(bandReverted, "price band was not enforced");
    }

    function testPermissionRevocationAndExpiryAreEnforced() external {
        address user = VM.addr(USER_KEY);
        PlanBook book = _book(user);
        PlanAccountToken token = new PlanAccountToken();
        PlanAccountRouter router = new PlanAccountRouter();
        PlanAccount account = new PlanAccount(address(book), user);
        PlanAccount.Permission memory permission = _permission(router, token, user);
        PlanAccount.SwapCall memory swap = _swap(token, router);

        VM.prank(user);
        account.revoke(permission);
        VM.prank(agent);
        bool revokeReverted;
        try account.executeSwap(permission, _signature(account, permission, swap), swap) {
            revokeReverted = false;
        } catch {
            revokeReverted = true;
        }
        _assert(revokeReverted, "revoked permission executed");

        PlanAccount.Permission memory expiring = _permission(router, token, user);
        expiring.notBefore = uint64(block.timestamp + 2 hours);
        expiring.notAfter = uint64(block.timestamp + 3 hours);
        PlanAccount.SwapCall memory expiringSwap = _swap(token, router);
        bytes memory expiringSignature = _signature(account, expiring, expiringSwap);
        VM.warp(block.timestamp + 4 hours);
        VM.prank(agent);
        bool expiryReverted;
        try account.executeSwap(expiring, expiringSignature, expiringSwap) {
            expiryReverted = false;
        } catch {
            expiryReverted = true;
        }
        _assert(expiryReverted, "expired permission executed");
    }

    function testDelegatedModeUsesTheAccountAddressAsOwner() external {
        PlanBook book = new PlanBook(address(this), agent);
        PlanAccount delegated = new PlanAccount(address(book), address(0));
        _assert(delegated.accountOwner() == address(delegated), "delegated owner mismatch");
    }

    function testStandingPermissionAllowsOneCallPerFrozenWindowOnly() external {
        address user = VM.addr(USER_KEY);
        PlanBook book = new PlanBook(user, agent);
        bytes32 runHash = keccak256("standing-run");
        bytes32 firstPlanHash = keccak256("standing-plan-1");
        bytes32 secondPlanHash = keccak256("standing-plan-2");
        bytes32 firstEventKey = keccak256("TSLA:overnight:2026-10-05");
        bytes32 secondEventKey = keccak256("TSLA:overnight:2026-10-06");
        VM.prank(agent);
        book.freezeStandingPlan(
            user, firstEventKey, firstPlanHash, runHash, "TSLA", uint64(block.timestamp + 1 days), 1
        );
        VM.prank(agent);
        book.freezeStandingPlan(
            user, secondEventKey, secondPlanHash, runHash, "TSLA", uint64(block.timestamp + 2 days), 2
        );

        PlanAccountToken token = new PlanAccountToken();
        PlanAccountRouter router = new PlanAccountRouter();
        PlanAccount account = new PlanAccount(address(book), user);
        PlanAccount.Permission memory permission = PlanAccount.Permission({
            planHash: bytes32(0),
            standingRunHash: runHash,
            agent: agent,
            tokenIn: address(token),
            tokenOut: tokenOut,
            maxAmount: 100,
            router: address(router),
            notBefore: uint64(block.timestamp),
            notAfter: uint64(block.timestamp + 1 hours),
            maxPriceDeviationBps: 100
        });
        PlanAccount.SwapCall memory firstSwap = _swap(token, router);
        firstSwap.planHash = firstPlanHash;
        firstSwap.eventKey = firstEventKey;
        bytes memory firstSignature = _signature(account, permission, firstSwap);
        VM.prank(agent);
        account.executeSwap(permission, firstSignature, firstSwap);

        PlanAccount.SwapCall memory secondSwap = _swap(token, router);
        secondSwap.planHash = secondPlanHash;
        secondSwap.eventKey = secondEventKey;
        bytes memory secondSignature = _signature(account, permission, secondSwap);
        VM.prank(agent);
        account.executeSwap(permission, secondSignature, secondSwap);
        _assert(router.calls() == 2, "standing permission did not reach both windows");

        bool replayReverted;
        VM.prank(agent);
        try account.executeSwap(permission, secondSignature, secondSwap) {
            replayReverted = false;
        } catch {
            replayReverted = true;
        }
        _assert(replayReverted, "standing permission replayed a window");

        PlanAccount.SwapCall memory unknownSwap = _swap(token, router);
        unknownSwap.planHash = keccak256("not-frozen");
        unknownSwap.eventKey = keccak256("TSLA:overnight:2026-10-07");
        bytes memory unknownSignature = _signature(account, permission, unknownSwap);
        VM.prank(agent);
        bool unknownReverted;
        try account.executeSwap(permission, unknownSignature, unknownSwap) {
            unknownReverted = false;
        } catch {
            unknownReverted = true;
        }
        _assert(unknownReverted, "unfrozen standing plan was accepted");
    }
}
