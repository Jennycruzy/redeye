// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PlanJobHook
/// @notice Hook for Redeye's team ERC-8183 jobs. The commerce contract on BNB Chain requires
/// every job to name a hook; the reference router also takes over approval, which means a
/// seven-day wait. Team jobs name this hook instead, so the buyer named as evaluator can
/// approve or reject a delivered job directly. The hook adds no rules of its own.
contract PlanJobHook {
    /// @dev ERC-165 interface id.
    bytes4 private constant ERC165_ID = 0x01ffc9a7;

    function beforeAction(uint256, bytes4, bytes calldata) external {}

    function afterAction(uint256, bytes4, bytes calldata) external {}

    /// @notice The hook interface id is beforeAction ^ afterAction, which the commerce
    /// contract checks when a job is created.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == ERC165_ID ||
            interfaceId == (this.beforeAction.selector ^ this.afterAction.selector);
    }
}
