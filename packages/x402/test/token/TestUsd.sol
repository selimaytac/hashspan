// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A minimal EIP-3009 token for hashspan's x402 tests: what the x402 exact EVM facilitator calls, and a
/// mint for setup. Not for production use: anyone can mint.
contract TestUsd {
    string public constant name = "Test USD";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /// @notice Transfers `value` from `from` to `to` with `from`'s EIP-712 signature; anyone can submit it.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "authorization is not yet valid");
        require(block.timestamp < validBefore, "authorization is expired");
        // The x402 facilitator recognises this message when it maps a failed settlement to its reason.
        require(!authorizationState[from][nonce], "authorization is used or canceled");
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        address signer = ecrecover(keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)), v, r, s);
        require(signer != address(0) && signer == from, "invalid signature");
        require(balanceOf[from] >= value, "transfer amount exceeds balance");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
