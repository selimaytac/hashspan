// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A minimal EIP-3009 token for hashspan's x402 tests: what the x402 exact EVM facilitator calls, the ERC-20
/// allowance functions that Permit2 transfers through, `receiveWithAuthorization` and `transfer`, which x402's
/// batch-settlement deposit collector calls, and a mint for setup. Not for production use: anyone can mint.
contract TestUsd {
    string public constant name = "Test USD";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// @notice Transfers `value` from `from` to `to` within the caller's allowance, as Permit2 does for a payment.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "transfer amount exceeds allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
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
        bytes32 digest = _digest(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce);
        _authorize(digest, from, nonce, v, r, s);
        _move(from, to, value);
    }

    /// @notice As `transferWithAuthorization`, but only `to` can submit it, with the signature as 65 bytes.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        require(msg.sender == to, "caller must be the payee");
        require(signature.length == 65, "invalid signature length");
        bytes32 digest = _digest(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce);
        _authorize(digest, from, nonce, uint8(signature[64]), bytes32(signature[0:32]), bytes32(signature[32:64]));
        _move(from, to, value);
    }

    function _digest(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view returns (bytes32) {
        require(block.timestamp > validAfter, "authorization is not yet valid");
        require(block.timestamp < validBefore, "authorization is expired");
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _authorize(bytes32 digest, address from, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) private {
        // The x402 facilitator recognises this message when it maps a failed settlement to its reason.
        require(!authorizationState[from][nonce], "authorization is used or canceled");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
