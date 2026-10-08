// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanJobHook} from "../src/PlanJobHook.sol";

contract PlanJobHookTest {
    PlanJobHook private hook;

    function setUp() public {
        hook = new PlanJobHook();
    }

    function testSupportsErc165() public view {
        require(hook.supportsInterface(0x01ffc9a7), "erc165");
    }

    function testSupportsHookInterface() public view {
        // beforeAction(uint256,bytes4,bytes) = 0xdc08fb1d, afterAction(uint256,bytes4,bytes) = 0xa3fe4783
        require(hook.supportsInterface(bytes4(0xdc08fb1d) ^ bytes4(0xa3fe4783)), "hook interface");
    }

    function testRejectsOtherInterfaces() public view {
        require(!hook.supportsInterface(0xffffffff), "invalid id");
        require(!hook.supportsInterface(0xdc08fb1d), "half of the hook id");
    }

    function testActionsAcceptAnyCall() public {
        hook.beforeAction(1, 0x12345678, hex"");
        hook.afterAction(1, 0x12345678, hex"abcd");
    }
}
