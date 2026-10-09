// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanAccount} from "./PlanAccount.sol";
import {PasskeyOwner} from "./PasskeyOwner.sol";

/// @notice Deterministically creates a seedless PlanAccount and its WebAuthn signer.
contract PasskeyAccountFactory {
    address public immutable planBook;

    event PasskeyAccountCreated(bytes32 indexed credentialIdHash, address indexed account, address indexed owner);

    constructor(address planBookAddress) {
        require(planBookAddress != address(0), "zero PlanBook");
        planBook = planBookAddress;
    }

    function createAccount(bytes32 credentialIdHash, bytes32 qx, bytes32 qy)
        external
        returns (address account, address owner)
    {
        bytes32 ownerSalt = _ownerSalt(credentialIdHash, qx, qy);
        owner = address(new PasskeyOwner{salt: ownerSalt}(qx, qy));
        account = address(new PlanAccount{salt: _accountSalt(ownerSalt)}(planBook, owner));
        emit PasskeyAccountCreated(credentialIdHash, account, owner);
    }

    function predictAccount(bytes32 credentialIdHash, bytes32 qx, bytes32 qy)
        external
        view
        returns (address account, address owner)
    {
        bytes32 ownerSalt = _ownerSalt(credentialIdHash, qx, qy);
        bytes32 ownerHash = keccak256(abi.encodePacked(type(PasskeyOwner).creationCode, abi.encode(qx, qy)));
        owner = _create2(ownerSalt, ownerHash);
        bytes32 accountHash = keccak256(abi.encodePacked(type(PlanAccount).creationCode, abi.encode(planBook, owner)));
        account = _create2(_accountSalt(ownerSalt), accountHash);
    }

    function _ownerSalt(bytes32 credentialIdHash, bytes32 qx, bytes32 qy) private pure returns (bytes32) {
        return keccak256(abi.encode(credentialIdHash, qx, qy));
    }

    function _accountSalt(bytes32 ownerSalt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("REDEYE_PASSKEY_ACCOUNT", ownerSalt));
    }

    function _create2(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
