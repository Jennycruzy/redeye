// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-1271 signer backed by one WebAuthn P-256 credential.
/// @dev The assertion encoding is
///      abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON).
contract PasskeyOwner {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    address private constant P256_VERIFIER = address(0x100);
    bytes internal constant BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    bytes32 public immutable publicKeyX;
    bytes32 public immutable publicKeyY;

    constructor(bytes32 qx, bytes32 qy) {
        require(qx != bytes32(0) && qy != bytes32(0), "zero passkey");
        publicKeyX = qx;
        publicKeyY = qy;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (
            bytes32 r,
            bytes32 s,
            uint256 challengeIndex,
            uint256 typeIndex,
            bytes memory authenticatorData,
            string memory clientDataJSON
        ) = abi.decode(signature, (bytes32, bytes32, uint256, uint256, bytes, string));

        bytes memory client = bytes(clientDataJSON);
        if (authenticatorData.length < 37) return bytes4(0xffffffff);
        bytes1 flags = authenticatorData[32];
        if ((flags & 0x01) == 0 || (flags & 0x04) == 0) return bytes4(0xffffffff);
        if ((flags & 0x10) != 0 && (flags & 0x08) == 0) return bytes4(0xffffffff);
        if (!_matches(client, typeIndex, bytes('"type":"webauthn.get"'))) {
            return bytes4(0xffffffff);
        }
        if (!_matches(client, challengeIndex, bytes(string.concat('"challenge":"', _challenge(digest), '"')))) {
            return bytes4(0xffffffff);
        }

        bytes32 signedHash = sha256(abi.encodePacked(authenticatorData, sha256(client)));
        (bool ok, bytes memory result) = P256_VERIFIER.staticcall(abi.encode(signedHash, r, s, publicKeyX, publicKeyY));
        return ok && result.length >= 32 && abi.decode(result, (uint256)) == 1 ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    function challengeForDigest(bytes32 digest) external pure returns (string memory) {
        return _challenge(digest);
    }

    function _matches(bytes memory source, uint256 at, bytes memory expected) private pure returns (bool) {
        if (at > source.length || expected.length > source.length - at) return false;
        for (uint256 i; i < expected.length; ++i) {
            if (source[at + i] != expected[i]) return false;
        }
        return true;
    }

    function _challenge(bytes32 digest) private pure returns (string memory) {
        bytes memory input = abi.encodePacked(digest);
        bytes memory output = new bytes(43);
        uint256 out = 0;
        for (uint256 i = 0; i < 30; i += 3) {
            uint24 value =
                (uint24(uint8(input[i])) << 16) | (uint24(uint8(input[i + 1])) << 8) | uint24(uint8(input[i + 2]));
            output[out++] = BASE64URL[(value >> 18) & 63];
            output[out++] = BASE64URL[(value >> 12) & 63];
            output[out++] = BASE64URL[(value >> 6) & 63];
            output[out++] = BASE64URL[value & 63];
        }
        uint16 tail = (uint16(uint8(input[30])) << 8) | uint16(uint8(input[31]));
        output[out++] = BASE64URL[(tail >> 10) & 63];
        output[out++] = BASE64URL[(tail >> 4) & 63];
        output[out] = BASE64URL[(tail & 15) << 2];
        return string(output);
    }
}
