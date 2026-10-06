// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanBook} from "../src/PlanBook.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
}

contract PlanBookTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private owner = address(0x1001);
    address private agent = address(0x1002);
    address private user = address(0x1003);
    bytes32 private eventKey = keccak256("NVDA:earnings:2026-10-20");
    bytes32 private planHash = keccak256("plan");
    bytes32 private decisionHash = keccak256("decision");
    bytes32 private verdictHash = keccak256("verdict");

    function _book() private returns (PlanBook book) {
        book = new PlanBook(owner, agent);
    }

    function _freeze(PlanBook book, bytes32 key) private returns (uint256 id) {
        VM.prank(agent);
        id = book.freezePlan(user, key, planHash, "NVDA", uint64(block.timestamp + 1 days), 7);
    }

    function _assert(bool condition, string memory message) private pure {
        require(condition, message);
    }

    function testFreezeAndRecordLifecycle() external {
        PlanBook book = _book();
        uint256 id = _freeze(book, eventKey);

        VM.prank(agent);
        book.recordDecision(id, decisionHash);
        VM.prank(agent);
        book.recordFill(id, bytes32(uint256(1)), 1);
        VM.prank(agent);
        book.recordVerdict(id, 1, verdictHash);

        (uint256 kept, uint256 refused, uint256 broken, uint256 cancelled, uint256 open) = book.counts();
        _assert(kept == 1 && refused == 0 && broken == 0 && cancelled == 0 && open == 0, "bad counts");
    }

    function testRefusedCanCloseWithoutDecision() external {
        PlanBook book = _book();
        uint256 id = _freeze(book, eventKey);

        VM.prank(agent);
        book.recordVerdict(id, 2, verdictHash);

        (, uint256 refused,,,) = book.counts();
        _assert(refused == 1, "refusal not counted");
    }

    function testSecondFreezeForOwnerAndEventReverts() external {
        PlanBook book = _book();
        _freeze(book, eventKey);

        bool reverted;
        VM.prank(agent);
        try book.freezePlan(user, eventKey, planHash, "NVDA", uint64(block.timestamp + 1 days), 8) {
            reverted = false;
        } catch {
            reverted = true;
        }
        _assert(reverted, "duplicate freeze succeeded");
    }

    function testFreezeAfterReleaseReverts() external {
        PlanBook book = _book();
        VM.warp(1000);

        bool reverted;
        VM.prank(agent);
        try book.freezePlan(user, eventKey, planHash, "NVDA", 1000, 7) {
            reverted = false;
        } catch {
            reverted = true;
        }
        _assert(reverted, "late freeze succeeded");
    }

    function testOnlyAgentCanWriteAndOwnerCanRotateAgent() external {
        PlanBook book = _book();
        bool reverted;
        try book.freezePlan(user, eventKey, planHash, "NVDA", uint64(block.timestamp + 1 days), 7) {
            reverted = false;
        } catch {
            reverted = true;
        }
        _assert(reverted, "non-agent wrote plan");

        address nextAgent = address(0x1004);
        VM.prank(owner);
        book.setAgent(nextAgent);
        _assert(book.agent() == nextAgent, "agent did not rotate");
    }

    function testCancelBeforeReleaseIsCounted() external {
        PlanBook book = _book();
        uint256 id = _freeze(book, eventKey);

        VM.prank(agent);
        book.cancelPlan(id);
        (,,, uint256 cancelled, uint256 open) = book.counts();
        _assert(cancelled == 1 && open == 0, "cancel not counted");
    }

    function testFrozenPlanHashCanBeCheckedByPermissionAccount() external {
        PlanBook book = _book();
        _freeze(book, eventKey);

        _assert(book.isPlanHashFrozen(user, planHash), "frozen plan hash not indexed");
        _assert(book.isPlanHashActive(user, planHash), "frozen plan hash not active");
        _assert(!book.isPlanHashFrozen(user, keccak256("other")), "unknown hash reported frozen");

        VM.prank(agent);
        book.recordVerdict(1, 2, verdictHash);
        _assert(!book.isPlanHashActive(user, planHash), "closed plan reported active");
    }
}
